'use strict';

/**
 * ocSkillBridge.js — pure leaf: the single source of truth for *where* OpenClaw
 * stores installed skills on disk, so khy can reuse OpenClaw's skill assets
 * (anything OpenClaw installs, khy discovers too). Zero-IO / deterministic /
 * never throws. Mirrors ccSkillBridge.js.
 *
 * Verified OpenClaw convention (phase 0): skills live under the OpenClaw state
 * home at
 *   - <stateHome>/skills/<name>/SKILL.md
 * where <stateHome> defaults to ~/.openclaw and is resolved (with the
 * KHY_OPENCLAW_DATA_HOME / OPENCLAW_STATE_DIR / --profile overrides) by the
 * shared utils/openclawHome leaf. The SKILL.md format (AgentSkills.io: YAML
 * frontmatter with required name/description + markdown body) is BYTE-COMPATIBLE
 * with khy's skillLoader parser, so "reuse OpenClaw's skills" reduces to feeding
 * OpenClaw's on-disk skills root into khy's existing recursive discovery. That
 * is exactly what this leaf computes; NO format conversion happens.
 *
 * Contract: zero IO (no fs/network/clock; homedir + env injected by the shell),
 * deterministic, never throws (fail-soft → []), env gate
 * KHY_OPENCLAW_SKILL_BRIDGE default ON; OFF → isEnabled=false and the shell
 * reverts byte-for-byte to its prior discovery chain (khy + CC bridge only).
 *
 * Honest boundary: this only *discovers* OpenClaw skills already present on
 * disk; it does not install, network-fetch, or execute anything. A missing
 * directory is silently skipped by the shell (fail-soft).
 *
 * Note on workspace-level skills: OpenClaw also documents a bare
 * `<workspace>/skills/` convention, but that root is intentionally NOT emitted
 * here — a plain `<projectDir>/skills` is too generic (many repos ship an
 * unrelated `skills/` dir) to auto-scan safely. Only the OpenClaw state-home
 * skills root is bridged.
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** KHY_OPENCLAW_SKILL_BRIDGE gate: default ON, {0,false,off,no} (case/space-insensitive) → OFF. */
function isOcSkillBridgeEnabled(env = process.env) {
  const raw = env && env.KHY_OPENCLAW_SKILL_BRIDGE;
  const v = String(raw === undefined || raw === null ? 'true' : raw)
    .trim()
    .toLowerCase();
  return !_FALSY.has(v);
}

/** Join fail-soft: any bad segment → ''. Keeps the leaf non-throwing. */
const { openclawStateDir } = require('../utils/openclawHome');
const _join = require('../utils/pathJoinSafe');

/**
 * Compute OpenClaw's on-disk skill search roots (does NOT touch the fs — the
 * shell decides which of these actually exist and scans them recursively).
 *
 * @param {object} args
 * @param {string} [args.homedir]  user home (shell injects os.homedir())
 * @param {object} [args.env]      environment map (shell injects process.env);
 *   drives the KHY_OPENCLAW_DATA_HOME / OPENCLAW_STATE_DIR / --profile overrides.
 * @returns {Array<{dir:string, source:string}>} search roots (empty on bad input
 *   or when no state home resolves). Source is `oc-*` namespaced so it never
 *   collides with khy/CC sources.
 */
function ocSkillSearchPaths({ homedir, env = process.env } = {}) {
  try {
    const out = [];
    const stateDir = openclawStateDir({ homedir, env });
    if (stateDir) {
      const skillsDir = _join(stateDir, 'skills');
      if (skillsDir) {
        out.push({ dir: skillsDir, source: 'oc-user' });
      }
    }
    return out;
  } catch {
    return [];
  }
}

module.exports = {
  isOcSkillBridgeEnabled,
  ocSkillSearchPaths,
};
