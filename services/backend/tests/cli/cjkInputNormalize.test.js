'use strict';

// 对齐 CC「后端逻辑也对齐」:**CJK 全角数字 / 全角空格输入归一**单一真源。
// CC src/utils/stringUtils.ts 的 normalizeFullWidthDigits / normalizeFullWidthSpace 被
// CustomSelect(菜单数字快捷选择)、FeedbackSurvey 数字输入等**数字输入上下文**在解析前
// 调用——因为 CJK-IME 常产出全角数字「０-９」与全角空格 U+3000,直接喂 `\d` / parseInt 会
// 静默失败。Khy 是中文 CLI 却完全缺失此归一(`session show ２` 静默不解析)。本测试验证:
// 门控 KHY_CJK_INPUT_NORMALIZE 开 → 全角归半角后 `\d` 命中;关 → 逐字节回退原样不归一。
const test = require('node:test');
const assert = require('node:assert');

const {
  cjkNormalizeEnabled,
  normalizeFullWidthDigits,
  normalizeFullWidthSpace,
  normalizeNumericInput,
} = require('../../src/cli/cjkInputNormalize');

// ── 移植函数:全角数字 → 半角(偏移 0xFEE0,逐字符)─────────────────────────
test('normalizeFullWidthDigits 全角０-９ → 半角0-9(CC 偏移 0xFEE0)', () => {
  assert.strictEqual(normalizeFullWidthDigits('２'), '2');
  assert.strictEqual(normalizeFullWidthDigits('０１２３４５６７８９'), '0123456789');
  // 混排:仅全角数字被替,其它字符(含中文 / ASCII / #)原样保留。
  assert.strictEqual(normalizeFullWidthDigits('#２'), '#2');
  assert.strictEqual(normalizeFullWidthDigits('第３页'), '第3页');
  assert.strictEqual(normalizeFullWidthDigits('abc12'), 'abc12'); // 无全角 → 原样
  // 边界:CC 是逐字符替换,半角数字与全角字母**不**受影响(只命中 ０-９ 区段)。
  assert.strictEqual(normalizeFullWidthDigits('Ａ'), 'Ａ'); // 全角字母 A 不是数字 → 不动
  // 健壮:非字符串 / 空 → 绝不抛。
  assert.strictEqual(normalizeFullWidthDigits(''), '');
  assert.strictEqual(normalizeFullWidthDigits(null), '');
  assert.strictEqual(normalizeFullWidthDigits(undefined), '');
});

// ── 移植函数:全角空格 U+3000 → 半角空格 ───────────────────────────────────
test('normalizeFullWidthSpace 全角空格 U+3000 → 半角空格', () => {
  assert.strictEqual(normalizeFullWidthSpace('a　b'), 'a b'); // U+3000 居中
  assert.strictEqual(normalizeFullWidthSpace('　'), ' ');
  assert.strictEqual(normalizeFullWidthSpace('a b'), 'a b'); // 已是半角 → 原样
  assert.strictEqual(normalizeFullWidthSpace(null), '');
});

// ── 门控判定 ────────────────────────────────────────────────────────────────
test('cjkNormalizeEnabled 默认开;0/false/off/no → 关', () => {
  assert.strictEqual(cjkNormalizeEnabled({}), true); // 未设 → 开
  assert.strictEqual(cjkNormalizeEnabled({ KHY_CJK_INPUT_NORMALIZE: '1' }), true);
  assert.strictEqual(cjkNormalizeEnabled({ KHY_CJK_INPUT_NORMALIZE: '0' }), false);
  assert.strictEqual(cjkNormalizeEnabled({ KHY_CJK_INPUT_NORMALIZE: 'off' }), false);
  assert.strictEqual(cjkNormalizeEnabled({ KHY_CJK_INPUT_NORMALIZE: 'FALSE' }), false);
  assert.strictEqual(cjkNormalizeEnabled({ KHY_CJK_INPUT_NORMALIZE: 'no' }), false);
});

// ── 门控包装:开→归一(数字解析得救)、关→逐字节回退 ─────────────────────────
test('normalizeNumericInput 门控开 → 归一全角数字+空格,使 \\d 命中', () => {
  const out = normalizeNumericInput('#２', { KHY_CJK_INPUT_NORMALIZE: '1' });
  assert.strictEqual(out, '#2');
  assert.ok(/^#?(\d+)$/.test(out), `归一后应被索引正则命中: ${out}`);
  // 归一前的全角输入直接喂 \d 必然失败(证明缺口真实)。
  assert.ok(!/^#?(\d+)$/.test('#２'), '全角输入未归一时 \\d 不命中(缺口存在)');
  assert.strictEqual(parseInt('２', 10), parseInt('NaN', 10)); // 二者皆 NaN
  assert.ok(Number.isNaN(parseInt('２', 10)), 'parseInt(全角) === NaN(缺口存在)');
  // 全角空格一并归一。
  assert.strictEqual(normalizeNumericInput('a　b', { KHY_CJK_INPUT_NORMALIZE: '1' }), 'a b');
});

test('normalizeNumericInput 门控关 → 原样字节回退(不归一)', () => {
  assert.strictEqual(normalizeNumericInput('#２', { KHY_CJK_INPUT_NORMALIZE: 'off' }), '#２');
  assert.strictEqual(normalizeNumericInput('#２', { KHY_CJK_INPUT_NORMALIZE: '0' }), '#２');
  // 关时连半角输入也只是原样穿过(确认是纯穿透,不做任何替换)。
  assert.strictEqual(normalizeNumericInput('#2', { KHY_CJK_INPUT_NORMALIZE: '0' }), '#2');
});

test('normalizeNumericInput 默认(无显式门控)= 开档(归一)', () => {
  const prev = process.env.KHY_CJK_INPUT_NORMALIZE;
  delete process.env.KHY_CJK_INPUT_NORMALIZE;
  try {
    assert.strictEqual(normalizeNumericInput('５'), '5');
  } finally {
    if (prev === undefined) delete process.env.KHY_CJK_INPUT_NORMALIZE;
    else process.env.KHY_CJK_INPUT_NORMALIZE = prev;
  }
});
