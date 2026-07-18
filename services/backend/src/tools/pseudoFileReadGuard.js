'use strict';

/**
 * 读取工具的「伪文件系统阻塞文件（/proc · /sys）」有界读编排器 —— 判定纯函数 + 有界子进程读 · 绝不抛。
 *
 * ── 补的缺口：按「文件位置」拦下会永久阻塞的**常规**伪文件（第四条卡死向量）─────
 * `tools/readFile.js` 的三条既有卡死守卫按「文件的某个属性」拦：
 *   - OPS-121 readBinaryGuard：按**二进制内容**拒绝；
 *   - OPS-123 readFileFormatRouter：按**格式**路由到有界提取器；
 *   - OPS-125 specialFileReadGuard：按**文件类型**（FIFO/套接字/字符或块设备）拦。
 * 但 Linux 伪文件系统 `/proc` · `/sys` 下的条目是**常规文件**（`stat.isFile()===true`）、
 * `stat.size===0`、内容在读时现生成——其中一部分（`/proc/kmsg`、某些 `/sys` poll 属性等）
 * **读第一个字节就永久阻塞**。它们：
 *   - 是常规文件 → 溜过 OPS-125 的类型谓词（isFIFO/isSocket… 全 false）；
 *   - size===0 → 溜过 OPS-121 之后的「超限」检查（0 > maxBytes 恒 false）；
 *   - 多非二进制 → detectFile 会去**读 magic 字节**，恰在此处对阻塞伪文件卡死。
 * 已实测：`/proc/cpuinfo` 就是 size=0 的常规文件，isFIFO/isSocket/isCharDev/isBlockDev 全 false。
 *
 * ── 修法（承 OPS-123 教训「路由到有界读，别一律拒绝」）───────────────────────
 * 关键架构点：**同步阻塞读无法在进程内超时**（`fs.readFileSync` 卡住会锁死事件循环，
 * 进程内 Promise.race 定时器永不触发——这是 OPS-125 的血泪）。但把阻塞读**搬进子进程**
 * 就能被 `spawnSync` 的 `timeout` 选项杀掉：子进程 `head -c <maxBytes> <path>` 阻塞在
 * read() 上 → 到点收 SIGTERM 而死，父进程在 timeout 处返回。**有限伪文件**（cpuinfo）
 * 秒回内容；**阻塞伪文件**（kmsg）到点被杀 → 有界返回、绝不无限挂起。
 *
 * 于是本叶不「拒绝伪文件」而是「用有界子进程读伪文件」：
 *   - 有内容 → 返回可读文本（截断标注），保住 `/proc/cpuinfo` 之类的可用读取；
 *   - 到点仍阻塞 → 返回信息性拒绝（点明该伪文件会阻塞，已在 <N>ms 处杀掉），绝不卡死。
 *
 * ── 保守边界（零误伤常规文件）──────────────────────────────────────────────
 * 仅当**全部**成立才接管：门开 + 平台是 linux + `stat.isFile()` + `stat.size===0` +
 * 路径落在 `/proc/` 或 `/sys/` 挂载下。普通工程文件永不落在 `/proc`·`/sys`，非 Linux
 * 平台这两处挂载不存在 → 本叶天然旁路，零误伤。
 * 门控 `KHY_READFILE_PSEUDO_GUARD`（默认开；env ∈ {0,false,off,no} 归一后关）：关 →
 * readFile 逐字节回退历史行为（对阻塞伪文件照旧走 detectFile/解码 → 卡死），本防护旁路。
 *
 * 本叶纯判定 + 有界子进程读；`spawnSync` 经 deps 注入（DI 默认真实），故可桩测不 spawn。
 */

const { spawnSync: _realSpawnSync } = require('child_process');

const OFF_VALUES = ['0', 'false', 'off', 'no'];
const PSEUDO_GUARD_FLAG = 'KHY_READFILE_PSEUDO_GUARD';
const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_MAX_BYTES = 512 * 1024;

function _isOff(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return OFF_VALUES.includes(v);
}

/**
 * 门控 KHY_READFILE_PSEUDO_GUARD（默认开）。异常/非法 → 保守视为开（default-on）。
 * @param {object} [env=process.env]
 * @returns {boolean}
 */
function pseudoReadGuardEnabled(env = process.env) {
  try {
    return !_isOff(env && env[PSEUDO_GUARD_FLAG]);
  } catch {
    return true;
  }
}

/**
 * 判定绝对路径是否落在 Linux 伪文件系统挂载（/proc · /sys）下。
 * 精确匹配：路径必须是 `/proc`、`/proc/...`、`/sys`、`/sys/...` 之一——工程目录里名为
 * `proc`/`sys` 的子目录（如 `/home/x/proc/foo`）**不**匹配。非 Linux 平台恒返回 null。
 * @param {string} absPath  已 path.resolve 的绝对路径
 * @param {string} [platform=process.platform]
 * @returns {('proc'|'sys'|null)}
 */
function isPseudoFsPath(absPath, platform = process.platform) {
  try {
    if (platform !== 'linux') return null;
    if (typeof absPath !== 'string' || !absPath) return null;
    for (const root of ['proc', 'sys']) {
      const base = `/${root}`;
      if (absPath === base || absPath.startsWith(`${base}/`)) return root;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 综合判定「是否应改走有界伪文件读」。全部成立才返回 kind，否则 null（放行历史路径）。
 * 条件：门开 + linux + stat 是常规文件 + stat.size===0 + 路径在 /proc|/sys 下。
 * 绝不抛（stat 缺失/谓词非函数/畸形 → null）。
 * @param {object} args {absPath, stat, env, platform}
 * @returns {('proc'|'sys'|null)}
 */
function shouldBoundedRead(args) {
  try {
    const a = args && typeof args === 'object' ? args : {};
    const env = a.env || process.env;
    const platform = a.platform || process.platform;
    if (!pseudoReadGuardEnabled(env)) return null;
    const stat = a.stat;
    if (!stat || typeof stat !== 'object') return null;
    // 仅接管常规文件；FIFO/套接字/设备由 OPS-125 处理，目录由 readFile 特判。
    if (typeof stat.isFile !== 'function' || stat.isFile() !== true) return null;
    // 伪文件签名：size===0（内容读时现生成，size 无意义）。非 0 → 放行历史路径。
    if (Number(stat.size) !== 0) return null;
    return isPseudoFsPath(a.absPath, platform);
  } catch {
    return null;
  }
}

/**
 * 构造有界读子进程命令（纯函数）。`head -c <maxBytes> <path>`：有限文件返回全部并退出 0；
 * 阻塞文件卡在 read 上，由 spawnSync 的 timeout 杀掉。
 * @param {string} absPath
 * @param {number} maxBytes
 * @returns {{cmd:string, args:string[]}}
 */
function buildBoundedReadArgs(absPath, maxBytes) {
  const n = Number(maxBytes);
  const cap = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_BYTES;
  return { cmd: 'head', args: ['-c', String(cap), String(absPath)] };
}

const _KIND_LABEL = Object.freeze({ proc: '/proc 伪文件', sys: '/sys 伪文件' });

/**
 * 构造「伪文件读超时」的信息性拒绝消息（纯字符串 · 绝不抛）。
 * 点明该伪文件读取会阻塞、已在 <N>ms 处杀掉子进程、给逃生门。
 * @param {object} info {path, kind, timeoutMs}
 * @returns {string}
 */
function buildPseudoTimeoutMessage(info) {
  let i = info;
  try {
    if (!i || typeof i !== 'object') i = {};
    const label = _KIND_LABEL[i.kind] || '伪文件';
    const shown = i.path == null ? '' : String(i.path);
    const tail = shown ? `：${shown}` : '';
    const ms = Number(i.timeoutMs);
    const msNote = Number.isFinite(ms) && ms > 0 ? `${ms}ms` : '超时';
    return (
      `拒绝读取：这是会阻塞的${label}${tail}。读取它会永久等待（内核按需产出/无尽输入），` +
      `已在 ${msNote} 处杀掉有界读子进程以避免进程卡死。` +
      `\n若你想要的是该路径背后的实时数据，请改用带超时的定向 shell 命令（如 \`timeout 2 cat ${shown || '<path>'}\`），` +
      `不要用文件读取工具整读。` +
      `\n如确需强制整读（可能导致卡死），设 ${PSEUDO_GUARD_FLAG}=0 后重试。`
    );
  } catch {
    return `拒绝读取：目标疑为会阻塞的伪文件（/proc·/sys），已按超时杀掉有界读以避免卡死。如确需强读设 ${PSEUDO_GUARD_FLAG}=0。`;
  }
}

/**
 * 有界读取伪文件：把阻塞读搬进子进程，用 spawnSync 的 timeout 保底杀掉。
 *   - 子进程退出 0 且有输出 → { handled:true, result:{success:true, content, ...} }；
 *   - 超时/被信号杀 → { handled:true, result:{success:false, error:超时消息, pseudoFile, timedOut:true} }；
 *   - spawn 出错/其它异常 → { handled:false }（调用方回退历史读取路径）。
 * 整体 try/catch，绝不抛。真正的 spawnSync 经 deps 注入（默认真实），故可桩测。
 * @param {object} params {filePath, kind, maxBytes, timeoutMs, env, deps}
 * @returns {{handled:boolean, result?:object}}
 */
function readPseudoFileBounded(params) {
  try {
    const p = params && typeof params === 'object' ? params : {};
    const filePath = p.filePath;
    const kind = p.kind === 'sys' ? 'sys' : 'proc';
    const maxBytes = Number.isFinite(Number(p.maxBytes)) && Number(p.maxBytes) > 0
      ? Math.floor(Number(p.maxBytes)) : DEFAULT_MAX_BYTES;
    const timeoutMs = Number.isFinite(Number(p.timeoutMs)) && Number(p.timeoutMs) > 0
      ? Math.floor(Number(p.timeoutMs)) : DEFAULT_TIMEOUT_MS;
    if (typeof filePath !== 'string' || !filePath) return { handled: false };

    const spawnSync = (p.deps && typeof p.deps.spawnSync === 'function')
      ? p.deps.spawnSync : _realSpawnSync;
    const { cmd, args } = buildBoundedReadArgs(filePath, maxBytes);

    let res;
    try {
      res = spawnSync(cmd, args, {
        timeout: timeoutMs,
        maxBuffer: maxBytes + 4096,
        windowsHide: true,
      });
    } catch {
      return { handled: false };
    }
    if (!res || typeof res !== 'object') return { handled: false };

    // 超时被杀：spawnSync 置 error.code==='ETIMEDOUT' 或 signal==='SIGTERM'。
    const timedOut = (res.error && res.error.code === 'ETIMEDOUT')
      || res.signal === 'SIGTERM' || res.signal === 'SIGKILL';
    if (timedOut) {
      return {
        handled: true,
        result: {
          success: false,
          error: buildPseudoTimeoutMessage({ path: filePath, kind, timeoutMs }),
          pseudoFile: kind,
          timedOut: true,
        },
      };
    }
    // 其它 spawn 错误（如 head 不存在 ENOENT）→ 回退历史路径，别误报。
    if (res.error) return { handled: false };
    if (res.status !== 0) return { handled: false };

    const buf = res.stdout;
    const bytes = buf ? buf.length : 0;
    const text = buf ? buf.toString('utf8') : '';
    const truncated = bytes >= maxBytes;
    const label = _KIND_LABEL[kind] || '伪文件';
    const trunNote = truncated ? `（已截断至前 ${maxBytes} 字节）` : '';
    return {
      handled: true,
      result: {
        success: true,
        content: `【${label} · 有界读${trunNote}】\n${text}`,
        format: `pseudo-fs-${kind}`,
        extractedBy: 'bounded-read',
        size: bytes,
        truncated,
      },
    };
  } catch {
    return { handled: false };
  }
}

module.exports = {
  PSEUDO_GUARD_FLAG,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  pseudoReadGuardEnabled,
  isPseudoFsPath,
  shouldBoundedRead,
  buildBoundedReadArgs,
  buildPseudoTimeoutMessage,
  readPseudoFileBounded,
  _KIND_LABEL,
};
