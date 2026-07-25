'use strict';

/**
 * searchPlanBuilder.js — turn task signals into concrete search directives.
 *
 * Produces explicit { globs, grepPatterns, searchQueries } that drive
 * exploreTool's `patterns` / `grep_pattern` overrides directly — replacing the
 * tool's blind heuristic inference (_inferGlobPatterns / _inferGrepPattern)
 * with directives derived from the task's own identifiers, file/dir/ext hints.
 *
 * Web search queries are emitted ONLY when the task clearly needs external
 * knowledge (explicit markers, or no in-repo candidates found). A codebase task
 * does not trigger web search — staying precise, not omniscient.
 *
 * Pure; no I/O.
 */

const EXTERNAL_MARKERS = /\b(latest|newest|best practice|how to|changelog|release notes|cve|vulnerability|documentation|docs for|version of)\b|最新|最佳实践|官方文档|版本号|发行说明/iu;

// 收敛到 utils/escapeRegExp 单一真源(逐字节委托,调用点不变)
const _escapeRe = require('../../utils/escapeRegExp');

function _dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    if (!v) continue;
    const s = String(v);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * @param {object} signals  taskSignalExtractor output
 * @param {object} [opts]    { hasRepoCandidates?: boolean, maxGrep?: number, maxGlob?: number }
 * @returns {{globs:string[], grepPatterns:string[], searchQueries:string[]}}
 */
function buildSearchPlan(signals, opts = {}) {
  const sig = signals || {};
  const maxGrep = Number(opts.maxGrep) || 8;
  const maxGlob = Number(opts.maxGlob) || 8;

  const dirs = (sig.dirHints || []).filter(Boolean);
  const exts = (sig.extHints || []).filter(Boolean);
  const files = (sig.fileHints || []).filter(Boolean);

  // ---- globs ----------------------------------------------------------
  const globs = [];
  for (const f of files) {
    const norm = String(f).replace(/\\/g, '/').replace(/^\.\//, '');
    globs.push(norm.includes('/') ? norm : `**/${norm}`);
  }
  for (const d of dirs) {
    if (exts.length) for (const e of exts) globs.push(`${d}/**/*${e}`);
    else globs.push(`${d}/**/*`);
  }
  if (!dirs.length) for (const e of exts) globs.push(`**/*${e}`);

  // ---- grep patterns (identifiers + quoted literals) ------------------
  const grepTokens = _dedupe([
    ...(sig.identifiers || []),
    ...(sig.quoted || []),
  ]).slice(0, maxGrep);
  const grepPatterns = grepTokens.map(_escapeRe);

  // ---- web search queries (conservative) ------------------------------
  const searchQueries = [];
  const taskText = [
    ...(sig.keywords || []),
    ...(sig.quoted || []),
  ].join(' ');
  const wantsExternal = EXTERNAL_MARKERS.test(taskText) || opts.needWeb === true;
  const noRepoTarget = opts.hasRepoCandidates === false
    && grepPatterns.length === 0 && files.length === 0;
  if (wantsExternal || noRepoTarget) {
    const q = _dedupe([...(sig.quoted || []), ...(sig.keywords || [])]).slice(0, 4).join(' ').trim();
    if (q) searchQueries.push(q);
  }

  return {
    globs: _dedupe(globs).slice(0, maxGlob),
    grepPatterns: _dedupe(grepPatterns),
    searchQueries: _dedupe(searchQueries),
  };
}

module.exports = { buildSearchPlan, _escapeRe };
