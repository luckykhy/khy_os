/**
 * Hook System — unified facade for the hooks subsystem.
 *
 * Usage:
 *   const hookSystem = require('./hooks/hookSystem');
 *   hookSystem.init(projectDir);
 *
 *   // Before tool execution:
 *   const { blocked, context } = await hookSystem.trigger('PreToolUse', { toolName, args });
 *   if (blocked) return; // hook vetoed this action
 *
 *   // After tool execution:
 *   await hookSystem.trigger('PostToolUse', { toolName, result });
 */
const registry = require('./hookRegistry');
const { runHooks } = require('./hookRunner');

let _initialized = false;

function init(projectDir) {
  registry.load(projectDir);
  // Register built-in ToolGuards after config hooks
  try {
    const { registerBuiltinGuards } = require('../../services/toolGuards');
    registerBuiltinGuards(module.exports);
  } catch {
    // toolGuards module not available — skip
  }
  // Register the change-watch feedback injector: a code-level, AI-independent
  // PrePrompt injection of "your last khy change was correct/incorrect". The
  // verdict text is produced deterministically by changeWatchVerdict (no LLM);
  // this hook only reads the persisted, unconsumed record and appends it as
  // additionalContext. Gated by KHY_CHANGE_WATCH, independent of tool guards.
  try {
    const changeWatch = require('../changeWatchService');
    if (changeWatch.isWatchEnabled(process.env)) {
      module.exports.registerFunction('PrePrompt', changeWatch.makePrePromptInjector(), {
        source: 'builtin:ChangeWatchInjector',
        priority: 20,
      });
    }
  } catch {
    // changeWatchService not available — skip (feedback still reachable via cli/ai.js seam)
  }
  // Register built-in Qoder capability matching hook.
  // Observes PostResponse events from Qoder models and records skill gaps
  // when KHY coverage is below the configured threshold.
  if (process.env.KHY_TASK_HOOK_ENABLED !== '0') {
    try {
      const { makeQoderCapabilityHook } = require('./qoderCapabilityHook');
      module.exports.registerFunction('PostResponse', makeQoderCapabilityHook(), {
        source: 'builtin:qoder-capability-check',
        priority: 90,
        timeout: 3000,
      });
    } catch {
      // qoderCapabilityHook not available — skip
    }
  }
  _initialized = true;
  if (registry.count > 0) {
    console.log(`[Hooks] Loaded ${registry.count} hook(s)`);
  }
}

/**
 * Trigger hooks for an event.
 * @param {string} event - One of: PreToolUse, PostToolUse, PrePrompt, PostResponse, Stop, SubAgentStart, SubAgentEnd
 * @param {Object} context - Event-specific data
 * @returns {Promise<{blocked: boolean, reason?: string, context: Object}>}
 */
async function trigger(event, context = {}) {
  if (!_initialized) return { blocked: false, context };

  const hooks = registry.getHooks(event, context);
  if (hooks.length === 0) return { blocked: false, context };

  return runHooks(hooks, context);
}

function reload(projectDir) {
  init(projectDir);
}

/**
 * Register a function-based hook programmatically.
 * @param {string} event - Hook event name
 * @param {Function} handler - async (context) => {action, ...} | void
 * @param {object} [opts] - Options (pattern, timeout, source)
 */
function registerFunction(event, handler, opts) {
  registry.registerFunction(event, handler, opts);
}

function isInitialized() { return _initialized; }

module.exports = { init, trigger, reload, registerFunction, isInitialized, registry };
