'use strict';

/**
 * A2A Configuration — Configuration for Agent-to-Agent communication.
 *
 * Environment variables:
 * - KHY_A2A_ENABLED: Enable A2A protocol (default: '1')
 * - KHY_A2A_HEARTBEAT_INTERVAL: Heartbeat interval in ms (default: 30000)
 * - KHY_A2A_HEARTBEAT_TIMEOUT: Heartbeat timeout in ms (default: 90000)
 * - KHY_A2A_MAX_TASKS_PER_AGENT: Max concurrent tasks per agent (default: 5)
 * - KHY_A2A_MAX_RETRIES: Max message retry attempts (default: 3)
 * - KHY_A2A_RETRY_DELAY_MS: Retry delay in ms (default: 1000)
 * - KHY_A2A_MESSAGE_TIMEOUT_MS: Message timeout in ms (default: 30000)
 * - KHY_A2A_MAX_QUEUE_SIZE: Max message queue size (default: 1000)
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env = process.env) {
  const v = String(env.KHY_A2A_ENABLED || '1').toLowerCase();
  return !OFF_VALUES.includes(v);
}

function parseIntEnv(key, dflt, env = process.env) {
  const raw = String(env[key] || '');
  if (!raw) return dflt;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/**
 * Build A2A configuration from environment.
 * @param {object} [env=process.env]
 * @returns {object}
 */
function buildConfig(env = process.env) {
  return {
    enabled: isEnabled(env),
    
    // Registry settings
    registry: {
      heartbeatInterval: parseIntEnv('KHY_A2A_HEARTBEAT_INTERVAL', 30000, env),
      heartbeatTimeout: parseIntEnv('KHY_A2A_HEARTBEAT_TIMEOUT', 90000, env),
      maxTasksPerAgent: parseIntEnv('KHY_A2A_MAX_TASKS_PER_AGENT', 5, env),
    },
    
    // Lifecycle settings
    lifecycle: {
      maxDepth: parseIntEnv('KHY_A2A_MAX_DEPTH', 3, env),
      maxChildren: parseIntEnv('KHY_A2A_MAX_CHILDREN', 10, env),
      agentTimeoutMs: parseIntEnv('KHY_A2A_AGENT_TIMEOUT_MS', 300000, env),
      maxTotalAgents: parseIntEnv('KHY_A2A_MAX_TOTAL_AGENTS', 50, env),
      workspaceBaseDir: env.KHY_A2A_WORKSPACE_DIR || 
        require('path').resolve(process.cwd(), '.khy', 'agent-workspaces'),
    },
    
    // Router settings
    router: {
      maxRetries: parseIntEnv('KHY_A2A_MAX_RETRIES', 3, env),
      retryDelayMs: parseIntEnv('KHY_A2A_RETRY_DELAY_MS', 1000, env),
      maxQueueSize: parseIntEnv('KHY_A2A_MAX_QUEUE_SIZE', 1000, env),
      messageTimeoutMs: parseIntEnv('KHY_A2A_MESSAGE_TIMEOUT_MS', 30000, env),
      deadLetterEnabled: String(env.KHY_A2A_DEAD_LETTER_ENABLED || '1').toLowerCase() !== '0',
    },
  };
}

// ── Singleton Instance ────────────────────────────────────────────────────

let _config = null;

function getConfig(env) {
  if (!_config || env) {
    _config = buildConfig(env);
  }
  return _config;
}

function resetConfig() {
  _config = null;
}

module.exports = {
  isEnabled,
  parseIntEnv,
  buildConfig,
  getConfig,
  resetConfig,
};