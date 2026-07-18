'use strict';

/**
 * patchEmptyParamToolNamesHoist.test.js — Ch2「不要每轮重建可复用结构」
 *
 * Verifies the pure module-const hoist of the three tool-name Sets out of
 * _patchEmptySearchQuery / _patchEmptyShellCommand. They were rebuilt on every
 * response parse; now they are built once at module load as _PATCH_SEARCH_NAMES /
 * _PATCH_NORMALIZED_SEARCH_NAMES / _PATCH_SHELL_NAMES. The env flag only gates
 * WHICH Set is consulted, not its contents; each is consumed read-only via `.has`
 * and the patches mutate the passed toolCalls (never the Sets). A single shared
 * instance is byte-identical.
 */

const test = require('node:test');
const assert = require('node:assert');

const m = require('../src/services/toolUseLoop');

test('empty search query is filled for search-family names (normalized), others untouched', () => {
  const calls = [
    { name: 'web_search', params: {} },
    { name: 'WebSearch', params: { query: '' } }, // case/normalized variant
    { name: 'read', params: {} },                 // non-search: untouched
  ];
  m._patchEmptySearchQuery(calls, '帮我查一下上海天气预报');
  assert.ok(calls[0].params.query && calls[0].params.query.length > 0);
  assert.ok(calls[1].params.query && calls[1].params.query.length > 0);
  assert.strictEqual(calls[2].params.query, undefined);
});

test('a non-empty search query is left as-is', () => {
  const calls = [{ name: 'web_search', params: { query: '原始查询' } }];
  m._patchEmptySearchQuery(calls, '别的消息');
  assert.strictEqual(calls[0].params.query, '原始查询');
});

test('empty shell command is inferred for shell-family names (normalized), others untouched', () => {
  const calls = [
    { name: 'bash', params: {} },
    { name: 'BASH', params: { command: '' } }, // case variant
    { name: 'web_search', params: {} },        // non-shell: untouched
  ];
  m._patchEmptyShellCommand(calls, '看看桌面有什么文件');
  assert.ok(calls[0].params.command && calls[0].params.command.length > 0);
  assert.ok(calls[1].params.command && calls[1].params.command.length > 0);
  assert.strictEqual(calls[2].params.command, undefined);
});

test('repeated patches are stable (shared Sets do not leak state)', () => {
  const a = [{ name: 'web_search', params: {} }];
  const b = [{ name: 'web_search', params: {} }];
  m._patchEmptySearchQuery(a, '帮我查一下上海天气预报');
  m._patchEmptySearchQuery(b, '帮我查一下上海天气预报');
  assert.strictEqual(a[0].params.query, b[0].params.query);

  const s = [{ name: 'bash', params: {} }];
  const t = [{ name: 'bash', params: {} }];
  m._patchEmptyShellCommand(s, '看看桌面有什么文件');
  m._patchEmptyShellCommand(t, '看看桌面有什么文件');
  assert.strictEqual(s[0].params.command, t[0].params.command);
});
