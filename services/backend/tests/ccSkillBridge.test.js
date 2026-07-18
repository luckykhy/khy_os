'use strict';

/**
 * ccSkillBridge — pins the pure leaf that maps Claude Code's on-disk skill
 * roots so khy can reuse CC's marketplace. Zero-IO: paths are injected, so the
 * suite is deterministic and platform-independent (POSIX path assertions).
 * Covers: gate default-ON + falsy set, priority order, project/home optionality,
 * and fail-soft on junk input (never throws).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const bridge = require('../src/skills/ccSkillBridge');

test('isCcSkillBridgeEnabled: default ON, {0,false,off,no} OFF', () => {
  assert.strictEqual(bridge.isCcSkillBridgeEnabled({}), true);
  assert.strictEqual(bridge.isCcSkillBridgeEnabled({ KHY_CC_SKILL_BRIDGE: undefined }), true);
  assert.strictEqual(bridge.isCcSkillBridgeEnabled({ KHY_CC_SKILL_BRIDGE: 'true' }), true);
  assert.strictEqual(bridge.isCcSkillBridgeEnabled({ KHY_CC_SKILL_BRIDGE: '1' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(bridge.isCcSkillBridgeEnabled({ KHY_CC_SKILL_BRIDGE: v }), false, `expected off for ${v}`);
  }
});

test('ccSkillSearchPaths: home only → user + plugin cache + local-plugins, no project', () => {
  const home = '/home/u';
  const paths = bridge.ccSkillSearchPaths({ homedir: home });
  const dirs = paths.map((p) => p.dir);
  assert.deepStrictEqual(dirs, [
    path.join(home, '.claude', 'skills'),
    path.join(home, '.claude', 'plugins', 'cache'),
    path.join(home, '.claude', 'local-plugins'),
  ]);
  // sources are all cc-* namespaced (never collide with khy sources).
  assert.ok(paths.every((p) => p.source.startsWith('cc-')));
});

test('ccSkillSearchPaths: project wins first (priority order)', () => {
  const home = '/home/u';
  const proj = '/work/repo';
  const paths = bridge.ccSkillSearchPaths({ homedir: home, projectDir: proj });
  assert.strictEqual(paths[0].dir, path.join(proj, '.claude', 'skills'));
  assert.strictEqual(paths[0].source, 'cc-project');
  // then the three home roots follow.
  assert.strictEqual(paths.length, 4);
});

test('ccSkillSearchPaths: no home → only project (or empty)', () => {
  assert.deepStrictEqual(bridge.ccSkillSearchPaths({ projectDir: '/p' }).map((p) => p.dir), [
    path.join('/p', '.claude', 'skills'),
  ]);
  assert.deepStrictEqual(bridge.ccSkillSearchPaths({}), []);
  assert.deepStrictEqual(bridge.ccSkillSearchPaths(), []);
});

test('ccSkillSearchPaths: never throws on junk input', () => {
  assert.doesNotThrow(() => bridge.ccSkillSearchPaths({ homedir: {}, projectDir: [] }));
  const r = bridge.ccSkillSearchPaths({ homedir: 123, projectDir: null });
  assert.ok(Array.isArray(r));
});
