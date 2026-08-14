'use strict';

/**
 * selfAuditVerifier — contract tests for the khyos self-audit runtime evidence layer.
 *
 * Division of labor under test:
 *   selfAuditRegistry = pure data SSOT (declares evidenceAnchors, zero IO);
 *   selfAuditVerifier = IO verification layer (checks anchors against the live
 *   filesystem / flag registry) so the AI can PROVE the self-audit is grounded
 *   instead of circularly quoting static registry data.
 *
 * Invariants:
 *   ① gate KHY_AUDIT_DYNAMIC_VERIFY default ON → verifyAll returns a result
 *   ② gate OFF (0/false/off/no) → verifyAll returns null (byte-revert seam)
 *   ③ against the real codebase all 5 items (#1/#4/#5/#6/#7) verify true,
 *      each with well-formed checks ({type,target,ok}) and a checkedAt stamp
 *   ④ TTL cache: two calls within the TTL return the SAME checkedAt (same object)
 *   ⑤ invalid KHY_AUDIT_VERIFY_TTL_MS values never throw, behavior falls back
 *   ⑥ never throws on malformed opts
 *
 * Note: the module keeps a module-level TTL cache; tests use the exported
 * _resetCache() hook to isolate cases. The gate is checked BEFORE the cache
 * lookup (verified in source), so gate-off cases are immune to cache state.
 *
 * node:test (jest via rtk proxy unavailable — Exec format error).
 */

const test = require('node:test');
const assert = require('node:assert');

const verifier = require('../../src/services/selfAuditVerifier');

const ITEM_IDS = ['#1', '#4', '#5', '#6', '#7'];

// ── ② gate OFF → null (run cache-independent; gate is checked before cache) ──
test('KHY_AUDIT_DYNAMIC_VERIFY falsy words → verifyAll returns null', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    const r = verifier.verifyAll({ env: { KHY_AUDIT_DYNAMIC_VERIFY: off } });
    assert.strictEqual(r, null, `'${off}' must gate verification off`);
  }
});

test('isEnabled mirrors the gate semantics (default ON, falsy words OFF)', () => {
  assert.strictEqual(verifier.isEnabled({}), true);
  assert.strictEqual(verifier.isEnabled({ KHY_AUDIT_DYNAMIC_VERIFY: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(verifier.isEnabled({ KHY_AUDIT_DYNAMIC_VERIFY: off }), false, `'${off}'`);
  }
});

// ── ① + ③ default ON, all 5 items verified against the real codebase ─────
test('verifyAll (gate unset) returns evidence: all 5 items verified true', () => {
  verifier._resetCache();
  const r = verifier.verifyAll({ env: {} });
  assert.ok(r, 'default ON → non-null result');
  assert.strictEqual(typeof r.checkedAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(r.checkedAt)), 'checkedAt is a parseable timestamp');
  assert.ok(r.results && typeof r.results === 'object', 'results is a plain object');
  for (const id of ITEM_IDS) {
    const item = r.results[id];
    assert.ok(item, `results has ${id}`);
    assert.strictEqual(item.verified, true, `${id} verified against the live codebase (reason: ${item.reason})`);
    assert.ok(Array.isArray(item.checks) && item.checks.length > 0, `${id} has checks`);
    for (const c of item.checks) {
      assert.ok(['module', 'gate'].includes(c.type), `${id} check type valid`);
      assert.strictEqual(typeof c.target, 'string');
      assert.strictEqual(typeof c.ok, 'boolean');
      assert.strictEqual(c.ok, true, `${id} check ${c.target} ok`);
    }
    assert.strictEqual(typeof item.reason, 'string');
  }
});

// ── ④ TTL cache: same checkedAt within the TTL window ─────────────────────
test('TTL cache: two consecutive calls return the same checkedAt', () => {
  verifier._resetCache();
  const a = verifier.verifyAll({ env: {} });
  const b = verifier.verifyAll({ env: {} });
  assert.ok(a && b, 'both calls return results');
  assert.strictEqual(a.checkedAt, b.checkedAt, 'cache hit reuses the same checkedAt');
  assert.strictEqual(a, b, 'cache hit returns the SAME object');
});

// ── ⑤ invalid TTL values: no throw, fallback behavior ─────────────────────
test('invalid KHY_AUDIT_VERIFY_TTL_MS values never throw and still verify', () => {
  for (const bad of ['abc', '-5', '', '  ']) {
    verifier._resetCache();
    let r;
    assert.doesNotThrow(() => { r = verifier.verifyAll({ env: { KHY_AUDIT_VERIFY_TTL_MS: bad } }); }, `TTL '${bad}'`);
    assert.ok(r && r.results, `TTL '${bad}' falls back and still returns results`);
    for (const id of ITEM_IDS) assert.ok(r.results[id], `TTL '${bad}' still verifies ${id}`);
  }
});

// ── ⑥ never throws on malformed opts ──────────────────────────────────────
test('verifyAll never throws on malformed opts', () => {
  verifier._resetCache();
  assert.doesNotThrow(() => verifier.verifyAll(null));
  assert.doesNotThrow(() => verifier.verifyAll(undefined));
  assert.doesNotThrow(() => verifier.verifyAll({}));
  assert.doesNotThrow(() => verifier.verifyAll({ env: null }));
  assert.doesNotThrow(() => verifier.isEnabled(null));
});
