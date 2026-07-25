'use strict';

/**
 * ccSkillBridge.js — pure leaf: the single source of truth for *where* Claude
 * Code stores installed skills on disk, so khy can reuse CC's skill marketplace
 * (anything CC installs, khy discovers too). Zero-IO / deterministic / never
 * throws.
 *
 * Background (verified on a real dev box): CC keeps SKILL.md skills under a few
 * roots:
 *   - ~/.claude/skills/<name>/SKILL.md               (user-installed skills)
 *   - <project>/.claude/skills/<name>/SKILL.md       (project-scoped skills)
 *   - ~/.claude/plugins/cache/<mkt>/.../SKILL.md     (marketplace plugin cache;
 *                                                     nested arbitrarily deep)
 *   - ~/.claude/local-plugins/<pkg>/skills/.../SKILL.md  (local plugin skills)
 * khy's SKILL.md parser (skillLoader.parseSkillFile) and its recursive scanner
 * (skillLoader._scanDirectory) are ALREADY byte-compatible with CC's format —
 * so "reuse CC's marketplace" reduces to feeding CC's on-disk roots into khy's
 * existing recursive discovery. That is exactly what this leaf computes.
 *
 * Contract: zero IO (no fs/network/clock; homedir/projectDir injected by the
 * shell), deterministic, never throws (fail-soft → []), env gate
 * KHY_CC_SKILL_BRIDGE default ON; OFF → isEnabled=false and the shell reverts
 * byte-for-byte to its legacy khy-only discovery chain.
 *
 * Honest boundary: this only *discovers* CC skills already present on disk; it
 * does not install, network-fetch, or execute anything. Installing new skills
 * remains CC's job — khy simply reads what CC put there.
 */

const path = require('path');

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** KHY_CC_SKILL_BRIDGE gate: default ON, {0,false,off,no} (case/space-insensitive) → OFF. */
function isCcSkillBridgeEnabled(env = process.env) {
  const raw = env && env.KHY_CC_SKILL_BRIDGE;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

/** Join fail-soft: any bad segment → ''. Keeps the leaf non-throwing. */
// 收敛到 utils/pathJoinSafe 单一真源(逐字节委托,调用点不变)
const _join = require('../utils/pathJoinSafe');

/**
 * Compute Claude Code's on-disk skill search roots (does NOT touch the fs — the
 * shell decides which of these actually exist and scans them recursively).
 *
 * @param {object} args
 * @param {string} args.homedir  user home (shell injects os.homedir())
 * @param {string} [args.projectDir] current project dir (optional)
 * @returns {Array<{dir:string, source:string}>} search roots in priority order
 *   (project before user before plugin caches). Empty array on any bad input.
 */
function ccSkillSearchPaths({ homedir, projectDir } = {}) {
  try {
    const out = [];
    const push = (dir, source) => { if (dir) out.push({ dir, source }); };

    // Project-scoped CC skills win first (closest to the work).
    if (projectDir) push(_join(projectDir, '.claude', 'skills'), 'cc-project');

    if (homedir) {
      // User-installed CC skills.
      push(_join(homedir, '.claude', 'skills'), 'cc-user');
      // Marketplace plugin cache — recursive scan handles the deep nesting
      // (cache/<mkt>/skills/.../<name>/SKILL.md).
      push(_join(homedir, '.claude', 'plugins', 'cache'), 'cc-plugin');
      // Locally-linked plugins (skills-main/skills/<name>/SKILL.md, etc.).
      push(_join(homedir, '.claude', 'local-plugins'), 'cc-local-plugin');
    }

    return out;
  } catch {
    return [];
  }
}

module.exports = {
  isCcSkillBridgeEnabled,
  ccSkillSearchPaths,
};
