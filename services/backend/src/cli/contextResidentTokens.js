'use strict';

// 对齐 CC「后端逻辑也对齐」:上下文窗口**占用率**喂入值的口径 —— 纯叶子
// (零 IO、零业务 require、确定性,仅读 process.env 做门控)。
//
// CC 唯一真源 `src/utils/context.ts::calculateContextPercentages`:
//   const totalInputTokens =
//     currentUsage.input_tokens +
//     currentUsage.cache_creation_input_tokens +
//     currentUsage.cache_read_input_tokens
//   const usedPercentage = Math.round((totalInputTokens / contextWindowSize) * 100)
// 即占用率分子是**三段都算**:未缓存输入 + 本轮写缓存 + 命中读缓存。CC 的判据正确
// —— 命中的缓存 token 仍**占据**上下文窗口,只是计费更便宜;它们没从窗口里消失。
//
// khy 历史缺口=两处 `setContextUsage` 调用(`cli/ai.js`、`cli/repl.js`)只喂
// **未缓存的** `tokenUsage.inputTokens` 一段,把 `cacheReadInputTokens` /
// `cacheWriteInputTokens` 整段丢弃(repl.js 那处注释还写死了错误心智模型
// 「actual tokens sent as context」)。在开了 prompt cache 的 Claude-Direct 链路上,
// 一轮缓存命中的 turn 可能 `inputTokens:1.2k` 但 `cacheReadInputTokens:78k`,占用率
// 被低估一个数量级 → HUD 上下文条整段会话停在近空绿、`/context` 面板显 1%、且喂同
// 一个 `contextWindow.used` 的自动压缩告警(`contextWarning`)几乎永不触发。这三段
// 数据 khy 早已在同一 `tokenUsage` 对象上携带(`claudeAdapter.js` 等把
// `cache_read_input_tokens`/`cache_creation_input_tokens` 经 `_cacheUsage.js` 规范成
// `cacheReadInputTokens`/`cacheWriteInputTokens`),只是从未加回占用值 —— 故这是**真
// 缺口**(数据在手只是漏算),不是臆造不携带的数据。
//
// 采用 `*Or(value, legacy, env)` 形状(镜像 agentStatLine / ccFormat 既有约定):
// 门控开 → `legacyBase + 读缓存 + 写缓存`(对齐 CC 三段和);门控关 → 原样返回
// call-site 传入的 `legacyBase`,**逐字节回退**到各 call-site 历史口径(ai.js 传
// `tokenUsage.inputTokens`、repl.js 传 `inputTokens || promptTokens || 0`,各自历史
// 不同故由 call-site 传 base 而非叶子内写死,保证字节回退绝不串味)。三段在 Anthropic
// usage 对象里互不相交(未缓存输入 / 写缓存 / 读缓存 是 disjoint 桶,khy
// `state.totalInputTokens += input_tokens` 只累未缓存段亦佐证),相加不会重复计数。

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 门控:默认开;值为 0/false/off/no(大小写不敏感、去空白)→ 关,逐字节回退。
function isEnabled(env) {
  const raw = env && env.KHY_CONTEXT_CACHE_TOKENS;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

// NaN / 非有限 / 负 → 0(防御;token 计数永不为负)。与 _cacheUsage.js 同口径。
// 有限数强转家族单一真源 utils/finiteNumber(见 finiteNumber.js)。
const _num = require('../utils/finiteNumber').toNonNegOr0;

// 上下文占用喂入值:门控开 → legacyBase + 读缓存 + 写缓存(对齐 CC totalInputTokens
// 三段和);门控关或 tokenUsage 不含缓存段 → legacyBase(逐字节回退)。legacyBase
// 由 call-site 传入(其历史已解析的未缓存输入基数),叶子只负责把缓存两段加回去。
function contextResidentTokensOr(tokenUsage, legacyBase, env = process.env) {
  const base = _num(legacyBase);
  if (!isEnabled(env)) return base;
  const read = _num(tokenUsage && tokenUsage.cacheReadInputTokens);
  const write = _num(tokenUsage && tokenUsage.cacheWriteInputTokens);
  return base + read + write;
}

module.exports = {
  isEnabled,
  contextResidentTokensOr,
};
