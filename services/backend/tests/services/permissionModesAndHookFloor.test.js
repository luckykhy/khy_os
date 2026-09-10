'use strict';
/**
 * permissionModesAndHookFloor.test.js �?CC alignment coverage.
 *
 * Two gaps closed against Claude Code's permission model:
 *
 *  1. PreToolUse hook hard bottom on the single executeTool funnel �?so every
 *     caller (localToolLoop / direct / sub-agent), not just the main toolUseLoop,
 *     runs PreToolUse hooks. The HOOKS_EVALUATED Symbol stamp keeps it idempotent
 *     for loop-driven calls that already evaluated hooks once.
 *  2. The six permission modes (default / plan / acceptEdits / auto / dontAsk /
 *     bypass, CC-aligned) replacing the old boolean dangerousMode, with the
 *     legacy dangerousMode API kept as shims mapping onto mode='bypass'.
 *
 * Iron rule under test: the critical red line (rm -rf /, etc. �?human-gate +
 * critical) is NEVER blanket-allowed, even under bypass �?it must reach explicit
 * human confirmation. The syscall gateway's autoApproveL1 affects only L1 (yellow);
 * L2 (red) stays fail-closed.
 */
// Isolate from any persisted permission rules so the mode logic is tested cleanly.
process.env.KHY_PERMISSION_STORE = 'false';
const os = require('os');
const fs = require('fs');
const path = require('path');
const tc = require('../../src/services/toolCalling');
const { HOOKS_EVALUATED, EXEC_APPROVED } = require('../../src/services/execApproval');
const hookSystem = require('../../src/services/domain/extensions/hooks/hookSystem.js');
const { route, DECISIONS } = require('../../src/services/syscallGateway/approvalRouter');
const { LEVELS } = require('../../src/services/syscallGateway/resourceClassifier');
const allowStub = async () => ({ behavior: 'allow' });
const denyStub = async () => ({ behavior: 'deny' });
after(() => { tc.setPermissionMode('default'); });
describe('execApproval �?HOOKS_EVALUATED stamp', () => {
});
describe('permission modes �?requestPermission (CC alignment)', () => {
  beforeEach(() => tc.setPermissionMode('default'));
  after(() => tc.setPermissionMode('default'));
});
describe('syscall gateway �?autoApproveL1 only relaxes L1, never L2', () => {
  const intent = { tool: 'writeFile', action: 'WRITE', scope: 'project', resource: 'x' };
});
describe('PreToolUse hard bottom on the executeTool funnel', () => {
  const TMP = path.join(os.tmpdir(), `khy-hookfloor-${process.pid}`);
  let _floorCalls = 0;
  before(() => {
    fs.mkdirSync(TMP, { recursive: true });
    hookSystem.init(TMP);
    // priority 1 �?runs ahead of the built-in guards so the block is deterministic.
    hookSystem.registerFunction(
      'PreToolUse',
      () => { _floorCalls++; return { action: 'block', reason: 'TEST FLOOR' }; },
      { source: 'test-floor', priority: 1 },
    );
  });
  after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
});

describe('Permission Modes And Hook Floor', () => {
  test('HOOKS_EVALUATED is a distinct Symbol from EXEC_APPROVED', async () => {
        expect(typeof HOOKS_EVALUATED).toBe('symbol');
        expect(typeof EXEC_APPROVED).toBe('symbol');
        assert.notEqual(HOOKS_EVALUATED, EXEC_APPROVED);
  });

  test('plan mode denies a side-effecting write �?even with an allow channel', async () => {
        tc.setPermissionMode('plan');
        const d = await tc.requestPermission('writeFile', { file_path: 'x', content: 'y' }, allowStub);
        expect(d).toBe('deny');
  });

  test('plan mode allows a read-only tool �?even with a deny channel', async () => {
        tc.setPermissionMode('plan');
        const d = await tc.requestPermission('readFile', { file_path: 'x' }, denyStub);
        expect(d).toBe('allow');
  });

  test('acceptEdits auto-approves an edit tool without consulting the channel', async () => {
        tc.setPermissionMode('acceptEdits');
        // denyStub would deny if the channel were consulted; acceptEdits short-circuits.
        const d = await tc.requestPermission('writeFile', { file_path: 'x', content: 'y' }, denyStub);
        expect(d).toBe('allow');
  });

  test('bypass auto-approves an ordinary high-risk write', async () => {
        tc.setPermissionMode('bypass');
        const d = await tc.requestPermission('writeFile', { file_path: 'x', content: 'y' }, denyStub);
        expect(d).toBe('allow');
  });

  test('bypass does NOT cross the critical red line �?rm -rf / still defers to consent', async () => {
        tc.setPermissionMode('bypass');
        // shell_command + 'rm -rf /' �?human-gate + critical �?criticalGate.
        // bypass auto-allow is gated on !criticalGate, so it falls through to the
        // channel; a deny channel �?deny (informed consent is mandatory, unbypassable).
        const d = await tc.requestPermission('shell_command', { command: 'rm -rf /' }, denyStub);
        expect(d).toBe('deny');
  });

  test('bypass does NOT auto-approve a DESTRUCTIVE-but-non-critical op �?rm notes.txt (closed gap)', async () => {
        tc.setPermissionMode('bypass');
        // `rm notes.txt` �?destructive + high (NOT critical). Before the fix, criticalGate
        // only fired on riskLevel==='critical', so bypass blanket-allowed irreversible data
        // loss. Now any destructive human-gate is unbypassable: it must reach the channel,
        // so a deny channel �?deny. This is the backstop that holds even with the syscall
        // gateway disabled.
        const d = await tc.requestPermission('shell_command', { command: 'rm notes.txt' }, denyStub);
        expect(d).toBe('deny');
  });

  test('default mode never auto-approves a write �?defers to the channel', async () => {
        tc.setPermissionMode('default');
        const d = await tc.requestPermission('writeFile', { file_path: 'x', content: 'y' }, denyStub);
        expect(d).toBe('deny');
  });

  test('legacy dangerousMode API maps onto mode=bypass', async () => {
        tc.setPermissionMode('default');
        expect(tc.isDangerousMode()).toBe(false);
        tc.enableDangerousMode();
        expect(tc.getPermissionMode()).toBe('bypass');
        expect(tc.isDangerousMode()).toBe(true);
        tc.disableDangerousMode();
        expect(tc.getPermissionMode()).toBe('default');
        expect(tc.isDangerousMode()).toBe(false);
  });

  test('setPermissionMode normalizes aliases and rejects garbage', async () => {
        expect(tc.setPermissionMode('bypassPermissions')).toBe('bypass');
        expect(tc.setPermissionMode('yolo')).toBe('bypass');
        expect(tc.setPermissionMode('acceptedits')).toBe('acceptEdits');
        expect(tc.setPermissionMode('nonsense')).toBe('default');
        expect(tc.setPermissionMode('')).toBe('default');
  });

  test('L1 + autoApproveL1 �?auto-allow (no prompt)', async () => {
        const r = await route({ intent, level: LEVELS.L1, cache: null, prompter: null, autoApproveL1: true });
        expect(r.decision).toBe(DECISIONS.AUTO_ALLOW);
  });

  test('L1 without autoApproveL1 and no prompter �?deny (fail-closed)', async () => {
        const r = await route({ intent, level: LEVELS.L1, cache: null, prompter: null, autoApproveL1: false });
        expect(r.decision).toBe(DECISIONS.DENY);
  });

  test('L2 + autoApproveL1 + no prompter �?deny (red line ignores autoApproveL1)', async () => {
        const r = await route({
          intent: { ...intent, action: 'DELETE' },
          level: LEVELS.L2, cache: null, prompter: null, autoApproveL1: true,
        });
        expect(r.decision).toBe(DECISIONS.DENY);
  });

  test('a direct executeTool call (no loop) runs PreToolUse and is blocked', async () => {
        const before = _floorCalls;
        const res = await tc.executeTool('readFile', { file_path: __filename }, { sessionId: 'hook-floor' });
        expect(res && res.denied).toBe(true);
        expect(res && res._hookBlocked).toBe(true);
        expect(String(res && res.error)).toMatch(/TEST FLOOR/);
        expect(_floorCalls).toBe(before + 1);
  });

  test('a HOOKS_EVALUATED-stamped call skips the hook (idempotent for loop-driven calls)', async () => {
        const before = _floorCalls;
        const params = { file_path: __filename };
        params[HOOKS_EVALUATED] = true;
        const res = await tc.executeTool('readFile', params, { sessionId: 'hook-floor' });
        expect(_floorCalls).toBe(before);
        assert.notEqual(res && res._hookBlocked, true, 'stamped call is not hook-blocked');
  });

});

