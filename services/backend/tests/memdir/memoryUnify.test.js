'use strict';

// Unit tests for the memory-home unification pure leaf.
// node:test (jest is broken under rtk — run with `node --test`).

const test = require('node:test');
const assert = require('node:assert');

const mu = require('../../src/memdir/memoryUnify');

// ---------------------------------------------------------------------------
// Gate ladders — both default ON.
// ---------------------------------------------------------------------------

test('unifiedHomeEnabled: unset → on', () => {
  assert.strictEqual(mu.unifiedHomeEnabled({}), true);
  assert.strictEqual(mu.unifiedHomeEnabled(undefined), true);
});

test('unifiedHomeEnabled: off tokens → off', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.strictEqual(mu.unifiedHomeEnabled({ KHY_MEMORY_UNIFIED_HOME: v }), false, `value ${v}`);
  }
});

test('legacyMergeEnabled: unset → on; off tokens → off', () => {
  assert.strictEqual(mu.legacyMergeEnabled({}), true);
  assert.strictEqual(mu.legacyMergeEnabled({ KHY_MEMORY_MERGE_LEGACY: 'off' }), false);
});

// ---------------------------------------------------------------------------
// planLegacyMerge — established-wins, only-missing, .md only, no MEMORY.md.
// ---------------------------------------------------------------------------

test('copies legacy-only .md files', () => {
  const out = mu.planLegacyMerge([], ['user_home.md', 'project_x.md']);
  assert.deepStrictEqual(out.sort(), ['project_x.md', 'user_home.md']);
});

test('established-wins: never overwrites a canonical file', () => {
  const out = mu.planLegacyMerge(['user_home.md'], ['user_home.md', 'project_x.md']);
  assert.deepStrictEqual(out, ['project_x.md']);
});

test('excludes MEMORY.md (index reconciled separately)', () => {
  const out = mu.planLegacyMerge([], ['MEMORY.md', 'user_home.md']);
  assert.deepStrictEqual(out, ['user_home.md']);
});

test('ignores non-.md files and blanks/non-strings', () => {
  const out = mu.planLegacyMerge([], ['notes.txt', '', '  ', 42, null, 'good.md']);
  assert.deepStrictEqual(out, ['good.md']);
});

test('canonical superset → nothing to copy', () => {
  const out = mu.planLegacyMerge(['a.md', 'b.md'], ['a.md', 'b.md']);
  assert.deepStrictEqual(out, []);
});

test('defensive: non-array inputs → empty list', () => {
  assert.deepStrictEqual(mu.planLegacyMerge(null, null), []);
  assert.deepStrictEqual(mu.planLegacyMerge(undefined, 'x.md'), []);
});
