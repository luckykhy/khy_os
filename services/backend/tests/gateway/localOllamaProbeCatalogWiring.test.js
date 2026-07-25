'use strict';

/**
 * OPS-MAN-158 接线验证:localOllamaProbe 叶 → modelCatalogGraph.buildCatalogGraph §4。
 *
 * localOllamaProbe.fetchLocalModels()(gateway/localOllamaProbe.js)是一个 never-throw、
 * 非阻塞的适配器:复用 ollamaModelManager 的 isOllamaRunning()/listModels() 发现本地
 * Ollama 正在服务的模型,专为「per-user 模型目录」而写,但此前**零生产消费者**——统一目录
 * modelCatalogGraph 从不并入本地模型,能力完全休眠。
 *
 * 本接线把它接进 buildCatalogGraph 的第 4 源(继 chat/image/video 之后),仅在 `live` 发现
 * 且门 KHY_LOCAL_MODEL_CATALOG default-on 时并入 source:'local' 边。门关 / 非 live /
 * Ollama 未运行 / 探测抛错,一律 → 无本地边、sources.localModels===0、目录逐字节回退。
 *
 * 用 require.cache 桩把有状态依赖(customProviderRegistry / apiKeyPool / apiAdapter /
 * image/videoGenService)全部换成空实现使测试 hermetic 零网络,localOllamaProbe 换成可切换
 * 桩;modelTier / modelCapability 保留真实(纯函数,真算 tier/capability)。node:test 风格,
 * 已登记进 test:maintainer:safety。
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

function stub(relPath, exportsObj) {
  const abs = require.resolve(relPath);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: exportsObj };
  return abs;
}

// ── hermetic 桩:必须在 require modelCatalogGraph 之前安装 ──
stub('../../src/services/customProviderRegistry', { listProviders: () => [] });
stub('../../src/services/apiKeyPool', { init: () => {}, getProviders: () => [], getPoolStatus: () => [] });
stub('../../src/services/gateway/adapters/apiAdapter', {
  getPoolDefaultModelMap: () => ({}), listModels: async () => [],
});
stub('../../src/services/imageGenService', { catalogModels: () => [] });
stub('../../src/services/videoGenService', { catalogModels: () => [] });

// 可切换的本地探测桩 + 调用计数
let _localImpl = async () => ({ running: false, models: [], error: null });
const _probeCalls = { n: 0 };
stub('../../src/services/gateway/localOllamaProbe', {
  fetchLocalModels: async (...a) => { _probeCalls.n++; return _localImpl(...a); },
});

// 现在 require 被测模块(拾取全部桩)
const graph = require('../../src/services/gateway/modelCatalogGraph');
const PROBE_SRC = path.join(__dirname, '../../src/services/gateway/localOllamaProbe.js');
const GRAPH_SRC = path.join(__dirname, '../../src/services/gateway/modelCatalogGraph.js');

async function withGate(val, fn) {
  const prev = process.env.KHY_LOCAL_MODEL_CATALOG;
  if (val === undefined) delete process.env.KHY_LOCAL_MODEL_CATALOG;
  else process.env.KHY_LOCAL_MODEL_CATALOG = val;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.KHY_LOCAL_MODEL_CATALOG;
    else process.env.KHY_LOCAL_MODEL_CATALOG = prev;
  }
}

const local = (r) => r.edges.filter((e) => e.source === 'local');

beforeEach(() => {
  _localImpl = async () => ({ running: false, models: [], error: null });
  _probeCalls.n = 0;
  delete process.env.KHY_LOCAL_MODEL_CATALOG; // default-on
});

// ── 接线守卫 ──────────────────────────────────────────────────

test('WIRING: live + 门开 + Ollama 运行 → 本地模型作 source:local 边并入', async () => {
  _localImpl = async () => ({ running: true, error: null, models: [
    { id: 'llama3', source: 'local' }, { id: 'qwen2', source: 'local' },
  ] });
  const r = await graph.buildCatalogGraph({ live: true });
  const l = local(r);
  assert.strictEqual(l.length, 2);
  assert.strictEqual(r.sources.localModels, 2);
  assert.deepStrictEqual(l.map((e) => e.model).sort(), ['llama3', 'qwen2']);
  assert.ok(l.every((e) => e.provider === 'ollama' && e.connectionMode === 'direct'
    && e.status === 'active' && e.keyCount === 0 && typeof e.capability === 'string'));
  assert.strictEqual(_probeCalls.n, 1);
});

test('BYTE-REVERT: live + 门开 + Ollama 未运行 → 无本地边(探测被查但返空)', async () => {
  _localImpl = async () => ({ running: false, models: [], error: null });
  const r = await graph.buildCatalogGraph({ live: true });
  assert.strictEqual(local(r).length, 0);
  assert.strictEqual(r.sources.localModels, 0);
  assert.strictEqual(_probeCalls.n, 1);
});

test('BYTE-REVERT: 非 live(默认快路径)→ 探测从不被调用', async () => {
  _localImpl = async () => ({ running: true, error: null, models: [{ id: 'llama3' }] });
  const r = await graph.buildCatalogGraph({ live: false });
  assert.strictEqual(local(r).length, 0);
  assert.strictEqual(r.sources.localModels, 0);
  assert.strictEqual(_probeCalls.n, 0);
});

test('BYTE-REVERT: 门关(KHY_LOCAL_MODEL_CATALOG=0)→ 短路,探测从不被调用', async () => {
  _localImpl = async () => ({ running: true, error: null, models: [{ id: 'llama3' }] });
  const r = await withGate('0', () => graph.buildCatalogGraph({ live: true }));
  assert.strictEqual(local(r).length, 0);
  assert.strictEqual(r.sources.localModels, 0);
  assert.strictEqual(_probeCalls.n, 0);
});

test('DEDUP: 探测返回重复 id → 去重', async () => {
  _localImpl = async () => ({ running: true, error: null, models: [
    { id: 'dup' }, { id: 'dup' }, { id: 'x' },
  ] });
  const r = await graph.buildCatalogGraph({ live: true });
  assert.strictEqual(r.sources.localModels, 2);
  assert.strictEqual(local(r).length, 2);
});

test('NEVER-THROW: 探测抛错 → 目录照常返回,无本地边', async () => {
  _localImpl = async () => { throw new Error('boom'); };
  const r = await graph.buildCatalogGraph({ live: true });
  assert.strictEqual(local(r).length, 0);
  assert.strictEqual(r.sources.localModels, 0);
  assert.ok(Array.isArray(r.edges) && r.sources && typeof r.sources.localModels === 'number');
});

// ── 源级接线断言 ──────────────────────────────────────────────

test('SOURCE: modelCatalogGraph 惰性 require localOllamaProbe 且以 live && 门 为门', () => {
  const src = fs.readFileSync(GRAPH_SRC, 'utf-8');
  assert.ok(/require\(['"]\.\/localOllamaProbe['"]\)/.test(src), 'must require ./localOllamaProbe');
  assert.ok(/live\s*&&\s*_localModelCatalogEnabled\(\)/.test(src), 'must gate on live && flag');
  assert.ok(src.includes("source: 'local'"), 'must emit source:local edges');
  assert.ok(src.includes('localModels'), 'sources block must report localModels');
});

test('LEAF: localOllamaProbe 复用 ollamaModelManager 不重造 HTTP 且失败返空(never-throw)', () => {
  const leaf = fs.readFileSync(PROBE_SRC, 'utf-8');
  assert.ok(/module\.exports\s*=\s*\{\s*fetchLocalModels\s*\}/.test(leaf), 'exports fetchLocalModels');
  assert.ok(/require\(['"]\.\.\/ollamaModelManager['"]\)/.test(leaf), 'reuses ollamaModelManager (no HTTP re-impl)');
  assert.ok(/running:\s*false/.test(leaf), 'returns empty running:false on failure (never-throw)');
});
