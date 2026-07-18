'use strict';

/**
 * ccCommandBridge.js — pure leaf: the single source of truth for *where* Claude
 * Code stores custom slash commands on disk, so khy can reuse the community's
 * slash-command packs (anything CC installs or a repo ships under `.claude/commands`,
 * khy discovers too). Zero-IO / deterministic / never throws.
 *
 * Background (verified on a real dev box + Claude Code docs): CC loads custom
 * slash commands from markdown files under a couple of roots:
 *   - <project>/.claude/commands/<name>.md        (project-scoped commands)
 *   - <project>/.claude/commands/<ns>/<name>.md   (namespaced → /ns:name)
 *   - ~/.claude/commands/<name>.md                (user-personal commands)
 * Each file is YAML frontmatter (description / argument-hint / allowed-tools /
 * model) plus a markdown body that IS the prompt, with `$ARGUMENTS` / `$1..$9`
 * placeholders. This is exactly the format thriving community "command pack"
 * repos ship. khy already had its own khy-native command mechanisms but never
 * read CC's `.claude/commands` — so third-party CC command packs were invisible.
 *
 * This leaf is the disk-location half of the bridge (mirrors ccSkillBridge /
 * ccAgentBridge): it only computes the search roots. The discovery + parse +
 * dispatch half lives in cli/repl/ccUserCommands.js, which feeds these roots
 * into khy's existing slash-command surface.
 *
 * Contract: zero IO (no fs/network/clock; homedir/projectDir injected by the
 * shell), deterministic, never throws (fail-soft → []), env gate
 * KHY_CC_COMMAND_BRIDGE default ON; OFF → isEnabled=false and the shell reverts
 * byte-for-byte to its legacy khy-only command discovery.
 *
 * Honest boundary: this only *discovers* CC command files already present on
 * disk; it does not install, network-fetch, or execute anything. Installing a
 * command pack (git clone / CC marketplace) remains the user's / CC's job — khy
 * simply reads what is there.
 */

const path = require('path');

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** KHY_CC_COMMAND_BRIDGE gate: default ON, {0,false,off,no} (case/space-insensitive) → OFF. */
function isCcCommandBridgeEnabled(env = process.env) {
  const raw = env && env.KHY_CC_COMMAND_BRIDGE;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

/** Join fail-soft: any bad segment → ''. Keeps the leaf non-throwing. */
// 收敛到 utils/pathJoinSafe 单一真源(逐字节委托,调用点不变)
const _join = require('../utils/pathJoinSafe');

/**
 * Compute Claude Code's on-disk slash-command search roots (does NOT touch the
 * fs — the shell decides which of these actually exist and scans them, one
 * level of namespace subdirectories deep).
 *
 * Project-scoped commands win first (closest to the work), then user-personal.
 * Consumers must list khy's own roots BEFORE these so khy wins name ties (the
 * same first-match-wins ordering ccSkillBridge/ccAgentBridge rely on).
 *
 * @param {object} args
 * @param {string} [args.homedir]    user home (shell injects os.homedir())
 * @param {string} [args.projectDir] current project dir (optional)
 * @returns {Array<{dir:string, source:string}>} search roots in priority order.
 *   Empty array on any bad input.
 */
function ccCommandSearchDirs({ homedir, projectDir } = {}) {
  try {
    const out = [];
    const push = (dir, source) => { if (dir) out.push({ dir, source }); };

    // Project-scoped CC commands win first.
    if (projectDir) push(_join(projectDir, '.claude', 'commands'), 'cc-project');
    // User-personal CC commands.
    if (homedir) push(_join(homedir, '.claude', 'commands'), 'cc-user');

    return out;
  } catch {
    return [];
  }
}

module.exports = {
  isCcCommandBridgeEnabled,
  ccCommandSearchDirs,
};
