'use strict';

/**
 * thinkbackReport.js — 纯叶子(零 IO · 确定性 · 绝不抛 · 可单测)。
 *
 * 承 Goal(Thread 4)「缺少的工具和 /菜单全部补齐」。真缺口:khy 命令面**没有**
 * `/thinkback`——对齐 Claude Code `/thinkback`(CC 的「Year in Review / 使用回顾」)。
 *
 * **诚实边界(核心·honest-NA)**:CC 的 `/thinkback` 自身实现 460+ 行,重度依赖
 * plugin/marketplace + 终端动画 + Statsig 特性门。khy **不复刻**这些云端/动画层——
 * khy-native 版本是对**本地既有使用数据**(tokenUsageService.getUsageHistory 的按日
 * token/请求/成本聚合 + usageHabitService.getHabitSummary 的会话/模型/话题画像)做一份
 * **确定性、离线、可复现**的周期回顾。无模型也可用,绝不阻塞等模型,绝不外发数据。
 *
 * 本叶子只负责纯逻辑:门控 + 把「已取好的聚合数据」格式化成回顾行。所有 IO(读使用
 * 数据、读习惯画像)由薄壳 handlers/thinkback.js 完成后注入,保证确定性可单测。token
 * 数字格式器亦由薄壳注入(注入 ccFormatTokens 保持与 khy 其余 token 面同一 SSOT;
 * 缺省 → 朴素整数串),叶子自身零依赖。
 *
 * 门控 KHY_THINKBACK(默认开;{0,false,off,no} 关)。
 */

const _OFF = ['0', 'false', 'off', 'no'];

/**
 * 是否启用 `/thinkback` 命令。默认开(unset → 开)。
 * @param {object} [env]
 * @returns {boolean}
 */
function thinkbackEnabled(env = process.env) {
  const raw = env && env.KHY_THINKBACK;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !_OFF.includes(v);
}

/** 非负数(负/非有限/非数 → 0)。 */
function _num(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** 成本格式化(两位小数;0 → '0.00')。纯,无依赖。 */
function _fmtCost(n) {
  const v = _num(n);
  return v.toFixed(2);
}

/**
 * 由「已取好的聚合数据」构造 `/thinkback` 回顾行(纯文本,无缩进无着色,交调用方拼)。
 *   门控关 / 坏输入 → []
 *   数据全空 → 一行「数据不足」提示(诚实:没有可回顾的使用数据)
 *   否则 → 周期标题 + 汇总(token/请求/成本/活跃天/最活跃日)+ 习惯画像(会话/模型/话题)
 *
 * @param {object} p
 * @param {Array<{date:string,totalTokens:number,requests:number,costUSD:number}>} [p.history]
 * @param {object} [p.habits]  usageHabitService.getHabitSummary() 返回对象
 * @param {string} [p.periodLabel]  周期人读标签(如「近 30 天」),薄壳注入
 * @param {object} [env]
 * @param {object} [deps]
 * @param {(n:number)=>string} [deps.fmtTokens]  token 数字格式器(薄壳注入 ccFormatTokens)
 * @returns {string[]}
 */
function buildThinkbackReport(p, env = process.env, deps = {}) {
  if (!thinkbackEnabled(env)) return [];
  const o = p || {};
  const history = Array.isArray(o.history) ? o.history : [];
  const habits = o.habits && typeof o.habits === 'object' ? o.habits : {};
  const periodLabel = String(o.periodLabel == null ? '' : o.periodLabel).trim() || '本期';
  const fmtTokens = typeof deps.fmtTokens === 'function'
    ? deps.fmtTokens
    : (n) => String(Math.floor(_num(n)));

  // 聚合按日历史。
  let totalTokens = 0;
  let totalRequests = 0;
  let totalCost = 0;
  let activeDays = 0;
  let peakDay = null; // { date, totalTokens }
  for (const row of history) {
    if (!row || typeof row !== 'object') continue;
    const tk = _num(row.totalTokens);
    const rq = _num(row.requests);
    totalTokens += tk;
    totalRequests += rq;
    totalCost += _num(row.costUSD);
    if (tk > 0 || rq > 0) activeDays += 1;
    if (tk > 0 && (!peakDay || tk > peakDay.totalTokens)) {
      peakDay = { date: String(row.date || ''), totalTokens: tk };
    }
  }

  const timeProfile = habits.timeProfile && typeof habits.timeProfile === 'object'
    ? habits.timeProfile : {};
  const totalSessions = _num(timeProfile.totalSessions);
  const avgSession = String(timeProfile.avgSession == null ? '' : timeProfile.avgSession).trim();
  const modelRanking = Array.isArray(habits.modelRanking) ? habits.modelRanking : [];
  const topics = Array.isArray(habits.topics) ? habits.topics : [];

  // 诚实:全空 → 数据不足,绝不编造。
  const hasUsage = totalTokens > 0 || totalRequests > 0;
  const hasHabits = totalSessions > 0 || modelRanking.length > 0 || topics.length > 0;
  if (!hasUsage && !hasHabits) {
    return [`使用回顾（${periodLabel}）：暂无足够数据可回顾——多用一段时间后再来。`];
  }

  const lines = [];
  lines.push(`使用回顾（${periodLabel}）`);

  if (hasUsage) {
    lines.push(`  Token 合计: ${fmtTokens(totalTokens)}`);
    lines.push(`  请求合计: ${Math.floor(totalRequests)}`);
    lines.push(`  成本合计: $${_fmtCost(totalCost)}`);
    lines.push(`  活跃天数: ${activeDays}`);
    if (peakDay && peakDay.date) {
      lines.push(`  最活跃日: ${peakDay.date}（${fmtTokens(peakDay.totalTokens)} tokens）`);
    }
  }

  if (totalSessions > 0) {
    const avg = avgSession ? `,平均 ${avgSession}` : '';
    lines.push(`  会话数: ${Math.floor(totalSessions)}${avg}`);
  }

  if (modelRanking.length > 0) {
    const top = modelRanking[0];
    const name = top && top.model ? String(top.model) : '';
    if (name) lines.push(`  最常用模型: ${name}（${Math.floor(_num(top.count))} 次）`);
  }

  if (topics.length > 0) {
    const names = topics
      .slice(0, 5)
      .map((t) => (t && t.topic ? String(t.topic) : ''))
      .filter((s) => s.length > 0);
    if (names.length) lines.push(`  高频话题: ${names.join('、')}`);
  }

  return lines;
}

module.exports = {
  thinkbackEnabled,
  buildThinkbackReport,
};
