'use strict';

// 对齐 CC「后端逻辑也对齐」:TUI 选择菜单接受全角(zenkaku/CJK IME)数字 + 空格输入
// (CC src/utils/stringUtils.ts normalizeFullWidthDigits/normalizeFullWidthSpace,
//  用于 src/components/CustomSelect/use-select-input.ts 的数字跳选项 / 空格切换)。
// 钉住:门控开 = 折半角后判定(全角 `１`→`1`、全角空格→半角空格);门控关 = 原样返回
// (call-site 的 ASCII-only 判定 → 与历史逐字节一致)。
const test = require('node:test');
const assert = require('node:assert');

const {
  fullWidthInputEnabled,
  normalizeFullWidthDigits,
  normalizeFullWidthSpace,
  foldDigits,
  foldSpace,
} = require('../../src/cli/fullWidthInput');

const ON = { KHY_FULLWIDTH_INPUT: '1' };
const OFF = { KHY_FULLWIDTH_INPUT: 'off' };

const FW_ONE = '１';   // 全角 １
const FW_NINE = '９';  // 全角 ９
const FW_ZERO = '０';  // 全角 ０
const FW_SPACE = '　'; // 全角空格

// ── 门控梯 ─────────────────────────────────────────────────────────────────────
test('fullWidthInputEnabled:默认开,仅 0/false/off/no 关', () => {
  assert.strictEqual(fullWidthInputEnabled({}), true);
  assert.strictEqual(fullWidthInputEnabled(undefined), true);
  for (const v of ['0', 'false', 'off', 'no', ' OFF ', 'No']) {
    assert.strictEqual(fullWidthInputEnabled({ KHY_FULLWIDTH_INPUT: v }), false, v);
  }
  for (const v of ['1', 'true', 'on', 'yes', 'whatever']) {
    assert.strictEqual(fullWidthInputEnabled({ KHY_FULLWIDTH_INPUT: v }), true, v);
  }
});

// ── 纯函数移植(对齐 CC,与门控无关)──────────────────────────────────────────────
test('normalizeFullWidthDigits:全角 ０-９ → 半角 0-9(CC 逐字节)', () => {
  assert.strictEqual(normalizeFullWidthDigits('０１２３４５６７８９'), '0123456789');
  assert.strictEqual(normalizeFullWidthDigits('0123'), '0123');      // 半角不变
  assert.strictEqual(normalizeFullWidthDigits(FW_ONE), '1');
  assert.strictEqual(normalizeFullWidthDigits('选第' + FW_ONE + '项'), '选第1项'); // 仅替换数字
});

test('normalizeFullWidthSpace:全角空格 U+3000 → 半角空格(CC 逐字节)', () => {
  assert.strictEqual(normalizeFullWidthSpace(FW_SPACE), ' ');
  assert.strictEqual(normalizeFullWidthSpace(' '), ' ');   // 半角不变
  assert.strictEqual(normalizeFullWidthSpace('a' + FW_SPACE + 'b'), 'a b');
});

test('防呆:null/undefined/非串不抛,返空串', () => {
  for (const fn of [normalizeFullWidthDigits, normalizeFullWidthSpace]) {
    assert.strictEqual(fn(null), '');
    assert.strictEqual(fn(undefined), '');
    assert.doesNotThrow(() => fn(123));
  }
});

// ── foldDigits / foldSpace:门控感知封装 ─────────────────────────────────────────
test('门控开:foldDigits 折全角数字 → call-site 的 ASCII 判定命中', () => {
  const navCh = foldDigits(FW_ONE, ON);
  assert.strictEqual(navCh, '1');
  assert.ok(navCh >= '1' && navCh <= '9');          // call-site 判定通过
  assert.strictEqual(parseInt(navCh, 10) - 1, 0);    // 跳到第 1 项(index 0)
  assert.strictEqual(foldDigits(FW_NINE, ON), '9');
  assert.strictEqual(foldDigits('5', ON), '5');      // ASCII 不变
});

test('门控开:foldSpace 折全角空格 → call-site `=== \" \"` 命中', () => {
  assert.strictEqual(foldSpace(FW_SPACE, ON), ' ');
  assert.strictEqual(foldSpace(' ', ON), ' ');       // ASCII 不变
});

test('门控关:foldDigits/foldSpace 原样返回(逐字节回退 = 历史 ASCII-only 行为)', () => {
  // 全角输入门控关 → 原样返回 → call-site 的 `ch>='1'&&ch<='9'` / `ch===' '` 落空(同历史)。
  assert.strictEqual(foldDigits(FW_ONE, OFF), FW_ONE);
  assert.ok(!(FW_ONE >= '1' && FW_ONE <= '9'));      // 历史:全角数字落空
  assert.strictEqual(foldSpace(FW_SPACE, OFF), FW_SPACE);
  assert.notStrictEqual(FW_SPACE, ' ');              // 历史:全角空格落空
  // ASCII 输入门控开/关都一致。
  assert.strictEqual(foldDigits('3', OFF), '3');
  assert.strictEqual(foldSpace(' ', OFF), ' ');
});

test('门控开/关唯一分歧点 = 全角输入;ASCII 两态逐字节一致', () => {
  for (const ascii of ['1', '5', '9', '0', ' ', 'a']) {
    assert.strictEqual(foldDigits(ascii, ON), foldDigits(ascii, OFF), ascii);
    assert.strictEqual(foldSpace(ascii, ON), foldSpace(ascii, OFF), ascii);
  }
  assert.notStrictEqual(foldDigits(FW_ONE, ON), foldDigits(FW_ONE, OFF));
  assert.notStrictEqual(foldSpace(FW_SPACE, ON), foldSpace(FW_SPACE, OFF));
});

test('全角 ０(zero)折半角后仍 < "1" → 不跳选项(与 ASCII 0 同口径)', () => {
  const navCh = foldDigits(FW_ZERO, ON);
  assert.strictEqual(navCh, '0');
  assert.ok(!(navCh >= '1' && navCh <= '9'));        // index 0..8 才有效,'0' 不跳
});

// ── 默认 env(无显式门控)= 开档 ───────────────────────────────────────────────
test('默认 process.env(无 KHY_FULLWIDTH_INPUT)= 开档折半角', () => {
  const saved = process.env.KHY_FULLWIDTH_INPUT;
  delete process.env.KHY_FULLWIDTH_INPUT;
  try {
    assert.strictEqual(foldDigits(FW_ONE), '1');
    assert.strictEqual(foldSpace(FW_SPACE), ' ');
  } finally {
    if (saved !== undefined) process.env.KHY_FULLWIDTH_INPUT = saved;
  }
});
