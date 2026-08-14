'use strict';

/**
 * openclawAdapter.js — dedicated gateway adapter that lets khyos *command* the
 * OpenClaw CLI as a portable, individually-targetable backend engine (peer of
 * opencodeAdapter / claudeAdapter / codexAdapter). Modeled on opencodeAdapter.js.
 *
 * Registering a dedicated adapter key `openclaw` makes it reachable via
 * `gateway.generateWithAdapter('openclaw', ...)` and AgentTool
 * `subagent_type:'openclaw'` / `adapter:'openclaw'` (see aiGateway `_adapters`).
 *
 * Design — thin shell over cliToolAdapter (no spawn/stream/idle-timeout
 * duplication): detection + invocation reuse cliToolAdapter's battle-tested
 * child-process machinery, targeted at openclaw via `cliTool:'openclaw'`.
 * Argument shaping lives in the pure leaf openclawInvocation.js. Unlike opencode,
 * OpenClaw needs no config auto-heal, so that block is intentionally omitted.
 *
 * Gate KHY_OPENCLAW (default OFF): when off, detect() reports unavailable so the
 * gateway skips this adapter entirely (byte-fallback to "openclaw not wired").
 * Flip the default on after a real smoke test passes (see openclawInvocation.js).
 */

const { buildFailure } = require('./_responseBuilder');
const cliToolAdapter = require('./cliToolAdapter');
const invocation = require('./openclawInvocation');

/** Resolve the openclaw bin name from the portable CLI registry (SSOT). */
function _bin() {
  try {
    const tool = require('./portableCliRegistry').getTool('openclaw');
    return (tool && tool.bin) || 'openclaw';
  } catch {
    return 'openclaw';
  }
}

function _available(force) {
  if (!invocation.isEnabled(process.env)) {
    return false;
  }
  try {
    return require('./_commandAvailability').isAvailable(_bin(), { force });
  } catch {
    return false;
  }
}

/** Sync detection (mirrors sibling adapters' detect signature). */
function detect(forceRefresh = false) {
  return _available(forceRefresh);
}

/** Async detection — probes without freezing the event loop. */
async function detectAsync(forceRefresh = false) {
  if (!invocation.isEnabled(process.env)) {
    return false;
  }
  try {
    return await require('./_commandAvailability').isAvailableAsync(_bin(), {
      force: forceRefresh,
    });
  } catch {
    return false;
  }
}

/**
 * Generate by commanding `openclaw agent exec` (delegated to cliToolAdapter,
 * targeted). Re-tags the response adapter to 'openclaw' for coherent telemetry.
 */
async function generate(prompt, options = {}) {
  if (!invocation.isEnabled(options.env || process.env)) {
    return buildFailure('openclaw adapter disabled (KHY_OPENCLAW=off)', {
      adapter: 'openclaw',
      errorType: 'unavailable',
    });
  }
  const res = await cliToolAdapter.generate(prompt, { ...options, cliTool: 'openclaw' });
  if (res && typeof res === 'object') {
    return { ...res, adapter: 'openclaw' };
  }
  return res;
}

function getStatus() {
  const ok = detect();
  return {
    name: 'OpenClaw',
    type: 'openclaw',
    available: ok,
    detail: ok ? 'openclaw agent exec（便携 CLI 后端引擎）' : '未检测到 (openclaw)',
  };
}

function destroy() {
  /* no persistent state; detection cache lives in cliToolAdapter */
}

module.exports = {
  detect,
  detectAsync,
  generate,
  getStatus,
  destroy,
};
