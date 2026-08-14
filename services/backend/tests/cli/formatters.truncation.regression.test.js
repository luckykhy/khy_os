'use strict';

/**
 * formatters.truncation.regression — locks the width-aware truncation behaviour
 * after byte-level `slice(0, n) + '…' / '...'` call-sites were converged onto
 * the shared helpers:
 *  - formatters.truncateToWidth  (CJK/ANSI aware, reserves 3 columns for '...')
 *  - truncateDisplayWidthBudget.truncateWidth (ellipsis counted in the budget)
 *  - aiMonitor trace previews    (no longer over-wide on CJK input)
 *  - repl.formatShellEscapeContext fallback (notice reports overflow chars)
 *
 * Runnable under both jest and `node --test` via the shim (no jest binary here).
 */

const assert = require('assert');

const { truncateToWidth, displayWidth } = require('../../src/cli/formatters');
const { truncateWidth } = require('../../src/cli/truncateDisplayWidthBudget');

/* ── jest-or-node:test shim ─────────────────────────────────────────────── */
let _describe = global.describe;
let _test = global.test || global.it;
let _expect = global.expect;
if (typeof _describe !== 'function' || typeof _expect !== 'function') {
  const nt = require('node:test');
  _describe = nt.describe;
  _test = nt.test;
  _expect = (actual) => ({
    toBe: (e) => assert.strictEqual(actual, e),
    toContain: (e) => assert.ok(String(actual).includes(e), `expected to contain ${e}`),
    toMatch: (re) => assert.ok(re.test(String(actual)), `expected to match ${re}`),
  });
}

/* ── truncateToWidth: CJK/emoji mixed input ─────────────────────────────── */
_describe('truncateToWidth (CJK/emoji regression)', () => {
  const mixed = '宽度感知截断abc😀😀混排字符串测试用例xyz中文字符';

  _test('result display width never exceeds maxWidth', () => {
    for (const w of [4, 10, 20, 40]) {
      const out = truncateToWidth(mixed, w);
      assert.ok(
        displayWidth(out) <= w,
        `width ${displayWidth(out)} exceeds maxWidth ${w} for output ${JSON.stringify(out)}`
      );
    }
  });

  _test('strings that already fit are returned unchanged', () => {
    _expect(truncateToWidth('abc', 80)).toBe('abc');
    _expect(truncateToWidth('中文', 10)).toBe('中文');
  });

  _test('all-CJK input is cut on a character boundary, not a byte budget', () => {
    const cjk = '监'.repeat(100); // width 200
    const out = truncateToWidth(cjk, 20);
    assert.ok(displayWidth(out) <= 20, `width ${displayWidth(out)} > 20`);
    _expect(out).toMatch(/\.\.\.$/);
  });
});

/* ── truncateWidth: budget mode (ellipsis inside the budget) ────────────── */
_describe('truncateWidth budget mode (table cells)', () => {
  const widthOf = (ch) => displayWidth(ch);

  _test('truncated total width <= limit for limit 20/80/120 (all-CJK)', () => {
    const cjk = '中'.repeat(200); // width 400
    for (const limit of [20, 80, 120]) {
      const out = truncateWidth(cjk, limit, widthOf);
      let total = 0;
      for (const ch of Array.from(out)) total += widthOf(ch);
      assert.ok(total <= limit, `total width ${total} exceeds limit ${limit}`);
      _expect(out).toMatch(/\.\.\.$/);
    }
  });

  _test('mixed CJK/ASCII input also stays within the budget', () => {
    const mixed = 'adapter=测试通道 model=中文模型名称超长'.repeat(10);
    for (const limit of [20, 80, 120]) {
      const out = truncateWidth(mixed, limit, widthOf);
      let total = 0;
      for (const ch of Array.from(out)) total += widthOf(ch);
      assert.ok(total <= limit, `total width ${total} exceeds limit ${limit}`);
    }
  });

  _test('input that fits is returned unchanged (no ellipsis)', () => {
    _expect(truncateWidth('短文本', 20, widthOf)).toBe('短文本');
  });
});

/* ── aiMonitor: trace preview truncation via startTrace ─────────────────── */
_describe('aiMonitor truncate (via startTrace)', () => {
  const aiMonitor = require('../../src/services/aiMonitor');

  _test('CJK prompt preview is no longer over-wide after truncation', () => {
    const prompt = '监'.repeat(600); // length 600 > 500 cap, width 1200
    const id = aiMonitor.startTrace({ prompt });
    if (!id) return; // monitor disabled via env — nothing to lock here
    const trace = aiMonitor.getRecent(1)[0];
    const stored = trace.request.prompt;
    _expect(stored).toContain('已截断，共 600 字符');
    const content = stored.replace(/\(已截断，共 \d+ 字符\)$/, '');
    assert.ok(
      displayWidth(content) <= 500,
      `preview width ${displayWidth(content)} exceeds 500`
    );
  });

  _test('short and non-string prompts pass through without throwing', () => {
    assert.doesNotThrow(() => aiMonitor.startTrace({ prompt: null }));
    assert.doesNotThrow(() => aiMonitor.startTrace({ prompt: 12345 }));
    const id = aiMonitor.startTrace({ prompt: '短提示' });
    if (!id) return;
    _expect(aiMonitor.getRecent(1)[0].request.prompt).toBe('短提示');
  });
});

/* ── repl.formatShellEscapeContext: fallback truncation notice ──────────── */
_describe('formatShellEscapeContext fallback truncation notice', () => {
  _test('notice reports the exact overflow character count', () => {
    const prev = process.env.KHY_SHELL_ESCAPE_EXPAND_RECENT;
    process.env.KHY_SHELL_ESCAPE_EXPAND_RECENT = '0'; // force legacy slice path
    try {
      const { formatShellEscapeContext } = require('../../src/cli/repl');
      const body = 'x'.repeat(50);
      // joined = '$ big\n' + body + '\n(exit 0)' → 6 + 50 + 9 = 65 chars
      const out = formatShellEscapeContext([{ command: 'big', body, code: 0 }], 20);
      _expect(out).toContain('shell 输出已截断，超出 45 字符');
    } finally {
      if (prev === undefined) delete process.env.KHY_SHELL_ESCAPE_EXPAND_RECENT;
      else process.env.KHY_SHELL_ESCAPE_EXPAND_RECENT = prev;
    }
  });
});
