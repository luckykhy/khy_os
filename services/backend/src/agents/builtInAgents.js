'use strict';

/**
 * Built-in agent definitions for khy OS.
 * Source-level alignment with Claude Code's builtInAgents.ts architecture.
 *
 * Each agent has: agentType, whenToUse, tools/disallowedTools, model,
 * getSystemPrompt(), and optional metadata (color, background, omitClaudeMd).
 */

const { GENERAL_PURPOSE_AGENT } = require('./built-in/generalPurposeAgent');
const { STATUSLINE_SETUP_AGENT } = require('./built-in/statuslineSetup');
const { EXPLORE_AGENT } = require('./built-in/exploreAgent');
const { PLAN_AGENT } = require('./built-in/planAgent');
const { KHY_GUIDE_AGENT } = require('./built-in/khyGuideAgent');
const { VERIFICATION_AGENT } = require('./built-in/verificationAgent');
const { AUDIT_AGENT } = require('./built-in/auditAgent');
const { FIX_AGENT } = require('./built-in/fixAgent');
const { RESEARCH_AGENT } = require('./built-in/researchAgent');
const { READING_AGENT } = require('./built-in/readingAgent');
const { MAP_AGENT } = require('./built-in/mapAgent');

/**
 * Returns the list of built-in agents.
 * Mirrors Claude Code's getBuiltInAgents() with feature-gate equivalents.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.disableBuiltIn] - When true in SDK/non-interactive mode, returns []
 * @param {boolean} [opts.enableExplorePlan] - Enable explore/plan agents (default true)
 * @param {boolean} [opts.enableGuide] - Enable khy-guide agent (default true for interactive)
 * @param {boolean} [opts.enableVerification] - Enable verification agent (default true)
 * @param {boolean} [opts.enableAudit] - Enable audit (read-only critic) agent (default true)
 * @param {boolean} [opts.enableFix] - Enable fix (surgical repair) agent (default true)
 * @param {boolean} [opts.enableResearch] - Enable research (read-only multi-source investigator) agent (default true)
 * @param {boolean} [opts.enableReading] - Enable reading (read-only deep-comprehension) agent (default true)
 * @param {boolean} [opts.enableMap] - Enable map (read-only codebase cartographer) agent (default true)
 * @returns {Array<import('./types').AgentDefinition>}
 */
function getBuiltInAgents(opts = {}) {
  const {
    disableBuiltIn = false,
    enableExplorePlan = true,
    enableGuide = true,
    enableVerification = true,
    enableAudit = true,
    enableFix = true,
    enableResearch = true,
    enableReading = true,
    enableMap = true,
  } = opts;

  // Allow disabling all built-in agents via env var (useful for SDK users)
  if (
    disableBuiltIn ||
    process.env.KHY_DISABLE_BUILTIN_AGENTS === '1' ||
    process.env.KHY_DISABLE_BUILTIN_AGENTS === 'true'
  ) {
    return [];
  }

  const agents = [
    GENERAL_PURPOSE_AGENT,
    STATUSLINE_SETUP_AGENT,
  ];

  if (enableExplorePlan) {
    agents.push(EXPLORE_AGENT, PLAN_AGENT);
  }

  if (enableGuide) {
    agents.push(KHY_GUIDE_AGENT);
  }

  if (enableVerification) {
    agents.push(VERIFICATION_AGENT);
  }

  if (enableAudit) {
    agents.push(AUDIT_AGENT);
  }

  if (enableFix) {
    agents.push(FIX_AGENT);
  }

  if (enableResearch) {
    agents.push(RESEARCH_AGENT);
  }

  if (enableReading) {
    agents.push(READING_AGENT);
  }

  if (enableMap) {
    agents.push(MAP_AGENT);
  }

  return agents;
}

/**
 * Get active agents from a list, with later sources overriding earlier ones.
 * Priority: built-in < plugin < user < project < managed < flag
 *
 * @param {Array<import('./types').AgentDefinition>} allAgents
 * @returns {Array<import('./types').AgentDefinition>}
 */
function getActiveAgentsFromList(allAgents) {
  const builtIn = allAgents.filter(a => a.source === 'built-in');
  const plugin = allAgents.filter(a => a.source === 'plugin');
  const user = allAgents.filter(a => a.source === 'userSettings');
  const project = allAgents.filter(a => a.source === 'projectSettings');
  const managed = allAgents.filter(a => a.source === 'policySettings');
  const flag = allAgents.filter(a => a.source === 'flagSettings');

  const groups = [builtIn, plugin, user, project, flag, managed];
  const agentMap = new Map();

  for (const group of groups) {
    for (const agent of group) {
      agentMap.set(agent.agentType, agent);
    }
  }

  return Array.from(agentMap.values());
}

/**
 * Format one agent line for the agent listing prompt:
 * `- type: whenToUse (Tools: ...)`
 *
 * @param {import('./types').AgentDefinition} agent
 * @returns {string}
 */
function formatAgentLine(agent) {
  const { tools, disallowedTools } = agent;
  const hasAllowlist = tools && tools.length > 0;
  const hasDenylist = disallowedTools && disallowedTools.length > 0;

  let toolsDescription;
  if (hasAllowlist && hasDenylist) {
    const denySet = new Set(disallowedTools);
    const effective = tools.filter(t => !denySet.has(t));
    toolsDescription = effective.length === 0 ? 'None' : effective.join(', ');
  } else if (hasAllowlist) {
    toolsDescription = tools.join(', ');
  } else if (hasDenylist) {
    toolsDescription = `All tools except ${disallowedTools.join(', ')}`;
  } else {
    toolsDescription = 'All tools';
  }

  return `- ${agent.agentType}: ${agent.whenToUse} (Tools: ${toolsDescription})`;
}

module.exports = {
  getBuiltInAgents,
  getActiveAgentsFromList,
  formatAgentLine,
};
