'use strict';

// 离线确定性单测:scrollbackPreserve 纯叶子(在 ink stdout 边界按平台规范化 clearTerminal:
// 非 win32 剥 `\x1b[3J` 保全 scrollback;win32 注入 `\x1b[3J` 消除重复 transcript 副本)。
// 零 IO、零网络、可 CI 复跑。覆盖:门控默认开 + 四 falsy 关;stripScrollbackClear 剥 `3J`
// (单/多/真帧串/无 3J/win32 无 3J);normalizeClearTerminal 平台对称(win32 注入 + 幂等 +
// 真帧 + 普通串;非 win32 委托剥离);门控关两平台逐字节回退;非字符串透传;常量字节正确。
//
// 运行: node --test services/backend/tests/cli/scrollbackPreserve.test.js

const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../../src/cli/tui/scrollbackPreserve');
const {
  isEnabled,
  stripScrollbackClear,
  normalizeClearTerminal,
  SCROLLBACK_CLEAR,
  OFF_VALUES,
  WIN_CLEAR,
  WIN_CLEAR_FIXED,
} = leaf;

const ESC = '';
const CLEAR_TERMINAL = `${ESC}[2J${ESC}[3J${ESC}[H`; // 非 win32 ink clearTerminal
const WIN32_CLEAR = `${ESC}[2J${ESC}[0f`;            // win32 ink clearTerminal(无 3J)

// ── 常量 ──────────────────────────────────────────────────────────────────────

test('SCROLLBACK_CLEAR is exactly ESC[3J', () => {
  assert.strictEqual(SCROLLBACK_CLEAR, `${ESC}[3J`);
  assert.deepStrictEqual([...SCROLLBACK_CLEAR].map((c) => c.charCodeAt(0)), [27, 91, 51, 74]);
});

// ── isEnabled ─────────────────────────────────────────────────────────────────

test('isEnabled defaults on (unset / empty / "1")', () => {
  assert.strictEqual(isEnabled({}), true);
  assert.strictEqual(isEnabled({ KHY_PRESERVE_SCROLLBACK: '' }), true);
  assert.strictEqual(isEnabled({ KHY_PRESERVE_SCROLLBACK: '1' }), true);
  assert.strictEqual(isEnabled({ KHY_PRESERVE_SCROLLBACK: 'on' }), true);
});

test('isEnabled off for the four falsy values (case-insensitive)', () => {
  for (const v of OFF_VALUES) {
    assert.strictEqual(isEnabled({ KHY_PRESERVE_SCROLLBACK: v }), false, v);
    assert.strictEqual(isEnabled({ KHY_PRESERVE_SCROLLBACK: v.toUpperCase() }), false, v);
  }
  assert.strictEqual(isEnabled({ KHY_PRESERVE_SCROLLBACK: ' Off ' }), false); // trimmed
});

// ── stripScrollbackClear: gate on ─────────────────────────────────────────────

test('gate on: clearTerminal frame loses 3J, keeps 2J and H', () => {
  assert.strictEqual(stripScrollbackClear(CLEAR_TERMINAL, {}), `${ESC}[2J${ESC}[H`);
});

test('gate on: real fullscreen frame strips only 3J, body untouched', () => {
  const body = 'line1\nline2\n[32mgreen[39m\n';
  const frame = CLEAR_TERMINAL + body;
  assert.strictEqual(stripScrollbackClear(frame, {}), `${ESC}[2J${ESC}[H` + body);
});

test('gate on: multiple 3J occurrences all stripped', () => {
  const s = `${ESC}[3Jaaa${ESC}[3Jbbb${ESC}[3J`;
  assert.strictEqual(stripScrollbackClear(s, {}), 'aaabbb');
});

test('gate on: string without 3J returned unchanged', () => {
  const s = `${ESC}[2Jhello\nworld`;
  assert.strictEqual(stripScrollbackClear(s, {}), s);
});

test('gate on: win32 clearTerminal (no 3J) passes through stripScrollbackClear unchanged', () => {
  // stripScrollbackClear is the non-win32 arm: it only removes 3J, so a win32
  // clearTerminal (which has none) is a no-op through it.
  assert.strictEqual(stripScrollbackClear(WIN32_CLEAR, {}), WIN32_CLEAR);
});

// ── normalizeClearTerminal: platform-aware dispatch ───────────────────────────

test('exported win32 constants are the expected byte sequences', () => {
  assert.strictEqual(WIN_CLEAR, WIN32_CLEAR); // ESC[2J ESC[0f
  assert.strictEqual(WIN_CLEAR_FIXED, `${ESC}[2J${ESC}[3J${ESC}[0f`); // 3J injected
  // The fixed form must NOT contain the bare WIN_CLEAR token → injection is idempotent.
  assert.strictEqual(WIN_CLEAR_FIXED.indexOf(WIN_CLEAR), -1);
});

test('win32: clearTerminal gets 3J injected (purges duplicate scrollback copies)', () => {
  assert.strictEqual(normalizeClearTerminal(WIN_CLEAR, {}, 'win32'), WIN_CLEAR_FIXED);
});

test('win32: injection is idempotent (already-fixed frame unchanged)', () => {
  assert.strictEqual(normalizeClearTerminal(WIN_CLEAR_FIXED, {}, 'win32'), WIN_CLEAR_FIXED);
});

test('win32: real fullscreen frame injects 3J, body untouched', () => {
  const body = 'line1\nline2\n[32mgreen[39m\n';
  assert.strictEqual(normalizeClearTerminal(WIN_CLEAR + body, {}, 'win32'), WIN_CLEAR_FIXED + body);
});

test('win32: string without clearTerminal returned unchanged', () => {
  const s = 'plain windows output\r\nno clear here';
  assert.strictEqual(normalizeClearTerminal(s, {}, 'win32'), s);
});

test('non-win32: delegates to stripScrollbackClear (strips 3J)', () => {
  assert.strictEqual(
    normalizeClearTerminal(CLEAR_TERMINAL, {}, 'linux'),
    stripScrollbackClear(CLEAR_TERMINAL, {}),
  );
  // and never injects on non-win32
  assert.strictEqual(normalizeClearTerminal(WIN32_CLEAR, {}, 'linux'), WIN32_CLEAR);
});

test('normalizeClearTerminal: gate off is byte-identical on both platforms', () => {
  for (const v of OFF_VALUES) {
    const env = { KHY_PRESERVE_SCROLLBACK: v };
    assert.strictEqual(normalizeClearTerminal(WIN_CLEAR, env, 'win32'), WIN_CLEAR, `win32 ${v}`);
    assert.strictEqual(normalizeClearTerminal(CLEAR_TERMINAL, env, 'linux'), CLEAR_TERMINAL, `linux ${v}`);
  }
});

test('normalizeClearTerminal: non-string chunks pass through on win32', () => {
  const buf = Buffer.from('x');
  assert.strictEqual(normalizeClearTerminal(buf, {}, 'win32'), buf);
  assert.strictEqual(normalizeClearTerminal(undefined, {}, 'win32'), undefined);
  assert.strictEqual(normalizeClearTerminal(null, {}, 'win32'), null);
  assert.strictEqual(normalizeClearTerminal(42, {}, 'win32'), 42);
});

test('normalizeClearTerminal: does not throw on hostile env (win32 arm)', () => {
  const hostile = Object.create(null);
  assert.doesNotThrow(() => normalizeClearTerminal(WIN_CLEAR, hostile, 'win32'));
  assert.strictEqual(normalizeClearTerminal(WIN_CLEAR, hostile, 'win32'), WIN_CLEAR_FIXED);
});

// ── stripScrollbackClear: gate off (byte-identical fallback) ───────────────────

test('gate off: 3J-bearing frame returned byte-identical', () => {
  for (const v of OFF_VALUES) {
    assert.strictEqual(
      stripScrollbackClear(CLEAR_TERMINAL, { KHY_PRESERVE_SCROLLBACK: v }),
      CLEAR_TERMINAL,
      v,
    );
  }
});

// ── non-string passthrough ────────────────────────────────────────────────────

test('non-string chunks pass through unchanged', () => {
  const buf = Buffer.from(`${ESC}[3Jx`);
  assert.strictEqual(stripScrollbackClear(buf, {}), buf); // Buffer identity preserved
  assert.strictEqual(stripScrollbackClear(undefined, {}), undefined);
  assert.strictEqual(stripScrollbackClear(null, {}), null);
  assert.strictEqual(stripScrollbackClear(42, {}), 42);
});

// ── never throws ──────────────────────────────────────────────────────────────

test('does not throw on hostile env (null prototype, throwing getter)', () => {
  const hostile = Object.create(null);
  assert.doesNotThrow(() => stripScrollbackClear(CLEAR_TERMINAL, hostile));
  assert.strictEqual(stripScrollbackClear(CLEAR_TERMINAL, hostile), `${ESC}[2J${ESC}[H`);
});
