'use strict';

/**
 * MCP auto-connect (the missing runtime trigger).
 *
 * The consumer-side MCP client (services/mcp/index.js) was fully built and
 * unit-tested — stdio/HTTP/SSE transports, JSON-RPC, OAuth, collision-safe
 * `mcp__server__tool` naming, a per-turn registry refresh (toolPool.js) — but
 * NOTHING in production ever called `connectAll()`. Consequence:
 * `refreshMcpToolPool()` ran every loop turn yet `getConnectedServers()` was
 * always empty, so tools from a user's configured external MCP servers
 * (`~/.khy/mcp.json` / `<project>/.khy/mcp.json`) were never reachable.
 *
 * This leaf closes that gap with a one-shot, best-effort connect that runs once
 * per process at loop entry, mirroring the lazy `_getHookSystem()` pattern:
 *
 *   - One-shot: a latch (process-level by default, injectable for tests) ensures
 *     we connect at most once per process; persistent connections then survive
 *     across turns and the per-turn refresh picks up their tools.
 *   - Gated: `KHY_MCP_AUTOCONNECT` (default ON). Setting it to `false` yields the
 *     exact legacy behaviour (servers never connect) — byte-identical rollback.
 *   - Zero-cost when idle: if no servers are configured, returns immediately
 *     without spawning anything (the common case — no servers ship by default).
 *   - Best-effort: never throws. A connect failure must never break the loop.
 *
 * Dependencies (manager / env / latch state) are injectable so the decision and
 * dispatch logic are unit-testable with fakes — no subprocess, no network.
 */

const defaultManager = require('./index');

/**
 * Whether auto-connect is enabled. Default ON; only an explicit `false`
 * (case-insensitive) disables it, so the gate-off path is the legacy behaviour.
 * @param {object} [env]
 * @returns {boolean}
 */
function autoConnectEnabled(env = process.env) {
  return String((env && env.KHY_MCP_AUTOCONNECT) || '').toLowerCase() !== 'false';
}

// Process-level one-shot latch (default). Tests inject their own `state` to stay
// isolated, so no reset hook is needed.
const _processState = { started: false };

/**
 * Connect to configured client-side MCP servers exactly once per process.
 *
 * @param {object} [opts]
 * @param {object} [opts.manager]    MCP manager (default: services/mcp/index).
 * @param {object} [opts.env]        env source (default: process.env).
 * @param {string} [opts.projectDir] project dir for project-local mcp.json.
 * @param {{started:boolean}} [opts.state] one-shot latch (default: process singleton).
 * @returns {Promise<{connected?:string[], failed?:object[], skipped?:string, error?:string}>}
 */
async function ensureMcpConnected({
  manager = defaultManager,
  env = process.env,
  projectDir,
  state,
} = {}) {
  const st = state || _processState;
  if (st.started) return { skipped: 'already-started' };
  st.started = true;

  // Gate OFF → legacy behaviour: never connect.
  if (!autoConnectEnabled(env)) return { skipped: 'disabled' };

  try {
    // Cheap pre-check: don't pay any connect cost when nothing is configured.
    const cfg = typeof manager.loadConfig === 'function'
      ? (manager.loadConfig(projectDir) || { mcpServers: {} })
      : { mcpServers: {} };
    const names = Object.keys(cfg.mcpServers || {});
    if (!names.length) return { skipped: 'no-servers' };

    if (typeof manager.connectAll !== 'function') return { skipped: 'unsupported' };
    const res = await manager.connectAll(projectDir);
    return {
      connected: (res && res.connected) || [],
      failed: (res && res.failed) || [],
    };
  } catch (e) {
    // Best-effort: surface the message for diagnostics but never throw.
    return { error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { ensureMcpConnected, autoConnectEnabled };
