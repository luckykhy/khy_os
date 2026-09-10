'use strict';
/**
 * mcpServeToolPolicy â€?pure-leaf tool-exposure policy tests (node:test).
 *
 * Deterministic, no IO. Verifies: resolveExposeMode (default all, readonly/safe
 * mapping, unknownâ†’all), selectExposedTools (all keeps everything, readonly
 * keeps only isReadOnly, safe keeps readonly + low/safe-risk writes),
 * summarizeExposure (counts by risk + hasDestructive).
 */
const pol = require('../../../src/services/mcp/mcpServeToolPolicy');
// Stub tools: minimal shape the policy reads (name, risk, isReadOnly, isDestructive).
function tool(name, risk, readOnly, destructive) {
  return {
    name,
    risk,
    isReadOnly: () => !!readOnly,
    isDestructive: () => !!destructive,
  };
}
const READ = tool('Read', 'safe', true, false);
const GREP = tool('Grep', 'low', true, false);
const EDIT = tool('Edit', 'low', false, false);
const WRITE = tool('Write', 'medium', false, false);
const BASH = tool('Bash', 'high', false, true);
const ALL = [READ, GREP, EDIT, WRITE, BASH];

describe('Mcp Serve Tool Policy', () => {
  test('resolveExposeMode: default all; readonly/safe map; unknownâ†’all', () => {
      expect(pol.resolveExposeMode({})).toBe('all');
      expect(pol.resolveExposeMode({ KHY_MCP_SERVE_EXPOSE: 'readonly' })).toBe('readonly');
      expect(pol.resolveExposeMode({ KHY_MCP_SERVE_EXPOSE: 'safe' })).toBe('safe');
      expect(pol.resolveExposeMode({ KHY_MCP_SERVE_EXPOSE: 'ALL' })).toBe('all');
      expect(pol.resolveExposeMode({ KHY_MCP_SERVE_EXPOSE: 'bogus' })).toBe('all');
  });

  test('selectExposedTools: all â†?everything (user decision: expose all)', () => {
      const sel = pol.selectExposedTools(ALL, 'all');
      expect(sel.length).toBe(5);
  });

  test('selectExposedTools: readonly â†?only isReadOnly tools', () => {
      const sel = pol.selectExposedTools(ALL, 'readonly').map((t) => t.name);
      assert.deepEqual(sel.sort(), ['Grep', 'Read']);
  });

  test('selectExposedTools: safe â†?readonly + low/safe-risk writes (no medium+ writes)', () => {
      const sel = pol.selectExposedTools(ALL, 'safe').map((t) => t.name);
      expect(sel).toContain('Read');
      expect(sel).toContain('Grep');
      expect(sel.includes('Edit')).toBeTruthy();
      expect(!sel.includes('Write')).toBeTruthy();
      expect(!sel.includes('Bash')).toBeTruthy();
  });

  test('selectExposedTools: junk input â†?[] (never throws)', () => {
      assert.deepEqual(pol.selectExposedTools(null, 'all'), []);
      assert.deepEqual(pol.selectExposedTools([null, undefined], 'all'), []);
  });

  test('summarizeExposure: counts by risk + hasDestructive', () => {
      const s = pol.summarizeExposure(ALL);
      expect(s.total).toBe(5);
      expect(s.byRisk.safe).toBe(1);
      expect(s.byRisk.low).toBe(2);
      expect(s.byRisk.medium).toBe(1);
      expect(s.byRisk.high).toBe(1);
      expect(s.hasDestructive).toBe(true);
  });

  test('summarizeExposure: readonly-only set â†?hasDestructive false', () => {
      const s = pol.summarizeExposure([READ, GREP]);
      expect(s.total).toBe(2);
      expect(s.hasDestructive).toBe(false);
  });

});

