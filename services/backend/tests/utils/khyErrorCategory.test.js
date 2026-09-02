'use strict';

/**
 * khyErrorCategory.js 契约测试 —— 错误分类与严重度的单一真源。
 *
 * 关注点：
 *   1. 9 类 CATEGORIES 冻结，不可写；
 *   2. 5 个 SEVERITIES 都有 rank（用于排序）；
 *   3. SUB_CATEGORIES 至少 25 个，覆盖 user/config/auth/network/upstream/io/resource/internal。
 *   4. getCategorySpec / getSeveritySpec 对非法输入兜底到 UNKNOWN / ERROR，
 *      不能因为 category 拼错就崩。
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  CATEGORIES,
  SEVERITIES,
  SUB_CATEGORIES,
  getCategorySpec,
  getSeveritySpec,
  getSubCategory,
  listSubCategories,
} = require('../../src/utils/khyErrorCategory');

test('CATEGORIES 冻结且至少覆盖 8 大类', () => {
  assert.ok(Object.isFrozen(CATEGORIES), 'CATEGORIES 必须冻结');
  const keys = Object.keys(CATEGORIES);
  assert.ok(keys.length >= 8, `分类过少: ${keys.length}`);
  for (const expected of ['USER', 'CONFIG', 'AUTH', 'NETWORK', 'UPSTREAM', 'IO', 'RESOURCE', 'INTERNAL', 'UNKNOWN']) {
    assert.ok(keys.includes(expected), `缺分类 ${expected}`);
  }
});

test('每个分类都有 label / defaultSeverity / recoverable / retryable', () => {
  for (const [code, spec] of Object.entries(CATEGORIES)) {
    assert.strictEqual(typeof spec.code, 'string', `${code}.code 缺`);
    assert.strictEqual(typeof spec.label, 'string', `${code}.label 缺`);
    assert.ok(typeof spec.defaultSeverity === 'string', `${code}.defaultSeverity 缺`);
    assert.strictEqual(typeof spec.recoverable, 'boolean', `${code}.recoverable 必须是布尔`);
    assert.strictEqual(typeof spec.retryable, 'boolean', `${code}.retryable 必须是布尔`);
  }
});

test('SEVERITIES 按 rank 严格递增', () => {
  assert.ok(Object.isFrozen(SEVERITIES), 'SEVERITIES 必须冻结');
  const ranks = Object.values(SEVERITIES).map((s) => s.rank);
  for (let i = 1; i < ranks.length; i++) {
    assert.ok(ranks[i] > ranks[i - 1], `rank 必须递增: ${ranks.join(',')}`);
  }
});

test('SUB_CATEGORIES 至少 25 个且都能找到对应 CATEGORIES', () => {
  const subs = Object.keys(SUB_CATEGORIES);
  assert.ok(subs.length >= 25, `子分类过少: ${subs.length}`);
  for (const [code, spec] of Object.entries(SUB_CATEGORIES)) {
    const cat = CATEGORIES[spec.category.toUpperCase()];
    assert.ok(cat, `子分类 ${code} 引用未知 category=${spec.category}`);
    const sev = SEVERITIES[spec.severity.toUpperCase()];
    assert.ok(sev, `子分类 ${code} 引用未知 severity=${spec.severity}`);
  }
});

test('getCategorySpec 对非法输入兜底到 UNKNOWN', () => {
  assert.strictEqual(getCategorySpec().code, 'unknown');
  assert.strictEqual(getCategorySpec(null).code, 'unknown');
  assert.strictEqual(getCategorySpec('does-not-exist').code, 'unknown');
  assert.strictEqual(getCategorySpec('USER').code, 'user');
  assert.strictEqual(getCategorySpec('user').code, 'user');
});

test('getSeveritySpec 对非法输入兜底到 ERROR', () => {
  assert.strictEqual(getSeveritySpec().code, 'error');
  assert.strictEqual(getSeveritySpec(null).code, 'error');
  assert.strictEqual(getSeveritySpec('does-not-exist').code, 'error');
  assert.strictEqual(getSeveritySpec('WARN').code, 'warn');
});

test('getSubCategory 大小写不敏感，未注册返回 null', () => {
  assert.strictEqual(getSubCategory('AUTH_REQUIRED').category, 'auth');
  assert.strictEqual(getSubCategory('auth_required').category, 'auth');
  assert.strictEqual(getSubCategory('NOT_A_CODE'), null);
  assert.strictEqual(getSubCategory(null), null);
});

test('listSubCategories 导出所有已登记子分类', () => {
  const list = listSubCategories();
  assert.ok(Array.isArray(list));
  assert.ok(list.length >= 25);
  for (const item of list) {
    assert.ok(item.code && item.category && item.severity, '每项必须三件齐全');
  }
});