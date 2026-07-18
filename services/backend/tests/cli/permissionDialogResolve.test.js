'use strict';

/**
 * permissionDialogResolve — resolveChoiceIndex 语义兜底单测(node:test)。
 *
 * 锁定:别名匹配失败后,经 permissionReply 叶子把自然语肯定/否定词映射到代表别名
 * (allow→'yes'、allow-always→'always'、deny→'no'),返回对应 choice 的 index;
 * 门控关 → 兜底跳过 → -1(逐字节回退);既有数字/别名命中不受影响;批量对话框同形可用。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveChoiceIndex } = require('../../src/cli/ui/permissionDialog');

// 常规对话框三选项(与 permissionDialog.js 内一致的代表别名)
const CHOICES = [
  { value: 'allow', aliases: ['1', 'y', 'yes'] },
  { value: 'allow-always', aliases: ['2', 'a', 'always', 'trust'] },
  { value: 'deny', aliases: ['3', 'n', 'no'] },
];

// 批量对话框选项(value 不同,但代表别名 yes/always/no 同形)
const BATCH = [
  { value: 'approve-all', aliases: ['1', 'y', 'yes'] },
  { value: 'approve-all-always', aliases: ['2', 'a', 'always'] },
  { value: 'deny-all', aliases: ['3', 'n', 'no'] },
];

test('既有命中不受影响: 数字/字母/yes 仍解析', () => {
  assert.equal(resolveChoiceIndex('1', CHOICES, -1), 0);
  assert.equal(resolveChoiceIndex('y', CHOICES, -1), 0);
  assert.equal(resolveChoiceIndex('yes', CHOICES, -1), 0);
  assert.equal(resolveChoiceIndex('always', CHOICES, -1), 1);
  assert.equal(resolveChoiceIndex('no', CHOICES, -1), 2);
});

test('语义兜底: 中文肯定词 → Yes 行(index 0)', () => {
  for (const w of ['好的', '可以', '同意', '批准', '允许', '确认']) {
    assert.equal(resolveChoiceIndex(w, CHOICES, -1), 0, `「${w}」应→0`);
  }
});

test('语义兜底: 信任/总是类 → always 行(index 1)', () => {
  assert.equal(resolveChoiceIndex('一直', CHOICES, -1), 1);
  assert.equal(resolveChoiceIndex('信任', CHOICES, -1), 1);
  assert.equal(resolveChoiceIndex('总是允许', CHOICES, -1), 1);
});

test('语义兜底: 否定词 → No 行(index 2)', () => {
  for (const w of ['不要', '拒绝', '取消', '不允许']) {
    assert.equal(resolveChoiceIndex(w, CHOICES, -1), 2, `「${w}」应→2`);
  }
});

test('批量对话框同形可用(value 不同别名同形)', () => {
  assert.equal(resolveChoiceIndex('好的', BATCH, -1), 0);
  assert.equal(resolveChoiceIndex('一直', BATCH, -1), 1);
  assert.equal(resolveChoiceIndex('不要', BATCH, -1), 2);
});

test('乱码 → -1(default 透传)', () => {
  assert.equal(resolveChoiceIndex('zzzz', CHOICES, -1), -1);
  assert.equal(resolveChoiceIndex('', CHOICES, -1), -1);
});

test('门控关: KHY_PERMISSION_REPLY_TOKENS=off → 兜底跳过 → -1(字节回退)', () => {
  const prev = process.env.KHY_PERMISSION_REPLY_TOKENS;
  process.env.KHY_PERMISSION_REPLY_TOKENS = 'off';
  try {
    assert.equal(resolveChoiceIndex('好的', CHOICES, -1), -1);
    assert.equal(resolveChoiceIndex('同意', CHOICES, -1), -1);
    // 数字/字母仍命中(与门控无关)
    assert.equal(resolveChoiceIndex('1', CHOICES, -1), 0);
    assert.equal(resolveChoiceIndex('yes', CHOICES, -1), 0);
  } finally {
    if (prev === undefined) delete process.env.KHY_PERMISSION_REPLY_TOKENS;
    else process.env.KHY_PERMISSION_REPLY_TOKENS = prev;
  }
});
