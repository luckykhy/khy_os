'use strict';

/**
 * Windows 命令翻译层（纯函数，无副作用，可独立单测）。
 *
 * 模型在 Windows 上仍常按 Linux/bash 习惯生成命令；本模块作为安全网，把常见
 * Unix 语法翻译为活动 shell 的等价形式：
 *   - patchWinCommand：目标 cmd.exe —— 产出纯 cmd 语法（type/findstr/del/NUL/%VAR% …）。
 *   - patchGitBashCommand：目标 Git Bash/MSYS —— 盘符路径 `D:\a` → `/d/a`，`dir` → `ls`。
 *
 * 从 shellCommand.js 抽出以保持单一真源并便于测试（shellCommand 的导出对象被
 * defineTool 冻结，无法挂测试钩子；改用 shellClassifier 同款的兄弟纯模块模式）。
 */

// grep → findstr 的 flag 映射。findstr 的语义与 grep 有两处关键差异：
//   ① 默认按「字面量」匹配，正则需显式 /R；② 空格分隔的多个 pattern 表示「或」，
//      故 grep 的交替 `a|b` 必须转写成 `"a b"`（否则 findstr 把整串当字面量找不到）。
const GREP_FLAG_TO_FINDSTR = { i: '/i', r: '/s', R: '/s', v: '/v', n: '/n' };

/**
 * 把 grep 的 flag 串（如 " -rn" / "-iE"）翻译为 findstr 选项前缀（如 "findstr /s /n"）。
 * 未知 flag 安全忽略；`-E`/`-e`/`-G` 视为启用正则（findstr /R）。
 * @param {string} flagStr
 * @returns {string}
 */
function grepFlagsToFindstr(flagStr) {
  const opts = [];
  let regex = false;
  for (const ch of String(flagStr || '').replace(/[\s-]/g, '')) {
    if (ch === 'E' || ch === 'e' || ch === 'G') { regex = true; continue; }
    const mapped = GREP_FLAG_TO_FINDSTR[ch];
    if (mapped && !opts.includes(mapped)) opts.push(mapped);
  }
  if (regex && !opts.includes('/R')) opts.push('/R');
  return opts.length ? `findstr ${opts.join(' ')}` : 'findstr';
}

/**
 * Windows 命令自动修补：将常见 Linux-only 语法翻译为 cmd.exe 兼容形式。
 * AI 有时仍会生成 bash 命令，此函数作为安全网兜底。
 * @param {string} cmd
 * @returns {string}
 */
function patchWinCommand(cmd) {
  if (!cmd) return cmd;
  let patched = cmd;

  // ── 路径与重定向 ──
  // ~/path → %USERPROFILE%\path
  patched = patched.replace(/(?<=^|\s)~\//g, '%USERPROFILE%\\');
  // /dev/null → NUL
  patched = patched.replace(/2>\s*\/dev\/null/g, '2>NUL');
  patched = patched.replace(/>\s*\/dev\/null/g, '>NUL');
  patched = patched.replace(/\/dev\/null/g, 'NUL');

  // ── 目录操作 ──
  // mkdir -p dir → mkdir dir（cmd.exe 的 mkdir 默认创建中间目录）
  patched = patched.replace(/\bmkdir\s+-p\s+/g, 'mkdir ');

  // ── 文件查看/操作 ──
  // cat file → type file（仅在独立命令开头或 && 后）
  patched = patched.replace(/^cat\s+/m, 'type ');
  patched = patched.replace(/(?<=&&\s*)cat\s+/g, 'type ');
  // head/tail（带文件参数）→ powershell Get-Content。file 限定为单 token（不跨管道/分隔符），
  // 避免贪婪 `.+` 把后续 `| cmd` 误当文件名（旧实现的隐患），也让纯管道形式落到下方 stdin 规则。
  // head -n N file → Get-Content file -TotalCount N
  patched = patched.replace(/\bhead\s+-n?\s*(\d+)\s+([^\s|&;<>]+)/g, 'powershell -NoProfile -c "Get-Content $2 -TotalCount $1"');
  // tail -n N file → Get-Content file -Tail N
  patched = patched.replace(/\btail\s+-n?\s*(\d+)\s+([^\s|&;<>]+)/g, 'powershell -NoProfile -c "Get-Content $2 -Tail $1"');
  // head/tail 读管道（无文件参数，作为管道末段消费 stdin）→ PowerShell $input。
  // 形如 `... | head -30` / `... | tail -n 5`。cmd.exe 无原生等价命令，故借道 powershell
  // 的自动变量 $input 消费上游管道。前瞻锚定其后紧跟管道/分隔/重定向/行尾，避免误吞文件参数。
  patched = patched.replace(/\bhead\s+-n?\s*(\d+)(?=\s*(?:\||&|;|>|$))/g, 'powershell -NoProfile -c "$input | Select-Object -First $1"');
  patched = patched.replace(/\btail\s+-n?\s*(\d+)(?=\s*(?:\||&|;|>|$))/g, 'powershell -NoProfile -c "$input | Select-Object -Last $1"');
  // wc -l file → find /c /v "" file
  // R3 治理(KHY_WIN_TRANSLATE_FLAG_NORMALIZE,default-on):历史单条 `/\bwc\s+-l\s+(.+)/` 有两处缝:
  //   ① 贪婪 `.+` 把后续 `| sort` 一并吞进文件参数(与上方 head/tail 已修的隐患同型);
  //   ② 要求 `-l` 后必须紧跟文件参数,故纯管道形 `cat f | wc -l`(stdin 计数、无文件)整条落空
  //      → 原样下发给 cmd.exe(无 wc 命令直接报错)。
  // 开 → 先按「单 token 文件」翻译(前瞻停在管道/分隔符前),再把无文件的管道末段 `wc -l`
  // 翻成读 stdin 的 `find /c /v ""`;关 → 逐字节回退历史单条贪婪规则。
  let _winFlagNorm = true;
  try { _winFlagNorm = require('../services/flagRegistry').isFlagEnabled('KHY_WIN_TRANSLATE_FLAG_NORMALIZE', process.env); } catch { _winFlagNorm = true; }
  if (_winFlagNorm) {
    patched = patched.replace(/\bwc\s+-l\s+([^\s|&;<>]+)/g, 'find /c /v "" $1');
    patched = patched.replace(/\bwc\s+-l(?=\s*(?:[|&;>]|$))/g, 'find /c /v ""');
  } else {
    patched = patched.replace(/\bwc\s+-l\s+(.+)/g, 'find /c /v "" $1');
  }

  // ── 文件管理 ──
  // cp -r src dst → xcopy /s /e /i src dst
  patched = patched.replace(/\bcp\s+-r\s+/g, 'xcopy /s /e /i ');
  // cp src dst → copy src dst
  patched = patched.replace(/\bcp\s+(?!-)/g, 'copy ');
  // mv src dst → move src dst
  patched = patched.replace(/\bmv\s+/g, 'move ');
  // rm -rf dir → rmdir /s /q dir
  // R5 治理(KHY_WIN_RM_TRANSLATE_FLAGS,default-on):历史两条 `-r[f]*` / `-f[r]*` 只认「纯
  // r/f 且区分大小写」的 flag 簇 → `rm -rfv logs`(带额外 flag)、`rm -Rf x`(大写)落空,既
  // 不翻译又被后面的 `rm (?!-)` 拒(因带 `-`)→ 原样 `rm -Rf x` 漏给 cmd.exe(cmd 无 rm 直接
  // 报错)。开 → 单条 case-insensitive、含任一 r/f 的 flag 簇一律翻成 rmdir(原两条的严格超集);
  // 关 → 逐字节回退历史两条。
  let _winRmFlags = true;
  try { _winRmFlags = require('../services/flagRegistry').isFlagEnabled('KHY_WIN_RM_TRANSLATE_FLAGS', process.env); } catch { _winRmFlags = true; }
  if (_winRmFlags) {
    patched = patched.replace(/\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+/g, 'rmdir /s /q ');
  } else {
    patched = patched.replace(/\brm\s+-r[f]*\s+/g, 'rmdir /s /q ');
    patched = patched.replace(/\brm\s+-f[r]*\s+/g, 'rmdir /s /q ');
  }
  // rm file → del file（单文件删除）
  patched = patched.replace(/\brm\s+(?!-)/g, 'del ');
  // touch file → type nul > file
  patched = patched.replace(/\btouch\s+(["']?[^\s&|;]+["']?)/g, 'type nul > $1');
  // chmod → 忽略（Windows 无此概念）
  // R5 治理(KHY_WIN_TRANSLATE_FLAG_NORMALIZE):历史字符类 `[+\-rwx0-7]+` 只含权限位与八进制,
  // 漏了 who-selector(u/g/o/a)、`=` 赋值式与特殊位(s/t/X)→ 符号式 `chmod u+x f`/`chmod a+rwx f`/
  // `chmod o=r f` 落空未被中和,原样下发。开 → 字符类加宽到 `[ugoaX+\-=rwxst0-7]+` 覆盖全部符号式;
  // 关 → 逐字节回退历史字符类。
  if (_winFlagNorm) {
    patched = patched.replace(/\bchmod\s+[ugoaX+\-=rwxst0-7]+\s+/g, 'echo [skip chmod] & rem ');
  } else {
    patched = patched.replace(/\bchmod\s+[+\-rwx0-7]+\s+/g, 'echo [skip chmod] & rem ');
  }

  // ── 搜索 ──
  // grep [flags] "pattern" → findstr：引号内交替 `a|b` 转空格（findstr 用空格表示「或」）；
  // 只动引号内的 `|`，引号外的真实管道（如 `grep foo | sort`）保持不变。
  patched = patched.replace(
    /\bgrep((?:\s+-[A-Za-z]+)*)\s+(["'])([\s\S]*?)\2/g,
    (_m, flags, q, pat) => `${grepFlagsToFindstr(flags)} ${q}${pat.replace(/\|/g, ' ')}${q}`
  );
  // grep [flags] bareword（无引号单 token pattern；不吞其后的管道/文件参数）
  patched = patched.replace(
    /\bgrep((?:\s+-[A-Za-z]+)*)\s+(?!-)([^\s|&;<>"']+)/g,
    (_m, flags, pat) => `${grepFlagsToFindstr(flags)} ${pat}`
  );
  // find . -name "*.txt" → dir /s /b *.txt
  patched = patched.replace(/\bfind\s+\.\s+-name\s+["']?([^"'\s]+)["']?/g, 'dir /s /b $1');

  // ── 系统命令 ──
  // ls -la → dir /a
  // R4 治理(KHY_WIN_TRANSLATE_FLAG_NORMALIZE):历史三条 `-la?` / `-l` / bareword 只认 `l` 在前、
  // `a` 紧随的固定顺序 → `ls -al`(a 在前)、`ls -a`(只有 a)落到 bareword 规则被当文件名(`dir -al`),
  // 或原样漏下。开 → 先按「含 a 的 flag 簇」翻 `dir /a `(-la/-al/-a/-lart 全覆盖),再按「含 l 的簇」
  // 翻 `dir `,bareword/行尾规则不变;关 → 逐字节回退历史三条。
  if (_winFlagNorm) {
    patched = patched.replace(/\bls\s+-[latAr]*a[latAr]*\b\s*/g, 'dir /a ');
    patched = patched.replace(/\bls\s+-[latAr]*l[latAr]*\b\s*/g, 'dir ');
  } else {
    patched = patched.replace(/\bls\s+-la?\s*/g, 'dir /a ');
    patched = patched.replace(/\bls\s+-l\s*/g, 'dir ');
  }
  patched = patched.replace(/\bls\s+(?!-)/g, 'dir ');
  patched = patched.replace(/\bls\s*$/gm, 'dir');
  // which cmd → where cmd
  patched = patched.replace(/\bwhich\s+/g, 'where ');
  // pwd → cd（cmd.exe cd 无参数打印当前目录）
  patched = patched.replace(/\bpwd\b/g, 'cd');
  // clear → cls
  patched = patched.replace(/\bclear\b/g, 'cls');
  // ps aux → tasklist
  // R4 治理(同门控):历史 `\bps\s+(aux|ef|a)\b` 不认带连字符的标准写法 → `ps -ef` / `ps -e` 漏译。
  // 开 → 允许可选前导 `-` 并补 `e`(`ps -e` 全进程);关 → 逐字节回退历史无连字符形。
  if (_winFlagNorm) {
    patched = patched.replace(/\bps\s+-?(?:aux|ef|e|a)\b/g, 'tasklist');
  } else {
    patched = patched.replace(/\bps\s+(aux|ef|a)\b/g, 'tasklist');
  }
  // kill PID → taskkill /F /PID PID
  patched = patched.replace(/\bkill\s+-9\s+(\d+)/g, 'taskkill /F /PID $1');
  patched = patched.replace(/\bkill\s+(\d+)/g, 'taskkill /PID $1');
  // df -h → PowerShell CIM (wmic is removed in Windows 11 24H2+)
  patched = patched.replace(/\bdf\s+-h\b/g, 'powershell -NoProfile -c "Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,Size,FreeSpace"');
  // uname -a → ver
  patched = patched.replace(/\buname\s+-[a-z]+/g, 'ver');
  // whoami → whoami（Windows 也有）
  // echo $VAR → echo %VAR%
  patched = patched.replace(/\becho\s+\$([A-Za-z_]\w*)/g, 'echo %$1%');

  return patched;
}

/**
 * Git Bash / MSYS 命令兜底翻译。
 *
 * Windows 上探测到 Git Bash（MSYSTEM）时，活动 shell 是 bash，但模型常按
 * Windows 习惯生成 cmd 风格命令：盘符反斜杠路径（`D:\a\b`）与 cmd 专属命令
 * （dir）。MSYS coreutils 无法解析反斜杠盘符路径，也没有 `dir`，于是
 * `mkdir "D:\...\测试"` / `dir "D:\..."` 直接以退出码 1 失败（实测现象）。
 *
 * 本函数把盘符绝对路径翻译为 MSYS 形式（`D:\a\b` → `/d/a/b`，外层引号保留、
 * 路径内反斜杠→正斜杠），并把少量 cmd 专属命令译为 bash 等价。bash 本就支持的
 * 命令（mkdir/cp/mv/rm…）不动；纯 POSIX 命令保持原样（零回归）。
 * @param {string} cmd
 * @returns {string}
 */
function patchGitBashCommand(cmd) {
  if (!cmd) return cmd;
  let patched = cmd;

  // 盘符绝对路径 `X:\a\b\c` → MSYS `/x/a/b/c`。只匹配像路径的片段：盘符 + 冒号 +
  // 反斜杠 + 直到空白/引号/反引号/管道/分隔符为止。drive 统一小写，路径内反斜杠转正斜杠。
  patched = patched.replace(
    /([A-Za-z]):\\([^\s"'`|;&<>]*)/g,
    (_m, drive, rest) => `/${drive.toLowerCase()}/${rest.replace(/\\/g, '/')}`
  );

  // cmd 专属命令 → bash 等价（仅在命令起始或 && / || / ; / | 之后；保留前导分隔符）。
  // 仅翻译 bash 中确实不存在的 cmd 命令，避免误伤同名 POSIX 命令。
  patched = patched.replace(/(^|&&|\|\||;|\|)(\s*)dir\b/g, '$1$2ls -la');

  return patched;
}

/**
 * 命令是否「把非 ASCII needle 喂给 find/findstr 过滤器」。
 *
 * Windows `find.exe`(及较弱程度的 `findstr`)在代码页 65001(UTF-8)下无法可靠匹配
 * 中文/多字节 needle —— 故 `dir ... | find "文件"` 在被我们强制 `chcp 65001` 后零匹配、
 * 退出码 1。本判定用于让 forceWindowsUtf8 对这类命令**跳过 chcp 强制**,使 find 回到
 * 原生代码页(GBK 等)正常匹配;输出仍由 spawn 侧 iconv 自动探测解码,不乱码。
 *
 * 只匹配「管道末/中的 `| find`/`| findstr` 段且该段含非 ASCII」;纯 ASCII 的 find 与
 * 无 find 的命令一律 false(零行为改变)。
 * @param {string} cmd
 * @returns {boolean}
 */
function pipesNonAsciiFindFilter(cmd) {
  if (!cmd) return false;
  // 抓出每个 `| find`/`| findstr` 段(到下一个管道或行尾),逐段查非 ASCII。
  const re = /\|\s*(find|findstr)\b([^|]*)/gi;
  let m;
  while ((m = re.exec(cmd)) !== null) {
    if (/[^\x00-\x7F]/.test(m[2])) return true;
  }
  return false;
}

/**
 * Windows 非 ASCII 命令的 UTF-8 强制层(从 shellCommand.js 迁入以便单测 + 单一真源)。
 *
 * 中文 Windows 的 cmd.exe / PowerShell 默认走 OEM 代码页(GBK/CP936)。两类乱码均源于此:
 *   ① 命令含中文路径 → 解析/回显乱码;② 命令纯 ASCII 但**输出**含中文 → 子进程吐 GBK 字节,
 *      被按 UTF-8 解码即乱码。故强制条件**取决于 shell 类型而非命令字节**:shell 是 cmd/powershell
 *      就让子进程输出走 UTF-8(cmd `chcp 65001`;PowerShell 设 OutputEncoding),返回 'utf-8' 交给
 *      spawn 侧确定性解码。ASCII 输出在 UTF-8 下逐字节一致(零回归)。
 *
 * **例外(Fix B)**:命令把中文 needle 喂给 `find`/`findstr` 时,`chcp 65001` 反而弄坏匹配
 * (见 pipesNonAsciiFindFilter)—— 此时**跳过强制**,返回 outputEncoding:null,让 find 在原生
 * 代码页匹配,输出交由 spawn 侧自动探测(iconv GBK 兜底)解码。
 *
 * 逃生阀 `KHY_WIN_FORCE_UTF8=0/false/off/no` 关闭强制(回落 spawn 侧自动探测)。
 * Git Bash/MSYS 与非 Windows 不处理。env 注入便于单测。
 *
 * @param {{shell:'cmd'|'powershell'|'bash'|'sh'}} shellCfg
 * @param {string} command
 * @param {Record<string,string>} [env=process.env]
 * @returns {{ command: string, outputEncoding: string|null }}
 */
function forceWindowsUtf8(shellCfg, command, env = process.env) {
  if (process.platform !== 'win32') return { command, outputEncoding: null };
  if (!command) return { command, outputEncoding: null };
  const flag = String((env && env.KHY_WIN_FORCE_UTF8) || '').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off' || flag === 'no') {
    return { command, outputEncoding: null };
  }
  if (shellCfg && shellCfg.shell === 'cmd') {
    // Fix B:中文 needle 喂 find/findstr —— 跳过 chcp 强制(否则代码页 65001 弄坏匹配)。
    // 返回 null 让 spawn 侧 iconv 自动探测原生代码页(GBK)解码输出,不乱码。
    if (pipesNonAsciiFindFilter(command)) {
      return { command, outputEncoding: null };
    }
    // `&`(非 `&&`):chcp 先跑、命令后跑,退出码沿用最后一条命令,不改原命令成败语义。
    return { command: `chcp 65001>nul & ${command}`, outputEncoding: 'utf-8' };
  }
  if (shellCfg && shellCfg.shell === 'powershell') {
    return {
      command: `$OutputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;${command}`,
      outputEncoding: 'utf-8',
    };
  }
  return { command, outputEncoding: null };
}

/**
 * PowerShell `Get-ChildItem -Recurse` 无权限子目录的自动跳过修补(Fix C)。
 *
 * 现象:`Get-ChildItem '...\Temp' -Recurse | Measure-Object` 扫到无权限子目录时,
 * Get-ChildItem 报错且 `$?`=false → PowerShell 退出码 1,用户要的「文件计数」这条必要
 * 命令拿不到结果。修补:对带 `-Recurse` 且**未**显式带 `-ErrorAction` 的 GCI(及其 alias
 * gci/ls/dir),在 `-Recurse` 后注入 `-Force -ErrorAction SilentlyContinue` → 跳过无权限项,
 * 计数成功(exit 0)。
 *
 * 因用户常从 cmd 调 `powershell -Command "...-Recurse..."`,本函数对整条命令串做正则,不限活动
 * shell。已带 -ErrorAction / 无 -Recurse / 无 GCI → 原样返回。幂等(重复跑不叠加注入)。
 * 逃生阀 `KHY_WIN_RECURSE_GUARD=0/false/off/no`。
 *
 * @param {string} cmd
 * @param {Record<string,string>} [env=process.env]
 * @returns {{ command: string, patched: boolean }}
 */
function patchPowerShellRecurse(cmd, env = process.env) {
  if (!cmd) return { command: cmd, patched: false };
  const flag = String((env && env.KHY_WIN_RECURSE_GUARD) || '').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off' || flag === 'no') {
    return { command: cmd, patched: false };
  }
  // 必须看起来像 PowerShell 的 Get-ChildItem 调用(gci/ls/dir 是其 alias)。dir/ls 在 cmd/bash
  // 也存在,但只有当同一命令里出现 `-Recurse`(PS 专属拼写)时才命中,故不会误伤 cmd dir。
  if (!/-Recurse\b/i.test(cmd)) return { command: cmd, patched: false };
  if (!/\b(Get-ChildItem|gci|ls|dir)\b/i.test(cmd)) return { command: cmd, patched: false };
  // 已显式声明 -ErrorAction → 尊重用户选择,不动(幂等的一半)。
  if (/-ErrorAction\b/i.test(cmd)) return { command: cmd, patched: false };

  // 仅在 -Force 缺失时补它(PowerShell 对重复同名参数会报错)。-ErrorAction 此处必缺(上面已 return)。
  const injection = /-Force\b/i.test(cmd)
    ? '-ErrorAction SilentlyContinue'
    : '-Force -ErrorAction SilentlyContinue';
  let patched = false;
  const out = cmd.replace(/-Recurse\b/gi, (match) => {
    patched = true;
    return `${match} ${injection}`;
  });
  return { command: out, patched };
}

module.exports = {
  patchWinCommand,
  patchGitBashCommand,
  grepFlagsToFindstr,
  GREP_FLAG_TO_FINDSTR,
  pipesNonAsciiFindFilter,
  forceWindowsUtf8,
  patchPowerShellRecurse,
};
