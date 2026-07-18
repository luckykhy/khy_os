'use strict';

/**
 * mcpServeToolPolicy — pure-leaf tool-exposure policy tests (node:test).
 *
 * Deterministic, no IO. Verifies: resolveExposeMode (default all, readonly/safe
 * mapping, unknown→all), selectExposedTools (all keeps everything, readonly
 * keeps only isReadOnly, safe keeps readonly + low/safe-risk writes),
 * summarizeExposure (counts by risk + hasDestructive).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

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

test('resolveExposeMode: default all; readonly/safe map; unknown→all', () => {
  assert.equal(pol.resolveExposeMode({}), 'all');
  assert.equal(pol.resolveExposeMode({ KHY_MCP_SERVE_EXPOSE: 'readonly' }), 'readonly');
  assert.equal(pol.resolveExposeMode({ KHY_MCP_SERVE_EXPOSE: 'safe' }), 'safe');
  assert.equal(pol.resolveExposeMode({ KHY_MCP_SERVE_EXPOSE: 'ALL' }), 'all');
  assert.equal(pol.resolveExposeMode({ KHY_MCP_SERVE_EXPOSE: 'bogus' }), 'all');
});

test('selectExposedTools: all → everything (user decision: expose all)', () => {
  const sel = pol.selectExposedTools(ALL, 'all');
  assert.equal(sel.length, 5);
});

test('selectExposedTools: readonly → only isReadOnly tools', () => {
  const sel = pol.selectExposedTools(ALL, 'readonly').map((t) => t.name);
  assert.deepEqual(sel.sort(), ['Grep', 'Read']);
});

test('selectExposedTools: safe → readonly + low/safe-risk writes (no medium+ writes)', () => {
  const sel = pol.selectExposedTools(ALL, 'safe').map((t) => t.name);
  assert.ok(sel.includes('Read'));
  assert.ok(sel.includes('Grep'));
  assert.ok(sel.includes('Edit'), 'low-risk write kept');
  assert.ok(!sel.includes('Write'), 'medium-risk write dropped');
  assert.ok(!sel.includes('Bash'), 'high-risk write dropped');
});

test('selectExposedTools: junk input → [] (never throws)', () => {
  assert.deepEqual(pol.selectExposedTools(null, 'all'), []);
  assert.deepEqual(pol.selectExposedTools([null, undefined], 'all'), []);
});

test('summarizeExposure: counts by risk + hasDestructive', () => {
  const s = pol.summarizeExposure(ALL);
  assert.equal(s.total, 5);
  assert.equal(s.byRisk.safe, 1);
  assert.equal(s.byRisk.low, 2);
  assert.equal(s.byRisk.medium, 1);
  assert.equal(s.byRisk.high, 1);
  assert.equal(s.hasDestructive, true);
});

test('summarizeExposure: readonly-only set → hasDestructive false', () => {
  const s = pol.summarizeExposure([READ, GREP]);
  assert.equal(s.total, 2);
  assert.equal(s.hasDestructive, false);
});
