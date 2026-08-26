'use strict';

/**
 * staticItemsMemo.test.js — committed <Static> 包装数组按 messages 引用记忆(纯叶子,node:test)。
 *
 * 关键不变量:
 *  - buildStaticItems 只包装已提交的 messages，启动 banner 不得进入 <Static>。
 *  - 门控开:messages 引用命中 → 复用**同一** items 引用(零重建);引用变 → 新 items。
 *  - 门控关:每次都重建—— items 引用每次不同、内容相同。
 *  - ref 线程循环(镜像 hook):稳定引用的连续多帧只重建一次;messages 变则重建。
 *  - 坏输入(null/非数组)不抛、退化为空 committed 列表。
 *
 * 运行:node --test services/backend/tests/cli/staticItemsMemo.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const memo = require('../../src/cli/tui/staticItemsMemo');

const ON = {};
const OFF = { KHY_STATIC_ITEMS_MEMO: 'off' };

// 今日的确切构造(字节回退目标)。
function expectedItems(messages) {
  return messages.map((msg, i) => ({ kind: 'message', key: `m${i}`, msg }));
}

test('isEnabled:默认 on;显式 off/0/false/no 关', () => {
  assert.equal(memo.isEnabled({}), true);
  assert.equal(memo.isEnabled({ KHY_STATIC_ITEMS_MEMO: 'off' }), false);
  assert.equal(memo.isEnabled({ KHY_STATIC_ITEMS_MEMO: '0' }), false);
  assert.equal(memo.isEnabled({ KHY_STATIC_ITEMS_MEMO: 'false' }), false);
  assert.equal(memo.isEnabled({ KHY_STATIC_ITEMS_MEMO: 'no' }), false);
  assert.equal(memo.isEnabled({ KHY_STATIC_ITEMS_MEMO: 'on' }), true);
});

test('buildStaticItems 只包装已提交消息，绝不携带启动横幅', () => {
  for (const msgs of [
    [],
    [{ role: 'user', content: 'hi' }],
    [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'notice', content: 'c' }],
  ]) {
    const items = memo.buildStaticItems(msgs);
    assert.deepEqual(items, expectedItems(msgs));
    assert.equal(items.some((item) => item.kind === 'banner'), false);
  }
});

test('首屏到后续消息的转场始终只提交消息项，横幅不会回流到 Static', () => {
  const startup = memo.buildStaticItems([]);
  const firstTurn = memo.buildStaticItems([{ role: 'user', content: '讲个故事' }]);
  const nextTurn = memo.buildStaticItems([
    { role: 'user', content: '讲个故事' },
    { role: 'assistant', content: '从前有座山' },
  ]);

  assert.deepEqual(startup, []);
  assert.deepEqual(firstTurn, expectedItems([{ role: 'user', content: '讲个故事' }]));
  assert.deepEqual(nextTurn, expectedItems([
    { role: 'user', content: '讲个故事' },
    { role: 'assistant', content: '从前有座山' },
  ]));
  for (const items of [startup, firstTurn, nextTurn]) {
    assert.equal(items.some((item) => item.kind === 'banner'), false);
  }
});

test('包装项 msg 为原对象引用(不复制)', () => {
  const m0 = { role: 'user', content: 'hi' };
  const items = memo.buildStaticItems([m0]);
  assert.equal(items[0].msg, m0, 'msg 应是原 message 对象引用');
  assert.equal(items[0].key, 'm0');
});

test('门控开:messages 引用命中 → 复用同一 items 引用', () => {
  const msgs = [{ role: 'user', content: 'x' }];
  const r1 = memo.reconcileStaticItems(null, msgs, ON);
  const r2 = memo.reconcileStaticItems(r1.cache, msgs, ON); // 同引用
  assert.equal(r2.items, r1.items, '引用命中应复用同一 items(零重建)');
  assert.deepEqual(r1.items, expectedItems(msgs));
});

test('门控开:messages 引用变 → 重建新 items', () => {
  const a = [{ role: 'user', content: 'x' }];
  const b = a.concat([{ role: 'assistant', content: 'y' }]); // 新数组(append)
  const r1 = memo.reconcileStaticItems(null, a, ON);
  const r2 = memo.reconcileStaticItems(r1.cache, b, ON);
  assert.notEqual(r2.items, r1.items, '内容变(新引用)应重建');
  assert.deepEqual(r2.items, expectedItems(b));
});

test('门控关:每次都重建(引用每次不同、内容逐字节相同)', () => {
  const msgs = [{ role: 'user', content: 'x' }];
  const r1 = memo.reconcileStaticItems(null, msgs, OFF);
  const r2 = memo.reconcileStaticItems(r1.cache, msgs, OFF); // 即便同引用
  assert.notEqual(r2.items, r1.items, '门控关应每次新数组');
  assert.equal(r1.cache, null, '门控关不缓存');
  assert.deepEqual(r1.items, expectedItems(msgs));
  assert.deepEqual(r2.items, expectedItems(msgs));
});

test('ref 线程循环(镜像 hook):稳定引用连续多帧只重建一次,messages 变则重建', () => {
  let cache = null;
  let builds = 0;
  // 用探针版 reconcile 观测真正重建次数:包一层数元素身份。
  const seen = new Set();
  function step(messages, env) {
    const r = memo.reconcileStaticItems(cache, messages, env);
    cache = r.cache;
    if (!seen.has(r.items)) { seen.add(r.items); builds++; }
    return r.items;
  }
  const msgsA = [{ role: 'user', content: 'a' }];
  // 10 个「帧」都是同一 messages 引用(模拟流式/按键/nowTick 期间 messages 未变)。
  for (let i = 0; i < 10; i++) step(msgsA, ON);
  assert.equal(builds, 1, '同一 messages 引用的 10 帧应只重建一次');

  // messages 变(提交新消息)→ 再重建一次。
  const msgsB = msgsA.concat([{ role: 'assistant', content: 'b' }]);
  for (let i = 0; i < 5; i++) step(msgsB, ON);
  assert.equal(builds, 2, 'messages 变后应再重建一次(此后 5 帧复用)');
});

test('坏输入:null/非数组不抛,退化为空 committed 列表', () => {
  assert.deepEqual(memo.buildStaticItems(null), []);
  assert.deepEqual(memo.buildStaticItems(undefined), []);
  const r = memo.reconcileStaticItems(null, null, ON);
  assert.deepEqual(r.items, []);
});
