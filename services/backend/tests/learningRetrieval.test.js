'use strict';

/**
 * learningRetrieval.test.js — hermetic tests for the /learn unified retrieval
 * layer (the three-learning-modes "closed loop" core).
 *
 * Hermetic per the project pattern (cf. agentbus_gateway_brain_test.js): fake
 * HTTP servers stand in for the embedding endpoint and the docs remote; the
 * corpus/lexical/vector logic is exercised for real against the actual KHY-OS
 * curriculum + docs. No model, no real network egress.
 *
 * Env-derived module config (KHY_LEARN_*) is captured at module load, so each
 * scenario sets env then loads a fresh copy via jest.isolateModules.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
  return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
}

// Load a fresh copy of the module under a given env overlay.
function freshModule(envOverlay = {}) {
  const saved = {};
  for (const k of Object.keys(envOverlay)) {
    saved[k] = process.env[k];
    if (envOverlay[k] === undefined) delete process.env[k];
    else process.env[k] = envOverlay[k];
  }
  let mod;
  jest.isolateModules(() => { mod = require('../src/services/learningRetrieval'); });
  // restore
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  return mod;
}

// Keep the autodetected ollama/gateway endpoints from being probed during the
// "vector off / unreachable" scenarios: point them at a definitely-closed port.
const CLOSED = 'http://127.0.0.1:1'; // port 1 — nothing listens

describe('learningRetrieval — corpus + lexical recall (offline floor)', () => {
  test('builds a non-empty KHY-OS corpus and recalls the decision-plane chunk', async () => {
    const r = freshModule({ KHY_LEARN_RAG: '1' });
    const corpus = r._internals.getCorpus();
    expect(corpus.length).toBeGreaterThan(50);

    const ctx = await r.buildContext('决策面 OS 反过来问 agent 求决策', { allowVector: false });
    expect(ctx.chunks.length).toBeGreaterThan(0);
    expect(ctx.usedVector).toBe(false);
    expect(ctx.text.length).toBeGreaterThan(0);

    // Recall must surface the A5 decision-plane material (agentask / 决策面 / A5).
    const sources = ctx.chunks.map(c => c.source).join(' ');
    const blob = ctx.chunks.map(c => `${c.source} ${c.title} ${c.text}`).join(' ');
    expect(/agentask|agent_decision|决策面|A5/i.test(sources + ' ' + blob)).toBe(true);
  });

  test('query expansion bridges 中文概念 → 英文标识符 (召回提升)', () => {
    const r = freshModule({});
    const expanded = r._internals.expandTokens(r._internals.tokenize('决策'));
    expect(expanded).toEqual(expect.arrayContaining(['decision', 'agentask']));
    // 内存 → memory/pmm/vmm
    const mem = r._internals.expandTokens(r._internals.tokenize('内存'));
    expect(mem).toEqual(expect.arrayContaining(['memory', 'pmm', 'vmm']));
  });

  test('master switch off → empty context (no retrieval)', async () => {
    const r = freshModule({ KHY_LEARN_RAG: '0' });
    const ctx = await r.buildContext('内核调度', { allowVector: true });
    expect(ctx.chunks).toEqual([]);
    expect(ctx.text).toBe('');
  });
});

describe('learningRetrieval — vector rerank (hybrid, mode 3)', () => {
  let embedServer, embedPort, embedHits;

  beforeAll(async () => {
    embedHits = 0;
    embedServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        embedHits++;
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
        const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.prompt || ''];
        // Deterministic 8-dim vectors derived from text — enough to rerank.
        const data = inputs.map((t) => {
          const s = String(t);
          const v = Array.from({ length: 8 }, (_, i) => ((s.charCodeAt(i % Math.max(1, s.length)) || 0) % 13) / 13);
          return { embedding: v };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data }));
      });
    });
    embedPort = await listen(embedServer);
  });
  afterAll(async () => { await close(embedServer); });

  test('reachable embedding endpoint → usedVector true, chunks still returned', async () => {
    const url = `http://127.0.0.1:${embedPort}/v1/embeddings`;
    const r = freshModule({ KHY_LEARN_RAG: '1', KHY_LEARN_EMBED_URL: url });
    expect(await r.isEmbeddingReachable()).toBe(true);

    const ctx = await r.buildContext('内核如何用串口和 agent 通信', { allowVector: true });
    expect(ctx.usedVector).toBe(true);
    expect(ctx.chunks.length).toBeGreaterThan(0);
    expect(embedHits).toBeGreaterThan(0);
  });

  test('unreachable embedding endpoint → usedVector false, lexical fallback still returns', async () => {
    const r = freshModule({
      KHY_LEARN_RAG: '1',
      KHY_LEARN_EMBED_URL: `${CLOSED}/v1/embeddings`,
      OLLAMA_HOST: CLOSED,
      PROXY_HOST: '127.0.0.1',
      PROXY_PORT: '1',
      KHY_LEARN_EMBED_TIMEOUT_MS: '500',
      KHY_LEARN_PROBE_TIMEOUT_MS: '500',
    });
    const ctx = await r.buildContext('决策面 OS 问 agent', { allowVector: true });
    expect(ctx.usedVector).toBe(false);
    expect(ctx.chunks.length).toBeGreaterThan(0); // lexical recall unaffected
  });
});

describe('learningRetrieval — remote fetch (mode 2)', () => {
  let docsServer, docsPort, docsHits;
  const REL = '__rag_test__/probe_missing.md'; // a path guaranteed absent locally

  beforeAll(async () => {
    docsHits = 0;
    docsServer = http.createServer((req, res) => {
      docsHits++;
      res.writeHead(200, { 'Content-Type': 'text/markdown' });
      res.end(`# probe\nfetched body for ${req.url}\n`);
    });
    docsPort = await listen(docsServer);
  });
  afterAll(async () => {
    await close(docsServer);
    // Clean the cache files this test created.
    try {
      const dir = path.join(os.homedir(), '.khyquant', 'learn-cache', '__rag_test__');
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* best effort */ }
  });

  test('docs remote configured + reachable → fetches missing topic files', async () => {
    const base = `http://127.0.0.1:${docsPort}/`;
    const r = freshModule({ KHY_LEARN_RAG: '1', KHY_LEARN_DOCS_BASE_URL: base, KHY_LEARN_FETCH_TIMEOUT_MS: '2000' });

    expect(await r.isDocsRemoteReachable()).toBe(true);

    const fetched = await r.fetchMissingForTopic({ title: 'probe', desc: 'd', files: [REL] });
    expect(fetched.length).toBe(1);
    expect(fetched[0].file).toBe(REL);
    expect(fs.existsSync(fetched[0].abs)).toBe(true);
    expect(docsHits).toBeGreaterThan(0);

    // Fetched file can be folded into a retrieval context via extraPaths.
    const ctx = await r.buildContext('probe', { allowVector: false, extraPaths: [fetched[0].abs] });
    expect(ctx.chunks.length).toBeGreaterThan(0);
  });

  test('no docs remote configured → no fetch, honest degrade (mode 1)', async () => {
    const r = freshModule({ KHY_LEARN_RAG: '1', KHY_LEARN_DOCS_BASE_URL: undefined, KHY_LEARN_DOCS_DERIVE: '0' });
    expect(await r.isDocsRemoteReachable()).toBe(false);
    const fetched = await r.fetchMissingForTopic({ title: 'x', desc: 'y', files: ['kernel/src/agentask.c'] });
    expect(fetched).toEqual([]);
  });
});

describe('learningRetrieval — curriculum prompt builders accept ragContext (backward compatible)', () => {
  test('no ragContext → unchanged; with ragContext → grounding injected', () => {
    const c = require('../src/services/learningCurriculum');
    const layer = { id: 11, title: '内核与Agent协同', summary: 's', topics: [{ id: 't', title: '决策面', desc: 'd', files: ['kernel/src/agentask.c'] }] };
    const topic = layer.topics[0];

    const base = c.buildLearningPrompt(layer, topic);
    expect(base.includes('CHUNK-MARKER')).toBe(false);

    const grounded = c.buildLearningPrompt(layer, topic, { ragContext: 'CHUNK-MARKER' });
    expect(grounded.includes('CHUNK-MARKER')).toBe(true);
    expect(grounded.includes('优先据此讲解')).toBe(true);

    // simple variants too
    expect(c.buildSimpleTopicPrompt(layer, topic, { ragContext: 'XQ' }).includes('XQ')).toBe(true);
    expect(c.buildLayerOverviewPrompt(layer, { ragContext: 'YQ' }).includes('YQ')).toBe(true);
    expect(c.buildSimpleLayerPrompt(layer, { ragContext: 'ZQ' }).includes('ZQ')).toBe(true);
  });
});
