'use strict';

/**
 * Agent type definitions for khy OS.
 * Source-level alignment with Claude Code's loadAgentsDir.ts type system.
 *
 * Since this is JavaScript (not TypeScript), types are documented via JSDoc.
 * Runtime validation uses plain checks rather than Zod schemas.
 */

/**
 * @typedef {'built-in'|'plugin'|'userSettings'|'projectSettings'|'policySettings'|'flagSettings'} AgentSource
 */

/**
 * @typedef {'blue'|'green'|'orange'|'purple'|'red'|'cyan'|'yellow'|'magenta'} AgentColorName
 */

/**
 * @typedef {'user'|'project'|'local'} AgentMemoryScope
 */

/**
 * @typedef {'worktree'} IsolationMode
 */

/**
 * @typedef {Object} BaseAgentDefinition
 * @property {string} agentType - Unique agent type identifier
 * @property {string} whenToUse - Description of when to use this agent
 * @property {string[]} [tools] - Allowed tool names (allowlist)
 * @property {string[]} [disallowedTools] - Denied tool names (denylist)
 * @property {string[]} [skills] - Skill names to preload
 * @property {AgentColorName} [color] - Display color
 * @property {string} [model] - Model override ('haiku', 'sonnet', 'opus', 'inherit')
 * @property {string} [effort] - Effort level override
 * @property {string} [permissionMode] - Permission mode override
 * @property {number} [maxTurns] - Maximum agentic turns before stopping
 * @property {string} [filename] - Original filename without .md extension
 * @property {string} [baseDir] - Base directory for the agent definition
 * @property {string} [criticalSystemReminder_EXPERIMENTAL] - Short message re-injected every turn
 * @property {boolean} [background] - Always run as background task
 * @property {string} [initialPrompt] - Prepended to the first user turn
 * @property {AgentMemoryScope} [memory] - Persistent memory scope
 * @property {IsolationMode} [isolation] - Run in isolated git worktree
 * @property {boolean} [omitClaudeMd] - Omit CLAUDE.md from agent context
 */

/**
 * @typedef {BaseAgentDefinition & {
 *   source: 'built-in',
 *   getSystemPrompt: function(object=): string
 * }} BuiltInAgentDefinition
 */

/**
 * @typedef {BaseAgentDefinition & {
 *   source: AgentSource,
 *   getSystemPrompt: function(): string
 * }} CustomAgentDefinition
 */

/**
 * @typedef {BaseAgentDefinition & {
 *   source: 'plugin',
 *   plugin: string,
 *   getSystemPrompt: function(): string
 * }} PluginAgentDefinition
 */

/**
 * @typedef {BuiltInAgentDefinition|CustomAgentDefinition|PluginAgentDefinition} AgentDefinition
 */

/**
 * @typedef {Object} AgentDefinitionsResult
 * @property {AgentDefinition[]} activeAgents
 * @property {AgentDefinition[]} allAgents
 * @property {Array<{path: string, error: string}>} [failedFiles]
 * @property {string[]} [allowedAgentTypes]
 */

const AGENT_COLORS = ['blue', 'green', 'orange', 'purple', 'red', 'cyan', 'yellow', 'magenta'];

/**
 * Type guard: is this a built-in agent?
 * @param {AgentDefinition} agent
 * @returns {boolean}
 */
function isBuiltInAgent(agent) {
  return agent.source === 'built-in';
}

/**
 * Type guard: is this a custom agent?
 * @param {AgentDefinition} agent
 * @returns {boolean}
 */
function isCustomAgent(agent) {
  return agent.source !== 'built-in' && agent.source !== 'plugin';
}

/**
 * Type guard: is this a plugin agent?
 * @param {AgentDefinition} agent
 * @returns {boolean}
 */
function isPluginAgent(agent) {
  return agent.source === 'plugin';
}

module.exports = {
  AGENT_COLORS,
  isBuiltInAgent,
  isCustomAgent,
  isPluginAgent,
};
