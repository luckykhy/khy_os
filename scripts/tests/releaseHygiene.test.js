'use strict';

/**
 * Release source-hygiene guard tests (node:test, TDD red first).
 *
 * Pure-core contract (proposal 2026-09-18-tier1-minimax-code #3, method idea):
 * secret shapes, tracked .env files, symlinks without explicit review, and
 * LICENSE hash drift are reported as findings; the S1 stage never blocks.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  scanContent,
  isTrackedEnvFile,
  evaluateLicensePin,
  matchExemption,
  SECRET_PATTERNS,
} = require('../lib/releaseHygieneGuard');

test('scanContent flags provider-key and token shapes', () => {
  const findings = scanContent('src/a.js', 'const k = "sk-ABCDEFGHIJ0123456789";');
  assert.ok(findings.some((f) => f.code === 'secret-shape' && f.pattern === 'provider-key'));
  const tok = scanContent('src/b.js', 'token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  assert.ok(tok.some((f) => f.code === 'secret-shape'));
});

test('scanContent flags private key blocks but not base64 noise', () => {
  const pem = scanContent('c', '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----');
  assert.ok(pem.some((f) => f.code === 'secret-shape' && f.pattern === 'private-key-block'));
  assert.strictEqual(scanContent('d', 'const ok = "not a secret at all";').length, 0);
});

test('env placeholder text and redaction markers are not secrets', () => {
  assert.strictEqual(scanContent('e', 'export ANTHROPIC_API_KEY=sk-***REDACTED***').length, 0);
  assert.strictEqual(scanContent('f', '// e.g. sk-your-key-here').length, 0);
});

test('SECRET_PATTERNS are all regex objects', () => {
  for (const [, re] of SECRET_PATTERNS) assert.ok(re instanceof RegExp);
});

test('tracked .env files are reported, templates are not', () => {
  assert.strictEqual(isTrackedEnvFile('.env'), true);
  assert.strictEqual(isTrackedEnvFile('services/.env.production'), true);
  assert.strictEqual(isTrackedEnvFile('.env.example'), false);
  assert.strictEqual(isTrackedEnvFile('README.md'), false);
});

test('license pin: missing file, drift, and match are three distinct codes', () => {
  assert.strictEqual(evaluateLicensePin({ exists: false, pinned: null }).code, 'license-missing');
  assert.strictEqual(
    evaluateLicensePin({ exists: true, sha256: 'aa', pinned: 'aa' }).code,
    'license-pinned',
  );
  assert.strictEqual(
    evaluateLicensePin({ exists: true, sha256: 'aa', pinned: 'bb' }).code,
    'license-drift',
  );
});

test('exemptions match per file AND full value only (no directory-wide grants)', () => {
  const list = [{ file: 'tests/fixtures/keys.js', match: 'sk-ABCDEFGHIJ0123456789' }];
  assert.strictEqual(matchExemption(list, 'tests/fixtures/keys.js', 'sk-ABCDEFGHIJ0123456789'), true);
  assert.strictEqual(matchExemption(list, 'tests/fixtures/other.js', 'sk-ABCDEFGHIJ0123456789'), false);
  assert.strictEqual(matchExemption(list, 'tests/fixtures/keys.js', 'sk-OTHER'), false);
});
