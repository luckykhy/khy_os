'use strict';

/**
 * memoryEngine/vectorRecall.js — optional vector-similarity boost for proactive memory recall.
 *
 * When an embedding endpoint is reachable (same env knobs as learningRetrieval.js:
 * KHY_LEARN_EMBED_URL, KHY_LEARN_EMBED_MODEL, KHY_LEARN_EMBED_TIMEOUT_MS),
 * this module embeds the user query and candidate memory snippets and re-ranks
 * by cosine similarity on top of the keyword × recency score.
 *
 * Fail-soft: if the embedding service is unreachable or any call throws, the
 * module returns null so callers fall back to pure keyword scoring with zero
 * behavior change.
 *
 * @module memoryEngine/vectorRecall
 */

const http = require('http');
const https = require('https');

// ── Env knobs (mirror learningRetrieval.js SSOT) ────────────────────────────

function _envStr(name, def) {
  const v = process.env[name];
  return v == null || String(v).trim() === '' ? def : String(v).trim();
}

function _envInt(name, def, min, max) {
  const n = parseInt(process.env[name], 10);
  if (!Number.isFinite(n)) {
    return def;
  }
  let r = n;
  if (typeof min === 'number') {
    r = Math.max(min, r);
  }
  if (typeof max === 'number') {
    r = Math.min(max, r);
  }
  return r;
}

function _envBool(name, def) {
  const v = process.env[name];
  if (v == null || v === '') {
    return def;
  }
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

const EMBED_URL = _envStr('KHY_LEARN_EMBED_URL', '');
const EMBED_MODEL = _envStr('KHY_LEARN_EMBED_MODEL', '');
const EMBED_TIMEOUT_MS = _envInt('KHY_LEARN_EMBED_TIMEOUT_MS', 4000, 500, 60000);
const EMBED_MAX_TEXTS = _envInt('KHY_LEARN_EMBED_MAX_TEXTS', 16, 2, 64);
const VECTOR_RECALL_ENABLED = _envBool('KHY_MEMORY_VECTOR_RECALL', true);

// ── HTTP helper (minimal, fail-soft) ─────────────────────────────────────────

function _httpPostJson(urlStr, obj, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    let req;
    let payload, h;
    try {
      const mod = urlStr.startsWith('https') ? https : http;
      payload = Buffer.from(JSON.stringify(obj), 'utf-8');
      h = {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
      };
      req = mod.request(urlStr, { method: 'POST', headers: h }, (res) => {
        const bufs = [];
        res.on('data', (d) => bufs.push(d));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(bufs).toString('utf-8'));
          } catch {
            json = null;
          }
          finish({ status: res.statusCode || 0, json });
        });
      });
    } catch {
      return finish(null);
    }
    req.on('error', () => finish(null));
    req.setTimeout(timeoutMs, () => {
      try {
        req.destroy();
      } catch {}
      finish(null);
    });
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

// ── Embedding ───────────────────────────────────────────────────────────────

/**
 * Embed an array of texts. Returns array of float[] aligned to `texts`,
 * or null if no endpoint produced usable vectors.
 */
async function _embedTexts(texts) {
  if (!EMBED_URL || !EMBED_MODEL) {
    return null;
  }
  const slice = texts.slice(0, EMBED_MAX_TEXTS);

  // OpenAI-compatible endpoint
  try {
    const r = await _httpPostJson(
      EMBED_URL,
      { model: EMBED_MODEL, input: slice },
      EMBED_TIMEOUT_MS
    );
    const data = r && r.json && Array.isArray(r.json.data) ? r.json.data : null;
    if (data && data.length === slice.length && data.every((d) => Array.isArray(d.embedding))) {
      return data.map((d) => d.embedding);
    }
  } catch {
    /* try next */
  }

  // Ollama-style endpoint (derive from EMBED_URL by stripping /v1/embeddings)
  try {
    const ollamaUrl = EMBED_URL.replace(/\/v\d+\/embeddings?/, '/api/embeddings');
    const vecs = [];
    let ok = true;
    for (const t of slice) {
      const r = await _httpPostJson(ollamaUrl, { model: EMBED_MODEL, prompt: t }, EMBED_TIMEOUT_MS);
      const emb = r && r.json && Array.isArray(r.json.embedding) ? r.json.embedding : null;
      if (!emb) {
        ok = false;
        break;
      }
      vecs.push(emb);
    }
    if (ok && vecs.length === slice.length) {
      return vecs;
    }
  } catch {
    /* fail */
  }

  return null;
}

// ── Cosine similarity ───────────────────────────────────────────────────────

function _cosine(a, b) {
  if (!a || !b || a.length !== b.length) {
    return 0;
  }
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) {
    return 0;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Embed a single text. Returns float[] or null on failure.
 */
async function embedText(text) {
  if (!text) {
    return null;
  }
  const results = await _embedTexts([String(text)]);
  return results && results.length > 0 ? results[0] : null;
}

/**
 * Compute vector-enhanced scores for a set of scored memories.
 *
 * Takes the already-keyword-scored array from scoring.rankMemories, embeds
 * the query + each memory's body snippet, computes cosine similarity, and
 * returns a new array with `vectorScore` and updated `score` fields.
 *
 * If the embedding service is unreachable, returns null so callers keep
 * the original keyword-only scores.
 *
 * @param {string} query
 * @param {Array<{body:string, keywordScore:number, score:number, ...}>} scored
 * @param {object} [opts]
 * @param {number} [opts.vectorWeight=0.5]  - weight of vector sim in combined score
 * @returns {Array|null} enhanced scored array, or null if vector unavailable
 */
async function enhanceWithVectors(query, scored, opts = {}) {
  if (!VECTOR_RECALL_ENABLED) {
    return null;
  }
  if (!scored || scored.length === 0) {
    return null;
  }
  if (!query || !String(query).trim()) {
    return null;
  }

  const vectorWeight = Number.isFinite(opts.vectorWeight) ? opts.vectorWeight : 0.5;

  // Build text list: [query, ...memory snippets]
  const texts = [String(query)];
  for (const m of scored) {
    const body = String(m.body || '')
      .replace(/\s+/g, ' ')
      .trim();
    const snippet = body.slice(0, 500);
    texts.push(snippet);
  }

  let vectors;
  try {
    vectors = await _embedTexts(texts);
  } catch {
    return null; // fail-soft
  }
  if (!vectors || vectors.length !== texts.length) {
    return null;
  }

  const queryVec = vectors[0];

  // Enhance each memory with vector similarity (clone to avoid mutating caller's data)
  const enhanced = scored.map((m, i) => {
    const memVec = vectors[i + 1];
    const cosSim = _cosine(queryVec, memVec);
    const kw = Math.max(0, m.keywordScore || 0);
    // Combined score: keyword baseline + vector-modulated boost.
    // vectorBoost = kw * vectorWeight * max(0, cosSim - 0.3) / 0.7
    //   → cosSim >= 0.3 gives positive boost (linear 0→1 over [0.3, 1.0])
    //   → cosSim <  0.3 gives zero boost (no penalty for weak vector match)
    //   → high kw × high cosSim yields the biggest boost
    //   → low kw caps the boost (no random low-keyword results promoted)
    const normalizedSim = Math.max(0, (cosSim - 0.3) / 0.7);
    const vectorBoost = kw * vectorWeight * normalizedSim;
    return {
      ...m,
      vectorScore: cosSim,
      score: kw + vectorBoost,
    };
  });

  enhanced.sort(
    (a, b) =>
      b.score - a.score || b.modifiedAt - a.modifiedAt || a.filename.localeCompare(b.filename)
  );
  return enhanced;
}

module.exports = {
  embedText,
  enhanceWithVectors,
  VECTOR_RECALL_ENABLED,
};
