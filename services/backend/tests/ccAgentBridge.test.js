'use strict';

/**
 * ccAgentBridge — pins the pure leaf that maps Claude Code's on-disk agent
 * roots so khy reuses CC's agent marketplace. Zero-IO: roots are injected, so
 * the suite is deterministic (POSIX path assertions). Covers: gate default-ON +
 * falsy set, root enumeration (flat user + recursive plugin roots), project dir
 * intentionally omitted, and fail-soft on junk (never throws).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const bridge = require('../src/agents/ccAgentBridge');

test('isCcAgentBridgeEnabled: default ON, {0,false,off,no} OFF', () => {
  assert.strictEqual(bridge.isCcAgentBridgeEnabled({}), true);
  assert.strictEqual(bridge.isCcAgentBridgeEnabled({ KHY_CC_AGENT_BRIDGE: undefined }), true);
  assert.strictEqual(bridge.isCcAgentBridgeEnabled({ KHY_CC_AGENT_BRIDGE: 'true' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(bridge.isCcAgentBridgeEnabled({ KHY_CC_AGENT_BRIDGE: v }), false, `expected off for ${v}`);
  }
});

test('ccAgentSearchDirs: home → flat user root + two recursive plugin roots', () => {
  const home = '/home/u';
  const dirs = bridge.ccAgentSearchDirs({ homedir: home });
  assert.deepStrictEqual(dirs, [
    { dir: path.join(home, '.claude', 'agents'), source: 'cc-user', recursive: false },
    { dir: path.join(home, '.claude', 'plugins', 'cache'), source: 'cc-plugin', recursive: true },
    { dir: path.join(home, '.claude', 'local-plugins'), source: 'cc-plugin', recursive: true },
  ]);
});

test('ccAgentSearchDirs: user root is flat, plugin roots are recursive', () => {
  const dirs = bridge.ccAgentSearchDirs({ homedir: '/h' });
  assert.strictEqual(dirs[0].recursive, false, 'user agents dir is a flat *.md list');
  assert.ok(dirs.slice(1).every((d) => d.recursive === true), 'plugin roots recurse for nested agents/');
});

test('ccAgentSearchDirs: no home → empty (project .claude/agents handled by khy loader)', () => {
  assert.deepStrictEqual(bridge.ccAgentSearchDirs({}), []);
  assert.deepStrictEqual(bridge.ccAgentSearchDirs(), []);
  // Project dir is intentionally NOT a parameter — never emit a project root here.
  assert.deepStrictEqual(bridge.ccAgentSearchDirs({ projectDir: '/p' }), []);
});

test('ccAgentSearchDirs: never throws on junk input', () => {
  assert.doesNotThrow(() => bridge.ccAgentSearchDirs({ homedir: {} }));
  assert.ok(Array.isArray(bridge.ccAgentSearchDirs({ homedir: 123 })));
});
