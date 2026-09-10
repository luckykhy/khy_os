'use strict';
/**
 * trustGate â€?pins the IO shell for the workspace-trust dialog. Uses a throwaway
 * KHY_DATA_HOME and a fake inquirer so no real prompt is shown. Covers: gate off
 * short-circuit, already-trusted skip, acceptâ†’persist (non-home), acceptâ†’session
 * (home, no persist), declineâ†’exit, cancelâ†’exit, non-interactive fail-open, and
 * fail-open on internal error.
 */
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
test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('Trust Gate', () => {
  test('gate off: short-circuits as trusted, no prompt', async () => {
      process.env.KHY_WORKSPACE_TRUST = 'off';
      const d = await gate.ensureWorkspaceTrust({ cwd: path.join(TMP, 'anything'), inquirer: null });
      expect(d.trusted).toBe(true);
      expect(d.reason).toBe('gate-off');
  });

  test('already-persisted folder: trusted without prompt', async () => {
      const dir = path.join(TMP, 'proj');
      expect(gate._persistTrust(dir)).toBe(true);
      // inquirer that would throw if called â€?proves no prompt happens.
      const d = await gate.ensureWorkspaceTrust({ cwd: dir, homedir: TMP, inquirer: throwingInquirer() });
      expect(d.trusted).toBe(true);
      expect(d.reason).toBe('persisted');
  });

  test('accept a new non-home folder: persists trust', async () => {
      const dir = path.join(TMP, 'fresh');
      const d = await gate.ensureWorkspaceTrust({
        cwd: dir, homedir: TMP, inquirer: fakeInquirer('trust'),
      });
      expect(d.trusted).toBe(true);
      expect(d.reason).toBe('accepted');
      expect(d.persisted).toBe(true);
      // Persisted â†?a second call is trusted without prompting.
      const d2 = await gate.ensureWorkspaceTrust({ cwd: dir, homedir: TMP, inquirer: throwingInquirer() });
      expect(d2.reason).toBe('persisted');
  });

  test('exact-dir on: persisted parent does NOT auto-trust child; child needs its own approval', async () => {
      process.env.KHY_TRUST_EXACT_DIR = '1';
      const parent = path.join(TMP, 'workspace');
      const child = path.join(parent, 'sub');
      // Approve the parent.
      const dp = await gate.ensureWorkspaceTrust({ cwd: parent, homedir: TMP, inquirer: fakeInquirer('trust') });
      expect(dp.reason).toBe('accepted');
      // Parent re-entered â†?trusted, no prompt.
      const dp2 = await gate.ensureWorkspaceTrust({ cwd: parent, homedir: TMP, inquirer: throwingInquirer() });
      expect(dp2.reason).toBe('persisted');
      // Child in a fresh session â†?must approve separately (inquirer IS invoked).
      gate._resetSessionTrusted();
      const dc = await gate.ensureWorkspaceTrust({ cwd: child, homedir: TMP, inquirer: fakeInquirer('trust') });
      expect(dc.reason).toBe('accepted', 'child not inherited under exact-dir â€?its own prompt approved it');
      expect(dc.persisted).toBe(true);
      // Now child has its own key â†?no re-prompt.
      const dc2 = await gate.ensureWorkspaceTrust({ cwd: child, homedir: TMP, inquirer: throwingInquirer() });
      expect(dc2.reason).toBe('persisted');
  });

  test('exact-dir OFF (default): persisted parent auto-trusts child (inheritance)', async () => {
      const parent = path.join(TMP, 'inh');
      const child = path.join(parent, 'deep', 'nested');
      await gate.ensureWorkspaceTrust({ cwd: parent, homedir: TMP, inquirer: fakeInquirer('trust') });
      // Child inherits without a prompt (throwingInquirer proves no prompt).
      const dc = await gate.ensureWorkspaceTrust({ cwd: child, homedir: TMP, inquirer: throwingInquirer() });
      expect(dc.trusted).toBe(true);
      expect(dc.reason).toBe('persisted');
  });

  test('accept the home dir (default): persists exact-scope â†?one click, no re-prompt; subtree NOT trusted', async () => {
      const home = path.join(TMP, 'home');
      const child = path.join(home, 'proj');
      fs.mkdirSync(child, { recursive: true });
      const d = await gate.ensureWorkspaceTrust({ cwd: home, homedir: home, inquirer: fakeInquirer('trust') });
      expect(d.trusted).toBe(true);
      expect(d.reason).toBe('home-persisted-exact');
      expect(d.persisted).toBe(true);
      // On disk as an exact-scope key.
      const store = gate._readTrustStore();
      expect(store.exactPaths).toContain(path.resolve(home), 'home persisted with exact scope');
      expect(store.treePaths).toEqual([], 'home NOT persisted as an inheritable tree scope');
      // Fresh session: home is NOT re-prompted (throwingInquirer proves no prompt) â€?one click sufficed.
      gate._resetSessionTrusted();
      const d2 = await gate.ensureWorkspaceTrust({ cwd: home, homedir: home, inquirer: throwingInquirer() });
      expect(d2.trusted).toBe(true);
      expect(d2.reason).toBe('persisted-exact', 'exact-persisted home short-circuits across sessions');
      // But a subdirectory of home in a fresh session STILL needs its own approval
      // (exact scope never inherits) â€?inquirer IS invoked and approves it.
      gate._resetSessionTrusted();
      const dc = await gate.ensureWorkspaceTrust({ cwd: child, homedir: home, inquirer: fakeInquirer('trust') });
      expect(dc.reason).toBe('accepted', 'home subtree is not blanket-trusted by exact-scope home');
  });

  test('accept home with KHY_TRUST_PERSIST_HOME on: persists, no re-prompt next session', async () => {
      process.env.KHY_TRUST_PERSIST_HOME = '1';
      const home = path.join(TMP, 'homep');
      fs.mkdirSync(home, { recursive: true });
      const d = await gate.ensureWorkspaceTrust({ cwd: home, homedir: home, inquirer: fakeInquirer('trust') });
      expect(d.trusted).toBe(true);
      expect(d.reason).toBe('home-persisted');
      expect(d.persisted).toBe(true);
      // On disk now â€?the home path is a persisted trust key.
      expect(gate._readTrustedPaths().length >= 1).toBeTruthy();
      // Simulate a fresh session: reset the in-memory flag; must NOT re-prompt.
      gate._resetSessionTrusted();
      const d2 = await gate.ensureWorkspaceTrust({ cwd: home, homedir: home, inquirer: throwingInquirer() });
      expect(d2.trusted).toBe(true);
      expect(d2.reason).toBe('persisted', 'persisted home short-circuits â€?no re-prompt across sessions');
  });

  test('decline (exit choice): returns exit intent, no persist', async () => {
      const dir = path.join(TMP, 'declined');
      const d = await gate.ensureWorkspaceTrust({ cwd: dir, homedir: TMP, inquirer: fakeInquirer('exit') });
      expect(d.trusted).toBe(false);
      expect(d.action).toBe('exit');
      expect(d.code).toBe(0);
      expect(gate._readTrustedPaths()).toEqual([]);
  });

  test('cancel (Ctrl+C/ESC â†?prompt throws): returns exit intent', async () => {
      const dir = path.join(TMP, 'cancelled');
      const d = await gate.ensureWorkspaceTrust({ cwd: dir, homedir: TMP, inquirer: throwingInquirer() });
      expect(d.trusted).toBe(false);
      expect(d.action).toBe('exit');
      expect(d.reason).toBe('cancelled');
  });

  test('non-interactive (no inquirer): fail-open trusted, not persisted', async () => {
      const dir = path.join(TMP, 'noninteractive');
      const d = await gate.ensureWorkspaceTrust({ cwd: dir, homedir: TMP, inquirer: null });
      expect(d.trusted).toBe(true);
      expect(d.reason).toBe('non-interactive');
      expect(d.persisted).toBe(false);
  });

});

