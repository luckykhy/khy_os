'use strict';

/**
 * markdownStreaming.test.js — stream-safe live markdown render (node:test).
 *
 * Goal "流式渲染卡顿与格式闪烁": the LIVE region used to print raw text while the
 * committed transcript rendered markdown, so every code block / heading / list
 * JUMPED from bare syntax to a styled box at the commit boundary, and an
 * unclosed code block showed bare ``` until it closed ("先错乱后修正").
 *
 * renderMarkdownStreaming fixes the loud case by closing a dangling ```-fence
 * before rendering, so an in-progress block already shows as a code box; and it
 * renders identically to renderMarkdownLite once the fence closes, so the
 * live→committed handoff no longer jumps. These cases pin both properties plus
 * prefix-stability for plain prose (no jank for non-markdown text).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { renderMarkdownLite, renderMarkdownStreaming } = require('../../src/cli/markdownRenderer');

// Box-drawing chars the code-block renderer emits (see _renderMarkdownLiteInner).
const hasCodeBox = (s) => s.includes('╭') && s.includes('│') && s.includes('╰');

describe('renderMarkdownStreaming — graceful in-progress code block', () => {
  test('an UNCLOSED fence already renders as a code box (not bare backticks)', () => {
    const live = renderMarkdownStreaming('Here is code:\n```python\nprint("hi")');
    assert.ok(hasCodeBox(live), 'unclosed block should show a code box');
    assert.ok(!live.includes('```'), 'raw triple-backtick must not leak to the user');
  });

  test('a fence opened but not yet given a newline renders an (empty) code box', () => {
    const live = renderMarkdownStreaming('```js');
    assert.ok(hasCodeBox(live), 'half-typed opening fence should still box');
    assert.ok(!live.includes('```'));
  });

  test('once the fence CLOSES, output equals renderMarkdownLite (no jump at commit)', () => {
    const full = 'Here is code:\n```python\nprint("hi")\n```\n';
    assert.equal(renderMarkdownStreaming(full), renderMarkdownLite(full));
  });

  test('balanced fences are untouched (delegates straight to renderMarkdownLite)', () => {
    const closed = '```bash\nls -la\n```';
    assert.equal(renderMarkdownStreaming(closed), renderMarkdownLite(closed));
  });
});

describe('renderMarkdownStreaming — non-code constructs match committed render', () => {
  test('headings / bold / lists render the same live as committed', () => {
    for (const t of ['# Title', '**bold** text', '- item one\n- item two', '1. first\n2. second']) {
      assert.equal(renderMarkdownStreaming(t), renderMarkdownLite(t), `mismatch for: ${t}`);
    }
  });

  test('plain prose renders the same as committed (no markdown noise, prefix-stable)', () => {
    for (const t of ['just a sentence', '为什么程序员分不清节日']) {
      assert.equal(renderMarkdownStreaming(t), renderMarkdownLite(t), `mismatch for: ${t}`);
    }
  });

  test('falsy input is returned verbatim (no throw on empty/null/undefined)', () => {
    assert.equal(renderMarkdownStreaming(''), '');
    assert.equal(renderMarkdownStreaming(null), null);
    assert.equal(renderMarkdownStreaming(undefined), undefined);
  });

  test('inline backticks (odd single-backtick count) are NOT mistaken for a fence', () => {
    // Single backticks must not trigger the ```-fence close path.
    const t = 'use the `npm` command';
    assert.equal(renderMarkdownStreaming(t), renderMarkdownLite(t));
  });
});
