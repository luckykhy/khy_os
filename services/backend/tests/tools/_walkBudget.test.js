'use strict';

/**
 * _walkBudget.test.js — 目录遍历墙钟预算助手的单测(node:test)。
 *
 * 覆盖:门控开/关(createWalkDeadline 返对象/null)、注入时钟的 exceeded() 边界、预算毫秒
 * 解析与 clamp、坏输入/坏时钟绝不抛。
 *
 * 运行:node --test services/backend/tests/tools/_walkBudget.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const wb = require('../../src/tools/_walkBudget');

test('门控默认 on:createWalkDeadline 返判定器', () => {
  const d = wb.createWalkDeadline({});
  assert.ok(d && typeof d.exceeded === 'function');
  assert.equal(typeof d.budgetMs, 'number');
});

test('门控关 → createWalkDeadline 返 null(调用方走无预算今日路径)', () => {
  assert.equal(wb.createWalkDeadline({ KHY_FS_WALK_BUDGET: 'off' }), null);
  assert.equal(wb.createWalkDeadline({ KHY_FS_WALK_BUDGET: '0' }), null);
  assert.equal(wb.createWalkDeadline({ KHY_FS_WALK_BUDGET: 'false' }), null);
});

test('注入时钟:exceeded() 在预算内 false、越过预算 true', () => {
  let now = 1000;
  const clock = () => now;
  const d = wb.createWalkDeadline({ KHY_FS_WALK_BUDGET_MS: '5000' }, clock);
  assert.equal(d.budgetMs, 5000);
  assert.equal(d.exceeded(), false); // t=1000, deadline=6000
  now = 5999;
  assert.equal(d.exceeded(), false);
  now = 6000;
  assert.equal(d.exceeded(), true); // >= deadline
  now = 999999;
  assert.equal(d.exceeded(), true);
});

test('resolveWalkBudgetMs:默认 8000;合法值透传;越界 clamp[250,600000]', () => {
  assert.equal(wb.resolveWalkBudgetMs({}), 8000);
  assert.equal(wb.resolveWalkBudgetMs({ KHY_FS_WALK_BUDGET_MS: '3000' }), 3000);
  // clamp:低于下限 / 高于上限。
  assert.equal(wb.resolveWalkBudgetMs({ KHY_FS_WALK_BUDGET_MS: '10' }), 250);
  assert.equal(wb.resolveWalkBudgetMs({ KHY_FS_WALK_BUDGET_MS: '99999999' }), 600000);
  // 非法 → 默认。
  assert.equal(wb.resolveWalkBudgetMs({ KHY_FS_WALK_BUDGET_MS: 'abc' }), 8000);
});

test('createWalkDeadline 坏时钟绝不抛;构造期抛 → fail-soft 返 null', () => {
  const bad = () => { throw new Error('boom'); };
  // 构造期时钟抛 → 整体 fail-soft 返 null。
  assert.equal(wb.createWalkDeadline({}, bad), null);
});

test('isWalkBudgetEnabled 默认 on、显式 off 关', () => {
  assert.equal(wb.isWalkBudgetEnabled({}), true);
  assert.equal(wb.isWalkBudgetEnabled({ KHY_FS_WALK_BUDGET: 'no' }), false);
});

test('isWalkAsyncEnabled 默认 on;CANON off-words 关(逐字节回退同步 walk)', () => {
  assert.equal(wb.isWalkAsyncEnabled({}), true);
  assert.equal(wb.isWalkAsyncEnabled(undefined), true);
  assert.equal(wb.isWalkAsyncEnabled({ KHY_FS_WALK_ASYNC: '1' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(wb.isWalkAsyncEnabled({ KHY_FS_WALK_ASYNC: v }), false, `expected off for ${JSON.stringify(v)}`);
  }
});
