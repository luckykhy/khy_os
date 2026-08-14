'use strict';

/**
 * markdownColors.test.js — restrained markdown accent colors (node:test).
 *
 * Goal「纯白字阅读太费力」: bold runs, bullets, ordinal markers, H3-H6 headings
 * and blockquote bars now carry muted theme-driven colors (md* keys in
 * themes/*.json), with centralized fallbacks for older custom themes missing
 * the keys. FORCE_COLOR=3 pins chalk to truecolor so hex sequences are
 * deterministic regardless of the CI terminal.
 */

process.env.FORCE_COLOR = '3';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { renderMarkdownLite } = require('../../src/cli/markdownRenderer');
const themeRegistry = require('../../src/cli/themeRegistry');
const { renderCached, clearStreamMdCache } = require('../../src/cli/tui/ink-components/streamMdCache');

// hex → the "38;2;R;G;B" fragment chalk emits at color level 3.
const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
};

let _origTheme;
before(() => {
  _origTheme = themeRegistry.getActiveName();
  themeRegistry.setTheme('default');
});
after(() => {
  if (_origTheme) themeRegistry.setTheme(_origTheme);
});

describe('markdown accent colors (default theme)', () => {
  test('bold **text** renders bold + soft warm gold (mdBold)', () => {
    const out = renderMarkdownLite('去了 **大理** 和 **丽江**');
    assert.ok(out.includes('\x1b[1m'), 'bold ANSI present');
    assert.ok(out.includes(rgb('#E5C07B')), 'mdBold hex applied');
  });

  test('bullet "•" is colored (mdBullet) while body keeps default color', () => {
    const out = renderMarkdownLite('- 苍山\n- 洱海');
    assert.ok(out.includes(`${rgb('#61AFEF')}m•`) || out.includes(`\x1b[${rgb('#61AFEF')}m•`), 'bullet glyph colored');
    // Body text carries no foreground color of its own right after the reset.
    assert.ok(/•\x1b\[39m 苍山/.test(out), 'body stays default color');
  });

  test('ordered-list ordinal is colored (mdListNumber), not dim', () => {
    const out = renderMarkdownLite('1. 第一\n2. 第二');
    assert.ok(out.includes(rgb('#61AFEF')), 'mdListNumber hex applied');
    assert.ok(!/\x1b\[2m1\./.test(out), 'ordinal no longer dim');
  });

  test('H3 heading uses mdH3 soft blue instead of plain cyan', () => {
    const out = renderMarkdownLite('### 行程安排');
    assert.ok(out.includes(rgb('#61AFEF')), 'mdH3 hex applied');
    assert.ok(!/\x1b\[36m行程安排/.test(out), 'plain cyan removed from H3 title');
  });

  test('blockquote bar "│" uses mdQuote color instead of dim', () => {
    const out = renderMarkdownLite('> 风花雪月');
    assert.ok(out.includes(`\x1b[${rgb('#7F9CB3')}m│`), 'quote bar colored');
  });

  test('H1/H2 and inline code keep their existing styles', () => {
    const out = renderMarkdownLite('# 标题一\n## 标题二\n正文 `code` 结束');
    assert.ok(/\x1b\[36mcode/.test(out), 'inline code stays cyan');
    assert.ok(/\x1b\[1m\x1b\[36m标题二/.test(out), 'H2 stays bold cyan');
  });

  test('***bold-italic*** carries the mdBold accent', () => {
    const out = renderMarkdownLite('前缀 ***重点强调D4*** 后缀');
    assert.ok(out.includes('\x1b[1m'), 'bold ANSI present');
    assert.ok(out.includes('\x1b[3m'), 'italic ANSI present');
    assert.ok(out.includes(rgb('#E5C07B')), 'mdBold hex applied to bold-italic');
  });

  test('bold inside table cells carries the mdBold accent', () => {
    const out = renderMarkdownLite('| 城市 | 亮点 |\n| --- | --- |\n| **大理D5** | 风花雪月 |');
    assert.ok(out.includes(rgb('#E5C07B')), 'mdBold hex applied inside table cell');
  });
});

describe('markdown accent colors — robustness', () => {
  test('theme missing md* keys falls back to built-in defaults without throwing', () => {
    const theme = themeRegistry.getTheme();
    const saved = { ...theme.colors };
    try {
      for (const k of ['mdBold', 'mdBullet', 'mdListNumber', 'mdH3', 'mdQuote']) {
        delete theme.colors[k];
      }
      const out = renderMarkdownLite('**加粗A1** 与\n- 列表A1\n> 引用A1\n### 标题A1');
      assert.ok(!out.includes('undefined'), 'no "undefined" leaks into output');
      assert.ok(out.includes(rgb('#E5C07B')), 'mdBold fallback used');
      assert.ok(out.includes(rgb('#61AFEF')), 'mdBullet/mdH3 fallback used');
      assert.ok(out.includes(rgb('#7F9CB3')), 'mdQuote fallback used');
    } finally {
      theme.colors = saved;
    }
  });

  test('render cache is invalidated on theme switch (no stale colors)', () => {
    const src = '**缓存检查B2**';
    const first = renderMarkdownLite(src);
    assert.ok(first.includes(rgb('#E5C07B')), 'default mdBold color first');
    try {
      assert.ok(themeRegistry.setTheme('mono'), 'switch to mono');
      const second = renderMarkdownLite(src);
      assert.ok(second.includes(rgb('#DDDDDD')), 'mono mdBold color after switch');
      assert.ok(!second.includes(rgb('#E5C07B')), 'no stale default color served');
    } finally {
      themeRegistry.setTheme('default');
    }
  });

  test('streamMdCache key includes theme name (no stale LIVE colors after switch)', () => {
    clearStreamMdCache();
    // rawFn stamps the active theme so a stale cache hit is directly observable.
    const rawFn = (t) => `${themeRegistry.getActiveName()}:${t}`;
    const first = renderCached('live-seg-E6', 80, rawFn);
    assert.equal(first, 'default:live-seg-E6', 'first render under default theme');
    try {
      assert.ok(themeRegistry.setTheme('mono'), 'switch to mono');
      const second = renderCached('live-seg-E6', 80, rawFn);
      assert.equal(second, 'mono:live-seg-E6', 'theme switch misses the old-theme entry');
    } finally {
      themeRegistry.setTheme('default');
      clearStreamMdCache();
    }
  });
});
