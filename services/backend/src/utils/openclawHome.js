'use strict';

/**
 * openclawHome.js — pure leaf: the single source of truth for *where* OpenClaw
 * keeps its on-disk state (data) home, so every khy↔OpenClaw bridge
 * (skills / MCP / future agents) computes the same root. Zero-IO /
 * deterministic / never throws.
 *
 * Verified OpenClaw convention (phase 0):
 *   - default state home: ~/.openclaw/
 *   - overridable by env OPENCLAW_STATE_DIR
 *   - `--profile <name>` selects ~/.openclaw-<name>
 * khy adds ONE more override on top — KHY_OPENCLAW_DATA_HOME — so operators can
 * point every OpenClaw bridge at a custom root without touching OpenClaw's own
 * env. Precedence (highest first):
 *   1. KHY_OPENCLAW_DATA_HOME   (khy-side explicit override)
 *   2. OPENCLAW_STATE_DIR       (OpenClaw's own override)
 *   3. <homedir>/.openclaw[-<profile>]   (KHY_OPENCLAW_PROFILE mirrors --profile)
 *
 * Contract: zero IO (no fs/network/clock; homedir + env injected by the shell),
 * deterministic, never throws (fail-soft → '' meaning "no root → skip"). The
 * shell is responsible for existence checks: a missing dir is silently skipped.
 *
 * Honest boundary: this only *computes a path*; it does not read, create, or
 * probe anything. Whether the directory exists is the caller's concern.
 */

/** Join fail-soft: any bad segment → ''. Keeps the leaf non-throwing. */
const _join = require('./pathJoinSafe');

/**
 * Resolve OpenClaw's on-disk state (data) home.
 *
 * @param {object} args
 * @param {string} [args.homedir]  user home (shell injects os.homedir())
 * @param {object} [args.env]      environment map (shell injects process.env)
 * @returns {string} absolute state-home path, or '' when nothing resolves
 *   (no explicit override AND no homedir → caller skips the bridge).
 */
function openclawStateDir({ homedir, env } = {}) {
  try {
    const e = env || {};

    // 1 & 2: explicit dir overrides win outright (khy-side, then OpenClaw-side).
    const override = e.KHY_OPENCLAW_DATA_HOME || e.OPENCLAW_STATE_DIR;
    if (override && String(override).trim()) {
      return String(override).trim();
    }

    if (!homedir) {
      return '';
    }

    // 3: default ~/.openclaw, or ~/.openclaw-<profile> when a profile is named.
    const profile = e.KHY_OPENCLAW_PROFILE && String(e.KHY_OPENCLAW_PROFILE).trim();
    if (profile) {
      return _join(homedir, `.openclaw-${profile}`);
    }
    return _join(homedir, '.openclaw');
  } catch {
    return '';
  }
}

module.exports = {
  openclawStateDir,
};
