'use strict';

const test = require('node:test');
const assert = require('node:assert');

const r = require('../src/services/repoDisciplineRisk');

// ── gate ───────────────────────────────────────────────────────────────────
test('gate: default on; only 0/false/off/no turns it off', () => {
  assert.strictEqual(r.isEnabled({}), true);
  assert.strictEqual(r.isEnabled({ KHY_REPO_DISCIPLINE: '1' }), true);
  assert.strictEqual(r.isEnabled({ KHY_REPO_DISCIPLINE: 'off' }), false);
  assert.strictEqual(r.isEnabled({ KHY_REPO_DISCIPLINE: 'FALSE' }), false);
  assert.strictEqual(r.isEnabled({ KHY_REPO_DISCIPLINE: '0' }), false);
  assert.strictEqual(r.isEnabled({ KHY_REPO_DISCIPLINE: 'no' }), false);
});

test('gate off → safe-empty assessment (byte-revert: no findings)', () => {
  const res = r.assessRepoRisk({ env: { KHY_REPO_DISCIPLINE: 'off' }, diffText: '+const k="AKIAIOSFODNN7EXAMPLE";' });
  assert.strictEqual(res.enabled, false);
  assert.strictEqual(res.verdict, 'clean');
  assert.deepStrictEqual(res.findings, []);
});

// ── secret scanning ──────────────────────────────────────────────────────────
test('scanSecretLeaks: catches high-confidence patterns', () => {
  const diff = [
    'diff --git a/c.js b/c.js',
    '+++ b/c.js',
    '+const aws = "AKIAIOSFODNN7EXAMPLE";',
    '+const gh = "ghp_1234567890abcdefghijklmnopqrstuvwxyz123";',
    '+const key = "-----BEGIN RSA PRIVATE KEY-----";',
  ].join('\n');
  const hits = r.scanSecretLeaks(diff);
  const ids = hits.map((h) => h.id).sort();
  assert.deepStrictEqual(ids, ['aws-access-key-id', 'github-token', 'private-key-block']);
  assert.ok(hits.every((h) => h.severity === 'critical'));
});

test('scanSecretLeaks: generic assignment requires strong context + suppresses placeholders', () => {
  const real = r.scanSecretLeaks('password = "S3cr3tP@ssw0rd1234567"');
  assert.strictEqual(real.length, 1);
  assert.strictEqual(real[0].id, 'generic-assignment');
  // placeholders must NOT trigger
  assert.strictEqual(r.scanSecretLeaks('apiKey = "your-api-key-here"').length, 0);
  assert.strictEqual(r.scanSecretLeaks('token = "process.env.TOKEN_VALUE"').length, 0);
  assert.strictEqual(r.scanSecretLeaks('secret = "changeme-please-now-xx"').length, 0);
});

test('scanSecretLeaks: diff-aware — only added (+) lines, never removed (-) lines', () => {
  const diff = [
    'diff --git a/c.js b/c.js',
    '+++ b/c.js',
    '-const old = "AKIAIOSFODNN7EXAMPLE";',
    '+const ok = "harmless";',
  ].join('\n');
  assert.strictEqual(r.scanSecretLeaks(diff).length, 0);
});

test('scanSecretLeaks: never echoes the full secret (masked)', () => {
  const hits = r.scanSecretLeaks('+const aws = "AKIAIOSFODNN7EXAMPLE";');
  assert.ok(hits.length >= 1);
  assert.ok(!hits[0].masked.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.match(hits[0].masked, /^AKIA…/);
});

test('scanSecretLeaks: every finding carries a human message that does not leak the secret', () => {
  const hits = r.scanSecretLeaks([
    '+const aws = "AKIAIOSFODNN7EXAMPLE";',
    '+password = "S3cr3tP@ssw0rd1234567"',
  ].join('\n'));
  assert.ok(hits.length >= 2);
  for (const h of hits) {
    assert.ok(typeof h.message === 'string' && h.message.length > 0, 'finding must have a message (CLI/tool render f.message)');
    assert.ok(!h.message.includes('AKIAIOSFODNN7EXAMPLE'));
    assert.ok(!h.message.includes('S3cr3tP@ssw0rd1234567'));
  }
});

test('scanSecretLeaks: fail-soft on junk input', () => {
  assert.deepStrictEqual(r.scanSecretLeaks(undefined), []);
  assert.deepStrictEqual(r.scanSecretLeaks(null), []);
  assert.deepStrictEqual(r.scanSecretLeaks(123), []);
});

// ── file risk ────────────────────────────────────────────────────────────────
test('assessFileRisk: large file → high; binary artifact → medium; normal → none', () => {
  const out = r.assessFileRisk([
    { path: 'data/big.csv', size: 6 * 1024 * 1024 },
    { path: 'build/app.exe', size: 1234 },
    { path: 'src/index.js', size: 2000 },
  ]);
  const byKind = Object.fromEntries(out.map((f) => [f.path, f]));
  assert.strictEqual(byKind['data/big.csv'].severity, 'high');
  assert.strictEqual(byKind['build/app.exe'].kind, 'binary-artifact');
  assert.strictEqual(byKind['build/app.exe'].severity, 'medium');
  assert.strictEqual(byKind['src/index.js'], undefined);
});

test('assessFileRisk: fail-soft', () => {
  assert.deepStrictEqual(r.assessFileRisk(undefined), []);
  assert.deepStrictEqual(r.assessFileRisk([null, {}, { path: '' }]), []);
});

// ── commit message (delegates to forgeCore.evaluateCommitQuality) ─────────────
test('assessCommitMessage: conventional → A; vague → F; empty → flagged', () => {
  const good = r.assessCommitMessage('feat(repo): add discipline audit');
  assert.strictEqual(good.grade, 'A');
  assert.strictEqual(good.conventional, true);
  const vague = r.assessCommitMessage('wip');
  assert.strictEqual(vague.grade, 'F');
  const empty = r.assessCommitMessage('');
  assert.strictEqual(empty.empty, true);
});

// ── path tier risk (delegates to evolutionPolicy.classifyPath) ───────────────
test('classifyPathRisk: immutable→high advisory; evolvable→null', () => {
  const lic = r.classifyPathRisk('LICENSE');
  assert.ok(lic && lic.tier === 'immutable' && lic.severity === 'high');
  assert.strictEqual(r.classifyPathRisk('services/backend/src/services/foo.js'), null);
});

// ── composite verdict ────────────────────────────────────────────────────────
test('assessRepoRisk: critical signals → block', () => {
  const res = r.assessRepoRisk({
    branch: 'main', mainBranch: 'main', force: true, noVerify: true,
    files: [{ path: 'build/app.exe', size: 10 }],
    diffText: '+const aws = "AKIAIOSFODNN7EXAMPLE";',
    message: 'wip',
  });
  assert.strictEqual(res.enabled, true);
  assert.strictEqual(res.verdict, 'block');
  const kinds = res.findings.map((f) => f.kind);
  assert.ok(kinds.includes('secret'));
  assert.ok(kinds.includes('no-force-push-main'));
  assert.ok(kinds.includes('no-skip-hooks'));
  assert.ok(kinds.includes('branch-first'));
});

test('assessRepoRisk: only medium/high signals → caution', () => {
  const res = r.assessRepoRisk({
    branch: 'feature/x', mainBranch: 'main',
    files: [{ path: 'assets/logo.png', size: 1500 * 1024 }],
    message: 'feat: add logo asset to the brand kit',
  });
  assert.strictEqual(res.verdict, 'caution');
});

test('assessRepoRisk: clean working set → clean', () => {
  const res = r.assessRepoRisk({
    branch: 'feature/x', mainBranch: 'main',
    files: [{ path: 'services/backend/src/services/foo.js', size: 1000 }],
    diffText: '+const x = 1;',
    message: 'feat(foo): add x',
  });
  assert.strictEqual(res.verdict, 'clean');
  assert.strictEqual(res.findings.length, 0);
});

test('assessRepoRisk: fail-soft never throws on garbage', () => {
  assert.doesNotThrow(() => r.assessRepoRisk(null));
  assert.doesNotThrow(() => r.assessRepoRisk({ files: 'nope', diffText: {}, message: 42 }));
});

// ── charter rendering (single source for prompt + CLI) ───────────────────────
test('describeDisciplineCharter: stable shape, all rules carry severity', () => {
  const c = r.describeDisciplineCharter();
  assert.ok(Array.isArray(c.rules) && c.rules.length >= 10);
  assert.ok(c.rules.every((x) => x.id && x.severity && x.rule && x.why));
  assert.strictEqual(c.gate, 'KHY_REPO_DISCIPLINE');
});

test('buildGitSafetyBullets: one bullet per rule, English directives', () => {
  const bullets = r.buildGitSafetyBullets().split('\n');
  assert.strictEqual(bullets.length, r.DISCIPLINE_RULES.length);
  assert.ok(bullets.every((b) => b.startsWith('- ')));
  assert.ok(bullets.some((b) => /NEVER force-push to main/.test(b)));
});
