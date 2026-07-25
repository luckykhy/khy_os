'use strict';

/**
 * taskBlockedBySuffix.test.js — 刀29 纯叶子单测(node:test)。
 *
 * 验证「blocked by」后缀只列**仍未完成**依赖(对齐 CC TaskListV2 openBlockers),
 * 已完成依赖剔除、全完成则后缀消失、`#` 前缀 + 数字序;门控关逐字节回退历史。
 *
 * 运行:node --test tests/tools/taskBlockedBySuffix.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { buildBlockedBySuffix, blockedBySuffixEnabled } = require('../../src/tools/taskBlockedBySuffix');

const ON = {}; // 空 env → 默认开
const OFF = { KHY_TASK_BLOCKED_BY_FILTER: '0' };

test('门控:默认开,0/false/off/no 关', () => {
  assert.strictEqual(blockedBySuffixEnabled({}), true);
  assert.strictEqual(blockedBySuffixEnabled({ KHY_TASK_BLOCKED_BY_FILTER: '0' }), false);
  assert.strictEqual(blockedBySuffixEnabled({ KHY_TASK_BLOCKED_BY_FILTER: 'false' }), false);
  assert.strictEqual(blockedBySuffixEnabled({ KHY_TASK_BLOCKED_BY_FILTER: 'off' }), false);
  assert.strictEqual(blockedBySuffixEnabled({ KHY_TASK_BLOCKED_BY_FILTER: 'no' }), false);
  assert.strictEqual(blockedBySuffixEnabled({ KHY_TASK_BLOCKED_BY_FILTER: '1' }), true);
});

test('空/非数组 blockedBy → 空后缀(与历史一致)', () => {
  assert.strictEqual(buildBlockedBySuffix([], new Set(), ON), '');
  assert.strictEqual(buildBlockedBySuffix(null, new Set(), ON), '');
  assert.strictEqual(buildBlockedBySuffix(undefined, new Set(), ON), '');
  assert.strictEqual(buildBlockedBySuffix('1,2', new Set(), ON), '');
});

test('门控开:无依赖完成 → 全列出,`#` 前缀 + 数字序', () => {
  assert.strictEqual(
    buildBlockedBySuffix(['3', '1'], new Set(), ON),
    ' [blocked by: #1, #3]',
  );
});

test('门控开:已完成依赖被剔除', () => {
  assert.strictEqual(
    buildBlockedBySuffix(['1', '3'], new Set(['3']), ON),
    ' [blocked by: #1]',
  );
});

test('门控开:全部依赖已完成 → 后缀整段消失(对齐 CC isBlocked=false)', () => {
  assert.strictEqual(
    buildBlockedBySuffix(['1', '3'], new Set(['1', '3']), ON),
    '',
  );
});

test('门控开:completedIds 接受数组,内部转 Set', () => {
  assert.strictEqual(
    buildBlockedBySuffix(['1', '2'], ['1'], ON),
    ' [blocked by: #2]',
  );
});

test('诚实分歧:缺失/不存在的依赖 id 保留显示(missing dep = blocked)', () => {
  // '9' 既不在 completedIds 也无对应任务 → 仍当阻塞显示(对悬空依赖是有用告警)。
  assert.strictEqual(
    buildBlockedBySuffix(['9'], new Set(['1', '2']), ON),
    ' [blocked by: #9]',
  );
});

test('门控开:数字 id 数字序,非数字 id 稳定字典序', () => {
  assert.strictEqual(
    buildBlockedBySuffix(['10', '2', '1'], new Set(), ON),
    ' [blocked by: #1, #2, #10]',
  );
  assert.strictEqual(
    buildBlockedBySuffix(['t-b', 't-a'], new Set(), ON),
    ' [blocked by: #t-a, #t-b]',
  );
});

test('门控开:数字与 id 混入完成集仍用字符串匹配', () => {
  // completedIds 用字符串比较,数字 blockedBy 元素也归一为字符串。
  assert.strictEqual(
    buildBlockedBySuffix([1, 2, 3], new Set(['2']), ON),
    ' [blocked by: #1, #3]',
  );
});

test('门控关:逐字节回退历史(原始 join(\',\')、无 #、逗号无空格、不过滤)', () => {
  // 历史:`Array.isArray(t.blockedBy) && t.blockedBy.length ? ` [blocked by: ${join(',')}]` : ''`
  assert.strictEqual(
    buildBlockedBySuffix(['1', '3'], new Set(['3']), OFF),
    ' [blocked by: 1,3]',
  );
  // 门控关空数组仍 ''(与历史三元一致)。
  assert.strictEqual(buildBlockedBySuffix([], new Set(['3']), OFF), '');
});

test('门控开/关唯一分歧:过滤 + 格式;ASCII 单依赖未完成时两态文本不同但语义一致', () => {
  const on = buildBlockedBySuffix(['1', '3'], new Set(['3']), ON);
  const off = buildBlockedBySuffix(['1', '3'], new Set(['3']), OFF);
  assert.strictEqual(on, ' [blocked by: #1]');     // 过滤掉已完成 #3 + CC 格式
  assert.strictEqual(off, ' [blocked by: 1,3]');   // 历史:原样未过滤
  assert.notStrictEqual(on, off);
});
