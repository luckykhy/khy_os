'use strict';

/**
 * localNlp.js — a zero-dependency, no-model NLP toolkit for LOCAL mode.
 *
 * Goal "无模型也要能用 — 在没有 AI 的情况怎么切词、总结、智能处理": when no model is
 * loaded at all, the deterministic tool loop still has to (a) segment a query
 * into terms (切词), (b) condense long tool output instead of raw-dumping it
 * (总结), and (c) rank/score text by relevance (智能处理). All of this is done
 * with classic IR techniques — no dictionary downloads, no model, pure CPU:
 *
 *   - Segmentation: ASCII word tokens + CJK "stopword-boundary" chunking for
 *     readable terms, and dictionary-free CJK BIGRAMS for robust scoring (the
 *     standard CJKAnalyzer approach — works without a word dictionary).
 *   - Keyword extraction: frequency × term-length weighting over the readable
 *     segmentation.
 *   - Summarization: extractive — split into sentences, score each by term
 *     salience (TF) + optional query focus + position prior, pick the top few,
 *     and restore original order. List-like / short text is passed through.
 *   - Relevance: fraction of query terms present in a candidate text.
 *
 * Everything is a pure function (testable, deterministic) and bounded by caps.
 * Stopword sets are overridable via env so nothing is hardcoded shut.
 */

// ── Stopwords ────────────────────────────────────────────────────────────────
// Single CJK function chars (used as segmentation boundaries and bigram noise
// filters) + common English stopwords. Extend via env (comma/space separated).
const _CJK_STOP_BASE = '的了在是我有和就不都一个也请帮吗呢吧啊把要能可给再这那它你他她们之与及或被让从向对所为以与到使';
const _EN_STOP_BASE = [
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'i',
  'me', 'my', 'we', 'you', 'your', 'he', 'she', 'they', 'them', 'do', 'does',
  'did', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as', 'and',
  'or', 'but', 'if', 'so', 'this', 'that', 'these', 'those', 'what', 'how', 'why',
  'when', 'where', 'which', 'can', 'will', 'would', 'should', 'could', 'please',
  'help', 'show', 'tell', 'give', 'about', 'into', 'over', 'than', 'then', 'also',
];

function _envSet(name, base) {
  const set = new Set(base);
  const raw = String(process.env[name] || '').trim();
  if (raw) for (const t of raw.split(/[\s,]+/)) if (t) set.add(t.toLowerCase());
  return set;
}

const CJK_STOP = _envSet('KHY_LOCAL_CJK_STOPWORDS', _CJK_STOP_BASE.split(''));
const EN_STOP = _envSet('KHY_LOCAL_EN_STOPWORDS', _EN_STOP_BASE);

const _CJK_RUN_RE = /[一-龥]+/g;
const _ASCII_RE = /[a-z0-9_]{2,}/g;

/**
 * Readable segmentation ("切词"): ASCII word tokens + CJK runs split at stopword
 * characters. Dictionary-free yet produces human-readable multi-char terms
 * (e.g. "本地模式工具循环" → 本地模式 / 工具循环). This is the explainable cut used
 * for keyword display and for choosing a search/grep term.
 * @param {string} text
 * @returns {string[]}
 */
function segmentWords(text) {
  const s = String(text || '');
  const out = [];
  const ascii = s.toLowerCase().match(_ASCII_RE) || [];
  for (const w of ascii) if (!EN_STOP.has(w)) out.push(w);
  const runs = s.match(_CJK_RUN_RE) || [];
  for (const run of runs) {
    let cur = '';
    for (const ch of run) {
      if (CJK_STOP.has(ch)) {
        if (cur) out.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

/**
 * Scoring tokenizer: ASCII words + dictionary-free CJK BIGRAMS (plus lone
 * non-stopword chars for 1-char runs). Consistent granularity makes TF and
 * overlap scoring robust across query and document. Not meant to be read.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const out = [];
  const ascii = s.match(_ASCII_RE) || [];
  for (const w of ascii) if (!EN_STOP.has(w)) out.push(w);
  const runs = s.match(_CJK_RUN_RE) || [];
  for (const run of runs) {
    if (run.length === 1) {
      if (!CJK_STOP.has(run)) out.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) {
      const bg = run.slice(i, i + 2);
      // Drop a bigram made entirely of stopword chars (e.g. 的了) — pure noise.
      if (CJK_STOP.has(bg[0]) && CJK_STOP.has(bg[1])) continue;
      out.push(bg);
    }
  }
  return out;
}

function _freq(terms) {
  const m = new Map();
  for (const t of terms) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

/**
 * Extract the top keywords from text by frequency × length weighting over the
 * readable segmentation. Longer, more frequent terms rank first.
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.limit=8]
 * @returns {string[]}
 */
function extractKeywords(text, opts = {}) {
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 8;
  const terms = segmentWords(text).filter(t => t.length >= 2 || /[a-z0-9]/.test(t));
  if (!terms.length) return [];
  const freq = _freq(terms);
  const ranked = [...freq.entries()]
    .map(([term, f]) => ({ term, score: f * (1 + 0.4 * (Array.from(term).length - 1)) }))
    .sort((a, b) => b.score - a.score);
  return ranked.slice(0, limit).map(r => r.term);
}

/**
 * Relevance of a candidate text to a query: the fraction of distinct query
 * terms that appear in the candidate (bigram/word overlap). Range [0,1].
 * @param {string} text
 * @param {string} query
 * @returns {number}
 */
function scoreRelevance(text, query) {
  const q = new Set(tokenize(query));
  if (!q.size) return 0;
  const d = new Set(tokenize(text));
  if (!d.size) return 0;
  let hit = 0;
  for (const t of q) if (d.has(t)) hit += 1;
  return hit / q.size;
}

// ── Sentence splitting ───────────────────────────────────────────────────────
const _SENT_MARK = '';
function splitSentences(text) {
  const marked = String(text || '')
    .replace(/([。！？!?；;])/g, `$1${_SENT_MARK}`)
    .replace(/([.])(\s)/g, `$1${_SENT_MARK}$2`);
  return marked
    .split(new RegExp(`${_SENT_MARK}|[\\r\\n]+`))
    // Strip the trailing terminator(s) so a sentence is its content, not its
    // punctuation — splitting already captured the boundary.
    .map(s => s.trim().replace(/[。！？!?；;.]+$/, '').trim())
    .filter(s => s.length >= 2);
}

/** A short signature for near-duplicate sentence detection (web snippets repeat). */
function _sentSig(sentence) {
  return tokenize(sentence).slice(0, 8).join('|');
}

/**
 * Heuristic: is this body prose worth summarizing, or a list/table to keep raw?
 * git status / ls / grep output is line-oriented and must not be reflowed.
 */
function _isProse(text) {
  const s = String(text);
  const lines = s.split(/\r?\n/).filter(l => l.trim());
  // Count real sentence terminators (CJK + ASCII-with-trailing-space).
  const terminators = (s.match(/[。！？!?；;]/g) || []).length + (s.match(/[.]\s/g) || []).length;
  // Several lines but almost no terminators → list/table (git status, ls, grep
  // file lists). Must not be reflowed; keep raw.
  if (lines.length >= 3 && terminators < lines.length * 0.5) return false;
  return true;
}

function _truncate(text, maxChars) {
  const s = String(text);
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars - 1) + '…';
}

/**
 * Extractive summarization ("总结") — no model. Splits text into sentences,
 * scores each by TF salience (+ optional query focus + a small position prior),
 * selects the highest-scoring few within a character budget, and restores their
 * original order. List-like or already-short text is returned (truncated) as-is.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.query]          focus terms get a relevance bonus.
 * @param {number} [opts.maxSentences=3]
 * @param {number} [opts.maxChars=600]
 * @returns {string}
 */
function summarize(text, opts = {}) {
  const body = String(text || '');
  const maxSentences = Number.isFinite(opts.maxSentences) && opts.maxSentences > 0 ? opts.maxSentences : 3;
  const maxChars = Number.isFinite(opts.maxChars) && opts.maxChars > 0 ? opts.maxChars : 600;
  if (body.length <= maxChars) return body;

  const sentences = splitSentences(body);
  if (sentences.length <= maxSentences || !_isProse(body)) {
    return _truncate(body, maxChars);
  }

  // Document-level term frequency = salience weight for each term.
  const tf = _freq(tokenize(body));
  const queryTerms = opts.query ? new Set(tokenize(opts.query)) : null;
  const qSize = queryTerms ? queryTerms.size : 0;
  const n = sentences.length;

  const scored = sentences.map((sentence, idx) => {
    const terms = tokenize(sentence);
    let salience = 0;
    const qSeen = new Set();
    for (const t of terms) {
      salience += tf.get(t) || 0;
      if (queryTerms && queryTerms.has(t)) qSeen.add(t);
    }
    // Normalize by sqrt(len) so long sentences don't always win.
    const norm = salience / Math.sqrt(terms.length || 1);
    // Position prior: lead and final sentences carry more signal.
    const pos = (idx === 0 || idx === n - 1) ? 1.15 : 1.0;
    const qFrac = qSize ? qSeen.size / qSize : 0;
    return { idx, sentence, base: norm * pos, qFrac, len: sentence.length };
  });

  // Query-focused ranking: when a query is given, a sentence covering MORE query
  // terms always outranks one covering fewer (salience only breaks ties). This
  // is decisive regardless of TF magnitude — an absolute/multiplicative salience
  // bonus drowns when unrelated sentences share high-frequency bigrams. With no
  // query, fall back to pure salience.
  const ranked = [...scored].sort((a, b) => {
    if (qSize && b.qFrac !== a.qFrac) return b.qFrac - a.qFrac;
    return b.base - a.base;
  });

  const picked = [];
  const seen = new Set();
  let budget = maxChars;
  for (const s of ranked) {
    if (picked.length >= maxSentences) break;
    const sig = _sentSig(s.sentence);
    if (sig && seen.has(sig)) continue; // skip near-duplicate
    if (s.len > budget && picked.length) continue;
    seen.add(sig);
    picked.push(s);
    budget -= s.len;
    if (budget <= 0) break;
  }
  // Restore original reading order.
  picked.sort((a, b) => a.idx - b.idx);
  const joined = picked.map(s => s.sentence).join(' ');
  return _truncate(joined, maxChars);
}

module.exports = {
  segmentWords,
  tokenize,
  extractKeywords,
  scoreRelevance,
  splitSentences,
  summarize,
  CJK_STOP,
  EN_STOP,
};
