'use strict';

/**
 * permissionStore.newProfiles.test.js — P3 of the KHY⇄CC mode-alignment work.
 *
 * Gap: KHY had four profiles (strict/normal/acceptEdits/yolo), mapping to only
 * four of Claude Code's six permission modes. This suite locks the two added
 * profiles that complete CC parity:
 *
 *   - `auto` (CC v2.1.83+): routine calls auto-approved (incl. safe shell);
 *     destructive or high/critical-risk actions still ask. KHY has no classifier
 *     model like CC's `auto`, so it gates deterministically on the riskGate
 *     signals (isDestructive + risk) — an honest analog, not a fake classifier.
 *
 *   - `dontAsk` (CC CI mode): inverse of yolo — deny everything not EXPLICITLY
 *     allowed (persistent forever-rule / session approval). Fails loudly so a
 *     scripted/CI run never silently proceeds on a heuristic.
 *
 * The unbypassable red line in toolCalling (criticalGate / isUnbypassableGate)
 * stays in force regardless of profile — that floor is NOT exercised here (it
 * lives above permissionStore); these cases lock only the check() decision matrix.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// Hermetic HOME so we never touch the real ~/.khyquant/permissions.json.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-perm-newprofiles-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const permStore = require('../src/services/permissionStore');

// Tool option shapes as toolCalling resolves them from the registry descriptor.
const safeReadTool = { risk: 'safe', isReadOnly: true, isDestructive: false, category: 'data' };
const routineShellTool = { risk: 'low', isReadOnly: false, isDestructive: false, category: 'execution' };
const moderateEditTool = { risk: 'moderate', isReadOnly: false, isDestructive: false, category: 'filesystem' };
const destructiveTool = { risk: 'moderate', isReadOnly: false, isDestructive: true, category: 'filesystem' };
const highRiskTool = { risk: 'high', isReadOnly: false, isDestructive: false, category: 'execution' };
const criticalTool = { risk: 'critical', isReadOnly: false, isDestructive: false, category: 'execution' };

describe('permissionStore — auto profile (CC-aligned, P3)', () => {
  beforeEach(() => { permStore.reset(); });

  test("'auto' and 'dontAsk' are valid profiles", () => {
    assert.ok(permStore.VALID_PROFILES.includes('auto'));
    assert.ok(permStore.VALID_PROFILES.includes('dontAsk'));
  });

  test('auto auto-approves routine non-destructive calls (incl. safe shell)', () => {
    permStore.setProfile('auto');
    assert.equal(permStore.check('Read', {}, safeReadTool), 'allow');
    assert.equal(permStore.check('shellCommand', {}, routineShellTool), 'allow');
    assert.equal(permStore.check('Edit', {}, moderateEditTool), 'allow');
  });

  test('auto STILL asks for destructive actions', () => {
    permStore.setProfile('auto');
    assert.equal(permStore.check('Remove', {}, destructiveTool), 'ask');
  });

  test('auto STILL asks for high / critical risk actions', () => {
    permStore.setProfile('auto');
    assert.equal(permStore.check('bigOp', {}, highRiskTool), 'ask');
    assert.equal(permStore.check('nuke', {}, criticalTool), 'ask');
  });

  test('a session denial overrides auto auto-approve', () => {
    permStore.setProfile('auto');
    permStore.deny('shellCommand', 'session');
    assert.equal(permStore.check('shellCommand', {}, routineShellTool), 'deny');
  });
});

describe('permissionStore — dontAsk profile (CC-aligned, P3)', () => {
  beforeEach(() => { permStore.reset(); });

  test('dontAsk denies everything by default (no rule/approval)', () => {
    permStore.setProfile('dontAsk');
    assert.equal(permStore.check('Read', {}, safeReadTool), 'deny');
    assert.equal(permStore.check('shellCommand', {}, routineShellTool), 'deny');
    assert.equal(permStore.check('Edit', {}, moderateEditTool), 'deny');
  });

  test('dontAsk lets an EXPLICIT persistent allow-rule through', () => {
    permStore.setProfile('dontAsk');
    permStore.approve('Read', 'forever');
    assert.equal(permStore.check('Read', {}, safeReadTool), 'allow');
    // Everything else is still denied.
    assert.equal(permStore.check('shellCommand', {}, routineShellTool), 'deny');
  });

  test('dontAsk lets an EXPLICIT session approval through', () => {
    permStore.setProfile('dontAsk');
    permStore.approve('shellCommand', 'session');
    assert.equal(permStore.check('shellCommand', {}, routineShellTool), 'allow');
  });

  test('dontAsk honors a persistent deny-rule (explicit deny stays deny)', () => {
    permStore.setProfile('dontAsk');
    permStore.deny('Read', 'forever');
    assert.equal(permStore.check('Read', {}, safeReadTool), 'deny');
  });
});

describe('permissionStore — existing profiles unchanged (P3 regression)', () => {
  beforeEach(() => { permStore.reset(); });

  test('normal: safe/readonly allow, moderate edit asks', () => {
    permStore.setProfile('normal');
    assert.equal(permStore.check('Read', {}, safeReadTool), 'allow');
    assert.equal(permStore.check('Edit', {}, moderateEditTool), 'ask');
  });

  test('acceptEdits: non-destructive fs edit allows, shell asks', () => {
    permStore.setProfile('acceptEdits');
    assert.equal(permStore.check('Edit', {}, moderateEditTool), 'allow');
    assert.equal(permStore.check('shellCommand', {}, routineShellTool), 'ask');
  });

  test('strict: asks even for safe tools', () => {
    permStore.setProfile('strict');
    assert.equal(permStore.check('Read', {}, safeReadTool), 'ask');
  });

  test('yolo: allows everything including critical', () => {
    permStore.setProfile('yolo');
    assert.equal(permStore.check('nuke', {}, criticalTool), 'allow');
  });
});
