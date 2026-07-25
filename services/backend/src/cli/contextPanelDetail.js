'use strict';

/**
 * contextPanelDetail.js — 纯叶子(零 IO · 确定性 · 绝不抛 · 可单测)。
 *
 * 承 Goal(Thread 4)「学 CC 显示但**更重背后逻辑**」+「TUI 缺少的显示多学 CC」。
 * 与 刀85 /compact result、刀79 rewind diff-stat 同族(computed-but-never-shown:
 * 后端已算出富信息,呈现层只取其一丢弃其余)。
 *
 * 真缺口:`/context` 走 computeContextStats(services/context/ctxWindowStats.js)算出
 * `{ used, limit, limitSource, remaining, percentUsed, status,
 *    sessionInput, sessionOutput, sessionTotal, requestCount, model }`,其中
 * requestCount / limitSource / model 三字段的 JSDoc 均标「透传展示」,且 limitSource
 * 的文档(ctxWindowStats:10)明写「诚实标注上限来源(adapter 真值 / env 回退)」——
 * 但 router.js `/context` 渲染只打印 Used / Remaining / Session 三行,**这三个专为
 * 展示计算的字段全被丢弃**:
 *  - requestCount:在 router 处传入 computeContextStats 又原样返回,却从不显示;
 *  - model:call-site 甚至从不把 hudState.lastModel 传进去(输入侧半接线),
 *    stats.model 恒为 '';
 *  - limitSource:算出来标注「128k 是适配器真值还是回退默认猜测」,却从不告知用户,
 *    用户无从判断占用百分比是对着真窗口、还是一个 128000 的兜底估算。
 *
 * 本叶子把「stats → 详情行」这段纯格式化抽出单测。门控开 → 返回 [Model / Requests /
 * 上限来源] 中有值的若干行(纯文本,不着色不缩进,交调用方拼);门控关 → `[]`
 * (router 不追加任何行,逐字节回退今日三行输出)。
 *
 * 门控 KHY_CONTEXT_PANEL_DETAIL(默认开;{0,false,off,no} 关)。
 *
 * 诚实边界(刻意):① 只补 CC /context 中 khy 已备数据的字段(model / 请求数 /
 *   上限来源诚实标注);CC 的 token 分类网格(system/tools/messages/memory)需 khy
 *   不携带的 per-category 数据 → 刻意不臆造(honest-NA,承 刀36 记忆同结论)。
 *   ② sessionTotal 已由 Session 行两个箭头显式给出输入/输出,用户可自加,不再单列
 *   避免提示行过载(honest-NA)。③ 上限来源对称呈现(适配器真值 / 回退估算),直接
 *   兑现 ctxWindowStats 文档承诺的「诚实标注」——回退态尤其重要,提醒用户占用率对着
 *   的是估算窗口。④ 缺字段(model 空 / requestCount≤0)→ 该行省略,绝不显 `Model: `
 *   空值。⑤ 门控关 / 坏输入 / limitSource 未知 → 相应行省略,整体不抛。
 */

const _OFF = ['0', 'false', 'off', 'no'];

/**
 * 是否在 /context 追加 Model/Requests/上限来源 详情行。默认开(unset → 开)。
 * @param {object} [env]
 * @returns {boolean}
 */
function contextPanelDetailEnabled(env = process.env) {
  const raw = env && env.KHY_CONTEXT_PANEL_DETAIL;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !_OFF.includes(v);
}

/** 非负整数或 0(用于请求数;负/非有限/非数 → 0 不显)。 */
// 收敛到 utils/toNonNegInt 单一真源(逐字节委托,调用点不变)
const _nonNegInt = require('../utils/toNonNegInt');

/**
 * 由上下文统计对象构造 `/context` 详情行(纯文本,无缩进无着色,交调用方拼装)。
 *   门控关 / 坏输入 → []
 *   门控开 → [Model / Requests / 上限来源] 中有值的若干行
 * @param {object} stats  computeContextStats 返回对象
 * @param {object} [env]
 * @returns {string[]}
 */
function buildContextDetailLines(stats, env = process.env) {
  if (!contextPanelDetailEnabled(env)) return [];
  const s = stats || {};
  const lines = [];

  const model = s.model == null ? '' : String(s.model).trim();
  if (model) lines.push(`Model: ${model}`);

  const requests = _nonNegInt(s.requestCount);
  if (requests > 0) lines.push(`Requests: ${requests}`);

  // 诚实标注上限来源:兑现 ctxWindowStats 文档承诺(adapter 真值 / env 回退)。
  // 未知值(既非 adapter 也非 env-fallback)→ 不臆造,省略此行。
  if (s.limitSource === 'adapter') {
    lines.push('上限来源: 适配器真值');
  } else if (s.limitSource === 'env-fallback') {
    lines.push('上限来源: 回退估算（未取到适配器真值）');
  }

  return lines;
}

/**
 * 由上下文统计对象构造**交互中文面** `/context` 的身份详情行:仅 `模型` + `上限来源`。
 *
 * 承 刀102(router-path vs interactive-twin drift):两条交互中文 /context 孪生
 * (菜单 repl.js:3936、键入 repl.js:4529)已印 已使用/剩余/会话令牌/**请求次数**,但都
 * 漏掉 router 详情行里的 Model + 上限来源(诚实标注)。本函数是给这两条中文孪生**同时**补的
 * 单一真源——刻意**不含 Requests**(中文孪生自印「请求次数」,避免与 buildContextDetailLines 的
 * 英文 `Requests: N` 重复),Model 标签用中文「模型」(对齐中文面)。上限来源文案与
 * buildContextDetailLines 复用同一诚实标注(单一真源)。
 *
 *   门控关 / 坏输入 → []（两孪生逐字节回退刀103前,不追加任何行）
 *   门控开 → [模型 / 上限来源] 中有值的若干行(纯文本,无缩进无着色,交调用方拼装)
 * @param {object} stats  computeContextStats 返回对象
 * @param {object} [env]
 * @returns {string[]}
 */
function buildContextIdentityLines(stats, env = process.env) {
  if (!contextPanelDetailEnabled(env)) return [];
  const s = stats || {};
  const lines = [];

  const model = s.model == null ? '' : String(s.model).trim();
  if (model) lines.push(`模型: ${model}`);

  // 上限来源诚实标注——与 buildContextDetailLines 逐字复用(单一真源),中文面同样兑现
  // ctxWindowStats 文档承诺(adapter 真值 / env 回退)。未知值 → 省略,不臆造。
  if (s.limitSource === 'adapter') {
    lines.push('上限来源: 适配器真值');
  } else if (s.limitSource === 'env-fallback') {
    lines.push('上限来源: 回退估算（未取到适配器真值）');
  }

  return lines;
}

module.exports = {
  contextPanelDetailEnabled,
  buildContextDetailLines,
  buildContextIdentityLines,
};
