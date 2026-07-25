'use strict';

/**
 * shellEscapeContext.js —— `!` shell 转义输出的上下文格式化(纯叶子)。
 *
 * 承接 CC 参考包 `src/components/shell/ExpandShellOutputContext.tsx` 背后的
 * **后端语义**:「自动展开最近一条用户 `!` 命令输出(完整显示,不截断)」。
 *
 * khy 既有 formatShellEscapeContext 在总长超预算时对**拼接后的整串**从头
 * slice —— 这恰好先切掉**最新**一条(它排在拼接串末尾),与 CC 意图相反。
 * 本叶子改为**最近优先预算**:最新一条始终完整保留;较早的命令输出按剩余
 * 预算从新到旧纳入,放不下的整条省略并计数标注。渲染仍按时间顺序(旧→新)
 * 以便阅读。
 *
 * 纯叶子:零 IO、确定性、绝不抛。门控 KHY_SHELL_ESCAPE_EXPAND_RECENT 默认开;
 * 关闭 → 返回 undefined,调用方回退到既有 slice 行为(逐字节等价)。
 */

const TAG_OPEN = '<shell-escape-output>';
const TAG_CLOSE = '</shell-escape-output>';
const SEP = '\n\n';
const TRUNC_MARK = '\n…(shell 输出已截断)';

function shellEscapeExpandRecentEnabled(env = process.env) {
  const raw = env && env.KHY_SHELL_ESCAPE_EXPAND_RECENT;
  if (raw == null) return true;
  const v = String(raw).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

function _renderBlock(r) {
  const body = r && r.body != null ? String(r.body) : '(无输出)';
  const code = r && Number.isFinite(r.code) ? r.code : 0;
  return `$ ${r.command}\n${body}\n(exit ${code})`;
}

function _wrap(inner) {
  return `${TAG_OPEN}\n${inner}\n${TAG_CLOSE}`;
}

function _omitMarker(k) {
  return `…(省略 ${k} 条较早 shell 输出)`;
}

/**
 * 以「最近优先」预算格式化 `!` 转义输出块。
 *
 * @param {Array<{command:string, body?:string, code?:number}>} records 时间顺序(旧→新)。
 * @param {number} [maxLen=8000] 总字符预算。
 * @param {object} [env]
 * @returns {undefined | string}
 *   门控关 → undefined(调用方回退);无有效记录 → '';否则 `<shell-escape-output>` 块。
 */
function formatShellEscapeContextExpanded(records, maxLen = 8000, env = process.env) {
  if (!shellEscapeExpandRecentEnabled(env)) return undefined;

  const cap = Number.isFinite(Number(maxLen)) && Number(maxLen) > 0 ? Math.floor(Number(maxLen)) : 8000;
  const valid = (Array.isArray(records) ? records : []).filter((r) => r && r.command);
  if (valid.length === 0) return '';

  const blocks = valid.map(_renderBlock); // 时间顺序
  const n = blocks.length;
  const newest = blocks[n - 1];

  // 最新一条自身即超预算 → 截断它(仍尽量保留),较早的全部省略并计数。
  if (newest.length > cap) {
    const truncated = newest.slice(0, Math.max(0, cap)) + TRUNC_MARK;
    const parts = [];
    if (n > 1) parts.push(_omitMarker(n - 1));
    parts.push(truncated);
    return _wrap(parts.join(SEP));
  }

  // 最新一条完整保留;较早的从新到旧按剩余预算整条纳入,放不下即停。
  let used = newest.length;
  const keptOlder = [];
  for (let i = n - 2; i >= 0; i--) {
    const add = SEP.length + blocks[i].length;
    if (used + add <= cap) {
      used += add;
      keptOlder.push(i);
    } else {
      break;
    }
  }

  const omitted = (n - 1) - keptOlder.length;
  keptOlder.sort((a, b) => a - b); // 恢复时间顺序

  const parts = [];
  if (omitted > 0) parts.push(_omitMarker(omitted));
  for (const i of keptOlder) parts.push(blocks[i]);
  parts.push(newest);
  return _wrap(parts.join(SEP));
}

module.exports = {
  shellEscapeExpandRecentEnabled,
  formatShellEscapeContextExpanded,
};
