'use strict';

/**
 * repoMapRenderer.js — pure, deterministic renderer for the Repo Map.
 *
 * Leaf-module contract (like flagRegistry.js): NO IO, NO env reads, NEVER
 * throws. Given a context object (the shape produced by
 * projectMetadataService._internal._collectContext) it renders a compact
 * directory-tree skeleton plus per-file symbol signatures (`kind name`),
 * greedily filling a caller-supplied token budget highest-rank-first.
 *
 * The caller owns all policy (token budget, env flags); this module only turns
 * already-collected data into text. Same input → same output, every time.
 */

// contextWasm.estimateTokens is the canonical estimator (WASM with a chars/4 JS
// fallback); simpleTokenEstimate is the last-resort fallback if that require
// ever fails. Resolved once at load; both are pure w.r.t. this module.
let _estimateTokensImpl = null;
try {
  _estimateTokensImpl = require('../contextWasm').estimateTokens;
} catch {
  _estimateTokensImpl = null;
}
let _simpleTokenEstimate = null;
try {
  _simpleTokenEstimate = require('../../utils/simpleTokenEstimate');
} catch {
  _simpleTokenEstimate = null;
}

// Small token reserve so the truncation footer always fits inside the budget.
const FOOTER_RESERVE_TOKENS = 32;

/**
 * Estimate tokens for a string, tolerant of any estimator failure.
 * @param {string} text
 * @returns {number}
 */
function _estimateTokens(text) {
  const s = String(text == null ? '' : text);
  try {
    if (typeof _estimateTokensImpl === 'function') {
      const n = _estimateTokensImpl(s);
      if (Number.isFinite(n)) {
        return n;
      }
    }
  } catch {
    /* fall through to simple estimate */
  }
  try {
    if (typeof _simpleTokenEstimate === 'function') {
      const n = _simpleTokenEstimate(s);
      if (Number.isFinite(n)) {
        return n;
      }
    }
  } catch {
    /* fall through to chars/4 */
  }
  return Math.ceil(s.length / 4);
}

/** Normalize a relative path: forward slashes, drop a leading `./`. */
function _normalizeRel(rel) {
  if (typeof rel !== 'string' || !rel) {
    return '';
  }
  let r = rel.split('\\').join('/');
  if (r.startsWith('./')) {
    r = r.slice(2);
  }
  return r;
}

/**
 * Reference-frequency score for a symbol file.
 *
 * Ideally we would count how many other files reference this one via
 * import/require/from. That needs the raw source text, which is NOT present in
 * the collected context (only symbol declarations are). Documented fallback:
 * rank by symbol count — a file that declares more symbols is a heavier module
 * and a reasonable proxy for "referenced often". Deterministic and IO-free.
 *
 * TODO: when the context carries raw import edges, switch to a true reference
 * count here (the ranking call site is already isolated).
 * @param {{symbols?: Array}} sf
 * @returns {number}
 */
function _referenceScore(sf) {
  return Array.isArray(sf && sf.symbols) ? sf.symbols.length : 0;
}

/**
 * Rank symbol files: entry-point files first (in declared order), then the rest
 * by descending reference score with a stable path tie-break.
 * @param {object} ctx
 * @returns {Array<object>} ordered symbolFiles
 */
function _rankFiles(ctx) {
  const symbolFiles = Array.isArray(ctx && ctx.symbolFiles) ? ctx.symbolFiles.slice() : [];
  const det = (ctx && ctx.det) || {};
  const entryList =
    Array.isArray(det.entryPoints) && det.entryPoints.length
      ? det.entryPoints
      : Array.isArray(det.inferred)
        ? det.inferred
        : [];

  // Map entry-point path → declared order index (first occurrence wins).
  const entryOrder = new Map();
  entryList.forEach((e) => {
    const rel = _normalizeRel(e && e.path);
    if (rel && !entryOrder.has(rel)) {
      entryOrder.set(rel, entryOrder.size);
    }
  });

  const entries = [];
  const rest = [];
  for (const sf of symbolFiles) {
    const rel = _normalizeRel(sf && sf.rel);
    if (entryOrder.has(rel)) {
      entries.push(sf);
    } else {
      rest.push(sf);
    }
  }

  entries.sort((a, b) => {
    const oa = entryOrder.get(_normalizeRel(a.rel));
    const ob = entryOrder.get(_normalizeRel(b.rel));
    if (oa !== ob) {
      return oa - ob;
    }
    return _normalizeRel(a.rel) < _normalizeRel(b.rel) ? -1 : 1;
  });

  rest.sort((a, b) => {
    const sa = _referenceScore(a);
    const sb = _referenceScore(b);
    if (sa !== sb) {
      return sb - sa;
    } // higher score first
    const ra = _normalizeRel(a.rel);
    const rb = _normalizeRel(b.rel);
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });

  return entries.concat(rest);
}

/** Render one file block: `- `rel` (lang): kind name, kind name`. */
function _renderFileBlock(sf) {
  const rel = _normalizeRel(sf && sf.rel) || '(unknown)';
  const lang = (sf && sf.lang) || '';
  const symbols = Array.isArray(sf && sf.symbols) ? sf.symbols : [];
  const sig = symbols
    .map((s) => `${(s && s.kind) || ''} ${(s && s.name) || ''}`.trim())
    .filter(Boolean)
    .join(', ');
  const langTag = lang ? ` (${lang})` : '';
  return `- \`${rel}\`${langTag}: ${sig || '_无符号_'}`;
}

/**
 * Render a compact Repo Map from collected context.
 *
 * @param {object} ctx  Context object from _collectContext (projectName, det,
 *                       tree, symbolFiles, srcTree, limits).
 * @param {object} [opts]
 * @param {number} [opts.tokenBudget]  Token cap passed IN by the caller. The
 *                                     renderer never reads env for this.
 * @returns {{ text: string, fileCount: number, tokenCount: number, truncated: boolean }}
 */
function renderRepoMap(ctx, opts) {
  try {
    const options = opts || {};
    const budgetRaw = Number(options.tokenBudget);
    const budget = Number.isFinite(budgetRaw) && budgetRaw > 0 ? budgetRaw : Infinity;
    const projectName = (ctx && ctx.projectName) || 'project';
    const tree = ctx && typeof ctx.tree === 'string' ? ctx.tree : '';

    const ranked = _rankFiles(ctx);
    const totalFiles = ranked.length;

    // Header + directory-tree skeleton always lead the map.
    const header = [];
    header.push(`# 代码地图 — ${projectName}`);
    header.push('');
    header.push('## 目录结构');
    header.push(tree || '_（空项目）_');
    header.push('');
    header.push('## 文件符号');

    const lines = header.slice();
    // Budget available for file blocks, reserving room for a truncation footer.
    const blockBudget =
      budget === Infinity ? Infinity : Math.max(0, budget - FOOTER_RESERVE_TOKENS);

    let included = 0;
    let truncated = false;
    for (const sf of ranked) {
      const candidate = lines.concat(_renderFileBlock(sf));
      if (_estimateTokens(candidate.join('\n')) > blockBudget) {
        truncated = true;
        break;
      }
      lines.push(_renderFileBlock(sf));
      included += 1;
    }

    const remaining = totalFiles - included;
    if (truncated && remaining > 0) {
      lines.push(`… (还有 ${remaining} 个文件未展示)`);
    } else {
      truncated = false;
    }

    const text = lines.join('\n');
    return {
      text,
      fileCount: included,
      tokenCount: _estimateTokens(text),
      truncated,
    };
  } catch {
    // Leaf contract: never throw. Any unexpected failure → empty, safe result.
    return { text: '', fileCount: 0, tokenCount: 0, truncated: false };
  }
}

module.exports = {
  renderRepoMap,
  // Exposed for unit tests / reuse; all pure and IO-free.
  _internal: {
    _rankFiles,
    _renderFileBlock,
    _referenceScore,
    _normalizeRel,
    _estimateTokens,
    FOOTER_RESERVE_TOKENS,
  },
};
