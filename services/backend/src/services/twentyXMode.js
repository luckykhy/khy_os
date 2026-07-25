'use strict';

/**
 * 20 倍模式(20x mode)—— max-throughput 开关的纯决策叶子。
 *
 * 背景:Claude Code 的「20x mode」指 Anthropic 最上位订阅 Max 20x($200/月,约 Pro 的
 * 20 倍用量额度)。它的运行时体感 = 权力用户「满负荷跑」:更长的连续运行、并行的 agent
 * 团队、始终开着扩展思考。khy 是自托管网关(路由免费/多供应,并不受 Anthropic 额度约束),
 * 照搬「计费额度」无意义;真正可对齐、且对用户有意义的,是同一体感在 khy 能控制的轴上的
 * 表达 —— 一个可开关的「20 倍模式」:开启后 khy 对每个任务都投入顶格算力:
 *   · effort 强制到 max(唯一带扩展思考预算的档);
 *   · 工具循环迭代上限顶到硬顶;
 *   · 并行子代理扇出(maxChildren / maxTotalAgents)放大。
 *
 * 「20x」是模式名(沿用 CC 的品牌语),放大幅度取**安全、封顶**的值(把并行扇出真的
 * 乘到 20 会打爆资源),诚实标注于各常量。
 *
 * 契约(与 rtkMode / rtkEffectiveState 同族):
 *   · 纯函数,零 IO,绝不抛,坏输入 → 安全默认;
 *   · 门控 KHY_20X_MODE 为 **opt-in(默认关)**—— 关就是逐字节回退到今日行为,
 *     无需单独的 feature gate(模式关 = 无变化);
 *   · 决策叶子只计算「给定基线该放大成多少」,真正的读取点在各 IO 壳里接线。
 *
 * 门控读取委托 flagRegistry.isFlagEnabled(单一语义:opt-in 严格 'true'|'1'),
 * flagRegistry 不可用时回退等价严格判定。/20x on 与 NL 配置都持久化 'true'。
 *
 * @module services/twentyXMode
 */

const FLAG = 'KHY_20X_MODE';

// ── 放大目标(安全封顶;「20x」是模式名,非字面 20 倍并行)────────────────────
// effort:顶格档(EFFORT_PRESETS.max —— 唯一携带 thinking.budgetTokens 的档)。
const TWENTYX_EFFORT = 'max';
// 工具循环迭代:顶到 toolUseLoop 的硬顶(MAX_ITERATIONS=100),让长任务不早停。
const TWENTYX_ITER_TARGET = 100;
// 并行子代理:默认 maxChildren=10 / maxTotalAgents=50 → 放大 2×(团队并行,不打爆资源)。
const TWENTYX_MAX_CHILDREN = 20;
const TWENTYX_MAX_TOTAL_AGENTS = 100;
// 扩展思考预算:autoReasoning 的 max 档上限(供接线点可选放大,默认不强改以免触供应上限)。
const TWENTYX_THINKING_BUDGET = 32768;

/**
 * 20 倍模式是否启用(opt-in,默认关)。委托 flagRegistry 保持单一门控语义;
 * 不可用时回退等价严格判定(仅 'true' | '1' 视为开)。绝不抛。
 *
 * @param {object} [env=process.env]
 * @returns {boolean}
 */
function isTwentyXEnabled(env = process.env) {
  try {
    const reg = require('./flagRegistry');
    if (reg && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled(FLAG, env) === true;
    }
  } catch { /* flagRegistry 不可用 → 回退自包含判定 */ }
  try {
    const raw = env && env[FLAG];
    return raw === 'true' || raw === '1';
  } catch {
    return false;
  }
}

/**
 * 解析 effort:20x 开 → 顶格 'max';关 → 原样返回 baseEffort(逐字节回退)。
 * 绝不返回非法档:未知 baseEffort 关态原样透出(上游已有 `|| EFFORT_PRESETS.high` 兜底)。
 *
 * @param {string} baseEffort  当前 effort(low/medium/high/max/…)
 * @param {object} [env]
 * @returns {string}
 */
function resolveTwentyXEffort(baseEffort, env = process.env) {
  if (!isTwentyXEnabled(env)) return baseEffort;
  return TWENTYX_EFFORT;
}

/**
 * 解析工具循环迭代上限:20x 开 → 取 max(base, 目标)但绝不低于 base、绝不超过 100;
 * 关 → 原样返回 base(逐字节回退)。
 *
 * @param {number} baseMax  基线迭代上限(已 clamp 到 [1,100])
 * @param {object} [env]
 * @returns {number}
 */
function scaleIterations(baseMax, env = process.env) {
  const base = Number.isFinite(baseMax) ? baseMax : TWENTYX_ITER_TARGET;
  if (!isTwentyXEnabled(env)) return base;
  const boosted = Math.max(base, TWENTYX_ITER_TARGET);
  return Math.min(100, boosted);
}

/**
 * 放大并行子代理扇出。20x 开 → 把 maxChildren / maxTotalAgents 抬到目标,
 * 但**只对调用方未显式设定的键**生效(显式 opts 永远优先),且绝不低于现值;
 * 关 → 原样返回 config(同引用,逐字节回退)。绝不抛。
 *
 * @param {object} config       已 merge 的配置(通常 {...DEFAULTS, ...opts})
 * @param {object} [explicitOpts]  调用方显式传入的 opts(用于判定哪些键不该覆盖)
 * @param {object} [env]
 * @returns {object}  新配置(开态)或原 config(关态)
 */
function scaleFanout(config, explicitOpts = {}, env = process.env) {
  try {
    if (!config || typeof config !== 'object') return config;
    if (!isTwentyXEnabled(env)) return config;
    const opts = explicitOpts && typeof explicitOpts === 'object' ? explicitOpts : {};
    const out = { ...config };
    if (opts.maxChildren === undefined && Number.isFinite(out.maxChildren)) {
      out.maxChildren = Math.max(out.maxChildren, TWENTYX_MAX_CHILDREN);
    }
    if (opts.maxTotalAgents === undefined && Number.isFinite(out.maxTotalAgents)) {
      out.maxTotalAgents = Math.max(out.maxTotalAgents, TWENTYX_MAX_TOTAL_AGENTS);
    }
    return out;
  } catch {
    return config;
  }
}

/**
 * 放大扩展思考预算:20x 开 → max(base, 目标);关 → 原样(逐字节回退)。
 * 供接线点可选使用(默认不强接,避免触及供应端 max_tokens 上限)。
 *
 * @param {number} baseBudget
 * @param {object} [env]
 * @returns {number}
 */
function resolveThinkingBudget(baseBudget, env = process.env) {
  const base = Number.isFinite(baseBudget) ? baseBudget : 0;
  if (!isTwentyXEnabled(env)) return base;
  return Math.max(base, TWENTYX_THINKING_BUDGET);
}

/**
 * 状态自述(供 /20x status、capability 面板、selfProfile 注入)。
 * 始终返回对象(带 enabled 标志);调用方按 enabled 决定是否渲染 → 关态不渲染 = 逐字节回退。
 *
 * @param {object} [env]
 * @returns {{enabled:boolean,label:string,hint:string,effort:string,maxChildren:number,maxTotalAgents:number,maxIterations:number}}
 */
function describeTwentyXState(env = process.env) {
  const enabled = isTwentyXEnabled(env);
  if (!enabled) {
    return {
      enabled: false,
      label: '20 倍模式:关',
      hint: '开启后每个任务顶格投入算力(effort=max + 扩展思考 + 更高并行/迭代上限)。用 `/20x on` 开启。',
      effort: TWENTYX_EFFORT,
      maxChildren: TWENTYX_MAX_CHILDREN,
      maxTotalAgents: TWENTYX_MAX_TOTAL_AGENTS,
      maxIterations: TWENTYX_ITER_TARGET,
    };
  }
  return {
    enabled: true,
    label: '20 倍模式:开(满负荷)',
    hint: `effort 已顶到 max（含扩展思考）· 工具循环迭代上限 ${TWENTYX_ITER_TARGET} · 并行子代理扇出至 ${TWENTYX_MAX_CHILDREN}/${TWENTYX_MAX_TOTAL_AGENTS}。`,
    effort: TWENTYX_EFFORT,
    maxChildren: TWENTYX_MAX_CHILDREN,
    maxTotalAgents: TWENTYX_MAX_TOTAL_AGENTS,
    maxIterations: TWENTYX_ITER_TARGET,
  };
}

module.exports = {
  FLAG,
  TWENTYX_EFFORT,
  TWENTYX_ITER_TARGET,
  TWENTYX_MAX_CHILDREN,
  TWENTYX_MAX_TOTAL_AGENTS,
  TWENTYX_THINKING_BUDGET,
  isTwentyXEnabled,
  resolveTwentyXEffort,
  scaleIterations,
  scaleFanout,
  resolveThinkingBudget,
  describeTwentyXState,
};
