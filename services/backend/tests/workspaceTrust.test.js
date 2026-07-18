'use strict';

/**
 * workspaceTrust — pins the pure-leaf decision + text SSOT for the "quick safety
 * check / trust this folder" dialog (aligns with Claude Code workspace trust).
 *
 * The leaf is zero-IO: caller injects cwd/homedir/trustedPaths/sessionTrusted and
 * the leaf decides trusted vs needs-prompt, mirroring CC's parent-dir inheritance
 * and home-dir session-only trust. Gate KHY_WORKSPACE_TRUST default on; off →
 * caller byte-reverts to "no prompt, treat as trusted".
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const wt = require('../src/services/workspaceTrust');

test('isTrustGateEnabled: default on, {0,false,off,no} off', () => {
  assert.strictEqual(wt.isTrustGateEnabled({}), true);
  assert.strictEqual(wt.isTrustGateEnabled({ KHY_WORKSPACE_TRUST: undefined }), true);
  assert.strictEqual(wt.isTrustGateEnabled({ KHY_WORKSPACE_TRUST: 'true' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(wt.isTrustGateEnabled({ KHY_WORKSPACE_TRUST: v }), false, `expected off for ${v}`);
  }
});

test('isPersistHomeTrustEnabled: default OFF, {1,true,on,yes,y} on', () => {
  // Default off — home stays session-only unless explicitly opted in.
  assert.strictEqual(wt.isPersistHomeTrustEnabled({}), false);
  assert.strictEqual(wt.isPersistHomeTrustEnabled({ KHY_TRUST_PERSIST_HOME: undefined }), false);
  assert.strictEqual(wt.isPersistHomeTrustEnabled({ KHY_TRUST_PERSIST_HOME: '' }), false);
  for (const v of ['1', 'true', 'on', 'yes', 'y', 'ON', ' Yes ']) {
    assert.strictEqual(wt.isPersistHomeTrustEnabled({ KHY_TRUST_PERSIST_HOME: v }), true, `expected on for ${v}`);
  }
  for (const v of ['0', 'false', 'off', 'no', 'nope']) {
    assert.strictEqual(wt.isPersistHomeTrustEnabled({ KHY_TRUST_PERSIST_HOME: v }), false, `expected off for ${v}`);
  }
});

test('isExactDirTrustEnabled: default OFF, {1,true,on,yes,y} on', () => {
  // Default off — parent-dir inheritance stays the default (CC-aligned).
  assert.strictEqual(wt.isExactDirTrustEnabled({}), false);
  assert.strictEqual(wt.isExactDirTrustEnabled({ KHY_TRUST_EXACT_DIR: undefined }), false);
  assert.strictEqual(wt.isExactDirTrustEnabled({ KHY_TRUST_EXACT_DIR: '' }), false);
  for (const v of ['1', 'true', 'on', 'yes', 'y', 'ON', ' Yes ']) {
    assert.strictEqual(wt.isExactDirTrustEnabled({ KHY_TRUST_EXACT_DIR: v }), true, `expected on for ${v}`);
  }
  for (const v of ['0', 'false', 'off', 'no', 'nope']) {
    assert.strictEqual(wt.isExactDirTrustEnabled({ KHY_TRUST_EXACT_DIR: v }), false, `expected off for ${v}`);
  }
});

test('normalizePathForKey: resolves to absolute, fail-soft on junk', () => {
  assert.strictEqual(wt.normalizePathForKey('/a/b/../c'), path.resolve('/a/b/../c'));
  assert.strictEqual(wt.normalizePathForKey(''), '');
  assert.strictEqual(wt.normalizePathForKey(null), '');
});

test('isHomeDir: exact match after normalization', () => {
  assert.strictEqual(wt.isHomeDir('/home/u', '/home/u'), true);
  assert.strictEqual(wt.isHomeDir('/home/u/proj', '/home/u'), false);
  assert.strictEqual(wt.isHomeDir('/home/u/.', '/home/u'), true);
});

test('isPathTrusted: exact + parent-dir inheritance', () => {
  const trusted = ['/home/u/projects'];
  assert.strictEqual(wt.isPathTrusted('/home/u/projects', trusted), true);
  assert.strictEqual(wt.isPathTrusted('/home/u/projects/foo', trusted), true, 'child inherits');
  assert.strictEqual(wt.isPathTrusted('/home/u/projects/foo/bar', trusted), true, 'grandchild inherits');
  assert.strictEqual(wt.isPathTrusted('/home/u/other', trusted), false);
  assert.strictEqual(wt.isPathTrusted('/home/u', trusted), false, 'parent of a trusted dir is NOT trusted');
});

test('isPathTrusted: exactMatch=true → only the exact dir, no parent inheritance', () => {
  const trusted = ['/home/u'];
  assert.strictEqual(wt.isPathTrusted('/home/u', trusted, true), true, 'exact dir trusted');
  assert.strictEqual(wt.isPathTrusted('/home/u/foo', trusted, true), false, 'child NOT inherited under exactMatch');
  assert.strictEqual(wt.isPathTrusted('/home/u/foo/bar', trusted, true), false, 'grandchild NOT inherited');
  // A separately-trusted child IS trusted on its own key.
  const both = ['/home/u', '/home/u/foo'];
  assert.strictEqual(wt.isPathTrusted('/home/u/foo', both, true), true, 'child trusted only via its own key');
  assert.strictEqual(wt.isPathTrusted('/home/u/foo/bar', both, true), false, 'grandchild of a trusted child still needs its own approval');
});

test('isPathTrusted: accepts Set or array, empty → false', () => {
  assert.strictEqual(wt.isPathTrusted('/a/b', new Set([path.resolve('/a/b')])), true);
  assert.strictEqual(wt.isPathTrusted('/a/b', []), false);
  assert.strictEqual(wt.isPathTrusted('/a/b', null), false);
});

test('computeTrustState: session trust short-circuits', () => {
  const s = wt.computeTrustState({ cwd: '/x/y', homedir: '/x', trustedPaths: [], sessionTrusted: true });
  assert.deepStrictEqual(s, { trusted: true, needsPrompt: false, isHomeDir: false, reason: 'session' });
});

test('computeTrustState: persisted trust (with inheritance)', () => {
  const s = wt.computeTrustState({ cwd: '/x/y/z', homedir: '/x', trustedPaths: ['/x/y'], sessionTrusted: false });
  assert.strictEqual(s.trusted, true);
  assert.strictEqual(s.needsPrompt, false);
  assert.strictEqual(s.reason, 'persisted');
});

test('computeTrustState: exactDir=true → child of trusted parent needs its own prompt', () => {
  // Parent /x/y is trusted; under exactDir the child /x/y/z is NOT auto-trusted.
  const child = wt.computeTrustState({
    cwd: '/x/y/z', homedir: '/x', trustedPaths: ['/x/y'], sessionTrusted: false, exactDir: true,
  });
  assert.strictEqual(child.trusted, false);
  assert.strictEqual(child.needsPrompt, true);
  assert.strictEqual(child.reason, 'untrusted');
  // The exact parent dir itself is still trusted.
  const parent = wt.computeTrustState({
    cwd: '/x/y', homedir: '/x', trustedPaths: ['/x/y'], sessionTrusted: false, exactDir: true,
  });
  assert.strictEqual(parent.trusted, true);
  assert.strictEqual(parent.reason, 'persisted');
});

test('computeTrustState: untrusted folder needs prompt', () => {
  const s = wt.computeTrustState({ cwd: '/x/new', homedir: '/x', trustedPaths: [], sessionTrusted: false });
  assert.strictEqual(s.trusted, false);
  assert.strictEqual(s.needsPrompt, true);
  assert.strictEqual(s.reason, 'untrusted');
});

test('computeTrustState: exactTrustedPaths trusts the exact dir but NEVER a child', () => {
  // Mirrors the home-dir default: home is persisted exact-scope so it stops
  // re-prompting (one click), yet subdirectories still need their own approval.
  const home = wt.computeTrustState({
    cwd: '/home/u', homedir: '/home/u', trustedPaths: [], exactTrustedPaths: ['/home/u'], sessionTrusted: false,
  });
  assert.strictEqual(home.trusted, true);
  assert.strictEqual(home.needsPrompt, false);
  assert.strictEqual(home.reason, 'persisted-exact');
  const child = wt.computeTrustState({
    cwd: '/home/u/proj', homedir: '/home/u', trustedPaths: [], exactTrustedPaths: ['/home/u'], sessionTrusted: false,
  });
  assert.strictEqual(child.trusted, false);
  assert.strictEqual(child.needsPrompt, true);
  assert.strictEqual(child.reason, 'untrusted', 'exact-scope home does not inherit to children');
});

test('computeTrustState: home dir flagged, still needs prompt when untrusted', () => {
  const s = wt.computeTrustState({ cwd: '/home/u', homedir: '/home/u', trustedPaths: [], sessionTrusted: false });
  assert.strictEqual(s.isHomeDir, true);
  assert.strictEqual(s.needsPrompt, true);
});

test('computeTrustState: never throws on odd input (defensive fail-open catch)', () => {
  // Coercible junk (objects) does not throw — normalizePathForKey stringifies it,
  // so the leaf simply yields a well-formed "untrusted" verdict rather than hitting
  // the outer catch. The contract that matters: it never throws and always returns
  // the {trusted,needsPrompt,isHomeDir,reason} shape.
  let s;
  assert.doesNotThrow(() => { s = wt.computeTrustState({ cwd: {}, homedir: {}, trustedPaths: {}, sessionTrusted: false }); });
  assert.strictEqual(typeof s.trusted, 'boolean');
  assert.strictEqual(typeof s.needsPrompt, 'boolean');
  assert.ok('reason' in s);
  // Missing args also must not throw.
  assert.doesNotThrow(() => wt.computeTrustState());
  assert.doesNotThrow(() => wt.computeTrustState({}));
});

test('buildTrustPromptLines: includes the cwd and safety framing', () => {
  const lines = wt.buildTrustPromptLines('/home/u/secret-proj');
  const joined = lines.join('\n');
  assert.ok(joined.includes('/home/u/secret-proj'), 'shows the directory');
  assert.ok(joined.includes('快速安全检查'), 'quick safety check framing');
  assert.ok(Array.isArray(lines) && lines.length > 0);
});

test('TRUST_CHOICES: trust + exit, frozen', () => {
  assert.deepStrictEqual(wt.TRUST_CHOICES.map((c) => c.value), ['trust', 'exit']);
  assert.ok(Object.isFrozen(wt.TRUST_CHOICES));
});
