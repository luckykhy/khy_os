'use strict';
/**
 * readSearchToolsHoist.test.js �?Ch2「不要每轮重建可复用结构�?
 *
 * Verifies the pure module-const hoist of READ_SEARCH_TOOLS out of the REPL
 * per-round-trip tool loop. The Set is now built once at module load and
 * shared across round-trips (consumed read-only via `.has`).
 */
const repl = require('../../src/cli/repl');
const { READ_SEARCH_TOOLS } = repl;

describe('Read Search Tools Hoist', () => {
  test('READ_SEARCH_TOOLS is an exported shared Set', () => {
      expect(READ_SEARCH_TOOLS instanceof Set).toBeTruthy();
      // Re-require yields the same instance (module-scope const).
      const again = require('../../src/cli/repl');
      expect(again.READ_SEARCH_TOOLS).toBe(READ_SEARCH_TOOLS);
  });

  test('membership matches the historical inline literal exactly', () => {
      const expected = [
        'read_file', 'readFile', 'grep', 'glob', 'search',
        'find_files', 'findFiles', 'search_content', 'searchContent',
        'git_status', 'gitStatus', 'git_diff', 'gitDiff', 'git_log',
        'explore', 'search_codebase', 'find_code', 'codebase_search',
      ];
      expect(READ_SEARCH_TOOLS.size).toBe(expected.length);
      for (const name of expected) {
        expect(READ_SEARCH_TOOLS.has(name)).toBe(true, `missing ${name}`);
      }
  });

  test('non-read/search tool names are absent', () => {
      for (const name of ['Bash', 'write_file', 'edit', 'apply_patch', '']) {
        expect(READ_SEARCH_TOOLS.has(name)).toBe(false, `unexpected ${name}`);
      }
  });

});

