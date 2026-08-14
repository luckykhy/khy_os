'use strict';

/**
 * blockedToolConstraintSetsHoist.test.js — Ch2「不要每轮重建可复用结构」
 *
 * Verifies the pure module-const hoist of the two blocked-tool-name Sets out of
 * _matchBlockedToolConstraint. They were rebuilt on every tool call in
 * _filterToolCallsByIntent's loop; now they are built once at module load as
 * _BLOCKED_SEARCH_TOOLS / _BLOCKED_FILE_READ_TOOLS. Consumed read-only via
 * `.has`, returning only a string reason — a single shared instance is
 * byte-identical.
 */

const test = require('node:test');
const assert = require('node:assert');

const { _matchBlockedToolConstraint: match } = require('../src/services/toolUseLoop');

test('disallowSearch blocks search-family tools, nothing else', () => {
  for (const n of ['websearch', 'webfetch', 'search', 'searchweb']) {
    assert.strictEqual(match(n, { disallowSearch: true }), 'search', `${n} should be blocked`);
  }
  assert.strictEqual(match('read', { disallowSearch: true }), '');
  assert.strictEqual(match('websearch', {}), '');
});

test('disallowFileRead blocks file-read-family tools, nothing else', () => {
  for (const n of ['read', 'readfile', 'grep', 'glob', 'ls', 'gitstatus', 'gitdiff', 'gitlog', 'find', 'findfiles', 'explore', 'searchcontent']) {
    assert.strictEqual(match(n, { disallowFileRead: true }), 'file_read', `${n} should be blocked`);
  }
  assert.strictEqual(match('websearch', { disallowFileRead: true }), '');
});

test('disallowAllTools and empty/edge inputs behave as before', () => {
  assert.strictEqual(match('anything', { disallowAllTools: true }), 'all_tools');
  assert.strictEqual(match('', { disallowAllTools: true }), '');
  assert.strictEqual(match('read', null), '');
  assert.strictEqual(match('read', {}), '');
});

test('repeated calls are stable (shared Sets do not leak state)', () => {
  const a1 = match('websearch', { disallowSearch: true });
  const b1 = match('read', { disallowFileRead: true });
  const a2 = match('websearch', { disallowSearch: true });
  const b2 = match('read', { disallowFileRead: true });
  assert.strictEqual(a1, a2);
  assert.strictEqual(b1, b2);
  assert.strictEqual(a1, 'search');
  assert.strictEqual(b1, 'file_read');
});
