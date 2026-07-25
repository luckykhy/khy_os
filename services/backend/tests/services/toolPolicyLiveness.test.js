'use strict';

/**
 * toolPolicyLiveness.test.js — Phase D liveness glue (§4.D, Π_C).
 *
 * The capability policy / active-skill whitelist are the only places that prune
 * the action set A(s) to a subset. Without a liveness floor, a maximally
 * restrictive allowlist could prune EVERY action, wedging the agent with A(s)=∅.
 * The constraint lattice guarantees the escape floor (ask_user/abort) survives
 * any allowlist, so A(s) ≠ ∅ always. These tests drive the real
 * _checkToolPolicy / _checkActiveSkillPolicy predicates through a temp policy.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const { _checkToolPolicy, _checkActiveSkillPolicy } = require('../../src/services/toolCalling');

const POLICY_PATH = path.join(os.tmpdir(), `khy-policy-liveness-${process.pid}.json`);

function writePolicy(obj) {
  fs.writeFileSync(POLICY_PATH, JSON.stringify(obj), 'utf-8');
  process.env.KHY_CAPABILITY_POLICY_FILE = POLICY_PATH;
}

afterEach(() => {
  delete process.env.KHY_CAPABILITY_POLICY_FILE;
  delete process.env.KHY_LIVENESS_FALLBACK;
  try { fs.unlinkSync(POLICY_PATH); } catch { /* ignore */ }
});

describe('capability-policy liveness — the escape floor survives any allowlist', () => {
  test('an allowlist that excludes everything still blocks a normal tool', () => {
    writePolicy({ allowedTools: ['readFile'] });
    expect(_checkToolPolicy('editFile', 'editFile')).toMatch(/allowlist/);
  });

  test('but the escape floor (ask_user/abort) is NEVER pruned by the allowlist', () => {
    writePolicy({ allowedTools: ['readFile'] }); // floor not listed
    expect(_checkToolPolicy('ask_user', 'ask_user')).toBeNull();
    expect(_checkToolPolicy('abort', 'abort')).toBeNull();
    expect(_checkToolPolicy('askUserQuestion', 'askUserQuestion')).toBeNull();
  });

  test('a blocklist that names the escape action is also overridden (liveness wins)', () => {
    writePolicy({ blockedTools: ['ask_user'] });
    // blockedTools is checked before the allowlist; the floor must still survive.
    expect(_checkToolPolicy('ask_user', 'ask_user')).toBeNull();
  });

  test('env-extended floor also survives', () => {
    process.env.KHY_LIVENESS_FALLBACK = 'panic_button';
    writePolicy({ allowedTools: ['readFile'] });
    expect(_checkToolPolicy('panic_button', 'panic_button')).toBeNull();
    expect(_checkToolPolicy('editFile', 'editFile')).toMatch(/allowlist/);
  });
});

describe('active-skill whitelist liveness — escape floor survives a skill whitelist', () => {
  const activeSkillContext = require('../../src/services/activeSkillContext');

  afterEach(() => {
    try { activeSkillContext.clearActiveSkill && activeSkillContext.clearActiveSkill(); } catch { /* ignore */ }
  });

  test('a skill whitelist blocks a normal tool but never the escape floor', () => {
    activeSkillContext.setActiveSkill({ name: 'narrow', allowedTools: ['readFile'] });
    expect(_checkActiveSkillPolicy('editFile', 'editFile')).toMatch(/whitelist/);
    expect(_checkActiveSkillPolicy('ask_user', 'ask_user')).toBeNull();
    expect(_checkActiveSkillPolicy('abort', 'abort')).toBeNull();
  });
});
