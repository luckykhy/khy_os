'use strict';

/**
 * ccOutputTruncate — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 「对齐 Claude Code 不只是显示对齐,更要让 CC 前端显示背后的**后端逻辑**对齐。」
 * 工具(build / test / lint)的原始输出过长时必须裁剪后再喂模型 / 落进 `outputTail`。
 * Khy 历史一律 **pure-head 截断**——`output.slice(0, maxCaptureBytes) + '\n... [truncated]'`——
 * 只留**开头**丢弃结尾。但 build / test / lint 的**结论恰在结尾**:
 *   - jest/vitest 的机读 JSON 摘要(`{"numFailedTests":…}`)与 `Tests: N failed, M passed` 汇总行在 **stdout 末尾**;
 *   - linker / 编译器的「N errors generated」汇总、测试 runner 的失败清单常在末尾。
 * pure-head 截断会**静默丢掉结论**,更糟的是这些工具的 `outputTail` 是从**已被 head 截断后的串**再
 * `split('\n').slice(-N)` 取的 → 取到的是「截断点附近」而非真正的结尾 → `outputTail` **也救不回结论**,
 * 且 `_parseJestJson` 在被丢弃了尾部 JSON 的串上解析失败 → 回退泛化解析 → pass/fail 计数可能失真。
 *
 * CC `src/utils/toolErrors.ts` `formatError` 的关键后端逻辑(逐字节移植):超过阈值时保留
 * **头一半 + 尾一半**,中间插 `\n\n... [${N} characters truncated] ...\n\n` 标记 —— 这样无论
 * 失败信息在头还是尾都被保住(`halfLength = limit/2`,`start = slice(0, half)`、`end = slice(-half)`)。
 *
 * 门控:KHY_CC_OUTPUT_TRUNCATE(默认开)。=0/false/off/no → 关 → `capOutput` **逐字节回退**
 * 历史 pure-head 串 `slice(0, limit) + '\n... [truncated]'`(与各 call-site 旧行为完全一致)。
 */

function ccOutputTruncateEnabled(env = process.env) {
  const flag = String((env && env.KHY_CC_OUTPUT_TRUNCATE) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

// 各 call-site 历史 pure-head 截断追加的标记(逐字节回退须保持完全一致)。
const LEGACY_HEAD_MARKER = '\n... [truncated]';

/**
 * CC `toolErrors.formatError` 的头尾保留中段裁剪(纯):
 *   text.length <= limit → 原样;否则保留 floor(limit/2) 头 + floor(limit/2) 尾,
 *   中间插 `\n\n... [${omitted} characters truncated] ...\n\n`(omitted = text.length - 2*half)。
 * 与 CC 一致:limit=10000 时 half=5000、start=slice(0,5000)、end=slice(-5000)。
 * @param {string} text
 * @param {number} limit  保留预算(总字符数,约等于历史 maxCaptureBytes)。
 * @returns {string}
 */
function ccMiddleTruncate(text, limit) {
  if (typeof text !== 'string') return text;
  if (!Number.isFinite(limit) || limit <= 0) return text;
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  if (half <= 0) return text.slice(0, limit); // 退化极小 limit:不可能两端,退头截
  const start = text.slice(0, half);
  const end = text.slice(-half);
  const omitted = text.length - half * 2;
  return `${start}\n\n... [${omitted} characters truncated] ...\n\n${end}`;
}

/**
 * 门控包装:工具输出裁剪的单一入口。
 *   - text 非串 / limit 非正 → 原样(防呆,绝不抛);
 *   - text.length <= limit → 原样(无裁剪,与历史「不超不动」一致);
 *   - 门控关 → **逐字节回退** `text.slice(0, limit) + '\n... [truncated]'`(历史 pure-head);
 *   - 门控开 → CC 头尾保留中段裁剪 `ccMiddleTruncate`。
 * @param {string} text
 * @param {number} limit
 * @param {object} [env]
 * @returns {string}
 */
function capOutput(text, limit, env) {
  if (typeof text !== 'string') return text;
  if (!Number.isFinite(limit) || limit <= 0) return text;
  if (text.length <= limit) return text;
  if (!ccOutputTruncateEnabled(env)) {
    return text.slice(0, limit) + LEGACY_HEAD_MARKER;
  }
  return ccMiddleTruncate(text, limit);
}

module.exports = {
  ccOutputTruncateEnabled,
  ccMiddleTruncate,
  capOutput,
  LEGACY_HEAD_MARKER,
};
