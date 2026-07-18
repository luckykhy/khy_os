'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { envFlagEnabled, resolveFlag } = require('../../../src/services/capabilityMatrix/predicates');

// The exhaustive env-value space every seam flag is parsed against. This is the
// unit-level proof that isEnabledAt() cannot drift from the inline checks it
// replaces: for each predicate kind we assert resolveFlag() equals the ORIGINAL
// inline expression for every one of these values.
const ENV_VALUES = [
  undefined, '', '0', '1', 'off', 'on', 'true', 'false', 'no', 'yes',
  'y', 'n', 'OFF', 'On', '  1  ', ' off ', 'garbage',
];

function withRaw(value) {
  return value === undefined ? {} : { KHY_X: value };
}

test('envFlagEnabled matches the canonical _envFlagEnabled semantics', () => {
  // undefined/null/blank → default
  assert.strictEqual(envFlagEnabled(undefined, true), true);
  assert.strictEqual(envFlagEnabled(undefined, false), false);
  assert.strictEqual(envFlagEnabled('', true), true);
  assert.strictEqual(envFlagEnabled('   ', false), false);
  // truthy tokens
  for (const v of ['1', 'true', 'on', 'yes', 'y', ' ON ', 'True']) {
    assert.strictEqual(envFlagEnabled(v, false), true, `${v} → true`);
  }
  // falsy tokens
  for (const v of ['0', 'false', 'off', 'no', 'n', ' OFF ', 'False']) {
    assert.strictEqual(envFlagEnabled(v, true), false, `${v} → false`);
  }
  // unrecognized → default
  assert.strictEqual(envFlagEnabled('garbage', true), true);
  assert.strictEqual(envFlagEnabled('garbage', false), false);
});

test("kind:envFlagDefault === _envFlagEnabled(env[name], default) for all env values", () => {
  for (const def of [true, false]) {
    for (const v of ENV_VALUES) {
      const env = withRaw(v);
      const expected = envFlagEnabled(env.KHY_X, def);
      const got = resolveFlag({ env: 'KHY_X', kind: 'envFlagDefault', default: def }, { env });
      assert.strictEqual(got, expected, `envFlagDefault(default=${def}) raw=${JSON.stringify(v)}`);
    }
  }
});

test("kind:offDisables === (env[name] !== 'off') — strict, no trim/lowercase", () => {
  for (const v of ENV_VALUES) {
    const env = withRaw(v);
    const expected = env.KHY_X !== 'off';
    const got = resolveFlag({ env: 'KHY_X', kind: 'offDisables' }, { env });
    assert.strictEqual(got, expected, `offDisables raw=${JSON.stringify(v)}`);
  }
  // explicit strictness: ' off ' and 'OFF' are NOT 'off'
  assert.strictEqual(resolveFlag({ env: 'KHY_X', kind: 'offDisables' }, { env: { KHY_X: ' off ' } }), true);
  assert.strictEqual(resolveFlag({ env: 'KHY_X', kind: 'offDisables' }, { env: { KHY_X: 'OFF' } }), true);
  assert.strictEqual(resolveFlag({ env: 'KHY_X', kind: 'offDisables' }, { env: { KHY_X: 'off' } }), false);
});

test("kind:zeroDisables === (String(env[name]||'').trim() !== '0')", () => {
  for (const v of ENV_VALUES) {
    const env = withRaw(v);
    const expected = String(env.KHY_X || '').trim() !== '0';
    const got = resolveFlag({ env: 'KHY_X', kind: 'zeroDisables' }, { env });
    assert.strictEqual(got, expected, `zeroDisables raw=${JSON.stringify(v)}`);
  }
  // '  0  ' trims to '0' → disabled
  assert.strictEqual(resolveFlag({ env: 'KHY_X', kind: 'zeroDisables' }, { env: { KHY_X: '  0  ' } }), false);
  // anything non-'0' (incl. blank/undefined) → enabled (default-ON)
  assert.strictEqual(resolveFlag({ env: 'KHY_X', kind: 'zeroDisables' }, { env: {} }), true);
});

test("kind:onEnables === (['1','on'].includes(trimmed lower)) — default OFF", () => {
  for (const v of ENV_VALUES) {
    const env = withRaw(v);
    const expected = ['1', 'on'].includes(String(env.KHY_X || '').trim().toLowerCase());
    const got = resolveFlag({ env: 'KHY_X', kind: 'onEnables' }, { env });
    assert.strictEqual(got, expected, `onEnables raw=${JSON.stringify(v)}`);
  }
  assert.strictEqual(resolveFlag({ env: 'KHY_X', kind: 'onEnables' }, { env: {} }), false);
  assert.strictEqual(resolveFlag({ env: 'KHY_X', kind: 'onEnables' }, { env: { KHY_X: 'On' } }), true);
});

test('kind:always is unconditionally true', () => {
  for (const v of ENV_VALUES) {
    assert.strictEqual(resolveFlag({ kind: 'always' }, { env: withRaw(v) }), true);
  }
  // missing flag spec → unconditional too
  assert.strictEqual(resolveFlag(null), true);
  assert.strictEqual(resolveFlag(undefined), true);
});

test('kind:module delegates to isEnabledFn and fails closed', () => {
  assert.strictEqual(resolveFlag({ kind: 'module' }, { isEnabledFn: () => true }), true);
  assert.strictEqual(resolveFlag({ kind: 'module' }, { isEnabledFn: () => false }), false);
  assert.strictEqual(resolveFlag({ kind: 'module' }, { isEnabledFn: () => { throw new Error('boom'); } }), false);
  assert.strictEqual(resolveFlag({ kind: 'module' }, {}), false); // no fn → disabled
});

test('unknown kind falls through to true (never silently disables)', () => {
  assert.strictEqual(resolveFlag({ env: 'KHY_X', kind: 'mystery' }, { env: {} }), true);
});
