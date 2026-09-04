/**
 * Hook Registry — stores and matches lifecycle hooks.
 *
 * Hooks intercept CLI events at well-defined points:
 *   PreToolUse    — before a tool executes (can block/modify)
 *   PostToolUse   — after a tool returns (can transform result)
 *   PrePrompt     — before sending prompt to LLM
 *   PostResponse  — after receiving LLM response
 *   Stop          — when a task or session is stopped/interrupted
 *   SubAgentStart — when a sub-agent is spawned
 *   SubAgentEnd   — when a sub-agent completes
 *
 * Config: ~/.khyquant/hooks.json or project .khyquant/hooks.json
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PrePrompt',
  'PostResponse',
  'PreCompact',
  'PostCompact',
  'Stop',
  'SubAgentStart',
  'SubAgentEnd',
  // 插件注册点(Block B):插件在明确接缝上注册能力,而非散写进调用点。
  // ToolPermission 的 handler 只能**收紧**裁决(单调性由 hookContribSeams.tighten 强制,
  // 见该文件);PromptSection 只能**追加**段落,永不改写既有指令。
  'ToolPermission',
  'PromptSection',
];

// Lazily resolve the global hooks file (portable-aware); fallback to legacy.
function _globalHooksPath() {
  try {
    const { getAppHome } = require('../../../../utils/dataHome');
    return path.join(getAppHome(), 'hooks.json');
  } catch {
    return path.join(os.homedir(), '.khyquant', 'hooks.json');
  }
}

class HookRegistry {
  constructor() {
    this._hooks = new Map(); // event → Hook[]
    this._disabledHooks = new Set(); // hookId strings disabled via config
    for (const ev of HOOK_EVENTS) {
      this._hooks.set(ev, []);
    }
  }

  /**
   * Load hooks from config files (project-level overrides global).
   */
  load(projectDir) {
    this._clearAll();

    const configs = [];
    if (fs.existsSync(_globalHooksPath())) {
      configs.push({ source: 'global', path: _globalHooksPath() });
    }
    if (projectDir) {
      const projectHooks = path.join(projectDir, '.khyquant', 'hooks.json');
      if (fs.existsSync(projectHooks)) {
        configs.push({ source: 'project', path: projectHooks });
      }
    }

    for (const cfg of configs) {
      try {
        const raw = JSON.parse(fs.readFileSync(cfg.path, 'utf-8'));
        const hooks = Array.isArray(raw) ? raw : raw.hooks || [];
        // Populate disabled hooks list from config
        const disabled = Array.isArray(raw.disabled) ? raw.disabled : [];
        for (const id of disabled) {
          this._disabledHooks.add(String(id));
        }
        for (const h of hooks) {
          this._register(h, cfg.source);
        }
      } catch (err) {
        console.error(`[HookRegistry] Failed to load ${cfg.path}: ${err.message}`);
      }
    }
  }

  _register(hookDef, source) {
    const {
      event,
      command,
      handler,
      pattern,
      timeout = 10000,
      enabled = true,
      priority = 100,
    } = hookDef;
    if (!enabled) {
      return;
    }
    if (!HOOK_EVENTS.includes(event)) {
      console.warn(`[HookRegistry] Unknown event "${event}", skipping`);
      return;
    }
    const type = typeof handler === 'function' ? 'function' : 'command';
    if (type === 'command' && !command) {
      console.warn(`[HookRegistry] Hook missing "command", skipping`);
      return;
    }

    this._hooks.get(event).push({
      event,
      type,
      command: command || null,
      handler: type === 'function' ? handler : null,
      pattern: pattern ? new RegExp(pattern) : null,
      timeout,
      priority,
      source,
    });
  }

  /**
   * Register a function-based hook programmatically.
   * @param {string} event - One of HOOK_EVENTS
   * @param {Function} handler - async (context) => {action, ...} | void
   * @param {object} [opts]
   * @param {string} [opts.pattern] - RegExp pattern for filtering
   * @param {number} [opts.timeout] - Timeout in ms
   * @param {string} [opts.source] - Source label
   */
  registerFunction(event, handler, opts = {}) {
    if (!HOOK_EVENTS.includes(event)) {
      throw new Error(`Unknown hook event: ${event}. Valid: ${HOOK_EVENTS.join(', ')}`);
    }
    if (typeof handler !== 'function') {
      throw new Error('Hook handler must be a function');
    }
    // Config-gating: skip if this hook source is disabled
    const hookId = opts.source || '';
    if (hookId && !this.isHookEnabled(hookId)) {
      return;
    }

    this._hooks.get(event).push({
      event,
      type: 'function',
      command: null,
      handler,
      pattern: opts.pattern ? new RegExp(opts.pattern) : null,
      timeout: opts.timeout || 10000,
      priority: opts.priority || 100,
      source: opts.source || 'programmatic',
    });
  }

  /**
   * Get all hooks for a given event, optionally filtered by context.
   */
  getHooks(event, context = {}) {
    const hooks = this._hooks.get(event) || [];
    return hooks
      .filter((h) => {
        if (!h.pattern) {
          return true;
        }
        const target = context.toolName || context.prompt || '';
        return h.pattern.test(target);
      })
      .sort((a, b) => (a.priority || 100) - (b.priority || 100));
  }

  _clearAll() {
    for (const ev of HOOK_EVENTS) {
      this._hooks.set(ev, []);
    }
    this._disabledHooks.clear();
  }

  /**
   * Check whether a hook with the given source ID is enabled.
   * @param {string} hookId - Hook source identifier (e.g. 'builtin:OutputSizeGuard')
   * @returns {boolean}
   */
  isHookEnabled(hookId) {
    return !this._disabledHooks.has(hookId);
  }

  get events() {
    return [...HOOK_EVENTS];
  }
  get count() {
    let n = 0;
    for (const hooks of this._hooks.values()) {
      n += hooks.length;
    }
    return n;
  }
}

module.exports = new HookRegistry();
