'use strict';

/**
 * Round-14 regression: TOON codec decode depth cap (stack overflow).
 *
 * `_parseLines` recurses once per `key:`-ending line at increasing indent with
 * no depth bound, while the encode path IS capped (`_encodeValue` checks
 * `depth > opts.maxDepth`). That asymmetry lets a TOON document nested ~5000
 * levels deep overflow the JS stack (RangeError: Maximum call stack size
 * exceeded).
 *
 * Honest reachability: `toonDecode` is an EXPORTED api (tokenless/index.js) but
 * no internal caller currently wires it to untrusted (user/model) input — so
 * this is NEITHER user- nor model-reachable today. It is symmetric hardening of
 * an exported codec to match encode's existing guard (latent footgun, not a
 * live P1). Gate KHY_TOON_DEPTH_CAP (default on); off → legacy uncapped
 * recursion (byte-identical output, but overflows on adversarial nesting).
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const MOD = path.join(__dirname, '..', 'src', 'services', 'tokenless', 'toonCodec.js');

function load(gate) {
  delete require.cache[require.resolve(MOD)];
  if (gate === undefined) delete process.env.KHY_TOON_DEPTH_CAP;
  else process.env.KHY_TOON_DEPTH_CAP = gate;
  return require(MOD);
}

test.afterEach(() => { delete process.env.KHY_TOON_DEPTH_CAP; });

function nested(depth) {
  let out = '';
  for (let i = 0; i < depth; i++) out += '  '.repeat(i) + 'k' + i + ':\n';
  out += '  '.repeat(depth) + 'leaf: 1';
  return out;
}

test('deeply-nested TOON no longer overflows the stack (was RangeError at ~5000)', () => {
  const tc = load(undefined);
  assert.doesNotThrow(() => tc.decode(nested(5000)));
  assert.doesNotThrow(() => tc.decode(nested(20000)));
});

test('round-trip decode is byte-identical gate on vs off for realistic objects', () => {
  const on = load(undefined);
  const off = load('0');
  const objs = [
    { users: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }] },
    { a: 1, b: { c: 2, d: { e: 3 } } },
    { list: [1, 2, 3], flag: true, nil: null },
    { deep: { deep: { deep: { deep: { v: 'x' } } } } },
    'plain string',
    [10, 20, 30],
  ];
  for (const o of objs) {
    const enc = on.encode(o).toon;
    assert.deepStrictEqual(on.decode(enc), off.decode(enc),
      `decode mismatch for ${JSON.stringify(o).slice(0, 40)}`);
  }
});

test('a document within the cap decodes identically with the cap on', () => {
  const on = load(undefined);
  const off = load('0');
  // 100 levels — well within the 2048 cap, must be untouched by the guard.
  const toon = nested(100);
  assert.deepStrictEqual(on.decode(toon), off.decode(toon));
});

test('gate disabled reproduces the legacy stack overflow (load-bearing)', () => {
  const off = load('0');
  assert.throws(() => off.decode(nested(6000)), RangeError);
});

test('disable-token variants all turn the cap off', () => {
  for (const tok of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.strictEqual(load(tok)._toonDepthCapEnabled(), false, `token ${tok}`);
  }
  assert.strictEqual(load(undefined)._toonDepthCapEnabled(), true);
  assert.strictEqual(load('1')._toonDepthCapEnabled(), true);
});
