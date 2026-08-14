'use strict';

/**
 * Round-13 regression: directiveParser sentinel DoS guard (freeze).
 *
 * `_createSentinel` builds a Unicode placeholder guaranteed not to occur in the
 * text before masking fenced code blocks. The legacy implementation grew the
 * sentinel one seed char (U+E000) at a time and rescanned the ENTIRE text with
 * `text.includes` on every iteration. When the raw user message contains a run
 * of k consecutive seed chars — trivially present in garbled / crafted-unicode
 * paste — the loop runs k times, each rescan O(len) => O(n^2). A ~200 KB paste
 * of U+E000 freezes the turn ~32 s. `extractDirectives`/`stripDirectives` run on
 * the raw userMessage (cli/ai.js:5052) inside a try/catch, but a hang never
 * throws, so nothing catches it — a real, user-reachable DoS.
 *
 * The terminating sentinel is provably `SEED * (longestRun + 1)`, computable in
 * one linear pass. The guard (KHY_DIRECTIVE_SENTINEL_LINEAR, default on) yields
 * the byte-identical sentinel without the rescan; off => legacy quadratic loop.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const MOD = path.join(__dirname, '..', 'src', 'services', 'directiveParser.js');
const SEED = String.fromCharCode(0xE000);

function load(gate) {
  delete require.cache[require.resolve(MOD)];
  if (gate === undefined) delete process.env.KHY_DIRECTIVE_SENTINEL_LINEAR;
  else process.env.KHY_DIRECTIVE_SENTINEL_LINEAR = gate;
  return require(MOD);
}

test.afterEach(() => { delete process.env.KHY_DIRECTIVE_SENTINEL_LINEAR; });

test('a huge run of seed chars no longer freezes (was ~32s at 200k)', () => {
  const dp = load(undefined);
  const text = SEED.repeat(200000) + ' hi [[audio_as_voice]]';
  const t0 = process.hrtime.bigint();
  const r = dp.extractDirectives(text);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 1000, `should stay linear, took ${ms}ms`);
  assert.strictEqual(r.audioAsVoice, true); // directive still detected past the run
});

test('sentinel is byte-identical to the legacy loop across shapes', () => {
  const on = load('1')._createSentinel;
  const off = load('0')._createSentinel;
  const shapes = [
    'no seed here',
    'one' + SEED + 'seed',
    SEED + SEED + SEED,
    'a' + SEED + SEED + 'b' + SEED + 'c',
    SEED.repeat(5) + 'x' + SEED.repeat(3),
    '',
    'code ```js\nx=1\n``` and [[reply_to: 42]]',
  ];
  for (const s of shapes) {
    assert.strictEqual(on(s), off(s), `sentinel mismatch for ${JSON.stringify(s.slice(0, 24))}`);
  }
});

test('sentinel length equals longest seed run + 1', () => {
  const dp = load(undefined);
  assert.strictEqual(dp._createSentinel('no seed').length, 1);
  assert.strictEqual(dp._createSentinel(SEED).length, 2);
  assert.strictEqual(dp._createSentinel('a' + SEED.repeat(4) + 'b' + SEED.repeat(2)).length, 5);
  assert.strictEqual(dp._createSentinel('').length, 1);
});

test('extract / strip / normalize are byte-identical gate on vs off', () => {
  const on = load('1');
  const off = load('0');
  const cases = [
    'hello [[audio_as_voice]] world',
    'reply [[reply_to: msg-123]] here',
    '```js\nconst x = [[audio_as_voice]];\n```\nnow [[reply_to_current]]',
    'text with ' + SEED + SEED + ' seed runs [[audio_as_voice]]',
    '  messy\n\n\n  whitespace  here  ',
    'plain text no directives',
  ];
  for (const c of cases) {
    assert.deepStrictEqual(on.extractDirectives(c), off.extractDirectives(c));
    assert.strictEqual(on.stripDirectives(c), off.stripDirectives(c));
    assert.strictEqual(on.normalizeWhitespace(c), off.normalizeWhitespace(c));
  }
});

test('code-block masking round-trips even when text contains seed runs', () => {
  const dp = load(undefined);
  // A seed run adjacent to a fenced block must not corrupt restoration.
  const text = SEED.repeat(3) + '\n```js\nlet a = 1;\n```\n' + SEED.repeat(2) + ' tail';
  const out = dp.stripDirectives(text);
  assert.ok(out.includes('let a = 1;'), 'code block content preserved');
});

test('gate disabled reproduces the legacy quadratic cost (load-bearing)', () => {
  const dp = load('0');
  // Small size to keep the test fast; assert the quadratic branch is taken by
  // measuring a clearly-super-linear cost vs the linear branch on the same input.
  const text = SEED.repeat(20000);
  const t0 = process.hrtime.bigint();
  dp._createSentinel(text);
  const offMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const dpOn = load('1');
  const t1 = process.hrtime.bigint();
  dpOn._createSentinel(text);
  const onMs = Number(process.hrtime.bigint() - t1) / 1e6;

  // The linear branch must be dramatically cheaper on this pathological input.
  assert.ok(onMs * 10 < offMs || offMs > 20,
    `expected quadratic OFF (${offMs}ms) >> linear ON (${onMs}ms)`);
});

test('disable-token variants all select the legacy loop', () => {
  for (const tok of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.strictEqual(load(tok)._sentinelLinearEnabled(), false, `token ${tok}`);
  }
  assert.strictEqual(load(undefined)._sentinelLinearEnabled(), true);
  assert.strictEqual(load('1')._sentinelLinearEnabled(), true);
});
