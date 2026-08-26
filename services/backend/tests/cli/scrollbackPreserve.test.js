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
//
// win32 契约(本轮修复):clearTerminal 的 ED2 形式 `2J + 0f` 被改写为等价的
// 「归位 + ED0」`H + J`。视觉终态一致(可视区清空、光标归位),但 ED0 是就地擦除,
// 不会像 conhost / Windows Terminal 的 ED2 那样把旧视口滚进 scrollback 留下重复副本,
// 也不像注入 3J 那样清空用户的原生回滚历史。非 win32 维持「只剥 3J」,逐字节不变。

const WIN32_INPLACE = `${ESC}[H${ESC}[J`;

test('WIN_CLEAR_INPLACE 恰为 ESC[H ESC[J(归位在前、ED0 在后)', () => {
  assert.strictEqual(leaf.WIN_CLEAR_INPLACE, WIN32_INPLACE);
  // 顺序是语义性的:ED0 只擦光标之后,不先归位就擦不干净整屏。
  assert.deepStrictEqual(
    [...leaf.WIN_CLEAR_INPLACE].map((c) => c.charCodeAt(0)),
    [27, 91, 72, 27, 91, 74],
  );
});

test('win32 常量:WIN_CLEAR 是 ink 原序列,WIN_CLEAR_FIXED 是改写目标', () => {
  assert.strictEqual(WIN_CLEAR, WIN32_CLEAR);
  assert.strictEqual(WIN_CLEAR_FIXED, leaf.WIN_CLEAR_INPLACE);
});

test('win32: ED2 清屏被改写为就地擦除,且绝不注入 3J', () => {
  const out = normalizeClearTerminal(WIN_CLEAR, {}, 'win32');
  assert.strictEqual(out, WIN32_INPLACE);
  assert.strictEqual(
    out.includes(SCROLLBACK_CLEAR),
    false,
    '注入 3J 会清空用户原生 scrollback,是被刻意废弃的做法',
  );
  assert.strictEqual(
    out.includes(`${ESC}[2J`),
    false,
    'ED2 必须消失,否则 conhost 仍会把旧视口滚进 scrollback 留下重复副本',
  );
});

test('win32: 历史遗留的含 3J 帧先剥 3J 再改写', () => {
  const legacy = `${ESC}[2J${ESC}[3J${ESC}[0f`;
  assert.strictEqual(normalizeClearTerminal(legacy, {}, 'win32'), WIN32_INPLACE);
});

test('win32: 现代形式 clearTerminal(2J+3J+H)被改写为就地擦除', () => {
  // ink 6.x 用 ansi-escapes@7,其分支条件是 isOldWindows() 而非 platform ——
  // Win10/11 + Windows Terminal 实测走的是这条带 3J 的路径,是现代 Windows 的主路径。
  const modern = `${ESC}[2J${ESC}[3J${ESC}[H`;
  const out = normalizeClearTerminal(modern, {}, 'win32');
  assert.strictEqual(out, WIN32_INPLACE);
  assert.strictEqual(out.includes(SCROLLBACK_CLEAR), false, '不得保留 3J:那会清空原生 scrollback');
  assert.strictEqual(out.includes(`${ESC}[2J`), false, '不得保留 ED2:那会把旧视口滚进 scrollback');
});

test('win32: 已剥掉 3J 的形式(2J+H)同样被改写', () => {
  assert.strictEqual(normalizeClearTerminal(`${ESC}[2J${ESC}[H`, {}, 'win32'), WIN32_INPLACE);
});

test('win32: 现代形式的全屏帧正文逐字节不动', () => {
  const body = `banner\nline2\n${ESC}[36mcyan${ESC}[39m\n`;
  const frame = `${ESC}[2J${ESC}[3J${ESC}[H${body}`;
  assert.strictEqual(normalizeClearTerminal(frame, {}, 'win32'), WIN32_INPLACE + body);
});

test('stateful win32 normalizer: 跨 write 拆开的现代形式仍被完整改写', () => {
  const n = createClearTerminalNormalizer({}, 'win32');
  assert.strictEqual(n.write(`${ESC}[2J${ESC}[3`), '');
  assert.strictEqual(n.write(`J${ESC}[Hbody`), `${WIN32_INPLACE}body`);
  assert.strictEqual(n.flush(), '');
});


test('win32: 全屏帧只换清屏头,正文逐字节不动', () => {
  const body = `line1\nline2\n${ESC}[32mgreen${ESC}[39m\n`;
  assert.strictEqual(
    normalizeClearTerminal(WIN_CLEAR + body, {}, 'win32'),
    WIN32_INPLACE + body,
  );
});

test('win32: 一次 write 内的多次清屏全部改写', () => {
  const s = `${WIN32_CLEAR}a${WIN32_CLEAR}b`;
  assert.strictEqual(
    normalizeClearTerminal(s, {}, 'win32'),
    `${WIN32_INPLACE}a${WIN32_INPLACE}b`,
  );
});

test('win32: 不含 clearTerminal 的普通输出原样返回', () => {
  const s = 'plain windows output\r\nno clear here';
  assert.strictEqual(normalizeClearTerminal(s, {}, 'win32'), s);
});

test('win32: 裸 ED2(不是 clearTerminal 的一部分)不被改写', () => {
  // 只认完整的 `2J + 0f`;其他来源的裸 2J 不属于本叶子的职责范围。
  const s = `${ESC}[2Jsomething-else`;
  assert.strictEqual(normalizeClearTerminal(s, {}, 'win32'), s);
});

test('non-win32: 委托 stripScrollbackClear(只剥 3J),不做 ED0 改写', () => {
  assert.strictEqual(
    normalizeClearTerminal(CLEAR_TERMINAL, {}, 'linux'),
    stripScrollbackClear(CLEAR_TERMINAL, {}),
  );
  // win32 形式的序列出现在 linux 上时保持原样 —— 改写严格限定 win32。
  assert.strictEqual(normalizeClearTerminal(WIN32_CLEAR, {}, 'linux'), WIN32_CLEAR);
});

test('normalizeClearTerminal: gate off 两平台逐字节回退到 ink 原字节', () => {
  for (const v of OFF_VALUES) {
    const env = { KHY_PRESERVE_SCROLLBACK: v };
    assert.strictEqual(normalizeClearTerminal(WIN_CLEAR, env, 'win32'), WIN_CLEAR, `win32 ${v}`);
    assert.strictEqual(
      normalizeClearTerminal(CLEAR_TERMINAL, env, 'linux'),
      CLEAR_TERMINAL,
      `linux ${v}`,
    );
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
  assert.strictEqual(normalizeClearTerminal(WIN_CLEAR, hostile, 'win32'), WIN32_INPLACE);
});

test('stateful win32 normalizer: 跨 write 拆开的清屏序列仍被完整改写', () => {
  const n = createClearTerminalNormalizer({}, 'win32');
  // 前 5 字节是 `2J + 0f` 的真前缀 → 必须暂存;先吐出去就再也无法整体改写。
  assert.strictEqual(n.write(`${ESC}[2`), '');
  assert.strictEqual(n.write(`J${ESC}[0fbody`), `${WIN32_INPLACE}body`);
  assert.strictEqual(n.flush(), '');
});

test('stateful win32 normalizer: flush 归还未闭合尾缀,不吞字节', () => {
  const n = createClearTerminalNormalizer({}, 'win32');
  assert.strictEqual(n.write(`tail${ESC}[2J`), 'tail');
  assert.strictEqual(n.flush(), `${ESC}[2J`);
});

test('stateful normalizer handles Buffer frames and rewrites the clear', () => {
  const n = createClearTerminalNormalizer({}, 'win32');
  const out = n.write(Buffer.from(`${WIN32_CLEAR}prompt`, 'utf8'));
  assert.ok(Buffer.isBuffer(out));
  assert.strictEqual(out.toString('utf8'), `${WIN32_INPLACE}prompt`);
  assert.strictEqual(n.write(Buffer.from('tail', 'utf8')).toString('utf8'), 'tail');
});

test('stateful non-win32 normalizer 不暂存 ED2(只认 3J 前缀)', () => {
  const n = createClearTerminalNormalizer({}, 'linux');
  assert.strictEqual(n.write(`hello${ESC}[2J`), `hello${ESC}[2J`);
  assert.strictEqual(n.flush(), '');
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
