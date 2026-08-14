'use strict';

/**
 * readOnlyToolSetsHoist.test.js — Ch2「不要每轮重建可复用结构」
 *
 * Verifies the pure module-const hoist of the three read-only membership Sets
 * out of the agentic loop (runToolUseLoop). They were previously rebuilt as
 * `new Set([...literals])` on hot per-call / per-iteration / per-result paths;
 * they are now built once at module load. Behavior must be byte-identical, and
 * the three must remain DISTINCT (their membership differs by purpose).
 */

const test = require('node:test');
const assert = require('node:assert');

const loop = require('../src/services/toolUseLoop');
const {
  _DEDUP_READ_ONLY_TOOLS: DEDUP,
  _IDLE_READ_ONLY_TOOLS: IDLE,
  _READ_ONLY_SHELL_CMDS: SHELL,
} = loop;

test('all three sets are exported and non-empty', () => {
  assert.ok(DEDUP instanceof Set && DEDUP.size > 0);
  assert.ok(IDLE instanceof Set && IDLE.size > 0);
  assert.ok(SHELL instanceof Set && SHELL.size > 0);
});

test('DEDUP set membership is byte-identical to the former literal', () => {
  const expected = [
    'read_file', 'readfile', 'readFile', 'read',
    'grep', 'rg', 'search', 'glob', 'find', 'ls', 'LS',
    'quote', 'data_fetch', 'web_search', 'webSearch', 'websearch',
    'git_status', 'git_diff', 'git_log',
  ];
  assert.strictEqual(DEDUP.size, expected.length);
  for (const k of expected) assert.ok(DEDUP.has(k), `DEDUP missing ${k}`);
});

test('IDLE set membership is byte-identical to the former literal', () => {
  const expected = [
    'read_file', 'readFile',
    'search', 'toolSearch',
    'git_status', 'gitStatus',
    'git_diff', 'gitDiff',
    'git_log',
    'strategy_list', 'strategyList',
    'quote', 'grep', 'glob', 'ls', 'webSearch', 'web_search', 'webFetch', 'notebookRead',
  ];
  assert.strictEqual(IDLE.size, expected.length);
  for (const k of expected) assert.ok(IDLE.has(k), `IDLE missing ${k}`);
});

test('SHELL set membership is byte-identical to the former literal', () => {
  const expected = ['ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'wc', 'file', 'stat', 'pwd', 'which', 'echo', 'tree', 'du', 'df'];
  assert.strictEqual(SHELL.size, expected.length);
  for (const k of expected) assert.ok(SHELL.has(k), `SHELL missing ${k}`);
});

test('the three sets are DISTINCT (not accidentally merged)', () => {
  // Not the same object identity.
  assert.notStrictEqual(DEDUP, IDLE);
  assert.notStrictEqual(DEDUP, SHELL);
  assert.notStrictEqual(IDLE, SHELL);
  // Distinguishing members that live in only one of the tool-name sets:
  assert.ok(DEDUP.has('data_fetch') && !IDLE.has('data_fetch'));   // DEDUP-only
  assert.ok(DEDUP.has('find') && !IDLE.has('find'));               // DEDUP-only
  assert.ok(IDLE.has('webFetch') && !DEDUP.has('webFetch'));       // IDLE-only
  assert.ok(IDLE.has('strategy_list') && !DEDUP.has('strategy_list')); // IDLE-only
  // SHELL holds bare binaries, not tool names.
  assert.ok(SHELL.has('cat') && !DEDUP.has('cat') && !IDLE.has('cat'));
});

test('sets are stable singletons across module re-require (hoisted once)', () => {
  const again = require('../src/services/toolUseLoop');
  assert.strictEqual(again._DEDUP_READ_ONLY_TOOLS, DEDUP);
  assert.strictEqual(again._IDLE_READ_ONLY_TOOLS, IDLE);
  assert.strictEqual(again._READ_ONLY_SHELL_CMDS, SHELL);
});
