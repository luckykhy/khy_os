'use strict';

/**
 * Agent system entry point for khy OS.
 * Source-level alignment with Claude Code's AgentTool architecture.
 *
 * Exports:
 * - Built-in agent definitions and registry
 * - Agent loading from .khy/agents/ directory (custom agents)
 * - Agent prompt builder
 * - Type guards and utilities
 */

const {
  getBuiltInAgents,
  getActiveAgentsFromList,
  formatAgentLine,
} = require('./builtInAgents');

const {
  AGENT_COLORS,
  isBuiltInAgent,
  isCustomAgent,
  isPluginAgent,
} = require('./types');

const { getAgentToolPrompt } = require('./prompt');
const { loadCustomAgents, clearAgentCache } = require('./loadAgents');

/**
 * Get all agent definitions (built-in + custom).
 * Mirrors Claude Code's getAgentDefinitionsWithOverrides().
 *
 * @param {string} cwd - Current working directory
 * @param {object} [opts] - Options passed to getBuiltInAgents
 * @returns {Promise<import('./types').AgentDefinitionsResult>}
 */
async function getAgentDefinitions(cwd, opts = {}) {
  try {
    const builtInAgents = getBuiltInAgents(opts);
    const { agents: customAgents, failedFiles } = await loadCustomAgents(cwd);

    const allAgents = [...builtInAgents, ...customAgents];
    const activeAgents = getActiveAgentsFromList(allAgents);

    return {
      activeAgents,
      allAgents,
      failedFiles: failedFiles.length > 0 ? failedFiles : undefined,
    };
  } catch (error) {
    // Even on error, return the built-in agents
    const builtInAgents = getBuiltInAgents(opts);
    return {
      activeAgents: builtInAgents,
      allAgents: builtInAgents,
      failedFiles: [{ path: 'unknown', error: error.message || String(error) }],
    };
  }
}

module.exports = {
  // Registry
  getBuiltInAgents,
  getAgentDefinitions,
  getActiveAgentsFromList,
  clearAgentCache,

  // Prompt
  getAgentToolPrompt,
  formatAgentLine,

  // Type guards
  AGENT_COLORS,
  isBuiltInAgent,
  isCustomAgent,
  isPluginAgent,
};
