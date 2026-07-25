'use strict';

/**
 * readSearchToolsHoist.test.js — Ch2「不要每轮重建可复用结构」
 *
 * Verifies the pure module-const hoist of READ_SEARCH_TOOLS out of the REPL
 * per-round-trip tool loop. The Set is now built once at module load and
 * shared across round-trips (consumed read-only via `.has`).
 */

const test = require('node:test');
const assert = require('node:assert');

const repl = require('../../src/cli/repl');
const { READ_SEARCH_TOOLS } = repl;

test('READ_SEARCH_TOOLS is an exported shared Set', () => {
  assert.ok(READ_SEARCH_TOOLS instanceof Set);
  // Re-require yields the same instance (module-scope const).
  const again = require('../../src/cli/repl');
  assert.strictEqual(again.READ_SEARCH_TOOLS, READ_SEARCH_TOOLS);
});

test('membership matches the historical inline literal exactly', () => {
  const expected = [
    'read_file', 'readFile', 'grep', 'glob', 'search',
    'find_files', 'findFiles', 'search_content', 'searchContent',
    'git_status', 'gitStatus', 'git_diff', 'gitDiff', 'git_log',
    'explore', 'search_codebase', 'find_code', 'codebase_search',
  ];
  assert.strictEqual(READ_SEARCH_TOOLS.size, expected.length);
  for (const name of expected) {
    assert.strictEqual(READ_SEARCH_TOOLS.has(name), true, `missing ${name}`);
  }
});

test('non-read/search tool names are absent', () => {
  for (const name of ['Bash', 'write_file', 'edit', 'apply_patch', '']) {
    assert.strictEqual(READ_SEARCH_TOOLS.has(name), false, `unexpected ${name}`);
  }
});
