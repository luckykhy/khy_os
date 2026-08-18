'use strict';

// scrollbackPreserve 纯叶子单测：所有平台都剥 `\x1b[3J`，保留终端原生回滚缓冲。

const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../../src/cli/tui/scrollbackPreserve');
const {
  isEnabled,
  stripScrollbackClear,
  normalizeClearTerminal,
  createClearTerminalNormalizer,
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

test('exported win32 constants preserve the original byte sequence', () => {
  assert.strictEqual(WIN_CLEAR, WIN32_CLEAR);
  assert.strictEqual(WIN_CLEAR_FIXED, WIN_CLEAR);
});

test('win32: clearTerminal remains byte-identical and never gains 3J', () => {
  assert.strictEqual(normalizeClearTerminal(WIN_CLEAR, {}, 'win32'), WIN_CLEAR);
  assert.strictEqual(normalizeClearTerminal(WIN_CLEAR, {}, 'win32').includes(SCROLLBACK_CLEAR), false);
});

test('win32: a legacy 3J-bearing frame has 3J removed', () => {
  const legacy = `${ESC}[2J${ESC}[3J${ESC}[0f`;
  assert.strictEqual(normalizeClearTerminal(legacy, {}, 'win32'), WIN_CLEAR);
});

test('win32: real fullscreen frame keeps body untouched', () => {
  const body = 'line1\nline2\n[32mgreen[39m\n';
  assert.strictEqual(normalizeClearTerminal(WIN_CLEAR + body, {}, 'win32'), WIN_CLEAR + body);
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
  assert.strictEqual(normalizeClearTerminal(WIN_CLEAR, hostile, 'win32'), WIN_CLEAR);
});

test('stateful win32 normalizer passes split clear sequence through unchanged', () => {
  const n = createClearTerminalNormalizer({}, 'win32');
  assert.strictEqual(n.write(`${ESC}[2`), `${ESC}[2`);
  assert.strictEqual(n.write(`J${ESC}[0fbody`), `J${ESC}[0fbody`);
  assert.strictEqual(n.flush(), '');
});

test('stateful normalizer handles Buffer frames and preserves ordinary bytes', () => {
  const n = createClearTerminalNormalizer({}, 'win32');
  const out = n.write(Buffer.from(`${WIN32_CLEAR}prompt`, 'utf8'));
  assert.ok(Buffer.isBuffer(out));
  assert.strictEqual(out.toString('utf8'), `${WIN_CLEAR}prompt`);
  assert.strictEqual(n.write(Buffer.from('tail', 'utf8')).toString('utf8'), 'tail');
});

test('stateful normalizer gate off is byte-identical', () => {
  const n = createClearTerminalNormalizer({ KHY_PRESERVE_SCROLLBACK: 'off' }, 'win32');
  const frame = Buffer.from(`${WIN32_CLEAR}prompt`, 'utf8');
  const out = n.write(frame);
  assert.strictEqual(out, frame);
  assert.strictEqual(n.flush(), '');
});


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
