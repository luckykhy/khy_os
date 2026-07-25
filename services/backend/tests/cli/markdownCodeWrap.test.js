'use strict';

/**
 * markdownCodeWrap.test.js — code-block long-line wrapping stays word-aware
 * and inside the box (node:test).
 *
 * Bug "表格显示混乱": a long shell line inside a fenced code box wrapped at the
 * CHARACTER level, splitting words mid-token ("FullName" → "F" + "ullName",
 * "First" → "Fi" + "rst"), which read as broken/garbled. The box geometry was
 * already sound (every row ≤ terminal columns); the chaos was purely the
 * mid-word break.
 *
 * These cases pin the fix in _wrapRawToWidth (exercised through the public
 * renderMarkdownLite): wrapping now breaks at whitespace so tokens stay intact,
 * falling back to a character hard-split only for a single token wider than a
 * whole line. Every rendered row must still fit within the box.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { renderMarkdownLite } = require('../../src/cli/markdownRenderer');
const { displayWidth } = require('../../src/cli/formatters');

// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;
const strip = (s) => s.replace(ANSI, '');

// Content rows of the code box are the ones framed by the vertical border.
const contentRows = (rendered) =>
  strip(rendered)
    .split('\n')
    .filter((l) => l.includes('│'));

let _origCols;
before(() => {
  _origCols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
});
after(() => {
  if (_origCols) Object.defineProperty(process.stdout, 'columns', _origCols);
});
const setCols = (n) => {
  Object.defineProperty(process.stdout, 'columns', { value: n, configurable: true });
};

describe('code-block wrapping — word boundary, no mid-token split', () => {
  test('a long shell line breaks at whitespace, keeping words intact', () => {
    setCols(60);
    const md =
      '```cmd\n' +
      'powershell -c "Get-ChildItem -Recurse | Select-Object -First 20 FullNameAndLength"\n' +
      '```';
    const out = strip(renderMarkdownLite(md));

    // Distinct tokens must survive whole — never split across a wrap boundary.
    for (const word of ['Get-ChildItem', 'Select-Object', 'FullNameAndLength', 'First']) {
      assert.ok(out.includes(word), `token "${word}" must stay intact (got split)`);
    }
    // The specific regression: "FullName..." must not start a row as a broken prefix.
    assert.ok(!/│\s*ullName/.test(out), 'a row must not begin mid-word ("ullName…")');
  });

  test('every rendered box row fits within terminal columns', () => {
    setCols(48);
    const md =
      '```bash\n' +
      'git log --oneline --graph --decorate --all --since="2 weeks ago" | head -50\n' +
      '```';
    const cols = 48;
    for (const row of contentRows(renderMarkdownLite(md))) {
      assert.ok(displayWidth(row) <= cols, `row exceeds ${cols} cols: ${displayWidth(row)}`);
    }
  });

  test('a single token wider than a line still hard-splits and stays in bounds', () => {
    setCols(40);
    const longToken = 'A'.repeat(120); // no whitespace → must fall back to char split
    const md = '```\n' + longToken + '\n```';
    const rows = contentRows(renderMarkdownLite(md));
    assert.ok(rows.length >= 2, 'an over-wide token must wrap onto multiple rows');
    for (const row of rows) {
      assert.ok(displayWidth(row) <= 40, `hard-split row exceeds 40 cols: ${displayWidth(row)}`);
    }
    // All the As are still present across the wrapped rows.
    const reassembled = rows.join('').replace(/[^A]/g, '');
    assert.equal(reassembled.length, 120, 'no characters lost in the hard split');
  });

  test('CJK content wraps without overflowing the box', () => {
    setCols(30);
    const md = '```\n' + '清理临时文件并清空回收站然后查看磁盘占用情况报告' + '\n```';
    for (const row of contentRows(renderMarkdownLite(md))) {
      assert.ok(displayWidth(row) <= 30, `CJK row exceeds 30 cols: ${displayWidth(row)}`);
    }
  });

  test('leading indentation is preserved on the first wrapped segment', () => {
    setCols(40);
    const md = '```python\n' + '    return some_function(argument_one, argument_two, argument_three)\n' + '```';
    const rows = contentRows(renderMarkdownLite(md));
    // The first content row keeps the 4-space indent right after the border.
    const first = rows.find((r) => r.includes('return'));
    assert.ok(first && /│\s{5}return/.test(first), 'indentation must survive (│ + space gutter + 4 indent)');
  });
});
