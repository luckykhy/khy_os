'use strict';

// Force ANSI color so the code-block shading (256-color background) is emitted
// regardless of TTY — code rows are now identified by that background escape.
process.env.FORCE_COLOR = '3';

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

const { renderMarkdownLite, _wrapRawToWidth } = require('../../src/cli/markdownRenderer');
const { displayWidth } = require('../../src/cli/formatters');

// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;
const strip = (s) => s.replace(ANSI, '');

// Content rows of the code block carry an ANSI background shade instead of
// vertical borders. Chalk emits it as 256-color or truecolor depending on the
// level, so match the `[48;` background introducer (before stripping ANSI) to
// isolate code rows, then strip for width/text checks.
const CODE_BG = '[48;';
const contentRows = (rendered) =>
  rendered
    .split('\n')
    .filter((l) => l.includes(CODE_BG))
    .map(strip);

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
    const rows = contentRows(renderMarkdownLite(md));
    assert.ok(!rows.some((r) => /^\s*ullName/.test(r)), 'a row must not begin mid-word ("ullName…")');
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
    // The first content row keeps the 4-space indent. Layout: 2-space left
    // margin + 1-space shade padding + the preserved 4-space code indent = 7
    // leading spaces before `return`.
    const first = rows.find((r) => r.includes('return'));
    assert.ok(first && /^ {7}return/.test(first), 'indentation must survive (margin + shade pad + 4 indent)');
  });
});

describe('mixed CJK/Latin wrapping - a CJK clause fills the line', () => {
  // Regression: an unspaced CJK clause right after a Latin word used to
  // be wrapped wholesale to the next line, leaving the previous line
  // half-empty (Latin word + long Chinese sentence). It must instead
  // prefix-fill the remaining space of the current line.
  const MIXED = '    \u5C0F\u738B\u6CA1\u56DE\u3002\u4ED6\u60F3\u8D77\u4E0A\u5468 Code Review ' +
    '\u65F6\uFF0C\u8001\u5F20\u6307\u7740\u90A3\u6BB5\u6CA1\u6709\u9501\u7684\u5E76\u53D1\u4EE3\u7801\u8BF4\uFF1A\u201C\u8FD9\u79CD\u5751\uFF0C\u8E29\u8FC7\u4E00\u6B21\u5C31\u8BB0\u4F4F\u4E86\u3002\u201D' +
    '\u5F53\u65F6\u4ED6\u70B9\u5934\u5982\u6363\u849C\uFF0C\u5FC3\u91CC\u60F3\u7684\u662F\u201C\u54EA\u6709\u90A3\u4E48\u5DE7\u201D\u3002';

  test('does not break right after Review and fills the line', () => {
    const lines = _wrapRawToWidth(MIXED, 110, displayWidth);
    assert.ok(lines.length >= 2, 'must wrap onto multiple lines');
    assert.ok(!/Review\s*$/.test(lines[0]), 'line 1 must not end right after Review');
    assert.ok(displayWidth(lines[0]) >= 100, 'line 1 nearly full, got ' + displayWidth(lines[0]));
    for (const l of lines) assert.ok(displayWidth(l) <= 110, 'line overflows: ' + displayWidth(l));
    assert.equal(lines.join('').replace(/\s+/g, ''), MIXED.replace(/\s+/g, ''), 'no characters lost');
  });

  test('no wrapped line starts with closing CJK punctuation (kinsoku)', () => {
    const closers = new Set(Array.from('\uFF0C\u3002\u3001\uFF1B\uFF1A\uFF01\uFF1F\uFF09\u3011\u300B\u3009\u300D\u300F\u201D\u2019\u2026\u2014' + ',.;:!?)]}'));
    for (const w of [24, 40, 60, 80, 110]) {
      for (const l of _wrapRawToWidth(MIXED, w, displayWidth)) {
        const first = Array.from(l)[0];
        assert.ok(!closers.has(first), 'line starts with ' + first + ' at width ' + w);
      }
    }
  });

  test('a Latin word that fits a whole line still wraps whole', () => {
    const lines = _wrapRawToWidth('aaa bbb ccc Internationalize', 20, displayWidth);
    assert.ok(lines.some((l) => l.trim() === 'Internationalize'),
      'expected whole-word wrap, got ' + JSON.stringify(lines));
  });

  test('no wrapped line ends with an opening bracket/quote (kinsoku EOL)', () => {
    const openers = new Set(Array.from('\uFF08\u3010\u300A\u3008\u300C\u300E\u201C\u2018'));
    for (const w of [24, 40, 60, 80, 110]) {
      for (const l of _wrapRawToWidth(MIXED, w, displayWidth)) {
        const cs = Array.from(l);
        assert.ok(!openers.has(cs[cs.length - 1]), 'line ends with opener at width ' + w + ': ' + JSON.stringify(l));
      }
    }
  });

  test('boundary: empty string and a single CJK char at tiny limits', () => {
    assert.deepEqual(_wrapRawToWidth('', 1, displayWidth), ['']);
    assert.deepEqual(_wrapRawToWidth('\u6E05', 1, displayWidth), ['\u6E05']);
    assert.deepEqual(_wrapRawToWidth('\u6E05', 2, displayWidth), ['\u6E05']);
  });

  test('ultra-narrow limits stay at the single-wide-char physical floor', () => {
    const CJK = '\u6E05\u7406\u4E34\u65F6\u6587\u4EF6';
    for (const limit of [1, 2]) {
      const lines = _wrapRawToWidth(CJK, limit, displayWidth);
      for (const l of lines) {
        assert.ok(displayWidth(l) <= 2, 'piece above physical floor at limit ' + limit + ': ' + JSON.stringify(l));
      }
      assert.equal(lines.join(''), CJK, 'characters lost at limit ' + limit);
    }
  });

  test('unspaced Latin+CJK alternating token: words intact, in bounds, no loss', () => {
    const TOKEN = 'HTTP\u72B6\u6001\u7801200\u6210\u529F\u4E2D\u6587\u8BF4\u660E';
    for (const w of [4, 6, 8, 10]) {
      const lines = _wrapRawToWidth(TOKEN, w, displayWidth);
      for (const l of lines) assert.ok(displayWidth(l) <= w, 'overflow at width ' + w + ': ' + JSON.stringify(l));
      assert.equal(lines.join(''), TOKEN, 'characters lost at width ' + w);
      assert.ok(lines.some((l) => l.includes('HTTP')), 'HTTP split at width ' + w);
      assert.ok(lines.some((l) => l.includes('200')), '200 split at width ' + w);
    }
  });
});
