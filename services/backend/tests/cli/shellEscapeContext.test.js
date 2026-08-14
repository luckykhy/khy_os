'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  formatShellEscapeContextExpanded,
  shellEscapeExpandRecentEnabled,
} = require('../../src/cli/shellEscapeContext');

test('gate off → undefined (caller falls back to legacy)', () => {
  const r = formatShellEscapeContextExpanded([{ command: 'a', body: 'x', code: 0 }], 8000, { KHY_SHELL_ESCAPE_EXPAND_RECENT: '0' });
  assert.strictEqual(r, undefined);
  assert.strictEqual(shellEscapeExpandRecentEnabled({ KHY_SHELL_ESCAPE_EXPAND_RECENT: 'off' }), false);
  assert.strictEqual(shellEscapeExpandRecentEnabled({}), true);
});

test('empty / non-array / no-command → empty string', () => {
  assert.strictEqual(formatShellEscapeContextExpanded([], 8000, {}), '');
  assert.strictEqual(formatShellEscapeContextExpanded(null, 8000, {}), '');
  assert.strictEqual(formatShellEscapeContextExpanded([{ body: 'x' }, { command: '' }], 8000, {}), '');
});

test('single record: tag shape + body + exit code', () => {
  const out = formatShellEscapeContextExpanded([{ command: 'dir', body: 'a\nb', code: 0 }], 8000, {});
  assert.match(out, /^<shell-escape-output>\n/);
  assert.match(out, /<\/shell-escape-output>$/);
  assert.ok(out.includes('$ dir'));
  assert.ok(out.includes('a\nb'));
  assert.ok(out.includes('(exit 0)'));
});

test('missing body/code → placeholder / 0', () => {
  const out = formatShellEscapeContextExpanded([{ command: 'noop' }], 8000, {});
  assert.ok(out.includes('(无输出)'));
  assert.ok(out.includes('(exit 0)'));
});

test('multiple records separated by blank line, chronological order', () => {
  const out = formatShellEscapeContextExpanded([
    { command: 'a', body: '1', code: 0 },
    { command: 'b', body: '2', code: 1 },
  ], 8000, {});
  assert.ok(out.includes('$ a\n1\n(exit 0)\n\n$ b\n2\n(exit 1)'));
});

test('oversized single record truncated with marker', () => {
  const huge = 'x'.repeat(50);
  const out = formatShellEscapeContextExpanded([{ command: 'big', body: huge, code: 0 }], 20, {});
  assert.ok(out.includes('…(shell 输出已截断)'));
});

test('MOST-RECENT-EXPANDED: newest kept whole, older omitted when over budget', () => {
  // older produces a huge block; newest is small. Legacy slice-from-start would
  // cut the NEWEST (tail); this leaf must keep newest whole and omit the older.
  const older = { command: 'find /', body: 'F'.repeat(400), code: 0 };
  const newest = { command: 'echo hi', body: 'hi', code: 0 };
  const out = formatShellEscapeContextExpanded([older, newest], 120, {});
  // newest fully present
  assert.ok(out.includes('$ echo hi\nhi\n(exit 0)'), 'newest must be intact');
  // older omitted with count marker (not partially sliced at tail)
  assert.ok(out.includes('省略 1 条较早 shell 输出'), 'older should be omitted+counted');
  assert.ok(!out.includes('F'.repeat(400)), 'huge older body should not be included');
});

test('newest itself over budget → truncate newest + omit older count', () => {
  const older = { command: 'a', body: 'x', code: 0 };
  const newest = { command: 'cat huge', body: 'Y'.repeat(500), code: 0 };
  const out = formatShellEscapeContextExpanded([older, newest], 60, {});
  assert.ok(out.includes('…(shell 输出已截断)'));
  assert.ok(out.includes('省略 1 条较早 shell 输出'));
  assert.ok(out.includes('$ cat huge'));
});

test('all fit → no omission marker, all present in order', () => {
  const out = formatShellEscapeContextExpanded([
    { command: 'a', body: '1', code: 0 },
    { command: 'b', body: '2', code: 0 },
    { command: 'c', body: '3', code: 0 },
  ], 8000, {});
  assert.ok(!out.includes('省略'));
  const ia = out.indexOf('$ a');
  const ib = out.indexOf('$ b');
  const ic = out.indexOf('$ c');
  assert.ok(ia < ib && ib < ic, 'chronological order preserved');
});

test('partial older inclusion: keeps as many recent-older as fit', () => {
  // 3 older + newest; budget fits newest + 1 older only → omit 2 older.
  const mk = (name) => ({ command: name, body: name.repeat(30), code: 0 });
  const recs = [mk('a'), mk('b'), mk('c'), { command: 'new', body: 'n', code: 0 }];
  const newestBlock = '$ new\nn\n(exit 0)';
  const oneOlderLen = ('$ c\n' + 'c'.repeat(30) + '\n(exit 0)').length;
  const budget = newestBlock.length + 2 + oneOlderLen + 5; // room for newest + c only
  const out = formatShellEscapeContextExpanded(recs, budget, {});
  assert.ok(out.includes('$ new\nn\n(exit 0)'), 'newest kept');
  assert.ok(out.includes('$ c\n'), 'nearest older kept');
  assert.ok(out.includes('省略 2 条较早 shell 输出'), 'two oldest omitted');
});

test('never throws on malformed records', () => {
  assert.doesNotThrow(() => formatShellEscapeContextExpanded([null, { command: 'x', body: {}, code: 'z' }, 5], 100, {}));
});
