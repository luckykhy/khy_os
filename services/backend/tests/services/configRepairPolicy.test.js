'use strict';

/**
 * configRepairPolicy.test.js — 纯叶子:.env 配置损坏检测与修复(确定性)。
 *
 * 锁定 detectEnvCorruption 和 repairEnvLines:
 *   ① 重复键 → 检测到 duplicate-key;
 *   ② 畸形行(无 =) → 检测到 malformed-line;
 *   ③ 空键名 → 检测到 empty-key;
 *   ④ 未闭合引号 → 检测到 unclosed-quote;
 *   ⑤ 正常行 → 不报告问题;
 *   ⑥ 修复:移除畸形行、空键、未闭合引号;
 *   ⑦ 修复:重复键保留最后一次出现;
 *   ⑧ 门控关(KHY_CONFIG_REPAIR=off) → 不检测、不修复;
 *   ⑨ 坏输入(非数组) → 空结果不抛。
 */

const test = require('node:test');
const assert = require('node:assert');

const policy = require('../../src/services/configRepairPolicy');

test('正常行 → 不报告问题', () => {
  const lines = [
    'KEY1=value1',
    'KEY2=value2',
    '# comment',
    '',
    'KEY3="quoted value"',
  ];
  const result = policy.detectEnvCorruption(lines, { env: {} });
  assert.strictEqual(result.isCorrupted, false);
  assert.deepStrictEqual(result.issues, []);
});

test('重复键 → 检测到 duplicate-key', () => {
  const lines = [
    'KEY1=value1',
    'KEY2=value2',
    'KEY1=value3', // 重复
  ];
  const result = policy.detectEnvCorruption(lines, { env: {} });
  assert.strictEqual(result.isCorrupted, true);
  assert.strictEqual(result.issues.length, 1);
  assert.strictEqual(result.issues[0].type, 'duplicate-key');
  assert.ok(result.issues[0].message.includes('KEY1'));
  assert.ok(result.issues[0].message.includes('1, 3'));
});

test('畸形行(无 =) → 检测到 malformed-line', () => {
  const lines = [
    'KEY1=value1',
    'this line has no equals sign',
    'KEY2=value2',
  ];
  const result = policy.detectEnvCorruption(lines, { env: {} });
  assert.strictEqual(result.isCorrupted, true);
  assert.strictEqual(result.issues.length, 1);
  assert.strictEqual(result.issues[0].type, 'malformed-line');
  assert.strictEqual(result.issues[0].line, 2);
});

test('空键名 → 检测到 empty-key', () => {
  const lines = [
    'KEY1=value1',
    '=value_without_key',
    'KEY2=value2',
  ];
  const result = policy.detectEnvCorruption(lines, { env: {} });
  assert.strictEqual(result.isCorrupted, true);
  assert.strictEqual(result.issues.length, 1);
  assert.strictEqual(result.issues[0].type, 'empty-key');
  assert.strictEqual(result.issues[0].line, 2);
});

test('未闭合引号 → 检测到 unclosed-quote', () => {
  const lines = [
    'KEY1=value1',
    'KEY2="unclosed quote',
    'KEY3=value3',
  ];
  const result = policy.detectEnvCorruption(lines, { env: {} });
  assert.strictEqual(result.isCorrupted, true);
  assert.strictEqual(result.issues.length, 1);
  assert.strictEqual(result.issues[0].type, 'unclosed-quote');
  assert.strictEqual(result.issues[0].line, 2);
});

test('多种问题同时存在', () => {
  const lines = [
    'KEY1=value1',
    'KEY1=value2', // 重复
    'malformed line', // 畸形
    '=empty', // 空键
    'KEY2="unclosed', // 未闭合引号
  ];
  const result = policy.detectEnvCorruption(lines, { env: {} });
  assert.strictEqual(result.isCorrupted, true);
  assert.ok(result.issues.length >= 4); // 至少4个问题
  const types = result.issues.map((i) => i.type);
  assert.ok(types.includes('duplicate-key'));
  assert.ok(types.includes('malformed-line'));
  assert.ok(types.includes('empty-key'));
  assert.ok(types.includes('unclosed-quote'));
});

test('修复:移除畸形行', () => {
  const lines = [
    'KEY1=value1',
    'malformed line',
    'KEY2=value2',
  ];
  const issues = policy.detectEnvCorruption(lines, { env: {} }).issues;
  const result = policy.repairEnvLines(lines, issues, { env: {} });
  assert.strictEqual(result.removed, 1);
  assert.deepStrictEqual(result.repaired, ['KEY1=value1', 'KEY2=value2']);
});

test('修复:移除空键行', () => {
  const lines = [
    'KEY1=value1',
    '=empty_key',
    'KEY2=value2',
  ];
  const issues = policy.detectEnvCorruption(lines, { env: {} }).issues;
  const result = policy.repairEnvLines(lines, issues, { env: {} });
  assert.strictEqual(result.removed, 1);
  assert.deepStrictEqual(result.repaired, ['KEY1=value1', 'KEY2=value2']);
});

test('修复:移除未闭合引号行', () => {
  const lines = [
    'KEY1=value1',
    'KEY2="unclosed',
    'KEY3=value3',
  ];
  const issues = policy.detectEnvCorruption(lines, { env: {} }).issues;
  const result = policy.repairEnvLines(lines, issues, { env: {} });
  assert.strictEqual(result.removed, 1);
  assert.deepStrictEqual(result.repaired, ['KEY1=value1', 'KEY3=value3']);
});

test('修复:重复键保留最后一次出现', () => {
  const lines = [
    'KEY1=value1',
    'KEY2=value2',
    'KEY1=value3', // 应保留这个
  ];
  const issues = policy.detectEnvCorruption(lines, { env: {} }).issues;
  const result = policy.repairEnvLines(lines, issues, { env: {} });
  assert.strictEqual(result.removed, 1);
  assert.deepStrictEqual(result.repaired, ['KEY2=value2', 'KEY1=value3']);
});

test('修复:多个重复键,各保留最后一次', () => {
  const lines = [
    'KEY1=value1',
    'KEY2=value2',
    'KEY1=value1_new',
    'KEY2=value2_new',
    'KEY3=value3',
  ];
  const issues = policy.detectEnvCorruption(lines, { env: {} }).issues;
  const result = policy.repairEnvLines(lines, issues, { env: {} });
  assert.strictEqual(result.removed, 2);
  assert.deepStrictEqual(result.repaired, [
    'KEY1=value1_new',
    'KEY2=value2_new',
    'KEY3=value3',
  ]);
});

test('修复:无问题时返回原数组副本', () => {
  const lines = ['KEY1=value1', 'KEY2=value2'];
  const issues = [];
  const result = policy.repairEnvLines(lines, issues, { env: {} });
  assert.strictEqual(result.removed, 0);
  assert.deepStrictEqual(result.repaired, lines);
  assert.notStrictEqual(result.repaired, lines); // 应该是副本
});

test('门控关(KHY_CONFIG_REPAIR=off) → 不检测', () => {
  const lines = [
    'KEY1=value1',
    'malformed line',
    'KEY1=value2',
  ];
  for (const off of ['0', 'false', 'off', 'no', 'OFF']) {
    const result = policy.detectEnvCorruption(lines, { env: { KHY_CONFIG_REPAIR: off } });
    assert.strictEqual(result.isCorrupted, false, `gate=${off} 应不检测`);
    assert.deepStrictEqual(result.issues, []);
  }
});

test('门控关(KHY_CONFIG_REPAIR=off) → 不修复', () => {
  const lines = [
    'KEY1=value1',
    'malformed line',
    'KEY2=value2',
  ];
  const issues = [{ line: 2, type: 'malformed-line', message: 'test' }];
  for (const off of ['0', 'false', 'off', 'no']) {
    const result = policy.repairEnvLines(lines, issues, { env: { KHY_CONFIG_REPAIR: off } });
    assert.strictEqual(result.removed, 0, `gate=${off} 应不修复`);
    assert.deepStrictEqual(result.repaired, lines);
  }
});

test('坏输入(非数组)→ 空结果不抛', () => {
  assert.deepStrictEqual(policy.detectEnvCorruption(null, { env: {} }), { isCorrupted: false, issues: [] });
  assert.deepStrictEqual(policy.detectEnvCorruption('not-array', { env: {} }), { isCorrupted: false, issues: [] });
  assert.deepStrictEqual(policy.detectEnvCorruption(undefined, { env: {} }), { isCorrupted: false, issues: [] });
});

test('repairEnvLines 坏输入不抛', () => {
  assert.deepStrictEqual(policy.repairEnvLines(null, [], { env: {} }), { repaired: [], removed: 0 });
  assert.deepStrictEqual(policy.repairEnvLines('not-array', [], { env: {} }), { repaired: [], removed: 0 });
  assert.deepStrictEqual(policy.repairEnvLines([], null, { env: {} }), { repaired: [], removed: 0 });
});

test('isEnabled 门控逻辑', () => {
  assert.strictEqual(policy.isEnabled({ KHY_CONFIG_REPAIR: 'true' }), true);
  assert.strictEqual(policy.isEnabled({ KHY_CONFIG_REPAIR: '1' }), true);
  assert.strictEqual(policy.isEnabled({}), true); // 默认开
  assert.strictEqual(policy.isEnabled({ KHY_CONFIG_REPAIR: '0' }), false);
  assert.strictEqual(policy.isEnabled({ KHY_CONFIG_REPAIR: 'false' }), false);
  assert.strictEqual(policy.isEnabled({ KHY_CONFIG_REPAIR: 'off' }), false);
  assert.strictEqual(policy.isEnabled({ KHY_CONFIG_REPAIR: 'no' }), false);
});
