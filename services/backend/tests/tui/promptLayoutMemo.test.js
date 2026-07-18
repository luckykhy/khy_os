'use strict';

/**
 * promptLayoutMemo — guard tests for memoizing PromptFrame's per-render input
 * re-wrap (goal「khy 输入/动画体验卡顿,无法做真正的软件项目」).
 *
 * PromptFrame re-renders on EVERY App state change (keystroke, 1s busy nowTick,
 * hint/footer timers) and unconditionally re-wraps the whole buffer via
 * layoutPromptRows (O(len) string-width). A React.useMemo keyed on the pure
 * inputs {value,offset,cols,placeholder,maxRows} makes the re-wrap skip when the
 * input is unchanged. Byte-safety rests on layoutPromptRows being a pure function.
 *
 * Invariants:
 *   ① gate KHY_PROMPT_LAYOUT_MEMO default ON; 0/false/off/no → OFF (byte-revert)
 *   ② layoutPromptRows is PURE: identical inputs → deep-identical rows (this is
 *      exactly what makes memoization byte-safe — the memo can never diverge)
 *   ③ different inputs → the memo would recompute (rows actually differ)
 *   ④ LIVE wiring: PromptFrame requires promptLayoutMemo + calls
 *      isPromptLayoutMemoEnabled; useMemo keyed on the five inputs; gate-off
 *      branch recomputes directly (byte-revert); flag registered
 *
 * node:test (jest via rtk proxy is unavailable — Exec format error).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const memo = require('../../src/cli/tui/ink-components/promptLayoutMemo');
const PromptFrame = require('../../src/cli/tui/ink-components/PromptFrame');
const layoutPromptRows = PromptFrame.layoutPromptRows;
const BACKEND_ROOT = path.resolve(__dirname, '../../');

// ── ① gate default ON; falsy words → OFF ──────────────────────────────────
test('KHY_PROMPT_LAYOUT_MEMO defaults ON, reverts on falsy words', () => {
  assert.strictEqual(memo.isPromptLayoutMemoEnabled({}), true);
  assert.strictEqual(memo.isPromptLayoutMemoEnabled({ KHY_PROMPT_LAYOUT_MEMO: undefined }), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(memo.isPromptLayoutMemoEnabled({ KHY_PROMPT_LAYOUT_MEMO: off }), false, `'${off}'`);
  }
  assert.strictEqual(memo.isPromptLayoutMemoEnabled({ KHY_PROMPT_LAYOUT_MEMO: '1' }), true);
});

// ── ② purity: identical inputs → deep-identical rows (memo is byte-safe) ──
test('layoutPromptRows is pure: same inputs → deep-identical output', () => {
  const inputs = [
    { value: 'hello world', offset: 3, cols: 40, placeholder: '', maxRows: 8 },
    { value: '你好世界 mixed CJK 输入内容 wrapping across the width', offset: 5, cols: 20, placeholder: '', maxRows: 6 },
    { value: '', offset: 0, cols: 80, placeholder: '输入…', maxRows: 4 },
    { value: 'line one\nline two\nline three', offset: 12, cols: 30, placeholder: '', maxRows: 10 },
    { value: 'x'.repeat(4000), offset: 2000, cols: 60, placeholder: '', maxRows: 12 }, // multi-KB paste
  ];
  for (const inp of inputs) {
    const a = layoutPromptRows({ ...inp });
    const b = layoutPromptRows({ ...inp });
    assert.deepStrictEqual(a, b, `pure for ${JSON.stringify(inp).slice(0, 40)}`);
  }
});

// ── ③ different inputs → rows actually differ (memo would recompute) ───────
test('changing value/offset/cols changes the rows (memo dep sensitivity)', () => {
  const base = { value: 'abc def ghi', offset: 4, cols: 40, placeholder: '', maxRows: 8 };
  const r0 = JSON.stringify(layoutPromptRows({ ...base }));
  const rVal = JSON.stringify(layoutPromptRows({ ...base, value: 'abc def ghij' }));
  const rOff = JSON.stringify(layoutPromptRows({ ...base, offset: 0 }));
  const rCols = JSON.stringify(layoutPromptRows({ ...base, cols: 6 }));
  assert.notStrictEqual(r0, rVal, 'value change must alter rows');
  assert.notStrictEqual(r0, rOff, 'offset change must alter rows (caret)');
  assert.notStrictEqual(r0, rCols, 'cols change must alter wrapping');
});

// ── ④ LIVE wiring guards ──────────────────────────────────────────────────
test('PromptFrame wires promptLayoutMemo with keyed useMemo + byte-revert branch', () => {
  const src = fs.readFileSync(
    path.join(BACKEND_ROOT, 'src/cli/tui/ink-components/PromptFrame.js'), 'utf8');
  assert.ok(/require\(['"]\.\/promptLayoutMemo['"]\)/.test(src),
    'PromptFrame must require ./promptLayoutMemo');
  assert.ok(/isPromptLayoutMemoEnabled\(process\.env\)/.test(src),
    'PromptFrame must read the gate');
  assert.ok(/React\.useMemo\(\s*\n?\s*\(\) => layoutPromptRows\(/.test(src),
    'must memoize layoutPromptRows via React.useMemo');
  assert.ok(/\[value, offset, cols, placeholder, maxRows\]/.test(src),
    'useMemo must be keyed on the five pure inputs');
  // gate-off branch must recompute directly (byte-revert to today's behavior)
  assert.ok(/_layoutMemoOn[\s\S]{0,80}layoutPromptRows\(\{ value, offset, cols, placeholder, maxRows \}\)/.test(src),
    'gate-off branch must call layoutPromptRows directly');
});

test('flagRegistry registers KHY_PROMPT_LAYOUT_MEMO default ON', () => {
  const reg = require('../../src/services/flagRegistry');
  assert.strictEqual(reg.isFlagEnabled('KHY_PROMPT_LAYOUT_MEMO', {}), true);
  assert.strictEqual(reg.isFlagEnabled('KHY_PROMPT_LAYOUT_MEMO', { KHY_PROMPT_LAYOUT_MEMO: 'off' }), false);
});
