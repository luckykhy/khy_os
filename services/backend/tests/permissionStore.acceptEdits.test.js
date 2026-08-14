'use strict';

/**
 * permissionStore.acceptEdits.test.js — P1 of the KHY⇄CC mode-alignment work.
 *
 * Gap: KHY had no Claude-Code "auto-accept edits" sweet spot. Users were stuck
 * choosing between "ask for everything" (normal/strict) and "allow everything"
 * (yolo). The `acceptEdits` profile auto-approves non-destructive filesystem
 * edits (Edit/Write/MultiEdit/apply_patch/NotebookEdit — category 'filesystem')
 * while shell ('execution') and destructive ops still prompt, and the critical
 * red line in toolCalling stays unbypassable.
 *
 * These cases lock the profile's check() decision matrix.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// Hermetic HOME so we never touch the real ~/.khyquant/permissions.json.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-perm-acceptedits-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const permStore = require('../src/services/permissionStore');

// Tool option shapes as toolCalling resolves them from the registry descriptor.
const editTool = { risk: 'medium', isReadOnly: false, isDestructive: false, category: 'filesystem' };
const destructiveFsTool = { risk: 'medium', isReadOnly: false, isDestructive: true, category: 'filesystem' };
const shellTool = { risk: 'medium', isReadOnly: false, isDestructive: false, category: 'execution' };
const readTool = { risk: 'low', isReadOnly: true, isDestructive: false, category: 'filesystem' };
const safeTool = { risk: 'safe', isReadOnly: true, isDestructive: false, category: 'data' };

describe('permissionStore — acceptEdits profile (P1)', () => {
  beforeEach(() => { permStore.reset(); });

  test("'acceptEdits' is a valid profile", () => {
    permStore.setProfile('acceptEdits');
    assert.equal(permStore.getProfile(), 'acceptEdits');
  });

  test('acceptEdits auto-approves a non-destructive filesystem edit', () => {
    permStore.setProfile('acceptEdits');
    assert.equal(permStore.check('Edit', {}, editTool), 'allow');
    assert.equal(permStore.check('Write', {}, editTool), 'allow');
    assert.equal(permStore.check('MultiEdit', {}, editTool), 'allow');
  });

  test('acceptEdits still ASKS for shell / execution tools', () => {
    permStore.setProfile('acceptEdits');
    assert.equal(permStore.check('shellCommand', {}, shellTool), 'ask');
  });

  test('acceptEdits still ASKS for a destructive filesystem op', () => {
    permStore.setProfile('acceptEdits');
    assert.equal(permStore.check('Remove', {}, destructiveFsTool), 'ask');
  });

  test('acceptEdits still auto-approves read-only and safe tools (normal parity)', () => {
    permStore.setProfile('acceptEdits');
    assert.equal(permStore.check('Read', {}, readTool), 'allow');
    assert.equal(permStore.check('quote', {}, safeTool), 'allow');
  });

  test('normal profile does NOT auto-approve an edit (regression guard)', () => {
    permStore.setProfile('normal');
    assert.equal(permStore.check('Edit', {}, editTool), 'ask');
  });

  test('strict profile asks for an edit even under acceptEdits-eligible category', () => {
    permStore.setProfile('strict');
    assert.equal(permStore.check('Edit', {}, editTool), 'ask');
  });

  test('yolo still allows everything including shell', () => {
    permStore.setProfile('yolo');
    assert.equal(permStore.check('shellCommand', {}, shellTool), 'allow');
    assert.equal(permStore.check('Edit', {}, editTool), 'allow');
  });

  test('a session denial overrides acceptEdits auto-approve', () => {
    permStore.setProfile('acceptEdits');
    permStore.deny('Edit', 'session');
    assert.equal(permStore.check('Edit', {}, editTool), 'deny');
  });
});
