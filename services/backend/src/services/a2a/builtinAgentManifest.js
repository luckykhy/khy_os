'use strict';

/**
 * builtinAgentManifest.js — 纯叶子（零 IO、确定性、绝不抛、可单测）：khy-os 内置 agent
 * 清单的单一真源。
 *
 * 定位：这份清单原先**只**内联在 `services/a2aFacade.js` 的 `_registerBuiltinAgents()` 里，
 * 而那个方法是私有方法、只在 `initialize()` 中调用 —— 而 `initialize()` 全仓无调用方
 * （审计发现 A9：`initializeA2A` 是死代码）。结果是这份「khy 有哪些内置 agent」的知识
 * 既无法被 Agent Card 发布路径复用，也没有任何人能机器校验它。
 *
 * 抽成本叶子后：
 *   - `a2aFacade` 从「自己内联一份数组」改为 require 本模块 → 两份清单不再可能漂移；
 *   - `/.well-known/agent-card.json` 的 `skills` 由本清单派生 → 卡片上写的就是真实存在的
 *     agent 能力，而不是编出来的营销话术；
 *   - 守卫与单测可以对它做断言（如 id 唯一、capabilities 非空）。
 *
 * 契约：零 IO、确定性、绝不抛。
 * 门控无 —— 本叶子是纯数据，是否需要发布由调用方判定。
 */

/**
 * 内置 agent 描述符。
 *
 * - `name`         agent 的稳定标识（注册表以 name+type 判重，故二者组合必须唯一）
 * - `type`         agent 分类（`analyst` / `manager` / `coordinator` …）
 * - `capabilities` 该 agent 对外声明的能力标签（也是发布到 Agent Card 的 skills 来源）
 * - `description`  人类可读说明；缺省由 `toSkillSeeds()` 从能力标签推导
 */
const BUILTIN_AGENTS = Object.freeze([
  Object.freeze({
    name: 'fundamental',
    type: 'analyst',
    capabilities: Object.freeze(['fundamental_analysis', 'financial_analysis']),
    description: '基本面分析：财报、估值与行业对比。',
  }),
  Object.freeze({
    name: 'technical',
    type: 'analyst',
    capabilities: Object.freeze(['technical_analysis', 'chart_analysis']),
    description: '技术面分析：K 线形态、指标与量价关系。',
  }),
  Object.freeze({
    name: 'sentiment',
    type: 'analyst',
    capabilities: Object.freeze(['sentiment_analysis', 'news_analysis']),
    description: '情绪面分析：新闻、公告与舆情。',
  }),
  Object.freeze({
    name: 'risk',
    type: 'manager',
    capabilities: Object.freeze(['risk_assessment', 'position_sizing']),
    description: '风险管理：风险评估与仓位测算。',
  }),
  Object.freeze({
    name: 'coordinator',
    type: 'coordinator',
    capabilities: Object.freeze(['task_coordination', 'result_aggregation']),
    description: '协调者：任务分派与结果聚合。',
  }),
]);

/**
 * 全部内置 agent 的能力标签（去重、稳定顺序）。
 * @returns {string[]}
 */
function listCapabilities() {
  const seen = new Set();
  for (const agent of BUILTIN_AGENTS) {
    for (const cap of agent.capabilities || []) {
      const c = String(cap == null ? '' : cap).trim();
      if (c) seen.add(c);
    }
  }
  return [...seen];
}

/**
 * 转成 `agentCardSpec.buildAgentCard({ skills })` 能吃的 skill 种子。
 * 一个能力标签一条；`tags` 取自 agent type，便于外部 orchestrator 按类别筛选。
 * @returns {Array<{id:string,name:string,description:string,tags:string[]}>}
 */
function toSkillSeeds() {
  const byCapability = new Map();
  for (const agent of BUILTIN_AGENTS) {
    for (const cap of agent.capabilities || []) {
      const id = String(cap == null ? '' : cap).trim();
      if (!id) continue;
      if (!byCapability.has(id)) {
        byCapability.set(id, { id, description: agent.description || '', tags: new Set([agent.type]) });
      } else {
        byCapability.get(id).tags.add(agent.type);
      }
    }
  }
  return [...byCapability.values()].map((entry) => ({
    id: entry.id,
    name: entry.id,
    description: entry.description || `khy-os capability \`${entry.id}\`.`,
    tags: [...entry.tags].filter(Boolean),
  }));
}

/**
 * 内部一致性自检：name+type 组合唯一、capabilities 非空且元素为字符串。
 * @returns {string[]} 问题清单（空数组 = 全绿）
 */
function validateManifest() {
  const errors = [];
  const seen = new Set();
  for (const agent of BUILTIN_AGENTS) {
    if (!agent.name || !agent.type) errors.push(`agent 缺 name/type: ${JSON.stringify(agent)}`);
    const key = `${agent.name}::${agent.type}`;
    if (seen.has(key)) errors.push(`重复的 name+type 组合: ${key}`);
    seen.add(key);
    if (!Array.isArray(agent.capabilities) || agent.capabilities.length === 0) {
      errors.push(`${agent.name} 的 capabilities 为空`);
    } else if (agent.capabilities.some((c) => typeof c !== 'string' || !c.trim())) {
      errors.push(`${agent.name} 的 capabilities 含非字符串/空项`);
    }
  }
  return errors;
}

module.exports = {
  BUILTIN_AGENTS,
  listCapabilities,
  toSkillSeeds,
  validateManifest,
};
