'use strict';
/**
 * ccAgentBridge â€?pins the pure leaf that maps Claude Code's on-disk agent
 * roots so khy reuses CC's agent marketplace. Zero-IO: roots are injected, so
 * the suite is deterministic (POSIX path assertions). Covers: gate default-ON +
 * falsy set, root enumeration (flat user + recursive plugin roots), project dir
 * intentionally omitted, and fail-soft on junk (never throws).
 */
const path = require('node:path');
const bridge = require('../src/agents/ccAgentBridge');

describe('Cc Agent Bridge', () => {
  test('isCcAgentBridgeEnabled: default ON, {0,false,off,no} OFF', () => {
      expect(bridge.isCcAgentBridgeEnabled({})).toBe(true);
      expect(bridge.isCcAgentBridgeEnabled({ KHY_CC_AGENT_BRIDGE: undefined })).toBe(true);
      expect(bridge.isCcAgentBridgeEnabled({ KHY_CC_AGENT_BRIDGE: 'true' })).toBe(true);
      for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
        expect(bridge.isCcAgentBridgeEnabled({ KHY_CC_AGENT_BRIDGE: v })).toBe(false, `expected off for ${v}`);
      }
  });

  test('ccAgentSearchDirs: home â†?flat user root + two recursive plugin roots', () => {
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
      expect(dirs[0].recursive).toBe(false, 'user agents dir is a flat *.md list');
      expect(dirs.slice(1).every((d) => d.recursive === true)).toBe();
  });

  test('ccAgentSearchDirs: no home â†?empty (project .claude/agents handled by khy loader)', () => {
      expect(bridge.ccAgentSearchDirs({})).toBe([]);
      expect(bridge.ccAgentSearchDirs()).toBe([]);
      // Project dir is intentionally NOT a parameter â€?never emit a project root here.
      expect(bridge.ccAgentSearchDirs({ projectDir: '/p' })).toBe([]);
  });

  test('ccAgentSearchDirs: never throws on junk input', () => {
      expect(() => bridge.ccAgentSearchDirs({ homedir: {} }).not.toThrow());
      expect(Array.isArray(bridge.ccAgentSearchDirs({ homedir: 123 }).toBeTruthy()));
  });

});

