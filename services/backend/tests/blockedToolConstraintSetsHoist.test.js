'use strict';
/**
 * blockedToolConstraintSetsHoist.test.js —Ch2「不要每轮重建可复用结构」
 *
 * Verifies the pure module-const hoist of the two blocked-tool-name Sets out of
 * _matchBlockedToolConstraint. They were rebuilt on every tool call in
 * _filterToolCallsByIntent's loop; now they are built once at module load as
 * _BLOCKED_SEARCH_TOOLS / _BLOCKED_FILE_READ_TOOLS. Consumed read-only via
 * `.has`, returning only a string reason —a single shared instance is
 * byte-identical.
 */
const { _matchBlockedToolConstraint: match } = require('../src/services/toolUseLoop');

describe('Blocked Tool Constraint Sets Hoist', () => {
  test('disallowSearch blocks search-family tools, nothing else', () => {
    for (const n of ['websearch', 'webfetch', 'search', 'searchweb']) {
      expect(match(n, { disallowSearch: true })).toBe('search');
    }
    expect(match('read', { disallowSearch: true })).toBe('');
    expect(match('websearch', {})).toBe('');
  });

  test('disallowFileRead blocks file-read-family tools, nothing else', () => {
    for (const n of ['read', 'readfile', 'grep', 'glob', 'ls', 'gitstatus', 'gitdiff', 'gitlog', 'find', 'findfiles', 'explore', 'searchcontent']) {
      expect(match(n, { disallowFileRead: true })).toBe('file_read');
    }
    expect(match('websearch', { disallowFileRead: true })).toBe('');
  });

  test('disallowAllTools and empty/edge inputs behave as before', () => {
    expect(match('anything', { disallowAllTools: true })).toBe('all_tools');
    expect(match('', { disallowAllTools: true })).toBe('');
    expect(match('read', null)).toBe('');
    expect(match('read', {})).toBe('');
  });

  test('repeated calls are stable (shared Sets do not leak state)', () => {
    const a1 = match('websearch', { disallowSearch: true });
    const b1 = match('read', { disallowFileRead: true });
    const a2 = match('websearch', { disallowSearch: true });
    const b2 = match('read', { disallowFileRead: true });
    expect(a1).toBe(a2);
    expect(b1).toBe(b2);
    expect(a1).toBe('search');
    expect(b1).toBe('file_read');
  });
});
