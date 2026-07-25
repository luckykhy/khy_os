'use strict';

/**
 * costByModel — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 「对齐 Claude Code 不只是显示对齐,更要让显示背后的**后端逻辑**对齐。」
 * CC 的 `/cost` 报表(`cost-tracker.ts::formatModelUsage`)默认带一段
 * "Usage by model:":按规范模型名分组,逐模型列出 input/output/cache/(cost)。
 * khy 每次 AI 请求**早已**把 `{provider,model,inputTokens,outputTokens,total,costUSD}`
 * 记进 `tokenUsageService._sessionUsage.records`(见 recordUsage),但
 * `formatCostReport` 只把它汇成一笔会话总额,**从不按模型归组** —— per-model 归属
 * 这条 CC 默认呈现的信息在 khy 缺席(half-wired:记录侧已 live,呈现侧未接)。
 *
 * 本叶子只做**纯数据归组决策**:把 records 按注入的 labelFn(模型 → 友好显示名,
 * 复用 `cli/ccModelName.formatModelLabel` 这一 SSOT,由壳注入以保本叶子零依赖)聚合成
 * 有序数组;渲染(chalk / 中文 / CNY 换算)留给壳 `formatCostReport`。
 *
 * 诚实边界:khy 的 per-request record **不携带 cache read/write 分项**(与刀92 省略
 * 无底座字段同纪律)→ 本段只列 input/output/cost,绝不臆造 cache 列。门控
 * KHY_COST_BY_MODEL 默认开;关 → 壳短路不追加该段(逐字节回退刀93前报表)。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** 门控:KHY_COST_BY_MODEL 默认开;{0,false,off,no} 关。 */
function costByModelEnabled(env = process.env) {
  const raw = env && env.KHY_COST_BY_MODEL;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

// 有限数强转家族单一真源 utils/finiteNumber(见 finiteNumber.js)。
const _num = require('../utils/finiteNumber').toFiniteOr0;

/**
 * 把会话 per-request records 按模型标签聚合。纯函数、绝不抛。
 *
 * @param {Array<{model?:string,inputTokens?:number,outputTokens?:number,total?:number,costUSD?:number}>} records
 * @param {(model:string)=>string} [labelFn] 模型 slug → 显示标签(默认恒等;壳注入 formatModelLabel)
 * @returns {Array<{label:string,input:number,output:number,total:number,cost:number,requests:number}>}
 *   按 cost 降序、再 total 降序、再 label 升序稳定排序;空/非法输入 → []。
 */
function aggregateSessionUsageByModel(records, labelFn) {
  try {
    if (!Array.isArray(records) || records.length === 0) return [];
    const label = typeof labelFn === 'function' ? labelFn : (m) => m;
    const groups = new Map();
    for (const rec of records) {
      if (!rec || typeof rec !== 'object') continue;
      const rawModel = typeof rec.model === 'string' && rec.model.trim() ? rec.model.trim() : '(unknown)';
      let key;
      try { key = String(label(rawModel) || rawModel); } catch { key = rawModel; }
      if (!key) key = rawModel;
      let g = groups.get(key);
      if (!g) { g = { label: key, input: 0, output: 0, total: 0, cost: 0, requests: 0 }; groups.set(key, g); }
      const inTok = _num(rec.inputTokens);
      const outTok = _num(rec.outputTokens);
      g.input += inTok;
      g.output += outTok;
      g.total += _num(rec.total) || (inTok + outTok);
      g.cost += _num(rec.costUSD);
      g.requests += 1;
    }
    const rows = Array.from(groups.values());
    rows.sort((a, b) =>
      (b.cost - a.cost)
      || (b.total - a.total)
      || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    return rows;
  } catch {
    return [];
  }
}

module.exports = { costByModelEnabled, aggregateSessionUsageByModel };
