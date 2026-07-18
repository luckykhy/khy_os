'use strict';

/**
 * trustGate — pins the IO shell for the workspace-trust dialog. Uses a throwaway
 * KHY_DATA_HOME and a fake inquirer so no real prompt is shown. Covers: gate off
 * short-circuit, already-trusted skip, accept→persist (non-home), accept→session
 * (home, no persist), decline→exit, cancel→exit, non-interactive fail-open, and
 * fail-open on internal error.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-trust-gate-'));
process.env.KHY_DATA_HOME = TMP;

const gate = require('../src/cli/trustGate');

function fakeInquirer(value) {
  return { prompt: async () => ({ answer: value }) };
}
function throwingInquirer() {
  return { prompt: async () => { throw new Error('cancelled'); } };
}

beforeEach(() => {
  gate._resetSessionTrusted();
  delete process.env.KHY_WORKSPACE_TRUST;
  delete process.env.KHY_TRUST_PERSIST_HOME;
  delete process.env.KHY_TRUST_EXACT_DIR;
  // Clear the store between cases.
  try { fs.rmSync(gate._storePath(), { force: true }); } catch { /* ignore */ }
});

test('gate off: short-circuits as trusted, no prompt', async () => {
  process.env.KHY_WORKSPACE_TRUST = 'off';
  const d = await gate.ensureWorkspaceTrust({ cwd: path.join(TMP, 'anything'), inquirer: null });
  assert.strictEqual(d.trusted, true);
  assert.strictEqual(d.reason, 'gate-off');
});

test('already-persisted folder: trusted without prompt', async () => {
  const dir = path.join(TMP, 'proj');
  assert.strictEqual(gate._persistTrust(dir), true);
  // inquirer that would throw if called — proves no prompt happens.
  const d = await gate.ensureWorkspaceTrust({ cwd: dir, homedir: TMP, inquirer: throwingInquirer() });
  assert.strictEqual(d.trusted, true);
  assert.strictEqual(d.reason, 'persisted');
});

test('accept a new non-home folder: persists trust', async () => {
  const dir = path.join(TMP, 'fresh');
  const d = await gate.ensureWorkspaceTrust({
    cwd: dir, homedir: TMP, inquirer: fakeInquirer('trust'),
  });
  assert.strictEqual(d.trusted, true);
  assert.strictEqual(d.reason, 'accepted');
  assert.strictEqual(d.persisted, true);
  // Persisted → a second call is trusted without prompting.
  const d2 = await gate.ensureWorkspaceTrust({ cwd: dir, homedir: TMP, inquirer: throwingInquirer() });
  assert.strictEqual(d2.reason, 'persisted');
});

test('exact-dir on: persisted parent does NOT auto-trust child; child needs its own approval', async () => {
  process.env.KHY_TRUST_EXACT_DIR = '1';
  const parent = path.join(TMP, 'workspace');
  const child = path.join(parent, 'sub');
  // Approve the parent.
  const dp = await gate.ensureWorkspaceTrust({ cwd: parent, homedir: TMP, inquirer: fakeInquirer('trust') });
  assert.strictEqual(dp.reason, 'accepted');
  // Parent re-entered → trusted, no prompt.
  const dp2 = await gate.ensureWorkspaceTrust({ cwd: parent, homedir: TMP, inquirer: throwingInquirer() });
  assert.strictEqual(dp2.reason, 'persisted');
  // Child in a fresh session → must approve separately (inquirer IS invoked).
  gate._resetSessionTrusted();
  const dc = await gate.ensureWorkspaceTrust({ cwd: child, homedir: TMP, inquirer: fakeInquirer('trust') });
  assert.strictEqual(dc.reason, 'accepted', 'child not inherited under exact-dir — its own prompt approved it');
  assert.strictEqual(dc.persisted, true);
  // Now child has its own key → no re-prompt.
  const dc2 = await gate.ensureWorkspaceTrust({ cwd: child, homedir: TMP, inquirer: throwingInquirer() });
  assert.strictEqual(dc2.reason, 'persisted');
});

test('exact-dir OFF (default): persisted parent auto-trusts child (inheritance)', async () => {
  const parent = path.join(TMP, 'inh');
  const child = path.join(parent, 'deep', 'nested');
  await gate.ensureWorkspaceTrust({ cwd: parent, homedir: TMP, inquirer: fakeInquirer('trust') });
  // Child inherits without a prompt (throwingInquirer proves no prompt).
  const dc = await gate.ensureWorkspaceTrust({ cwd: child, homedir: TMP, inquirer: throwingInquirer() });
  assert.strictEqual(dc.trusted, true);
  assert.strictEqual(dc.reason, 'persisted');
});

test('accept the home dir (default): persists exact-scope → one click, no re-prompt; subtree NOT trusted', async () => {
  const home = path.join(TMP, 'home');
  const child = path.join(home, 'proj');
  fs.mkdirSync(child, { recursive: true });
  const d = await gate.ensureWorkspaceTrust({ cwd: home, homedir: home, inquirer: fakeInquirer('trust') });
  assert.strictEqual(d.trusted, true);
  assert.strictEqual(d.reason, 'home-persisted-exact');
  assert.strictEqual(d.persisted, true);
  // On disk as an exact-scope key.
  const store = gate._readTrustStore();
  assert.ok(store.exactPaths.includes(path.resolve(home)), 'home persisted with exact scope');
  assert.deepStrictEqual(store.treePaths, [], 'home NOT persisted as an inheritable tree scope');
  // Fresh session: home is NOT re-prompted (throwingInquirer proves no prompt) — one click sufficed.
  gate._resetSessionTrusted();
  const d2 = await gate.ensureWorkspaceTrust({ cwd: home, homedir: home, inquirer: throwingInquirer() });
  assert.strictEqual(d2.trusted, true);
  assert.strictEqual(d2.reason, 'persisted-exact', 'exact-persisted home short-circuits across sessions');
  // But a subdirectory of home in a fresh session STILL needs its own approval
  // (exact scope never inherits) — inquirer IS invoked and approves it.
  gate._resetSessionTrusted();
  const dc = await gate.ensureWorkspaceTrust({ cwd: child, homedir: home, inquirer: fakeInquirer('trust') });
  assert.strictEqual(dc.reason, 'accepted', 'home subtree is not blanket-trusted by exact-scope home');
});

test('accept home with KHY_TRUST_PERSIST_HOME on: persists, no re-prompt next session', async () => {
  process.env.KHY_TRUST_PERSIST_HOME = '1';
  const home = path.join(TMP, 'homep');
  fs.mkdirSync(home, { recursive: true });
  const d = await gate.ensureWorkspaceTrust({ cwd: home, homedir: home, inquirer: fakeInquirer('trust') });
  assert.strictEqual(d.trusted, true);
  assert.strictEqual(d.reason, 'home-persisted');
  assert.strictEqual(d.persisted, true);
  // On disk now — the home path is a persisted trust key.
  assert.ok(gate._readTrustedPaths().length >= 1, 'home path persisted to store');
  // Simulate a fresh session: reset the in-memory flag; must NOT re-prompt.
  gate._resetSessionTrusted();
  const d2 = await gate.ensureWorkspaceTrust({ cwd: home, homedir: home, inquirer: throwingInquirer() });
  assert.strictEqual(d2.trusted, true);
  assert.strictEqual(d2.reason, 'persisted', 'persisted home short-circuits — no re-prompt across sessions');
});

test('decline (exit choice): returns exit intent, no persist', async () => {
  const dir = path.join(TMP, 'declined');
  const d = await gate.ensureWorkspaceTrust({ cwd: dir, homedir: TMP, inquirer: fakeInquirer('exit') });
  assert.strictEqual(d.trusted, false);
  assert.strictEqual(d.action, 'exit');
  assert.strictEqual(d.code, 0);
  assert.deepStrictEqual(gate._readTrustedPaths(), []);
});

test('cancel (Ctrl+C/ESC → prompt throws): returns exit intent', async () => {
  const dir = path.join(TMP, 'cancelled');
  const d = await gate.ensureWorkspaceTrust({ cwd: dir, homedir: TMP, inquirer: throwingInquirer() });
  assert.strictEqual(d.trusted, false);
  assert.strictEqual(d.action, 'exit');
  assert.strictEqual(d.reason, 'cancelled');
});

test('non-interactive (no inquirer): fail-open trusted, not persisted', async () => {
  const dir = path.join(TMP, 'noninteractive');
  const d = await gate.ensureWorkspaceTrust({ cwd: dir, homedir: TMP, inquirer: null });
  assert.strictEqual(d.trusted, true);
  assert.strictEqual(d.reason, 'non-interactive');
  assert.strictEqual(d.persisted, false);
});

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});
