'use strict';

/**
 * Agent Launcher Registry — SSOT for `khy <agent>` backend launch commands.
 *
 * `khy claude` / `khy codex` / `khy opencode` / … each enter an interactive
 * session driven by one specific gateway adapter. Historically the launchable
 * set was hardcoded in three drifting places (commandSchema ROUTER_COMMANDS,
 * the router switch, and the ide handler doc) and lagged behind the gateway's
 * actual adapter registry — e.g. an `opencode` adapter shipped and was routable
 * via subagent/preferredAdapter, but `khy opencode` did nothing.
 *
 * This module is the single declarative table of which agent backends are
 * launchable and how each is driven:
 *   - kind 'model-select' : adapter exposes listModels() → user picks a model →
 *                           chat via gateway.generateWithAdapter(key, prompt, {model}).
 *   - kind 'direct'       : adapter has no model list (it delegates to the
 *                           external agent's own provider/model, e.g. opencode) →
 *                           skip selection, chat straight through the adapter.
 *
 * Adding a new agent backend is now a one-line table entry here (plus its
 * gateway adapter); the guard test locks this registry against the live
 * gateway, command schema, and auth family so the three surfaces cannot drift.
 *
 * Contract (pure leaf): zero IO, deterministic, never throws.
 *
 * Gate KHY_AGENT_LAUNCHERS (default on). When off, only the legacy five
 * (claude/codex/cursor/kiro/trae) are returned, so the router/schema fall back
 * byte-for-byte to the pre-registry behavior.
 *
 * Invariants locked by agentLauncherRegistry.test.js against live sources:
 *   - every launcher.adapterKey is a registered gateway adapter key
 *   - every launcher.command is in commandSchema ROUTER_COMMANDS
 *   - every launcher.command is in featureKeyBuilder IDE_FAMILY_KEYS
 *     (so `<cmd>.launch` resolves login-free, same as claude)
 *   - model-select adapters expose listModels(); direct launchers do not
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

// The five launchers that existed before this registry — the byte-revert
// baseline the router/schema fall back to when the gate is off.
const LEGACY_LAUNCHER_COMMANDS = Object.freeze(['kiro', 'cursor', 'claude', 'codex', 'trae']);

/**
 * Declarative SSOT of launchable agent backends.
 *   command    — the `khy <command>` name (also the router-command / adapter key)
 *   adapterKey — the gateway adapter that drives the session
 *   kind       — 'model-select' (list→pick→chat) | 'direct' (delegate, no model list)
 *   legacy     — true = present before this registry (gate-off baseline)
 */
const AGENT_LAUNCHERS = Object.freeze([
  Object.freeze({ command: 'kiro', adapterKey: 'kiro', kind: 'model-select', legacy: true }),
  Object.freeze({ command: 'cursor', adapterKey: 'cursor', kind: 'model-select', legacy: true }),
  Object.freeze({ command: 'claude', adapterKey: 'claude', kind: 'model-select', legacy: true }),
  Object.freeze({ command: 'codex', adapterKey: 'codex', kind: 'model-select', legacy: true }),
  Object.freeze({ command: 'trae', adapterKey: 'trae', kind: 'model-select', legacy: true }),
  // ── New backends (adapters already registered in the gateway) ──
  Object.freeze({ command: 'opencode', adapterKey: 'opencode', kind: 'direct', legacy: false }),
  Object.freeze({ command: 'warp', adapterKey: 'warp', kind: 'model-select', legacy: false }),
  Object.freeze({ command: 'vscode', adapterKey: 'vscode', kind: 'model-select', legacy: false }),
  Object.freeze({ command: 'windsurf', adapterKey: 'windsurf', kind: 'model-select', legacy: false }),
]);

/**
 * Gate resolution. Prefer flagRegistry (centralized priority); fall back to a
 * local CANON word list when the registry is unavailable. Default on.
 * @param {object} [env]
 * @returns {boolean}
 */
function isLaunchersEnabled(env) {
  const e = env || (typeof process !== 'undefined' && process.env) || {};
  try {
    const reg = require('./flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_AGENT_LAUNCHERS', e);
    }
  } catch { /* registry unavailable → local fallback */ }
  const v = e.KHY_AGENT_LAUNCHERS;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * The active launcher set. Gate off → only the legacy five (byte-revert).
 * @param {object} [env]
 * @returns {Array<{command,adapterKey,kind,legacy}>} frozen entries
 */
function getAgentLaunchers(env) {
  if (!isLaunchersEnabled(env)) {
    return AGENT_LAUNCHERS.filter(l => l.legacy === true);
  }
  return AGENT_LAUNCHERS.slice();
}

/**
 * Just the `khy <command>` names of the active launchers.
 * @param {object} [env]
 * @returns {string[]}
 */
function getLauncherCommands(env) {
  return getAgentLaunchers(env).map(l => l.command);
}

/**
 * Resolve a launcher by its command name (case-insensitive). Returns null when
 * the name is not an active launcher.
 * @param {string} name
 * @param {object} [env]
 * @returns {{command,adapterKey,kind,legacy}|null}
 */
function resolveAgentLauncher(name, env) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  return getAgentLaunchers(env).find(l => l.command === n) || null;
}

/**
 * @returns {boolean} whether `name` is an active launcher command.
 */
function isAgentLauncherCommand(name, env) {
  return resolveAgentLauncher(name, env) !== null;
}

/**
 * @returns {boolean} whether `name` is an active launcher of kind 'direct'
 *   (no model selection; chat delegates straight to the external agent).
 */
function isDirectLauncher(name, env) {
  const l = resolveAgentLauncher(name, env);
  return l !== null && l.kind === 'direct';
}

module.exports = {
  AGENT_LAUNCHERS,
  LEGACY_LAUNCHER_COMMANDS,
  isLaunchersEnabled,
  getAgentLaunchers,
  getLauncherCommands,
  resolveAgentLauncher,
  isAgentLauncherCommand,
  isDirectLauncher,
};
