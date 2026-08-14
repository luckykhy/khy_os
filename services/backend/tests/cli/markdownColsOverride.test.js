'use strict';

// Force ANSI color so the code-block shading (256-color background) is emitted
// regardless of TTY — code rows are now identified by that background escape.
process.env.FORCE_COLOR = '3';

/**
 * markdownColsOverride.test.js — optional width override for the markdown
 * renderer (任务#16, node:test).
 *
 * While the right-column board shares the flex row, streamed markdown renders
 * inside the LEFT column only — but renderMarkdownLite used to wrap code boxes
 * and tables against the FULL terminal width (getTerminalColumns), producing
 * rows wider than the left column that ink then re-wrapped (ugly double wrap).
 *
 * These cases pin the fix: a valid colsOverride beats the terminal width for
 * every soft-wrap decision; absent/invalid override keeps the legacy full-width
 * path byte-identical; and the render cache never serves a wrong-width hit when
 * the same text renders at different widths (width joined the cache key).
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { renderMarkdownLite, renderMarkdownStreaming } = require('../../src/cli/markdownRenderer');
const { displayWidth } = require('../../src/cli/formatters');

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s) => s.replace(ANSI, '');

// Content rows of a code block carry an ANSI background shade instead of a
// vertical border. Chalk emits it as 256-color or truecolor depending on the
// level, so match the `[48;` background introducer (before stripping ANSI),
// then strip for width measurement.
const CODE_BG = '[48;';
const boxRows = (rendered) =>
  rendered.split('\n').filter((l) => l.includes(CODE_BG)).map(strip);

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

// Each render below uses UNIQUE text so LRU cache hits can never mask a
// wrong-width render (except the dedicated cache-keying case, which reuses
// one text on purpose).
describe('renderMarkdownLite — colsOverride beats the terminal width', () => {
  test('code box wraps at the override width, not the (wider) terminal', () => {
    setCols(120);
    const md = '```bash\ngit log --oneline --graph --decorate --all --since="2 weeks ago" | head -50 # ovr-a\n```';
    const out = renderMarkdownLite(md, 40);
    const rows = boxRows(out);
    assert.ok(rows.length >= 2, 'long line must wrap under the narrow override');
    for (const row of rows) {
      assert.ok(displayWidth(row) <= 40, `row exceeds override 40: ${displayWidth(row)}`);
    }
  });

  test('table clamps to the override width, not the (wider) terminal', () => {
    setCols(120);
    // Force the BOX-table branch: the default plain-table path is copy-friendly
    // content-width alignment and never clamps to the terminal (legacy), so the
    // width clamp under test only exists in the box branch.
    const prev = process.env.KHY_PLAIN_PROCESS_TABLE;
    process.env.KHY_PLAIN_PROCESS_TABLE = '0';
    try {
      const md = '| first column header ovr-b | second column header long | third column header long |\n'
        + '| --- | --- | --- |\n'
        + '| aaaaaaaaaaaaaaaaaaaa | bbbbbbbbbbbbbbbbbbbb | cccccccccccccccccccc |';
      const out = renderMarkdownLite(md, 44);
      for (const row of strip(out).split('\n')) {
        assert.ok(displayWidth(row) <= 44, `table row exceeds override 44: ${displayWidth(row)} (${row})`);
      }
    } finally {
      if (prev === undefined) delete process.env.KHY_PLAIN_PROCESS_TABLE;
      else process.env.KHY_PLAIN_PROCESS_TABLE = prev;
    }
  });

  test('invalid override (0/negative/NaN/non-number) falls back to the terminal width', () => {
    setCols(60);
    const md = '```\n' + 'x'.repeat(100) + ' ovr-c\n```';
    const legacy = renderMarkdownLite(md);
    for (const bad of [0, -5, NaN, Infinity, '40', null, undefined]) {
      // Same text: identical output also proves cache keying maps all invalid
      // overrides onto the same (terminal-width) key — no wrong-width entries.
      assert.equal(renderMarkdownLite(md, bad), legacy, `override ${String(bad)} must fall back`);
    }
  });

  test('cache never serves a wrong-width hit: same text, two widths, two outputs', () => {
    setCols(120);
    const md = '```bash\necho "a fairly long single code line that wraps differently by width" # ovr-d\n```';
    const wide = renderMarkdownLite(md, 100);
    const narrow = renderMarkdownLite(md, 36);
    assert.notEqual(wide, narrow, 'different widths must not collide in the cache');
    // Re-render at the first width again: must reproduce the first output
    // (a text-only key would now return the narrow render).
    assert.equal(renderMarkdownLite(md, 100), wide);
  });
});

describe('renderMarkdownStreaming — override passthrough + legacy default', () => {
  test('streaming passes the override through (unclosed fence, narrow box)', () => {
    setCols(120);
    const live = renderMarkdownStreaming('```bash\ngit status --porcelain=v2 --branch --show-stash # ovr-e', 40);
    const rows = boxRows(live);
    assert.ok(rows.length >= 2, 'unclosed block must wrap under the narrow override');
    for (const row of rows) {
      assert.ok(displayWidth(row) <= 40, `row exceeds override 40: ${displayWidth(row)}`);
    }
  });

  test('no override → byte-identical to renderMarkdownLite (legacy contract intact)', () => {
    setCols(60);
    const closed = '```bash\nls -la # ovr-f\n```';
    assert.equal(renderMarkdownStreaming(closed), renderMarkdownLite(closed));
  });
});
