'use strict';

/**
 * ccAgentBridge.js — pure leaf: the single source of truth for *where* Claude
 * Code stores installed subagent definitions on disk, so khy can reuse CC's
 * agent marketplace (any agent CC installs becomes selectable in khy). Zero-IO /
 * deterministic / never throws.
 *
 * Background (verified against CC's layout): CC keeps markdown subagent defs at:
 *   - ~/.claude/agents/<name>.md                         (user-installed agents)
 *   - <projectDir>/.claude/agents/<name>.md              (project agents — khy's
 *     loader ALREADY reads this; not re-added here to avoid a duplicate scan)
 *   - ~/.claude/plugins/cache/<mkt>/.../agents/<name>.md (marketplace plugins)
 *   - ~/.claude/local-plugins/<pkg>/.../agents/<name>.md (local plugins)
 * khy's parseAgentFromMarkdown already accepts CC's frontmatter, so "reuse CC's
 * agent marketplace" reduces to feeding CC's agent roots into khy's loader. Flat
 * roots list .md directly; plugin roots are scanned by the shell for nested
 * `agents/` dirs (the leaf only says WHICH roots and whether to recurse).
 *
 * Contract: zero IO (no fs/network/clock; homedir/projectDir injected), pure,
 * never throws (fail-soft → []), env gate KHY_CC_AGENT_BRIDGE default ON; OFF →
 * isEnabled=false and the shell reverts byte-for-byte to its legacy search dirs.
 *
 * Honest boundary: discovery/reuse only — no install/fetch/exec. And khy's agent
 * loader is otherwise flat; the `recursive` flag exists solely so the shell can
 * find plugin-nested `agents/` dirs without changing how flat dirs are read.
 */

const path = require('path');

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** KHY_CC_AGENT_BRIDGE gate: default ON, {0,false,off,no} (case/space-insensitive) → OFF. */
function isCcAgentBridgeEnabled(env = process.env) {
  const raw = env && env.KHY_CC_AGENT_BRIDGE;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

/** Join fail-soft: any bad segment → ''. Keeps the leaf non-throwing. */
// 收敛到 utils/pathJoinSafe 单一真源(逐字节委托,调用点不变)
const _join = require('../utils/pathJoinSafe');

/**
 * Compute Claude Code's on-disk agent search roots (does NOT touch the fs).
 *
 * @param {object} args
 * @param {string} args.homedir  user home (shell injects os.homedir())
 * @returns {Array<{dir:string, source:string, recursive:boolean}>}
 *   flat roots (recursive:false → read `<dir>/*.md`) then plugin roots
 *   (recursive:true → shell finds nested `agents/*.md`). Empty on bad input.
 *   Project `.claude/agents` is intentionally omitted (khy's loader has it).
 */
function ccAgentSearchDirs({ homedir } = {}) {
  try {
    const out = [];
    const push = (dir, source, recursive) => { if (dir) out.push({ dir, source, recursive }); };

    if (homedir) {
      // User-installed CC agents — flat directory of <name>.md.
      push(_join(homedir, '.claude', 'agents'), 'cc-user', false);
      // Marketplace / local plugins — agents are nested under each plugin's
      // agents/ dir; the shell recurses to locate them.
      push(_join(homedir, '.claude', 'plugins', 'cache'), 'cc-plugin', true);
      push(_join(homedir, '.claude', 'local-plugins'), 'cc-plugin', true);
    }

    return out;
  } catch {
    return [];
  }
}

module.exports = {
  isCcAgentBridgeEnabled,
  ccAgentSearchDirs,
};
