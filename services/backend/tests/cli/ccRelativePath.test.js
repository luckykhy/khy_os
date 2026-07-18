'use strict';

// 对齐 CC「后端逻辑也对齐」:工具路径展示 relative-to-cwd 单一真源
// (CC src/utils/path.ts toRelativePath:绝对路径相对化到 cwd,cwd 外保绝对)。
// 钉住:门控开 = 相对化(cwd 内 → 相对、cwd 外 → 绝对);门控关 = 原样返回
// (call-site 展示完整绝对路径 → 与历史逐字节一致)。
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  relativeToolPathEnabled,
  toRelativePath,
  relativizeToolPath,
} = require('../../src/cli/ccRelativePath');

const ON = { KHY_TOOL_RELATIVE_PATH: '1' };
const OFF = { KHY_TOOL_RELATIVE_PATH: 'off' };

const CWD = '/home/kodehu03/Khy-OS';
const UNDER = '/home/kodehu03/Khy-OS/services/backend/src/cli/foo.js';
const UNDER_REL = 'services/backend/src/cli/foo.js';
const OUTSIDE = '/etc/hosts';

// ── 门控梯 ─────────────────────────────────────────────────────────────────────
test('relativeToolPathEnabled:默认开,仅 0/false/off/no 关', () => {
  assert.strictEqual(relativeToolPathEnabled({}), true);
  assert.strictEqual(relativeToolPathEnabled(undefined), true);
  for (const v of ['0', 'false', 'off', 'no', ' OFF ', 'No']) {
    assert.strictEqual(relativeToolPathEnabled({ KHY_TOOL_RELATIVE_PATH: v }), false, v);
  }
  for (const v of ['1', 'true', 'on', 'yes', 'whatever']) {
    assert.strictEqual(relativeToolPathEnabled({ KHY_TOOL_RELATIVE_PATH: v }), true, v);
  }
});

// ── toRelativePath:CC 逐字节移植(与门控无关)──────────────────────────────────
test('toRelativePath:cwd 内绝对路径 → 相对路径(省列宽/易读)', () => {
  assert.strictEqual(toRelativePath(UNDER, CWD), UNDER_REL);
  assert.strictEqual(toRelativePath('/a/b/c/d.txt', '/a/b'), path.join('c', 'd.txt'));
});

test('toRelativePath:cwd 外绝对路径(相对会以 .. 开头)→ 保留绝对(不歧义)', () => {
  assert.strictEqual(toRelativePath(OUTSIDE, CWD), OUTSIDE);
  assert.strictEqual(toRelativePath('/a/x.js', '/a/b/c'), '/a/x.js');
});

test('toRelativePath:非绝对路径输入 → 原样返回(无 cwd 可减)', () => {
  assert.strictEqual(toRelativePath('src/index.js', CWD), 'src/index.js');
  assert.strictEqual(toRelativePath('./rel/p.txt', CWD), './rel/p.txt');
});

test('toRelativePath:防呆——abs/cwd 缺失 → 返回 abs,绝不抛', () => {
  assert.strictEqual(toRelativePath('', CWD), '');
  assert.strictEqual(toRelativePath(UNDER, ''), UNDER);
  assert.strictEqual(toRelativePath(null, CWD), '');
  assert.strictEqual(toRelativePath(undefined, CWD), '');
  assert.doesNotThrow(() => toRelativePath(123, CWD));
});

// ── relativizeToolPath:门控感知封装 ─────────────────────────────────────────────
test('门控开:relativizeToolPath 相对化 cwd 内、保留 cwd 外', () => {
  assert.strictEqual(relativizeToolPath(UNDER, CWD, ON), UNDER_REL);
  assert.strictEqual(relativizeToolPath(OUTSIDE, CWD, ON), OUTSIDE);
});

test('门控关:relativizeToolPath 原样返回(逐字节回退历史绝对路径)', () => {
  // cwd 内绝对路径门控关 → 仍展示完整绝对(与历史一致)。
  assert.strictEqual(relativizeToolPath(UNDER, CWD, OFF), UNDER);
  // 非绝对/cwd 外两态都不变。
  assert.strictEqual(relativizeToolPath('src/index.js', CWD, OFF), 'src/index.js');
  assert.strictEqual(relativizeToolPath(OUTSIDE, CWD, OFF), OUTSIDE);
});

test('门控开/关唯一分歧点 = cwd 内绝对路径;cwd 外 / 相对路径两态一致', () => {
  // 唯一会变的:cwd 内绝对路径(开 → 相对,关 → 绝对)。
  assert.notStrictEqual(relativizeToolPath(UNDER, CWD, ON), relativizeToolPath(UNDER, CWD, OFF));
  // cwd 外 / 已是相对:开关逐字节一致。
  for (const p of [OUTSIDE, 'src/index.js', './rel.txt', '']) {
    assert.strictEqual(relativizeToolPath(p, CWD, ON), relativizeToolPath(p, CWD, OFF), p);
  }
});

test('门控开:path 恰 === cwd(相对化为空)→ 回退绝对(不展示空路径)', () => {
  // CC 字面会返回 ''(`''.startsWith('..')` 为假);本封装刻意回退绝对避免空展示。
  assert.strictEqual(relativizeToolPath(CWD, CWD, ON), CWD);
});

// ── 默认 env(无显式门控)= 开档 ───────────────────────────────────────────────
test('默认 process.env(无 KHY_TOOL_RELATIVE_PATH)= 开档相对化', () => {
  const saved = process.env.KHY_TOOL_RELATIVE_PATH;
  delete process.env.KHY_TOOL_RELATIVE_PATH;
  try {
    assert.strictEqual(relativizeToolPath(UNDER, CWD), UNDER_REL);
    assert.strictEqual(relativizeToolPath(OUTSIDE, CWD), OUTSIDE);
  } finally {
    if (saved !== undefined) process.env.KHY_TOOL_RELATIVE_PATH = saved;
  }
});
