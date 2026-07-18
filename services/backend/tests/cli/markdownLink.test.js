'use strict';

/**
 * markdownLink.test.js — 行内链接展示形态单一真源(node:test)。
 *
 * 对齐 CC `src/utils/markdown.ts` 的 link case 两条刻意规则:
 *   1. mailto: 链接剥 `mailto:` scheme,只显裸邮箱纯文本(不泄 scheme、不埋括号)。
 *   2. 展示文本 === URL(或为空)→ 只显 URL 一次,不自我重复。
 * 其余链接保持 khy 历史的 `text (dim url)` 形态。门控 KHY_MARKDOWN_LINK_DISPLAY
 * 默认开,关 → 一律 text-url 逐字节回退(连 mailto 也回退到泄 scheme 的旧行为)。
 *
 * 既验证纯叶子 planLinkDisplay,又经公共入口 renderMarkdownLite 验证 call-site 接线。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { markdownLinkDisplayEnabled, planLinkDisplay } = require('../../src/cli/markdownLink');
const { renderMarkdownLite } = require('../../src/cli/markdownRenderer');

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// ── 门控梯 ────────────────────────────────────────────────────────────────
describe('markdownLinkDisplayEnabled 门控梯', () => {
  test('默认开·仅 0/false/off/no 关', () => {
    assert.equal(markdownLinkDisplayEnabled({}), true);
    assert.equal(markdownLinkDisplayEnabled({ KHY_MARKDOWN_LINK_DISPLAY: '1' }), true);
    assert.equal(markdownLinkDisplayEnabled({ KHY_MARKDOWN_LINK_DISPLAY: 'yes' }), true);
    for (const off of ['0', 'false', 'off', 'no', 'OFF', 'False']) {
      assert.equal(markdownLinkDisplayEnabled({ KHY_MARKDOWN_LINK_DISPLAY: off }), false, off);
    }
  });
});

// ── 纯叶子 planLinkDisplay ──────────────────────────────────────────────────
describe('planLinkDisplay 决策', () => {
  test('mailto: → 裸邮箱纯文本(剥 scheme,丢弃展示文本=对齐 CC)', () => {
    assert.deepEqual(
      planLinkDisplay('Email', 'mailto:foo@bar.com', {}),
      { kind: 'plain', text: 'foo@bar.com' },
    );
    // scheme 大小写不敏感
    assert.deepEqual(
      planLinkDisplay('x', 'MAILTO:a@b.io', {}),
      { kind: 'plain', text: 'a@b.io' },
    );
  });

  test('text === url → url-only(去自我重复)', () => {
    assert.deepEqual(
      planLinkDisplay('https://x.com', 'https://x.com', {}),
      { kind: 'url-only', url: 'https://x.com' },
    );
  });

  test('空/纯空白展示文本 → url-only(防御性,call-site 正则实际不命中)', () => {
    assert.deepEqual(planLinkDisplay('   ', 'https://x.com', {}), { kind: 'url-only', url: 'https://x.com' });
  });

  test('普通链接 → text-url(历史默认)', () => {
    assert.deepEqual(
      planLinkDisplay('docs', 'https://x.com/docs', {}),
      { kind: 'text-url', text: 'docs', url: 'https://x.com/docs' },
    );
  });

  test('门控关 → 一律 text-url(连 mailto/text===url 也逐字节回退)', () => {
    const off = { KHY_MARKDOWN_LINK_DISPLAY: 'off' };
    assert.deepEqual(
      planLinkDisplay('Email', 'mailto:foo@bar.com', off),
      { kind: 'text-url', text: 'Email', url: 'mailto:foo@bar.com' },
    );
    assert.deepEqual(
      planLinkDisplay('https://x.com', 'https://x.com', off),
      { kind: 'text-url', text: 'https://x.com', url: 'https://x.com' },
    );
  });

  test('防呆:null/undefined 入参不抛', () => {
    assert.deepEqual(planLinkDisplay(null, null, {}), { kind: 'url-only', url: '' });
    assert.deepEqual(planLinkDisplay(undefined, 'mailto:z@z.z', {}), { kind: 'plain', text: 'z@z.z' });
  });
});

// ── 集成:经 renderMarkdownLite(门控默认开)─────────────────────────────────
describe('renderMarkdownLite 链接渲染(默认开)', () => {
  test('mailto 链接显裸邮箱,绝不泄 mailto: scheme', () => {
    const out = strip(renderMarkdownLite('Reach me at [Email](mailto:foo@bar.com).'));
    assert.ok(out.includes('foo@bar.com'), '显裸邮箱');
    assert.ok(!out.includes('mailto:'), '不泄 scheme');
    assert.ok(!/\(mailto:/.test(out), '邮箱不被埋进括号');
  });

  test('text===url 链接只显一次,不重复', () => {
    const out = strip(renderMarkdownLite('See [https://x.com](https://x.com) now.'));
    const occurrences = (out.match(/https:\/\/x\.com/g) || []).length;
    assert.equal(occurrences, 1, 'URL 只出现一次');
    assert.ok(!/https:\/\/x\.com \(https:\/\/x\.com\)/.test(out), '无自我重复');
  });

  test('普通链接仍显 text (url)', () => {
    const out = strip(renderMarkdownLite('Read the [docs](https://x.com/docs) here.'));
    assert.ok(out.includes('docs'), '显文本');
    assert.ok(out.includes('(https://x.com/docs)'), '显 dim 括号 url');
  });
});

// ── 集成:门控关逐字节回退 ──────────────────────────────────────────────────
describe('renderMarkdownLite 链接渲染(门控关)', () => {
  test('mailto 回退到泄 scheme 的历史形态', () => {
    const prev = process.env.KHY_MARKDOWN_LINK_DISPLAY;
    process.env.KHY_MARKDOWN_LINK_DISPLAY = 'off';
    try {
      const out = strip(renderMarkdownLite('[Email](mailto:foo@bar.com)'));
      assert.ok(out.includes('Email'), '历史:显展示文本');
      assert.ok(out.includes('(mailto:foo@bar.com)'), '历史:括号内含 scheme');
    } finally {
      if (prev == null) delete process.env.KHY_MARKDOWN_LINK_DISPLAY;
      else process.env.KHY_MARKDOWN_LINK_DISPLAY = prev;
    }
  });
});
