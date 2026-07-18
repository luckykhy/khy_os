'use strict';

/**
 * opencodeAdapter.js — dedicated gateway adapter that lets khyos *command* the
 * OpenCode CLI as a first-class, individually-targetable executor (peer of
 * claudeAdapter / codexAdapter).
 *
 * goal「我希望 Khyos 可以指挥 cc、opencode 等代码编辑器」:khyos already commands
 * Claude Code / Codex / Aider; OpenCode was the missing editor. Registering a
 * dedicated adapter key `opencode` makes it reachable via
 * `gateway.generateWithAdapter('opencode', ...)` and AgentTool
 * `subagent_type:'opencode'` / `adapter:'opencode'` (see aiGateway `_adapters`
 * and AgentTool roleMap).
 *
 * Design — thin shell over cliToolAdapter (no spawn/stream/idle-timeout
 * duplication): detection + invocation reuse cliToolAdapter's battle-tested
 * child-process machinery, targeted at opencode via `cliTool:'opencode'`.
 * Argument shaping lives in the pure leaf opencodeInvocation.js.
 *
 * Gate KHY_OPENCODE (default on): when off, detect() reports unavailable so the
 * gateway skips this adapter entirely (byte-fallback to "opencode not wired").
 */

const cliToolAdapter = require('./cliToolAdapter');
const invocation = require('./opencodeInvocation');
const { buildFailure } = require('./_responseBuilder');

const _HEAL_OFF = new Set(['0', 'false', 'off', 'no']);

/**
 * Gate KHY_OPENCODE_AUTO_HEAL (default on): before khy commands `opencode run`,
 * auto-repair opencode's own config (~/.config/opencode/opencode.json). opencode
 * refuses to start if its `models` shape is corrupt (the内部 `{default,list}` shape
 * khy once wrote → "Expected object"). Healing it first means a khy-driven
 * opencode invocation self-recovers instead of dying at startup. Off → skip
 * (byte-fallback: no pre-invocation write).
 */
function _isAutoHealEnabled(env) {
  const v = (env || process.env || {}).KHY_OPENCODE_AUTO_HEAL;
  return !(v !== undefined && _HEAL_OFF.has(String(v).trim().toLowerCase()));
}

/** Best-effort pre-invocation heal of opencode's own config. Never throws. */
function _autoHeal(env) {
  try {
    if (!_isAutoHealEnabled(env)) return;
    require('../../externalApps/opencodeAdapter').repair(env);
  } catch { /* fail-soft: healing must never block the invocation */ }
}

function _available(force) {
  if (!invocation.isEnabled(process.env)) return false;
  try {
    const bin = require('./opencodeBinResolver').resolveOpencodeBin(process.env);
    return require('./_commandAvailability').isAvailable(bin, { force });
  } catch { return false; }
}

/** Sync detection (mirrors sibling adapters' detect signature). */
function detect(forceRefresh = false) {
  return _available(forceRefresh);
}

/** Async detection — probes without freezing the event loop. */
async function detectAsync(forceRefresh = false) {
  if (!invocation.isEnabled(process.env)) return false;
  try {
    const bin = require('./opencodeBinResolver').resolveOpencodeBin(process.env);
    return await require('./_commandAvailability').isAvailableAsync(bin, { force: forceRefresh });
  } catch { return false; }
}

/**
 * Generate by commanding `opencode run` (delegated to cliToolAdapter, targeted).
 * Re-tags the response adapter to 'opencode' for coherent telemetry.
 */
async function generate(prompt, options = {}) {
  if (!invocation.isEnabled(options.env || process.env)) {
    return buildFailure('opencode adapter disabled (KHY_OPENCODE=off)', {
      adapter: 'opencode', errorType: 'unavailable',
    });
  }
  _autoHeal(options.env || process.env); // 指挥前自动自愈 opencode.json,避免其因损坏配置拒启动
  const res = await cliToolAdapter.generate(prompt, { ...options, cliTool: 'opencode' });
  if (res && typeof res === 'object') return { ...res, adapter: 'opencode' };
  return res;
}

function getStatus() {
  const ok = detect();
  return {
    name: 'OpenCode',
    type: 'opencode',
    available: ok,
    detail: ok ? 'opencode run（指挥外部代码编辑器）' : '未检测到 (opencode)',
  };
}

function destroy() { /* no persistent state; detection cache lives in cliToolAdapter */ }

module.exports = {
  detect,
  detectAsync,
  generate,
  getStatus,
  destroy,
};
