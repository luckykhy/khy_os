'use strict';

/**
 * envFingerprint.js — environment fingerprint for trajectory replay (DESIGN-ARCH-048 PHASE 2).
 *
 * Deterministic replay is only sound under the user's "relatively static
 * environment" assumption. This module captures a small, comparable fingerprint
 * of the recording environment so the replay engine can gate before re-executing:
 * on a mismatch it warns and lists every diff, and only proceeds under --force
 * (状态透明 — never a silent "close enough").
 *
 * 零硬编码: the toolchain probe list is env-tunable (KHY_REPLAY_FINGERPRINT_TOOLS,
 * default "node"), and every probe is bounded by an activity timeout
 * (KHY_REPLAY_PROBE_TIMEOUT_MS, default 3000ms) so a hung tool never wedges
 * capture. Capture is total: any missing field resolves to null, never throws.
 */

const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const artifactHash = require('./artifactHash');

const DEFAULT_PROBE_TOOLS = 'node';
const DEFAULT_PROBE_TIMEOUT_MS = 3000;

/** Parse the env-configured toolchain probe list (comma/space separated). */
function _probeTools() {
  const raw = process.env.KHY_REPLAY_FINGERPRINT_TOOLS;
  const list = (raw == null || raw === '' ? DEFAULT_PROBE_TOOLS : raw)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : [DEFAULT_PROBE_TOOLS];
}

function _probeTimeoutMs() {
  const n = parseInt(process.env.KHY_REPLAY_PROBE_TIMEOUT_MS, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PROBE_TIMEOUT_MS;
}

/**
 * Probe a single tool's version string. Best-effort, time-bounded; returns null
 * on any failure (missing tool, timeout, non-zero exit).
 */
function _probeToolVersion(tool, timeoutMs) {
  try {
    const out = execFileSync(tool, ['--version'], {
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      windowsHide: true,
    });
    return String(out).trim().split('\n')[0] || null;
  } catch {
    return null;
  }
}

/**
 * Capture an environment fingerprint. Synchronous, best-effort, total.
 * @param {object} [opts]
 * @param {string} [opts.cwd]            override the recorded cwd
 * @param {string} [opts.manifestPath]   a project manifest to hash (e.g. package.json)
 * @returns {object} EnvFingerprint
 */
function capture(opts = {}) {
  const timeoutMs = _probeTimeoutMs();
  const toolchain = {};
  for (const tool of _probeTools()) {
    toolchain[tool] = _probeToolVersion(tool, timeoutMs);
  }

  let osInfo = null;
  try {
    osInfo = { platform: os.platform(), release: os.release(), arch: os.arch() };
  } catch { osInfo = null; }

  let nodeVersion = null;
  try { nodeVersion = process.version || null; } catch { nodeVersion = null; }

  let cwd = null;
  try { cwd = opts.cwd != null ? String(opts.cwd) : process.cwd(); } catch { cwd = null; }

  let manifestHash = null;
  if (opts.manifestPath) {
    try { manifestHash = artifactHash.hashFile(path.resolve(opts.manifestPath)); } catch { manifestHash = null; }
  }

  let capturedAt = null;
  try { capturedAt = Date.now(); } catch { capturedAt = null; }

  return { os: osInfo, node: nodeVersion, cwd, toolchain, manifestHash, capturedAt };
}

/** Walk two plain objects and collect leaf-value differences as dotted paths. */
function _diffLeaves(prefix, a, b, out) {
  const keys = new Set([
    ...(a && typeof a === 'object' ? Object.keys(a) : []),
    ...(b && typeof b === 'object' ? Object.keys(b) : []),
  ]);
  for (const k of keys) {
    const pa = a ? a[k] : undefined;
    const pb = b ? b[k] : undefined;
    const key = prefix ? `${prefix}.${k}` : k;
    const bothObj = pa && pb && typeof pa === 'object' && typeof pb === 'object';
    if (bothObj) {
      _diffLeaves(key, pa, pb, out);
    } else if (JSON.stringify(pa) !== JSON.stringify(pb)) {
      out.push({ field: key, recorded: pa == null ? null : pa, current: pb == null ? null : pb });
    }
  }
}

/**
 * Compare a recorded fingerprint against the current one. `capturedAt` is
 * intentionally ignored — wall-clock drift is expected and not a mismatch.
 * @returns {{match:boolean, diffs:Array<{field,recorded,current}>}}
 */
function compare(recorded, current) {
  const a = { ...(recorded || {}) };
  const b = { ...(current || {}) };
  delete a.capturedAt;
  delete b.capturedAt;
  const diffs = [];
  _diffLeaves('', a, b, diffs);
  return { match: diffs.length === 0, diffs };
}

module.exports = {
  DEFAULT_PROBE_TOOLS,
  DEFAULT_PROBE_TIMEOUT_MS,
  capture,
  compare,
  _probeTools,
  _probeTimeoutMs,
};
