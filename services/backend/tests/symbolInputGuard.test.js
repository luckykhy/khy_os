'use strict';

/**
 * Regression tests for the symbolResolver public-boundary input guard.
 *
 * Context: resolveSymbol / searchInstruments are exposed to third-party
 * plugins via the plugin `context.resolve` API. Their documented contract is
 * `@param {string}`. The real CLI path (routerHandlers.resolveArg0) always
 * passes string tokens, so a non-string arrival is NOT user-reachable — this
 * guard is defense-in-depth for the plugin-facing contract. It must NEVER
 * throw `input.trim is not a function` on hostile non-string input, and must
 * stay byte-identical for every string input.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const MOD = path.resolve(__dirname, '../src/cli/symbolResolver.js');
const {
  resolveSymbol,
  searchInstruments,
  _symbolInputGuardEnabled,
  _coerceSymbolInput,
} = require(MOD);

function withEnv(value, fn) {
  const prev = process.env.KHY_SYMBOL_INPUT_GUARD;
  if (value === undefined) delete process.env.KHY_SYMBOL_INPUT_GUARD;
  else process.env.KHY_SYMBOL_INPUT_GUARD = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.KHY_SYMBOL_INPUT_GUARD;
    else process.env.KHY_SYMBOL_INPUT_GUARD = prev;
  }
}

test('guard defaults on; disable tokens turn it off', () => {
  withEnv(undefined, () => assert.strictEqual(_symbolInputGuardEnabled(), true));
  for (const off of ['0', 'false', 'off', 'no', 'FALSE', 'Off', ' No ']) {
    withEnv(off, () => assert.strictEqual(_symbolInputGuardEnabled(), false, `token=${JSON.stringify(off)}`));
  }
  for (const on of ['1', 'true', 'yes', 'on', '']) {
    withEnv(on, () => assert.strictEqual(_symbolInputGuardEnabled(), true, `token=${JSON.stringify(on)}`));
  }
});

test('_coerceSymbolInput: strings byte-identical, non-strings coerced when on', () => {
  withEnv(undefined, () => {
    // Strings pass through unchanged (byte-identical)
    for (const s of ['', 'sh600519', '茅台', 'gzmt', '  spaced  ', '600519']) {
      assert.strictEqual(_coerceSymbolInput(s), s);
    }
    // Falsy non-strings pass through unchanged (callers handle them)
    assert.strictEqual(_coerceSymbolInput(null), null);
    assert.strictEqual(_coerceSymbolInput(undefined), undefined);
    // Truthy non-strings coerced to string
    assert.strictEqual(_coerceSymbolInput(42), '42');
    assert.strictEqual(_coerceSymbolInput(true), 'true');
  });
});

test('_coerceSymbolInput: guard OFF returns value unchanged (byte-identical legacy)', () => {
  withEnv('0', () => {
    assert.strictEqual(_coerceSymbolInput(42), 42);
    assert.strictEqual(_coerceSymbolInput(null), null);
    assert.strictEqual(_coerceSymbolInput('sh600519'), 'sh600519');
  });
});

test('_coerceSymbolInput: hostile toString does not escape (returns empty)', () => {
  withEnv(undefined, () => {
    const hostile = { toString() { throw new Error('boom'); } };
    assert.strictEqual(_coerceSymbolInput(hostile), '');
  });
});

test('resolveSymbol never throws on hostile non-string input (guard ON)', async () => {
  await withEnv(undefined, async () => {
    // Numbers/booleans/objects: contrived non-strings that would legacy-throw.
    // 42 -> '42' matches /^[0-9]/ so it hits loadInstruments (empty-safe) and
    // returns a shaped result. We only assert it does NOT throw.
    for (const bad of [42, true, {}, [], { toString() { return '茅台'; } }]) {
      const r = await resolveSymbol(bad);
      assert.ok(r && typeof r === 'object' && 'symbol' in r && 'matched' in r,
        `input=${JSON.stringify(bad)} produced ${JSON.stringify(r)}`);
    }
  });
});

test('resolveSymbol: falsy inputs keep legacy early-return shape', async () => {
  await withEnv(undefined, async () => {
    for (const falsy of [null, undefined, '', 0, false, NaN]) {
      const r = await resolveSymbol(falsy);
      assert.deepStrictEqual(r, { symbol: falsy, name: '', matched: false });
    }
  });
});

test('resolveSymbol: string behavior unchanged for pinyin/code (guard ON vs OFF equal)', async () => {
  // Pinyin map lookup does hit loadInstruments; with empty DB it returns the
  // mapped symbol with matched=false. Both guard states must agree for strings.
  const on = await withEnv(undefined, () => resolveSymbol('gzmt'));
  const off = await withEnv('0', () => resolveSymbol('gzmt'));
  assert.deepStrictEqual(on, off);
  assert.strictEqual(on.symbol, 'sh600519');
});

test('searchInstruments never throws on non-string (guard ON)', async () => {
  await withEnv(undefined, async () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      const r = await searchInstruments(bad);
      assert.ok(Array.isArray(r), `input=${JSON.stringify(bad)} -> ${JSON.stringify(r)}`);
    }
  });
});
