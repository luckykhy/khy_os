'use strict';

// 对齐 CC「后端逻辑也对齐」:编辑结果摘要行 "Added N lines, removed M lines" 的**构造逻辑**
// (CC src/components/FileEditToolUpdatedMessage.tsx)。核心后端逻辑 = CC 的句首/句中大小写规则
//   {numAdditions === 0 ? 'R' : 'r'}emoved <M> line(s)
// —— 纯删除编辑(additions === 0)句首 "Removed" 首字母大写;跟在 "Added …" 之后保持小写。
// Khy 三处 call-site(toolDisplay/diffRenderer/ToolLines)历史 copy-paste 同一份**恒小写**构造,
// 本测试钉住:门控开 = CC 大小写规则;门控关 = 逐字节回退恒小写 legacy。
const test = require('node:test');
const assert = require('node:assert');

const { buildEditStatLine, editStatLineEnabled } = require('../../src/cli/editStatLine');

const ON = { KHY_EDIT_STAT_LINE: '1' };
const OFF = { KHY_EDIT_STAT_LINE: 'off' };

// ── 门控梯 ─────────────────────────────────────────────────────────────────────
test('editStatLineEnabled:默认开,仅 0/false/off/no 关', () => {
  assert.strictEqual(editStatLineEnabled({}), true);
  assert.strictEqual(editStatLineEnabled(undefined), true);
  for (const v of ['0', 'false', 'off', 'no', ' OFF ', 'No']) {
    assert.strictEqual(editStatLineEnabled({ KHY_EDIT_STAT_LINE: v }), false, v);
  }
  for (const v of ['1', 'true', 'on', 'yes', 'whatever']) {
    assert.strictEqual(editStatLineEnabled({ KHY_EDIT_STAT_LINE: v }), true, v);
  }
});

// ── 门控开:CC 句首大小写规则 ──────────────────────────────────────────────────
test('门控开:纯新增 → "Added N line(s)"(无删除段)', () => {
  assert.strictEqual(buildEditStatLine(3, 0, ON), 'Added 3 lines');
  assert.strictEqual(buildEditStatLine(1, 0, ON), 'Added 1 line'); // 单数
});

test('门控开:纯删除(additions===0)→ 句首 "Removed" 大写(CC 关键规则)', () => {
  assert.strictEqual(buildEditStatLine(0, 3, ON), 'Removed 3 lines');
  assert.strictEqual(buildEditStatLine(0, 1, ON), 'Removed 1 line'); // 单数 + 大写
});

test('门控开:新增+删除 → "Added …, removed …"(句中删除保持小写)', () => {
  assert.strictEqual(buildEditStatLine(3, 2, ON), 'Added 3 lines, removed 2 lines');
  assert.strictEqual(buildEditStatLine(1, 1, ON), 'Added 1 line, removed 1 line'); // 双单数
});

test('两者皆 0 → 空串(call-site 据此不渲染该行)', () => {
  assert.strictEqual(buildEditStatLine(0, 0, ON), '');
  assert.strictEqual(buildEditStatLine(0, 0, OFF), '');
});

// ── 门控关:逐字节回退恒小写 legacy(三处 call-site 改动前行为)──────────────────
test('门控关:纯删除也恒小写 "removed"(与历史三份 copy-paste 一致)', () => {
  assert.strictEqual(buildEditStatLine(0, 3, OFF), 'removed 3 lines');
  assert.strictEqual(buildEditStatLine(0, 1, OFF), 'removed 1 line');
});

test('门控关:新增段与新增+删除段与门控开一致(仅纯删除大小写有别)', () => {
  assert.strictEqual(buildEditStatLine(3, 0, OFF), 'Added 3 lines');
  assert.strictEqual(buildEditStatLine(3, 2, OFF), 'Added 3 lines, removed 2 lines');
});

test('门控开/关唯一分歧点 = 纯删除句首大小写', () => {
  // 纯删除:开="Removed" 关="removed"
  assert.notStrictEqual(buildEditStatLine(0, 5, ON), buildEditStatLine(0, 5, OFF));
  assert.strictEqual(buildEditStatLine(0, 5, ON), 'Removed 5 lines');
  assert.strictEqual(buildEditStatLine(0, 5, OFF), 'removed 5 lines');
  // 其余取值域两态逐字节一致
  assert.strictEqual(buildEditStatLine(4, 0, ON), buildEditStatLine(4, 0, OFF));
  assert.strictEqual(buildEditStatLine(4, 6, ON), buildEditStatLine(4, 6, OFF));
});

// ── 复数判定:legacy `!== 1` 与 CC `> 1` 在 n>0 域内等价 ────────────────────────
test('复数:n=1 单数 / n>=2 复数(开关同口径)', () => {
  for (const env of [ON, OFF]) {
    assert.ok(buildEditStatLine(1, 0, env).endsWith('1 line'));   // 不带 s
    assert.ok(buildEditStatLine(2, 0, env).endsWith('2 lines'));  // 带 s
    assert.ok(buildEditStatLine(0, 1, env).endsWith('1 line'));
    assert.ok(buildEditStatLine(0, 2, env).endsWith('2 lines'));
  }
});

// ── 防呆:非法/负/小数/缺省入参不抛且与 legacy 守卫等价 ───────────────────────
test('防呆:负数 / 非有限 / undefined → 当作 0(不渲染对应段),绝不抛', () => {
  assert.strictEqual(buildEditStatLine(-5, 3, ON), 'Removed 3 lines');   // added<=0 视为 0 → 纯删除句首大写
  assert.strictEqual(buildEditStatLine(undefined, undefined, ON), '');
  assert.strictEqual(buildEditStatLine(NaN, 2, ON), 'Removed 2 lines');
  assert.strictEqual(buildEditStatLine(2.9, 0, ON), 'Added 2 lines');    // floor
  assert.doesNotThrow(() => buildEditStatLine('x', 'y', ON));
  assert.strictEqual(buildEditStatLine('x', 'y', ON), '');
});

// ── 默认 env(无显式门控)= 开档 ───────────────────────────────────────────────
test('默认 process.env(无 KHY_EDIT_STAT_LINE)= 开档大小写', () => {
  const saved = process.env.KHY_EDIT_STAT_LINE;
  delete process.env.KHY_EDIT_STAT_LINE;
  try {
    assert.strictEqual(buildEditStatLine(0, 2), 'Removed 2 lines');
  } finally {
    if (saved !== undefined) process.env.KHY_EDIT_STAT_LINE = saved;
  }
});
