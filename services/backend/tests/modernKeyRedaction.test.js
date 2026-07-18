'use strict';

/**
 * modernKeyRedaction.test.js — 纯叶子契约 + honestFailureReason.sanitizeCause 接线。
 *
 * 覆盖:门控(flagRegistry-first + 本地 CANON 回退)、fail-soft;叶子门开抹现代 key/门关 null;
 * 接线活验:门开 → sk-proj-/sk-svcacct-/sk-admin- 脱敏;门关 → 逐字节回退(泄漏);
 * 诊断真因(ECONNREFUSED/HTTP 502/host:port)两态都保留。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const leaf = require(path.join(__dirname, '../src/services/modernKeyRedaction'));

test('modernKeyRedactionEnabled: default ON; CANON off-words disable', () => {
  assert.strictEqual(leaf.modernKeyRedactionEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(
      leaf.modernKeyRedactionEnabled({ KHY_MODERN_KEY_REDACTION: off }), false, `off=${off}`);
  }
  assert.strictEqual(leaf.modernKeyRedactionEnabled({ KHY_MODERN_KEY_REDACTION: 'yes' }), true);
});

test('fail-soft: never throws on bad env', () => {
  assert.doesNotThrow(() => leaf.modernKeyRedactionEnabled(null));
  assert.doesNotThrow(() => leaf.redactModernKeys(12345, {}));
  assert.doesNotThrow(() => leaf.redactModernKeys(null, {}));
});

test('redactModernKeys: gate ON redacts modern OpenAI key formats', () => {
  assert.strictEqual(leaf.redactModernKeys('auth failed with sk-proj-abcd1234EFGH5678ijkl', {}),
    'auth failed with ***');
  assert.strictEqual(leaf.redactModernKeys('token sk-svcacct-abcd1234EFGH5678ijkl', {}),
    'token ***');
  assert.strictEqual(leaf.redactModernKeys('sk-admin-abcd1234EFGH5678', {}), '***');
});

test('redactModernKeys: preserves diagnostics, short tokens, non-string → null', () => {
  assert.strictEqual(leaf.redactModernKeys('ECONNREFUSED at host:8080', {}), 'ECONNREFUSED at host:8080');
  assert.strictEqual(leaf.redactModernKeys('HTTP 502 from api.openai.com', {}), 'HTTP 502 from api.openai.com');
  assert.strictEqual(leaf.redactModernKeys('just sk-1-2 short', {}), 'just sk-1-2 short');
  assert.strictEqual(leaf.redactModernKeys('', {}), null);
  assert.strictEqual(leaf.redactModernKeys(42, {}), null);
});

test('redactModernKeys: gate OFF → null (caller keeps legacy string)', () => {
  const off = { KHY_MODERN_KEY_REDACTION: '0' };
  assert.strictEqual(leaf.redactModernKeys('sk-proj-abcd1234EFGH5678ijkl', off), null);
});

// ── honestFailureReason.sanitizeCause 接线活验 ──────────────────────────
function freshHonest() {
  delete require.cache[require.resolve('../src/services/honestFailureReason')];
  delete require.cache[require.resolve('../src/services/modernKeyRedaction')];
  return require('../src/services/honestFailureReason');
}

function withEnv(mut, fn) {
  const saved = {};
  for (const k of Object.keys(mut)) { saved[k] = process.env[k]; if (mut[k] == null) delete process.env[k]; else process.env[k] = mut[k]; }
  try { return fn(); }
  finally { for (const k of Object.keys(mut)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('wiring ON: sanitizeCause redacts modern keys that legacy pattern missed', () => {
  withEnv({ KHY_MODERN_KEY_REDACTION: undefined }, () => {
    const m = freshHonest();
    assert.strictEqual(m.sanitizeCause('auth failed with sk-proj-abcd1234EFGH5678ijkl'), 'auth failed with ***');
    assert.strictEqual(m.sanitizeCause('token sk-svcacct-abcd1234EFGH5678ijkl'), 'token ***');
    // legacy key still redacted; diagnostics preserved
    assert.strictEqual(m.sanitizeCause('key sk-abcd1234EFGH5678ijklMNOP'), 'key ***');
    assert.strictEqual(m.sanitizeCause('ECONNREFUSED at 127.0.0.1:7890'), 'ECONNREFUSED at 127.0.0.1:7890');
  });
});

test('wiring OFF: byte-revert → modern key leaks through sanitizeCause', () => {
  withEnv({ KHY_MODERN_KEY_REDACTION: '0' }, () => {
    const m = freshHonest();
    assert.strictEqual(m.sanitizeCause('auth failed with sk-proj-abcd1234EFGH5678ijkl'),
      'auth failed with sk-proj-abcd1234EFGH5678ijkl');
    // legacy pattern unaffected under gate off
    assert.strictEqual(m.sanitizeCause('key sk-abcd1234EFGH5678ijklMNOP'), 'key ***');
  });
});
