/**
 * Tool access gateway — Claude Code SDK alignment (`--allowedTools` /
 * `--disallowedTools`, print mode).
 *
 * Single source of truth for the print-mode tool allow/deny set. It is consumed
 * by two distinct enforcement points so the gate holds no matter which backend
 * actually runs the tools:
 *
 *   1. khy-native path — toolCalling.getToolDefinitions() filters the surface the
 *      model sees, and executeTool() refuses a gated tool at the execution edge.
 *   2. external CLI delegate — cliToolAdapter shells out to the real Claude Code
 *      binary; {@link buildClaudeAllowDenyArgs} rewrites that invocation's
 *      `--allowedTools` / `--disallowedTools` flags so the delegate honours the
 *      same gate (Claude Code uses the identical flag names).
 *
 * Process-level state: print mode is a one-shot process, and the gate must reach
 * every adapter path through this shared module. Pure / leaf otherwise (no I/O).
 *
 * Matching is case-insensitive and ignores underscores, so Claude Code names
 * ("Read", "WebFetch", "mcp__fs__read_file") line up with khy-native names. Raw
 * (original-case) names are retained for propagation to the external CLI, which
 * expects canonical names like "Write".
 */

'use strict';

let _state = { allowedRaw: null, disallowedRaw: null, allowed: null, disallowed: null };

// 收敛到 utils/trimLowerStripUnderscores 单一真源(逐字节委托,调用点不变)
const _normalizeToolName = require('../utils/trimLowerStripUnderscores');

function _normSet(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const s = new Set(arr.map(_normalizeToolName).filter(Boolean));
  return s.size ? s : null;
}

function _rawList(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const out = arr.map((x) => String(x).trim()).filter(Boolean);
  return out.length ? out : null;
}

/**
 * Configure the gateway.
 * @param {{allowed?:string[], disallowed?:string[]}} gate
 */
function setToolAccessGateway(gate = {}) {
  _state = {
    allowedRaw: _rawList(gate.allowed),
    disallowedRaw: _rawList(gate.disallowed),
    allowed: _normSet(gate.allowed),
    disallowed: _normSet(gate.disallowed),
  };
}

/** Reset the gateway (test isolation / between runs). */
function clearToolAccessGateway() {
  _state = { allowedRaw: null, disallowedRaw: null, allowed: null, disallowed: null };
}

/** @returns {boolean} whether any allow/deny constraint is active. */
function isGatewayActive() {
  return !!(_state.allowed || _state.disallowed);
}

/**
 * Filter a list of tool definitions ({name}) by the active gate.
 * `disallowed` wins over `allowed`. Returns the input unchanged when inactive.
 * @param {Array<{name?:string}>} defs
 * @returns {Array}
 */
function filterToolDefs(defs) {
  if (!isGatewayActive() || !Array.isArray(defs)) return defs;
  const { allowed, disallowed } = _state;
  return defs.filter((d) => {
    const n = _normalizeToolName(d && d.name);
    if (disallowed && disallowed.has(n)) return false;
    if (allowed && !allowed.has(n)) return false;
    return true;
  });
}

/**
 * Decide whether a single tool name is blocked.
 * @param {string} toolName
 * @returns {string|null} refusal reason, or null when permitted
 */
function gatewayDecision(toolName) {
  if (!isGatewayActive()) return null;
  const { allowed, disallowed } = _state;
  const n = _normalizeToolName(toolName);
  if (disallowed && disallowed.has(n)) return `Tool "${toolName}" is blocked by --disallowedTools`;
  if (allowed && !allowed.has(n)) return `Tool "${toolName}" is not in --allowedTools`;
  return null;
}

/**
 * Rewrite the `--allowedTools` / `--disallowedTools` flag pair for an external
 * Claude Code invocation so the delegate enforces the same gate.
 *
 * - allowlist active → emit exactly the user's allowed names (intersected so a
 *   simultaneously-disallowed name never leaks back in).
 * - allowlist inactive → keep the adapter's default allow set, minus any
 *   disallowed names.
 * - disallowed names are also emitted via `--disallowedTools` (deny wins in
 *   Claude Code too — belt-and-suspenders).
 *
 * Returns a flat argv fragment, e.g. ['--allowedTools','Read,Grep','--disallowedTools','Write'].
 * When the gate is inactive, returns the default allow pair unchanged.
 *
 * @param {string[]} defaultAllowed  the adapter's built-in allowed tool names
 * @returns {string[]}
 */
function buildClaudeAllowDenyArgs(defaultAllowed) {
  const base = Array.isArray(defaultAllowed) ? defaultAllowed.slice() : [];
  if (!isGatewayActive()) return ['--allowedTools', base.join(',')];

  const { allowed, allowedRaw, disallowed, disallowedRaw } = _state;
  const isDenied = (name) => disallowed && disallowed.has(_normalizeToolName(name));

  let allowList;
  if (allowedRaw) {
    allowList = allowedRaw.filter((n) => !isDenied(n));
  } else {
    allowList = base.filter((n) => !isDenied(n));
  }

  const args = ['--allowedTools', allowList.join(',')];
  if (disallowedRaw && disallowedRaw.length) {
    args.push('--disallowedTools', disallowedRaw.join(','));
  }
  return args;
}

module.exports = {
  setToolAccessGateway,
  clearToolAccessGateway,
  isGatewayActive,
  filterToolDefs,
  gatewayDecision,
  buildClaudeAllowDenyArgs,
  _normalizeToolName,
};
