'use strict';

/**
 * shellEmptyOutputNote.js — 纯叶子:命令**成功但零输出**时的确定性说明。
 *
 * 背景(goal 截图 Image #4):`jest ... 2>&1 | grep -iE "Tests:|PASS|FAIL" | head`
 * 这类「过滤器/分页器收尾」的管道,整体退出码由**末段** head 决定(exit 0 = 成功),
 * 但 stdout 可能被 grep 过滤空 / head 从空流读到空 → 合并输出为空串。旧行为把空串
 * 原样交给前端,渲染成裸「(无输出)」/「(No output)」——既不说明「命令确实成功了」,
 * 也不说明「为什么没有输出」,用户误以为命令坏了(截图正是此困惑)。本叶子在
 * **成功 + 零输出**时产出一行确定性说明(命令成功;若末段是 head/grep/tail 等过滤器,
 * 很可能上游没有产出可匹配/可显示的行),落到 output 消除困惑。
 *
 * 与失败路径的 `shellDiagnostics.diagnoseEmptyFailure` **对称**:那条治「非零退出 +
 * 空输出」,本叶子治「零退出(成功)+ 空输出」,两者合起来保证 shell 结果**永不**
 * 塌缩成一个没有任何解释的空串。
 *
 * 契约(纯叶子):零 IO、确定性、绝不抛、门控。逃生阀 `KHY_SHELL_EMPTY_OUTPUT_NOTE`
 * (默认 on)。关闭 / 任何异常 → 返回 `null`,调用方据此保持空串**逐字节回退**。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no', 'disable', 'disabled']);

/** 门控:仅显式关闭词关闭,其余(含未设)均开启。 */
function emptyOutputNoteEnabled(env) {
  const v = (env || (typeof process !== 'undefined' ? process.env : undefined) || {}).KHY_SHELL_EMPTY_OUTPUT_NOTE;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

// 「过滤器/分页器」末段命令:这些命令的空输出**通常不是错误**,而是「上游没有可显示的行」。
// head/tail:分页器,从空流读到空;grep/rg/findstr:过滤器,无匹配即空;wc:计数(极少空);
// sort/uniq/cut/sed/awk/tr:流处理器,输入空则输出空;column/less/cat:透传空即空。
const _FILTER_TAILS = new Set([
  'head', 'tail', 'grep', 'rg', 'egrep', 'fgrep', 'findstr',
  'sort', 'uniq', 'cut', 'sed', 'awk', 'tr', 'wc', 'column', 'less', 'cat', 'xargs',
]);

// 「列举/枚举」命令:列目录 / 找文件的命令,空输出**常意味着路径不存在或无匹配项**,
// 而不是「已扫描完毕、目标为空」。会话现场坑:`powershell -Command "Get-ChildItem -Path
// 'D:\不存在'"` 退出码 0 且空输出,模型误当作「扫过了、没重复文件」——实为路径解析为空。
// PowerShell cmdlet(Get-ChildItem/Get-Item/gci)无歧义,整串匹配;dir/ls/find/tree 较短,
// 仅在「命令位置」(串首 / 引号后 / 管道后 / -Command|-c 之后)匹配,避免撞路径里的 dir 子串。
const _ENUM_CMDLET_RE = /Get-ChildItem|Get-Item|\bgci\b/i;
const _ENUM_CMD_POS_RE = /(?:^|["'`|;&(]|-Command\s+["']|-c\s+["'])\s*(?:dir|ls|find|tree)\b/i;

/** 命令是否是一次「列举/枚举」(列目录 / 找文件)。纯字符串形态判断。 */
function _looksLikeEnumeration(command) {
  const c = String(command == null ? '' : command);
  return _ENUM_CMDLET_RE.test(c) || _ENUM_CMD_POS_RE.test(c);
}

/**
 * 从单段命令(无管道/操作符)提取基础命令名:跳过 `FOO=bar` 环境赋值与 `sudo`/`env`
 * 前缀,再对路径取 basename(`/usr/bin/head` → `head`)。剥 RTK 前缀(`rtk head` → `head`)。
 * 内联以保持本叶子零依赖(与 shellExitSemantics._baseOfSegment 同口径)。
 */
function _baseOfSegment(segment) {
  const tokens = String(segment == null ? '' : segment).trim().split(/\s+/);
  let i = 0;
  if (i < tokens.length && tokens[i] === 'rtk') i++;           // 剥 RTK 省 token 前缀
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i])) i++;
  while (i < tokens.length && (tokens[i] === 'sudo' || tokens[i] === 'env')) i++;
  if (i >= tokens.length) return '';
  const full = tokens[i];
  const slash = full.lastIndexOf('/');
  return slash >= 0 ? full.slice(slash + 1) : full;
}

/**
 * 决定整体退出码/输出的「末段」命令(管道/逻辑链的最后一段)。
 * `cat f | grep x | head` → `head`。仅用于说明措辞,绝不用于安全判定。
 */
function _tailBaseCommand(command) {
  const cmd = String(command == null ? '' : command);
  if (!cmd.trim()) return '';
  const segments = cmd.split(/\|\||&&|;|\|&|\||&/g);
  let last = '';
  for (let k = segments.length - 1; k >= 0; k--) {
    if (segments[k] && segments[k].trim()) { last = segments[k]; break; }
  }
  if (!last) last = cmd;
  return _baseOfSegment(last);
}

/**
 * 命令成功(退出码 0)但输出为空时的确定性说明。
 *
 * 末段是过滤器/分页器(head/grep/tail/...) → 指出「很可能上游无匹配/无可显示的行」;
 * 否则 → 通用「命令成功,但没有产生任何输出」。始终**单行、非空**、以「✓」起头以示成功。
 *
 * @param {string} command 原始命令串(用于末段形态推断)
 * @param {object} [env]   注入 env(测试用);缺省取 process.env
 * @returns {string|null}  门控关 / 异常 → null(调用方保持空串逐字节回退)
 */
function buildEmptyOutputNote(command, env) {
  try {
    if (!emptyOutputNoteEnabled(env)) return null;
    const tail = _tailBaseCommand(command);
    if (tail && _FILTER_TAILS.has(tail)) {
      return `✓ 命令执行成功(退出码 0),但没有输出。末段是过滤器/分页器 \`${tail}\`,`
        + '很可能是上游没有产出可匹配/可显示的行(例如 grep 未匹配,或流本身为空);'
        + '这通常不是错误。若需要确认每一步的结果,可用 `<命令> && echo "=== <标签> OK ==="` '
        + '为每步追加确定性的成功标记,避免整条管道悄无声息。';
    }
    // 列举/枚举命令零输出:最常见原因是**路径不存在或未匹配**,而非「已扫描、目标为空」。
    // 先让模型核实路径存在,再据此判断,避免把「路径写错/解析为空」误当作「扫过没结果」。
    if (_looksLikeEnumeration(command)) {
      return '✓ 命令执行成功(退出码 0),但没有列出任何条目。列举/枚举命令的空结果**最常见的原因'
        + '是目标路径不存在或写错**(而非「已扫描完毕、目标为空」)——退出码 0 只表示命令本身没报错。'
        + '请先核实路径确实存在(如 `Test-Path <路径>` / `ls -d <路径>`)再下结论;'
        + '路径含空格/中文时确认引号与盘符正确。';
    }
    return '✓ 命令执行成功(退出码 0),但没有产生任何输出(stdout/stderr 均为空)。';
  } catch {
    return null;
  }
}

module.exports = {
  emptyOutputNoteEnabled,
  buildEmptyOutputNote,
  // 暴露内部助手供确定性单测
  _tailBaseCommand,
  _baseOfSegment,
  _FILTER_TAILS,
  _looksLikeEnumeration,
};
