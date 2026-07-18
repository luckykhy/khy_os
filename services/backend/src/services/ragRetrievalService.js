'use strict';

/**
 * RAG Retrieval Service — lightweight hybrid retrieval for chat augmentation.
 *
 * Goals:
 * - Keep retrieval local and fast (no extra network calls)
 * - Blend structured knowledge base + session history search
 * - Return compact, source-tagged context snippets for prompt augmentation
 */

const MAX_CACHE_ENTRIES = 120;
const DEFAULT_CACHE_TTL_MS = 90_000;
const DEFAULT_KNOWLEDGE_TOPK = 4;
const DEFAULT_SESSION_TOPK = 3;
const DEFAULT_TOTAL_TOPK = 6;
const DEFAULT_MAX_CONTEXT_CHARS = 2_400;

const _cache = new Map();

function _envBool(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const raw = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'y'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(raw)) return false;
  return fallback;
}

function _envInt(value, fallback, min, max) {
  const n = parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  if (typeof min === 'number' && n < min) return min;
  if (typeof max === 'number' && n > max) return max;
  return n;
}

function isEnabled() {
  return _envBool(process.env.KHY_RAG_ENABLED, true);
}

function _isGreetingLike(text = '') {
  const raw = String(text || '').trim().toLowerCase();
  return /^(hi|hello|hey|yo|你好|您好|在吗|在么|嗨)$/.test(raw);
}

function _shouldRetrieve(query = '', options = {}) {
  if (!isEnabled()) return false;
  if (options && options.isFollowUp) return false;
  const text = String(query || '').trim();
  if (!text) return false;
  if (text.startsWith('/')) return false;
  if (_isGreetingLike(text)) return false;
  if (text.length < 4 && !/[\u4e00-\u9fff]/.test(text)) return false;
  return true;
}

// 收敛到 utils/collapseWhitespaceLoose 单一真源(逐字节委托,调用点不变)
const _normalizeSpace = require('../utils/collapseWhitespaceLoose');

function _truncate(text = '', maxLen = 220) {
  const normalized = _normalizeSpace(text);
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen - 3)}...`;
}

// ── Synonym map for query expansion ──
const _SYNONYMS = {
  '量化': ['quant', '程序化'], 'quant': ['量化'],
  '止损': ['stop_loss', '离场'], 'stop_loss': ['止损'],
  '均线': ['ma', '移动平均'], 'ma': ['均线'],
  '回测': ['backtest'], 'backtest': ['回测'],
  '仓位': ['position', '资金管理'], 'position': ['仓位'],
  '因子': ['factor'], 'factor': ['因子'],
  '回撤': ['drawdown'], 'drawdown': ['回撤'],
  '波动率': ['volatility'], 'volatility': ['波动率'],
  '对冲': ['hedge'], 'hedge': ['对冲'],
  '夏普': ['sharpe'], 'sharpe': ['夏普'],
  '流动性': ['liquidity'], 'liquidity': ['流动性'],
  '高频': ['hft'], 'hft': ['高频'],
  'alpha': ['超额收益'], 'beta': ['系统性风险'],
  'rsi': ['相对强弱'], 'macd': ['异同移动平均'],
  '策略': ['strategy'], 'strategy': ['策略'],
  '风险': ['risk'], 'risk': ['风险'],
  '模型': ['model'], '网关': ['gateway'],
  '适配器': ['adapter'], '工具': ['tool'],
  '代理': ['proxy', 'agent'], 'proxy': ['代理'],
};

function _tokenize(text = '') {
  const lower = String(text || '').toLowerCase();
  const parts = lower.match(/[\u4e00-\u9fff]+|[a-z0-9_]+/g) || [];
  const tokens = [];

  for (const part of parts) {
    if (/^[\u4e00-\u9fff]+$/.test(part)) {
      for (let i = 0; i < part.length; i++) {
        tokens.push(part[i]);
        if (i < part.length - 1) tokens.push(part.slice(i, i + 2));
        if (i < part.length - 2) tokens.push(part.slice(i, i + 3));
      }
    } else {
      tokens.push(part);
      if (part.length >= 6) tokens.push(part.slice(0, 4));
      if (part.endsWith('ing') && part.length > 4) tokens.push(part.slice(0, -3));
      if (part.endsWith('tion') && part.length > 5) tokens.push(part.slice(0, -4));
      if (part.endsWith('ed') && part.length > 3) tokens.push(part.slice(0, -2));
    }
  }
  return [...new Set(tokens.filter(Boolean))];
}

function _expandWithSynonyms(tokens) {
  const expanded = new Set(tokens);
  for (const t of tokens) {
    const syns = _SYNONYMS[t];
    if (syns) for (const s of syns) expanded.add(s.toLowerCase());
  }
  return [...expanded];
}

function _overlapScore(queryTokens = [], text = '', expandedTokens = null) {
  if (!queryTokens.length) return 0;
  const docTokens = new Set(_tokenize(text));
  if (!docTokens.size) return 0;

  // Direct token overlap
  let directHit = 0;
  for (const token of queryTokens) {
    if (docTokens.has(token)) directHit += 1;
  }
  const directScore = directHit / queryTokens.length;

  // Synonym expansion hits (lower weight)
  let synScore = 0;
  if (expandedTokens && expandedTokens.length > queryTokens.length) {
    let synHit = 0;
    for (const token of expandedTokens) {
      if (!queryTokens.includes(token) && docTokens.has(token)) synHit++;
    }
    const synTotal = expandedTokens.length - queryTokens.length;
    synScore = synTotal > 0 ? (synHit / synTotal) * 0.3 : 0;
  }

  // Partial/fuzzy match: check if any doc token starts with a query token or vice versa
  let partialHit = 0;
  if (directHit < queryTokens.length) {
    for (const qt of queryTokens) {
      if (qt.length < 2) continue;
      for (const dt of docTokens) {
        if (dt !== qt && (dt.startsWith(qt) || qt.startsWith(dt)) && dt.length >= 2) {
          partialHit += 0.5;
          break;
        }
      }
    }
  }
  const partialScore = queryTokens.length > 0 ? (partialHit / queryTokens.length) * 0.15 : 0;

  return Math.min(1, directScore + synScore + partialScore);
}

function _keywordScore(query = '', keywords = []) {
  const q = String(query || '').toLowerCase();
  if (!q || !Array.isArray(keywords) || keywords.length === 0) return 0;
  let hits = 0;
  let partialHits = 0;
  for (const kw of keywords) {
    const k = String(kw || '').toLowerCase().trim();
    if (!k) continue;
    if (q.includes(k) || k.includes(q)) {
      hits += 1;
    } else {
      // Partial keyword match: shared prefix >= 2 chars
      const minLen = Math.min(q.length, k.length);
      if (minLen >= 2) {
        let shared = 0;
        for (let i = 0; i < minLen; i++) {
          if (q[i] === k[i]) shared++;
          else break;
        }
        if (shared >= 2) partialHits += shared / Math.max(q.length, k.length);
      }
    }
  }
  const base = Math.min(4, keywords.length) || 1;
  return Math.min(1, (hits + partialHits * 0.4) / base);
}

function _knowledgeCandidates(query = '', limit = DEFAULT_KNOWLEDGE_TOPK) {
  const qTokens = _tokenize(query);
  const expandedTokens = _expandWithSynonyms(qTokens);
  let raw = [];

  try {
    const knowledge = require('./knowledgeTeachingService');
    if (typeof knowledge.searchKnowledge === 'function') {
      raw = knowledge.searchKnowledge(query) || [];
    }
  } catch {
    raw = [];
  }

  const scored = raw.map((entry) => {
    const title = String(entry.title || '').trim();
    const content = String(entry.content || '').trim();
    const keywords = Array.isArray(entry.keywords) ? entry.keywords : [];
    const textForScore = `${title} ${content} ${keywords.join(' ')}`;
    const overlap = _overlapScore(qTokens, textForScore, expandedTokens);
    const kw = _keywordScore(query, keywords);
    const titleBoost = title && (title.includes(query) || query.includes(title)) ? 0.18 : 0;
    const sourceBoost = String(entry.source || '').toLowerCase() === 'learned' ? 0.04 : 0;
    // Query coverage: what fraction of query tokens are covered by this doc
    const docTokenSet = new Set(_tokenize(textForScore));
    let covered = 0;
    for (const t of qTokens) { if (docTokenSet.has(t)) covered++; }
    const coverageBoost = qTokens.length > 0 ? (covered / qTokens.length) * 0.06 : 0;
    const score = overlap * 0.55 + kw * 0.20 + titleBoost + sourceBoost + coverageBoost;
    return {
      kind: 'knowledge',
      source: String(entry.source || 'builtin'),
      category: String(entry.category || '').trim(),
      level: String(entry.level || '').trim(),
      title,
      content,
      keywords,
      score,
    };
  });

  return scored
    .filter(item => item.score > 0.06 && item.content)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));
}

function _sessionCandidates(query = '', limit = DEFAULT_SESSION_TOPK) {
  const qTokens = _tokenize(query);
  const expandedTokens = _expandWithSynonyms(qTokens);
  try {
    const index = require('./sessionSearchIndex');
    if (typeof index.init === 'function') index.init();
    if (typeof index.isAvailable === 'function' && !index.isAvailable()) return [];
    if (typeof index.searchMessages !== 'function') return [];

    const fetchLimit = Math.max(8, limit * 4);
    const rows = index.searchMessages(query, { limit: fetchLimit }) || [];
    return rows.map((row) => {
      const content = String(row.content || '').trim();
      const overlap = _overlapScore(qTokens, content, expandedTokens);
      const rank = Number(row.rank);
      const bm25 = Number.isFinite(rank) ? (1 / (1 + Math.abs(rank))) : 0;
      const ageMs = Math.max(0, Date.now() - Number(row.timestamp || Date.now()));
      const ageDays = ageMs / (24 * 60 * 60 * 1000);
      const recency = Math.max(0, 1 - (ageDays / 45));
      const score = overlap * 0.52 + bm25 * 0.30 + recency * 0.18;
      return {
        kind: 'session',
        source: 'session_index',
        sessionId: String(row.sessionId || '').trim(),
        title: String(row.title || '').trim(),
        role: String(row.role || '').trim(),
        content,
        timestamp: Number(row.timestamp || 0),
        score,
      };
    })
      .filter(item => item.score > 0.07 && item.content)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit));
  } catch {
    return [];
  }
}

function _dedupeCandidates(candidates = []) {
  const seen = new Set();
  const out = [];
  for (const item of candidates) {
    const key = `${item.kind}|${String(item.title || '').slice(0, 80)}|${String(item.content || '').slice(0, 140)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function _formatContext(candidates = [], maxChars = DEFAULT_MAX_CONTEXT_CHARS) {
  const lines = [
    '以下是检索增强上下文（RAG），仅在与当前问题相关时使用：',
  ];

  for (let i = 0; i < candidates.length; i++) {
    const item = candidates[i];
    const index = i + 1;
    if (item.kind === 'knowledge') {
      const sourceTag = item.source === 'learned' ? '学习知识' : '内置知识';
      const category = item.category || '通用';
      const level = item.level || 'unknown';
      lines.push(`${index}. [${sourceTag}|${category}|${level}] ${item.title || '无标题'}`);
      lines.push(`   ${_truncate(item.content, 220)}`);
    } else {
      const title = item.title || item.sessionId || 'untitled';
      lines.push(`${index}. [历史会话|${title}]`);
      lines.push(`   ${_truncate(item.content, 220)}`);
    }
  }

  lines.push('若上述上下文与当前问题冲突或信息不足，请明确说明不确定性并以当前问题为准。');

  let text = lines.join('\n');
  if (text.length > maxChars) {
    text = `${text.slice(0, Math.max(0, maxChars - 4))}\n...`;
  }
  return text;
}

function _cacheGet(key, ttlMs) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if ((Date.now() - hit.at) > ttlMs) {
    _cache.delete(key);
    return null;
  }
  return hit.value;
}

function _cacheSet(key, value) {
  _cache.set(key, { at: Date.now(), value });
  if (_cache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = _cache.keys().next().value;
    if (oldestKey) _cache.delete(oldestKey);
  }
}

/**
 * Build retrieval context for one user query.
 *
 * @param {string} query
 * @param {object} [options]
 * @param {boolean} [options.isFollowUp=false]
 * @returns {{ used:boolean, context:string, meta:object }}
 */
function buildRetrievalContext(query = '', options = {}) {
  const cleanQuery = String(query || '').trim();
  if (!_shouldRetrieve(cleanQuery, options)) {
    return {
      used: false,
      context: '',
      meta: { reason: 'skipped', selectedCount: 0, knowledgeHits: 0, sessionHits: 0, cacheHit: false },
    };
  }

  const knowledgeTopK = _envInt(process.env.KHY_RAG_KNOWLEDGE_TOPK, DEFAULT_KNOWLEDGE_TOPK, 1, 12);
  const sessionTopK = _envInt(process.env.KHY_RAG_SESSION_TOPK, DEFAULT_SESSION_TOPK, 1, 10);
  const totalTopK = _envInt(process.env.KHY_RAG_TOPK, DEFAULT_TOTAL_TOPK, 1, 16);
  const maxChars = _envInt(process.env.KHY_RAG_MAX_CONTEXT_CHARS, DEFAULT_MAX_CONTEXT_CHARS, 400, 12_000);
  const ttlMs = _envInt(process.env.KHY_RAG_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS, 2_000, 10 * 60_000);
  const cacheKey = `${cleanQuery}::${knowledgeTopK}:${sessionTopK}:${totalTopK}:${maxChars}`;

  const cached = _cacheGet(cacheKey, ttlMs);
  if (cached) {
    return {
      ...cached,
      meta: { ...(cached.meta || {}), cacheHit: true },
    };
  }

  const knowledge = _knowledgeCandidates(cleanQuery, knowledgeTopK);
  const sessions = _sessionCandidates(cleanQuery, sessionTopK);
  const merged = _dedupeCandidates([...knowledge, ...sessions])
    .sort((a, b) => b.score - a.score)
    .slice(0, totalTopK);

  if (merged.length === 0) {
    const miss = {
      used: false,
      context: '',
      meta: { reason: 'no_match', selectedCount: 0, knowledgeHits: 0, sessionHits: 0, cacheHit: false },
    };
    _cacheSet(cacheKey, miss);
    return miss;
  }

  const context = _formatContext(merged, maxChars);
  const result = {
    used: !!context,
    context,
    meta: {
      reason: 'matched',
      selectedCount: merged.length,
      knowledgeHits: knowledge.length,
      sessionHits: sessions.length,
      cacheHit: false,
      contextChars: context.length,
    },
  };
  _cacheSet(cacheKey, result);
  return result;
}

function _resetCacheForTest() {
  _cache.clear();
}

module.exports = {
  isEnabled,
  buildRetrievalContext,
  _resetCacheForTest,
};

