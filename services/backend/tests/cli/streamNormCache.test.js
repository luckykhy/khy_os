'use strict';

/**
 * streamNormCache — bounded content-keyed memo for StreamingBlock's live-stream
 * text normalization (goal「动画/任务体验卡顿,无法做真正的软件项目」).
 *
 * StreamingBlock re-runs regex normalization over the WHOLE accumulated timeline
 * every frame (~25fps). All but the growing last segment are frozen (identical
 * text every frame), so this is O(n²)/turn of pure waste — the dominant lag on
 * long streaming answers. The cache memoizes the pure normalize output by
 * content so frozen segments hit and only the growing one recomputes.
 *
 * Guard invariants:
 *   ① gate KHY_STREAM_NORM_CACHE default ON; 0/false/off/no → OFF (byte-revert)
 *   ② byte-identical: cached result === rawFn(text, selfRender) for any input
 *   ③ cache HIT: a repeated (text, selfRender) does NOT re-invoke rawFn
 *   ④ selfRender is part of the key (same text, different flag → different call)
 *   ⑤ gate OFF → rawFn invoked every time (no memo), still returns rawFn output
 *   ⑥ bounded: size never exceeds MAX_ENTRIES (LRU eviction)
 *   ⑦ LRU: a frozen (touched-every-round) key survives churn from growing keys
 *   ⑧ fail-soft: rawFn throwing → returns input text, never throws
 *   ⑨ LIVE wiring: StreamingBlock routes normLive through normalizeCached;
 *      flagRegistry registers KHY_STREAM_NORM_CACHE
 *
 * node:test (jest via rtk proxy reports Exec format error and is unavailable).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const cache = require('../../src/cli/tui/ink-components/streamNormCache');

const BACKEND_ROOT = path.resolve(__dirname, '../../');

// A deterministic "normalizer" that counts invocations so we can prove hits.
function mkRaw() {
  const calls = [];
  const fn = (text, selfRender) => {
    calls.push({ text, selfRender });
    return `${selfRender ? 'S' : 'N'}:${String(text).toUpperCase()}`;
  };
  fn.calls = calls;
  return fn;
}

// ── ① gate default ON; falsy words → OFF ──────────────────────────────────
test('KHY_STREAM_NORM_CACHE defaults ON, reverts on falsy words', () => {
  assert.strictEqual(cache.isStreamNormCacheEnabled({}), true);
  assert.strictEqual(cache.isStreamNormCacheEnabled({ KHY_STREAM_NORM_CACHE: undefined }), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(cache.isStreamNormCacheEnabled({ KHY_STREAM_NORM_CACHE: off }), false, `'${off}'`);
  }
  assert.strictEqual(cache.isStreamNormCacheEnabled({ KHY_STREAM_NORM_CACHE: '1' }), true);
});

// ── ② byte-identical to rawFn ─────────────────────────────────────────────
test('normalizeCached returns exactly rawFn output', () => {
  cache.clearStreamNormCache();
  const raw = mkRaw();
  assert.strictEqual(cache.normalizeCached('hello', false, raw, {}), 'N:HELLO');
  assert.strictEqual(cache.normalizeCached('hello', true, raw, {}), 'S:HELLO');
});

// ── ③ cache HIT avoids re-invoking rawFn ──────────────────────────────────
test('repeated (text, selfRender) hits cache; rawFn called once', () => {
  cache.clearStreamNormCache();
  const raw = mkRaw();
  const a = cache.normalizeCached('frozen segment', false, raw, {});
  const b = cache.normalizeCached('frozen segment', false, raw, {});
  const c = cache.normalizeCached('frozen segment', false, raw, {});
  assert.strictEqual(a, b);
  assert.strictEqual(b, c);
  assert.strictEqual(raw.calls.length, 1, 'rawFn must run only once for identical input');
});

// ── ④ selfRender is part of the key ───────────────────────────────────────
test('same text with different selfRender → separate entries', () => {
  cache.clearStreamNormCache();
  const raw = mkRaw();
  assert.strictEqual(cache.normalizeCached('x', false, raw, {}), 'N:X');
  assert.strictEqual(cache.normalizeCached('x', true, raw, {}), 'S:X');
  assert.strictEqual(raw.calls.length, 2, 'selfRender variants must not collide');
});

// ── ⑤ gate OFF → rawFn every time (byte-revert), still correct output ──────
test('gate OFF → no memo, rawFn invoked every call', () => {
  cache.clearStreamNormCache();
  const raw = mkRaw();
  const env = { KHY_STREAM_NORM_CACHE: 'off' };
  assert.strictEqual(cache.normalizeCached('y', false, raw, env), 'N:Y');
  assert.strictEqual(cache.normalizeCached('y', false, raw, env), 'N:Y');
  assert.strictEqual(raw.calls.length, 2, 'gate off must not cache');
  assert.strictEqual(cache._cacheSize(), 0, 'gate off must not populate cache');
});

// ── ⑥ bounded: size never exceeds MAX_ENTRIES ─────────────────────────────
test('cache is bounded by MAX_ENTRIES (LRU eviction)', () => {
  cache.clearStreamNormCache();
  const raw = mkRaw();
  const N = cache._MAX_ENTRIES + 50;
  for (let i = 0; i < N; i++) cache.normalizeCached(`seg-${i}`, false, raw, {});
  assert.ok(cache._cacheSize() <= cache._MAX_ENTRIES,
    `size ${cache._cacheSize()} must be <= ${cache._MAX_ENTRIES}`);
});

// ── ⑦ LRU keeps a frozen (touched-every-round) key hot across growing churn ─
test('frozen key touched every round survives eviction by growing keys', () => {
  cache.clearStreamNormCache();
  const raw = mkRaw();
  const FROZEN = 'the frozen segment';
  // Prime the frozen key.
  cache.normalizeCached(FROZEN, false, raw, {});
  const primeCalls = raw.calls.length;
  // Simulate many frames: each frame touches FROZEN then inserts a new growing key.
  for (let frame = 0; frame < cache._MAX_ENTRIES + 100; frame++) {
    cache.normalizeCached(FROZEN, false, raw, {});        // touched → moves to recent end
    cache.normalizeCached(`grow-${frame}`, false, raw, {}); // unique growing version
  }
  // FROZEN must never have been recomputed after priming (always a hit).
  assert.strictEqual(raw.calls.length - primeCalls,
    cache._MAX_ENTRIES + 100, // only the growing keys recompute, FROZEN stays hit
    'frozen key must not be recomputed (stayed hot in LRU)');
});

// ── ⑧ fail-soft on rawFn throw ────────────────────────────────────────────
test('rawFn throwing → returns input text, never throws', () => {
  cache.clearStreamNormCache();
  const boom = () => { throw new Error('boom'); };
  assert.strictEqual(cache.normalizeCached('keepme', false, boom, {}), 'keepme');
  assert.strictEqual(cache.normalizeCached('', false, boom, {}), '');
  // non-function rawFn → returns text
  assert.strictEqual(cache.normalizeCached('t', false, null, {}), 't');
});

// ── ⑨ LIVE wiring guards ──────────────────────────────────────────────────
test('StreamingBlock routes normLive through normalizeCached', () => {
  const src = fs.readFileSync(
    path.join(BACKEND_ROOT, 'src/cli/tui/ink-components/StreamingBlock.js'), 'utf8');
  assert.ok(/streamNormCache/.test(src), 'StreamingBlock must require streamNormCache');
  assert.ok(/normalizeCached\(text, selfRender, _rawNormLive/.test(src),
    'normLive must delegate to normalizeCached with _rawNormLive as ground truth');
});

test('flagRegistry registers KHY_STREAM_NORM_CACHE default ON', () => {
  const reg = require('../../src/services/flagRegistry');
  assert.strictEqual(reg.isFlagEnabled('KHY_STREAM_NORM_CACHE', {}), true);
  assert.strictEqual(reg.isFlagEnabled('KHY_STREAM_NORM_CACHE', { KHY_STREAM_NORM_CACHE: 'off' }), false);
});

// ── E2E: real normalizer output is preserved through the cache ─────────────
test('E2E: cache preserves real modelTextNormalizer output', () => {
  cache.clearStreamNormCache();
  let normalizer;
  try { normalizer = require('../../src/cli/modelTextNormalizer'); }
  catch { normalizer = null; }
  if (!normalizer) return; // environment without the normalizer → skip
  const raw = (text, selfRender) => (selfRender ? normalizer.sanitize(text) : normalizer.normalizeStreaming(text));
  const sample = 'Hello world\n\n\n\nsome text with trailing runs';
  const direct = raw(sample, false);
  const cached1 = cache.normalizeCached(sample, false, raw, {});
  const cached2 = cache.normalizeCached(sample, false, raw, {});
  assert.strictEqual(cached1, direct, 'cached output must equal direct normalizer output');
  assert.strictEqual(cached2, direct, 'second (hit) output must equal direct too');
});
