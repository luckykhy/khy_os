'use strict';

/**
 * Shell exit-code semantics — faithful port of Claude Code's
 * `BashTool/commandSemantics.ts` (`interpretCommandResult`).
 *
 * 背景(对齐 CC 后端逻辑,非显示):很多命令用**非零退出码传递信息而非报错**。
 * 最典型的是 grep/rg:退出码 1 表示「没有匹配」——这是一次**成功**的查询,
 * 不是失败。Khy 旧逻辑(`shellCommand.js` 主路径 `success: result.code === 0`)
 * 把任何非零退出一律判失败,于是:
 *   - `grep pat file` 无匹配(exit 1)  → 被当成命令失败,误导模型以为查询出错
 *   - `diff a b` 有差异(exit 1)        → 被当成失败,实际是「文件不同」
 *   - `test -f x` / `[ ... ]` 为假(exit 1)→ 被当成失败,实际是「条件为假」
 *   - `find` 部分目录不可访问(exit 1)   → 被当成失败,实际是部分成功
 * CC 用 `interpretCommandResult` 按命令语义重判这些退出码。本模块是其等价移植,
 * 让 Khy 的 shell 工具结果分类对齐 CC 的后端真值。
 *
 * 纯叶子:零 IO、确定性、绝不抛、门控。门控 `KHY_SHELL_EXIT_SEMANTICS`(默认开);
 * 关 / 命令不在语义表 / 任何异常 → 逐字节回退旧 `code === 0` 语义(legacy)。
 *
 * @typedef {{ isError: boolean, message: string|undefined, source: 'legacy'|'semantic' }} ExitVerdict
 */

/** 门控关? */
function _gateOff(env) {
  const v = String((env && env.KHY_SHELL_EXIT_SEMANTICS) || '').trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'off' || v === 'no';
}

/**
 * 命令专属语义(忠实复刻 CC COMMAND_SEMANTICS):退出码 → { isError, message }。
 * 仅对这些命令把 exit 1 重判为「非错误的信息性结果」;exit ≥2 仍为真错误。
 */
const _COMMAND_SEMANTICS = {
  // grep: 0=有匹配, 1=无匹配, 2+=错误
  grep: (code) => ({ isError: code >= 2, message: code === 1 ? 'No matches found' : undefined }),
  // ripgrep 与 grep 同语义
  rg: (code) => ({ isError: code >= 2, message: code === 1 ? 'No matches found' : undefined }),
  // find: 0=成功, 1=部分目录不可访问, 2+=错误
  find: (code) => ({ isError: code >= 2, message: code === 1 ? 'Some directories were inaccessible' : undefined }),
  // diff: 0=无差异, 1=有差异, 2+=错误
  diff: (code) => ({ isError: code >= 2, message: code === 1 ? 'Files differ' : undefined }),
  // test / [ : 0=条件真, 1=条件假, 2+=错误
  test: (code) => ({ isError: code >= 2, message: code === 1 ? 'Condition is false' : undefined }),
  '[': (code) => ({ isError: code >= 2, message: code === 1 ? 'Condition is false' : undefined }),
};

/**
 * 从单条命令(无管道/操作符)提取基础命令名:跳过 `FOO=bar` 环境赋值与 `sudo`/`env`
 * 前缀,再对路径取 basename(`/usr/bin/grep` → `grep`)。等价于 shellClassifier
 * 的 getBaseCommand,但内联以保持本叶子零依赖。
 */
function _baseOfSegment(segment) {
  const tokens = String(segment == null ? '' : segment).trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i])) i++;
  while (i < tokens.length && (tokens[i] === 'sudo' || tokens[i] === 'env')) i++;
  if (i >= tokens.length) return '';
  const full = tokens[i];
  const slash = full.lastIndexOf('/');
  return slash >= 0 ? full.slice(slash + 1) : full;
}

/**
 * 启发式提取「决定整体退出码」的命令——管道/逻辑链里的**最后一段**命令决定退出码
 * (如 `cat f | grep x` → grep)。与 CC heuristicallyExtractBaseCommand 同口径。
 * 仅用于结果分类,绝不用于安全判定。
 */
function _heuristicBaseCommand(command) {
  const cmd = String(command == null ? '' : command);
  if (!cmd.trim()) return '';
  // 按 shell 控制操作符切分;JS 交替按顺序匹配,`||`/`&&` 先于 `|`/`&`。
  const segments = cmd.split(/\|\||&&|;|\|&|\||&/g);
  let last = '';
  for (let k = segments.length - 1; k >= 0; k--) {
    if (segments[k] && segments[k].trim()) { last = segments[k]; break; }
  }
  if (!last) last = cmd;
  return _baseOfSegment(last);
}

/**
 * 解释一次 shell 命令的退出码。
 *
 * @param {string} command  - 用户/模型写的原始命令串(用于识别命令语义)
 * @param {number} exitCode - 进程退出码
 * @param {object} [env]    - 环境(默认 process.env),供门控判定
 * @returns {ExitVerdict} 门控关/命令无专属语义 → legacy(`isError: code !== 0`,
 *   message=undefined),与旧 `code === 0` 逐字节等价;命中专属语义 → semantic。
 */
function interpretShellExit(command, exitCode, env) {
  const code = Number.isFinite(exitCode) ? exitCode : 0;
  const legacy = { isError: code !== 0, message: undefined, source: 'legacy' };
  try {
    if (_gateOff(env || (typeof process !== 'undefined' ? process.env : undefined))) return legacy;
    const base = _heuristicBaseCommand(command);
    const sem = base && Object.prototype.hasOwnProperty.call(_COMMAND_SEMANTICS, base)
      ? _COMMAND_SEMANTICS[base]
      : null;
    if (!sem) return legacy; // 默认语义 == legacy(只 0 成功)
    const r = sem(code);
    if (!r || typeof r.isError !== 'boolean') return legacy;
    return { isError: r.isError, message: typeof r.message === 'string' ? r.message : undefined, source: 'semantic' };
  } catch {
    return legacy;
  }
}

module.exports = {
  interpretShellExit,
  // 导出内部助手供确定性单测
  _heuristicBaseCommand,
  _baseOfSegment,
};
