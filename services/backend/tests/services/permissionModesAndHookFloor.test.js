'use strict';

/**
 * permissionModesAndHookFloor.test.js — CC alignment coverage.
 *
 * Two gaps closed against Claude Code's permission model:
 *
 *  1. PreToolUse hook hard bottom on the single executeTool funnel — so every
 *     caller (localToolLoop / direct / sub-agent), not just the main toolUseLoop,
 *     runs PreToolUse hooks. The HOOKS_EVALUATED Symbol stamp keeps it idempotent
 *     for loop-driven calls that already evaluated hooks once.
 *  2. The six permission modes (default / plan / acceptEdits / auto / dontAsk /
 *     bypass, CC-aligned) replacing the old boolean dangerousMode, with the
 *     legacy dangerousMode API kept as shims mapping onto mode='bypass'.
 *
 * Iron rule under test: the critical red line (rm -rf /, etc. → human-gate +
 * critical) is NEVER blanket-allowed, even under bypass — it must reach explicit
 * human confirmation. The syscall gateway's autoApproveL1 affects only L1 (yellow);
 * L2 (red) stays fail-closed.
 */

// Isolate from any persisted permission rules so the mode logic is tested cleanly.
process.env.KHY_PERMISSION_STORE = 'false';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const tc = require('../../src/services/toolCalling');
const { HOOKS_EVALUATED, EXEC_APPROVED } = require('../../src/services/execApproval');
const hookSystem = require('../../src/services/hooks/hookSystem');
const { route, DECISIONS } = require('../../src/services/syscallGateway/approvalRouter');
const { LEVELS } = require('../../src/services/syscallGateway/resourceClassifier');

const allowStub = async () => ({ behavior: 'allow' });
const denyStub = async () => ({ behavior: 'deny' });

after(() => { tc.setPermissionMode('default'); });

describe('execApproval — HOOKS_EVALUATED stamp', () => {
  test('HOOKS_EVALUATED is a distinct Symbol from EXEC_APPROVED', () => {
    assert.equal(typeof HOOKS_EVALUATED, 'symbol');
    assert.equal(typeof EXEC_APPROVED, 'symbol');
    assert.notEqual(HOOKS_EVALUATED, EXEC_APPROVED);
  });
});

describe('permission modes — requestPermission (CC alignment)', () => {
  beforeEach(() => tc.setPermissionMode('default'));
  after(() => tc.setPermissionMode('default'));

  test('plan mode denies a side-effecting write — even with an allow channel', async () => {
    tc.setPermissionMode('plan');
    const d = await tc.requestPermission('writeFile', { file_path: 'x', content: 'y' }, allowStub);
    assert.equal(d, 'deny', 'plan is a read-only rehearsal; writes are authoritatively denied');
  });

  test('plan mode allows a read-only tool — even with a deny channel', async () => {
    tc.setPermissionMode('plan');
    const d = await tc.requestPermission('readFile', { file_path: 'x' }, denyStub);
    assert.equal(d, 'allow', 'read-only tools survive plan mode');
  });

  test('acceptEdits auto-approves an edit tool without consulting the channel', async () => {
    tc.setPermissionMode('acceptEdits');
    // denyStub would deny if the channel were consulted; acceptEdits short-circuits.
    const d = await tc.requestPermission('writeFile', { file_path: 'x', content: 'y' }, denyStub);
    assert.equal(d, 'allow');
  });

  test('bypass auto-approves an ordinary high-risk write', async () => {
    tc.setPermissionMode('bypass');
    const d = await tc.requestPermission('writeFile', { file_path: 'x', content: 'y' }, denyStub);
    assert.equal(d, 'allow');
  });

  test('bypass does NOT cross the critical red line — rm -rf / still defers to consent', async () => {
    tc.setPermissionMode('bypass');
    // shell_command + 'rm -rf /' → human-gate + critical → criticalGate.
    // bypass auto-allow is gated on !criticalGate, so it falls through to the
    // channel; a deny channel ⇒ deny (informed consent is mandatory, unbypassable).
    const d = await tc.requestPermission('shell_command', { command: 'rm -rf /' }, denyStub);
    assert.equal(d, 'deny', 'critical red line is unbypassable even under bypass/yolo');
  });

  test('bypass does NOT auto-approve a DESTRUCTIVE-but-non-critical op — rm notes.txt (closed gap)', async () => {
    tc.setPermissionMode('bypass');
    // `rm notes.txt` → destructive + high (NOT critical). Before the fix, criticalGate
    // only fired on riskLevel==='critical', so bypass blanket-allowed irreversible data
    // loss. Now any destructive human-gate is unbypassable: it must reach the channel,
    // so a deny channel ⇒ deny. This is the backstop that holds even with the syscall
    // gateway disabled.
    const d = await tc.requestPermission('shell_command', { command: 'rm notes.txt' }, denyStub);
    assert.equal(d, 'deny', 'destructive ops are unbypassable even when only high-risk');
  });

  test('default mode never auto-approves a write — defers to the channel', async () => {
    tc.setPermissionMode('default');
    const d = await tc.requestPermission('writeFile', { file_path: 'x', content: 'y' }, denyStub);
    assert.equal(d, 'deny');
  });

  test('legacy dangerousMode API maps onto mode=bypass', () => {
    tc.setPermissionMode('default');
    assert.equal(tc.isDangerousMode(), false);
    tc.enableDangerousMode();
    assert.equal(tc.getPermissionMode(), 'bypass');
    assert.equal(tc.isDangerousMode(), true);
    tc.disableDangerousMode();
    assert.equal(tc.getPermissionMode(), 'default');
    assert.equal(tc.isDangerousMode(), false);
  });

  test('setPermissionMode normalizes aliases and rejects garbage', () => {
    assert.equal(tc.setPermissionMode('bypassPermissions'), 'bypass');
    assert.equal(tc.setPermissionMode('yolo'), 'bypass');
    assert.equal(tc.setPermissionMode('acceptedits'), 'acceptEdits');
    assert.equal(tc.setPermissionMode('nonsense'), 'default');
    assert.equal(tc.setPermissionMode(''), 'default');
  });
});

describe('syscall gateway — autoApproveL1 only relaxes L1, never L2', () => {
  const intent = { tool: 'writeFile', action: 'WRITE', scope: 'project', resource: 'x' };

  test('L1 + autoApproveL1 → auto-allow (no prompt)', async () => {
    const r = await route({ intent, level: LEVELS.L1, cache: null, prompter: null, autoApproveL1: true });
    assert.equal(r.decision, DECISIONS.AUTO_ALLOW);
  });

  test('L1 without autoApproveL1 and no prompter → deny (fail-closed)', async () => {
    const r = await route({ intent, level: LEVELS.L1, cache: null, prompter: null, autoApproveL1: false });
    assert.equal(r.decision, DECISIONS.DENY);
  });

  test('L2 + autoApproveL1 + no prompter → deny (red line ignores autoApproveL1)', async () => {
    const r = await route({
      intent: { ...intent, action: 'DELETE' },
      level: LEVELS.L2, cache: null, prompter: null, autoApproveL1: true,
    });
    assert.equal(r.decision, DECISIONS.DENY, 'L2 never reads autoApproveL1; stays fail-closed');
  });
});

describe('PreToolUse hard bottom on the executeTool funnel', () => {
  const TMP = path.join(os.tmpdir(), `khy-hookfloor-${process.pid}`);
  let _floorCalls = 0;

  before(() => {
    fs.mkdirSync(TMP, { recursive: true });
    hookSystem.init(TMP);
    // priority 1 → runs ahead of the built-in guards so the block is deterministic.
    hookSystem.registerFunction(
      'PreToolUse',
      () => { _floorCalls++; return { action: 'block', reason: 'TEST FLOOR' }; },
      { source: 'test-floor', priority: 1 },
    );
  });
  after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

  test('a direct executeTool call (no loop) runs PreToolUse and is blocked', async () => {
    const before = _floorCalls;
    const res = await tc.executeTool('readFile', { file_path: __filename }, { sessionId: 'hook-floor' });
    assert.equal(res && res.denied, true);
    assert.equal(res && res._hookBlocked, true);
    assert.match(String(res && res.error), /TEST FLOOR/);
    assert.equal(_floorCalls, before + 1, 'hook must run exactly once for an unstamped call');
  });

  test('a HOOKS_EVALUATED-stamped call skips the hook (idempotent for loop-driven calls)', async () => {
    const before = _floorCalls;
    const params = { file_path: __filename };
    params[HOOKS_EVALUATED] = true;
    const res = await tc.executeTool('readFile', params, { sessionId: 'hook-floor' });
    assert.equal(_floorCalls, before, 'stamped call must NOT re-run PreToolUse hooks');
    assert.notEqual(res && res._hookBlocked, true, 'stamped call is not hook-blocked');
  });
});
