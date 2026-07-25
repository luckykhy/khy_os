'use strict';

// External instruction-file include detection — pure leaf (no filesystem reads,
// deterministic, fail-soft). Aligns the LOGIC BEHIND Claude Code's
// ClaudeMdExternalIncludesDialog, NOT its modal look.
//
// CC reference: src/components/ClaudeMdExternalIncludesDialog.tsx +
// src/utils/claudemd.ts getExternalClaudeMdIncludes(). CC's documented 背后逻辑:
// a project's CLAUDE.md can `@import` other files; any import that resolves
// OUTSIDE the original working directory is a security concern (a third-party repo
// could point CLAUDE.md at your home dir / another project and silently inject
// untrusted instructions into the system prompt). CC surfaces a warning
// ("Allow external CLAUDE.md file imports? … Never allow this for third-party
// repositories.") and records per-project approval. Crucially CC EXCLUDES the
// User/global memory file (`file.type !== 'User'`) — the user's own global config
// is trusted; only PROJECT-level imports outside cwd are flagged.
//
// khy parity: khy's instructionFileService.resolveIncludes() already parses the
// same `@path` directives and ALREADY denies includes resolving outside
// baseDir AND homedir. But includes that land OUTSIDE the project cwd yet still
// UNDER $HOME (e.g. `@~/.aws/credentials`, `@../other-repo/khy.md`) are inlined
// SILENTLY — no warning. That is exactly CC's flagged case. This leaf detects that
// set so the loader can surface a warning, WITHOUT changing khy's allow/deny gate
// (display/awareness only — the security control flow is untouched).
//
// Honest divergence from CC: CC gathers the full flattened MemoryFileInfo[] and so
// also sees nested imports; this leaf inspects the TOP-LEVEL `@path` lines of one
// instruction file's raw content (the primary attack surface — a repo's own
// khy.md/CLAUDE.md pointing outside cwd). khy already caps nested include
// depth/count (MAX_INCLUDE_DEPTH/FILES). And khy warns (non-blocking) rather than
// gating with a modal, matching khy's existing inline `⚠ [SECURITY]` prompt-
// injection notice in loadInstructions.

const path = require('path');
const os = require('os');

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function externalIncludeWarningEnabled(env) {
  const raw = env && env.KHY_EXTERNAL_INCLUDE_WARNING;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

// Same `@path` directive shape resolveIncludes matches: a bare `@relpath` on its
// own line.
const INCLUDE_LINE_SOURCE = '^@(\\S+)\\s*$';

// True when `child` is the same path as `parent` or nested beneath it — using a
// path-separator boundary so `/foo/bar2` is NOT considered inside `/foo/bar`.
function _isInside(child, parent) {
  if (!parent) return false;
  if (child === parent) return true;
  const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(withSep);
}

// Detect top-level `@path` includes that khy WOULD inline (allowed: under baseDir
// or under $HOME, mirroring resolveIncludes' exact naive prefix gate) but that
// resolve OUTSIDE the project cwd — CC's "imports files outside the current
// working directory" set. Returns [{ path: relPath, resolved: absPath }, …],
// de-duplicated, order-preserving. Gate off / bad input / any error → [].
function detectExternalIncludes(content, baseDir, cwd, env) {
  try {
    if (!externalIncludeWarningEnabled(env || (typeof process !== 'undefined' ? process.env : {}))) return [];
    if (typeof content !== 'string' || content.length === 0) return [];
    const home = os.homedir();
    const base = path.resolve(baseDir || '.');
    const root = path.resolve(cwd || base);
    const out = [];
    const seen = new Set();
    const re = new RegExp(INCLUDE_LINE_SOURCE, 'gm');
    let m;
    while ((m = re.exec(content)) !== null) {
      const rel = m[1];
      const resolved = path.resolve(base, rel);
      // Mirror resolveIncludes' exact allow gate (naive startsWith): includes
      // outside BOTH baseDir and home are already DENIED by khy → never inlined →
      // no warning needed. We only warn about what khy actually injects.
      const allowed = resolved.startsWith(base) || resolved.startsWith(home);
      if (!allowed) continue;
      // External (CC): resolves outside the project working directory.
      if (_isInside(resolved, root)) continue;
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      out.push({ path: rel, resolved });
    }
    return out;
  } catch {
    return [];
  }
}

// Build the inline warning line for a file whose instructions import external
// paths. Mirrors CC's warning copy; Chinese (khy scope allows it) and shaped like
// loadInstructions' existing `⚠ [SECURITY] …` prompt-injection notice. Returns ''
// when there is nothing to warn about (caller then appends nothing → byte-
// identical fallback).
function buildExternalIncludeWarning(filePath, externals) {
  if (!Array.isArray(externals) || externals.length === 0) return '';
  const list = externals.map((e) => (e && e.path) ? e.path : String(e)).join(', ');
  return `⚠ [SECURITY] ${filePath} 引入了工作目录之外的文件(第三方仓库切勿允许): ${list}`;
}

module.exports = {
  externalIncludeWarningEnabled,
  detectExternalIncludes,
  buildExternalIncludeWarning,
  _isInside,
  INCLUDE_LINE_SOURCE,
};
