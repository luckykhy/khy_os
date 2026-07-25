'use strict';

/**
 * salvageSummaryFocus.js — 纯叶子(零 IO · 确定性 · 绝不抛 · 可单测)。
 *
 * 承 Goal(Thread 4)「学 CC 显示但**更重背后逻辑**」+「其他功能逐项对齐」。
 * 与 刀83 `/compact <instructions>` 同族(live substrate 半接线):后端的
 * query-focus 归纳能力**已完整端到端接线**,但唯一 call-site 从不喂它。
 *
 * 真缺口(核实链路 toolUseLoop.js:612 → toolDataSummary → localNlp):
 * 弱模型/无模型跑完工具却不产收尾文本时,khy 用确定性抽取式归纳
 * `_salvageToolResults` 兜底(把工具原文归纳成结论领头)。其归纳器
 * `toolDataSummary.summarizeToolData(toolCallLog, opts)` **早已接受 opts.query**:
 *   toolDataSummary.js:161 summarizeToolData(log, opts={}) → :180 summarizeToolOutput(text, opts)
 *   → :143 nlp.summarize(body, { query: opts.query || '', … })
 *   → localNlp.js:217 queryTerms = opts.query ? tokenize(opts.query) …
 *   → localNlp.js:233 qFrac + :243 **排序主键就是 qFrac**(命中用户提问的句子排最前)。
 * 即「按用户实际问的问题给相关句子加权」这条 substrate 完整,但
 * `_salvageToolResults(toolCallLog)` 既不接收 userMessage 也不传 `{query}`
 * (toolUseLoop.js:612 `summarizeToolData(toolCallLog)` 裸调)→ 兜底归纳**永远无焦点**,
 * 只按句子位置/词频排 top-3,不优先用户真正问的那句。而 `originalUserMessage`
 * 就在两个 call-site(:2627/:2785 属 runToolUseLoop·:1164 捕获)作用域内,唾手可得。
 *
 * 本叶子把「userMessage + env → 传给 summarizeToolData 的 opts」这段纯决策抽出单测:
 * 门控开且有非空消息 → `{ query: <归一文本> }`;门控关 / 空消息 → `{}`
 * (与今日 `summarizeToolData(toolCallLog)` 逐字节一致,因其默认 opts={})。
 *
 * 门控 KHY_SALVAGE_QUERY_FOCUS(默认开;{0,false,off,no} 关)。关 →
 * `buildSalvageSummaryOpts` 恒返 `{}`,逐字节回退今日无焦点归纳。
 *
 * 诚实边界(刻意):① 只把 focus 接进已有的 localNlp 相关性加权·**不**改归纳算法本身
 * (maxSentences/maxChars 等仍由 toolDataSummary 定)。② query 仅空白归一 + 截断上限
 * (localNlp 把 query tokenize 成 Set·超长消息只是更多词项无害·截断防病态输入)·
 * 不做停用词/分词(交 localNlp.tokenize 单一真源)。③ 空/纯空白消息 → `{}`(无焦点优于
 * 空焦点·byte-identical)。④ 门控关 / 消息缺失 → `{}` 逐字节回退。
 */

const _OFF = ['0', 'false', 'off', 'no'];
const _QUERY_CAP = 500;

/**
 * 是否把用户提问作为 focus 传给兜底归纳器。默认开(unset → 开)。
 * @param {object} [env]
 * @returns {boolean}
 */
function salvageQueryFocusEnabled(env = process.env) {
  const raw = env && env.KHY_SALVAGE_QUERY_FOCUS;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !_OFF.includes(v);
}

/**
 * 归一用户提问为 focus query(空白折叠 + 去空 + 截断上限)。绝不抛。
 * @param {*} userMessage
 * @returns {string}  空/畸形 → ''
 */
function normalizeFocusQuery(userMessage) {
  if (userMessage == null) return '';
  let s = String(userMessage).replace(/\s+/g, ' ').trim();
  if (s.length > _QUERY_CAP) s = s.slice(0, _QUERY_CAP);
  return s;
}

/**
 * 构造传给 summarizeToolData 的 opts。
 *   门控关 / 空消息 → `{}`(逐字节回退今日无焦点归纳)
 *   门控开 + 非空消息 → `{ query: <归一文本> }`
 * @param {*} userMessage
 * @param {object} [env]
 * @returns {{query?:string}}
 */
function buildSalvageSummaryOpts(userMessage, env = process.env) {
  if (!salvageQueryFocusEnabled(env)) return {};
  const query = normalizeFocusQuery(userMessage);
  if (!query) return {};
  return { query };
}

module.exports = {
  salvageQueryFocusEnabled,
  normalizeFocusQuery,
  buildSalvageSummaryOpts,
};
