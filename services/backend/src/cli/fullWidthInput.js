'use strict';

// 对齐 CC「后端逻辑也对齐」:TUI 选择菜单的**全角(zenkaku/CJK IME)输入折半角**单一真源。
//
// CC 源 src/utils/stringUtils.ts::normalizeFullWidthDigits / normalizeFullWidthSpace,
// 在 src/components/CustomSelect/use-select-input.ts(:174 数字跳选项、:244 空格切换多选)
// 与 use-multi-select-state.ts 里:**先把全角数字/空格折成半角再做「跳选项 / 切换」判定**,
// 使 CJK 输入法用户键入全角 `１`(U+FF11)能跳到第 1 项、全角空格(U+3000)能切换多选项。
//
// 真缺口:Khy 五个 TUI 选择组件(QuestionPrompt/PermissionsPrompt/FormFlow/RewindPicker/
// ModelPicker)的「数字跳选项」一律用 ASCII-only `ch >= '1' && ch <= '9'` + `parseInt(ch,10)`、
// 「空格切换」用 `ch === ' '`,全角字符全部落空 → 对一个中文优先的产品尤其不应该。
//
// 本叶子把「折半角」收敛成单一真源 + 门控感知封装:门控开 = CC 折半角后判定;
// 门控关 = 原样返回(call-site 的 ASCII-only 判定 → 与历史逐字节一致)。只折「跳选项 /
// 切换」这一决策输入,绝不改任何**自由文本捕获**(那里仍用原始 ch 字面输入,含全角字符)。

const FALSY = new Set(['0', 'false', 'off', 'no']);

function fullWidthInputEnabled(env = process.env) {
  const flag = String((env && env.KHY_FULLWIDTH_INPUT) || '').trim().toLowerCase();
  return !FALSY.has(flag);
}

// CC 逐字节移植:全角数字 ０-９(U+FF10..U+FF19)→ 半角 0-9,偏移恒 0xFEE0。
function normalizeFullWidthDigits(input) {
  return String(input == null ? '' : input).replace(
    /[０-９]/g,
    (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0),
  );
}

// CC 逐字节移植:全角空格 U+3000 → 半角空格 U+0020。
function normalizeFullWidthSpace(input) {
  return String(input == null ? '' : input).replace(/　/g, ' ');
}

// 门控感知封装(call-site 直接调):门控关 → 原样返回(逐字节回退);门控开 → 折半角。
function foldDigits(input, env = process.env) {
  if (!fullWidthInputEnabled(env)) return input;
  return normalizeFullWidthDigits(input);
}

function foldSpace(input, env = process.env) {
  if (!fullWidthInputEnabled(env)) return input;
  return normalizeFullWidthSpace(input);
}

module.exports = {
  fullWidthInputEnabled,
  normalizeFullWidthDigits,
  normalizeFullWidthSpace,
  foldDigits,
  foldSpace,
};
