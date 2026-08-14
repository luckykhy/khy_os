'use strict';

/**
 * staticItemsMemo.test.js — committed <Static> 包装数组按 messages 引用记忆(纯叶子,node:test)。
 *
 * 关键不变量:
 *  - buildStaticItems 与今日表达式逐字节等价(deepEqual)。
 *  - 门控开:messages 引用命中 → 复用**同一** items 引用(零重建);引用变 → 新 items。
 *  - 门控关:每次都重建(逐字节回退今日每 render 一份新数组)—— items 引用每次不同、内容相同。
 *  - ref 线程循环(镜像 hook):稳定引用的连续多帧只重建一次;messages 变则重建。
 *  - 坏输入(null/非数组)不抛、退化为仅 banner。
 *
 * 运行:node --test services/backend/tests/cli/staticItemsMemo.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const memo = require('../../src/cli/tui/staticItemsMemo');

const ON = {};
const OFF = { KHY_STATIC_ITEMS_MEMO: 'off' };

// 今日的确切构造(字节回退目标)。
function legacyBuild(messages) {
  return [{ kind: 'banner', key: 'banner' }].concat(
    messages.map((msg, i) => ({ kind: 'message', key: `m${i}`, msg })),
  );
}

test('isEnabled:默认 on;显式 off/0/false/no 关', () => {
  assert.equal(memo.isEnabled({}), true);
  assert.equal(memo.isEnabled({ KHY_STATIC_ITEMS_MEMO: 'off' }), false);
  assert.equal(memo.isEnabled({ KHY_STATIC_ITEMS_MEMO: '0' }), false);
  assert.equal(memo.isEnabled({ KHY_STATIC_ITEMS_MEMO: 'false' }), false);
  assert.equal(memo.isEnabled({ KHY_STATIC_ITEMS_MEMO: 'no' }), false);
  assert.equal(memo.isEnabled({ KHY_STATIC_ITEMS_MEMO: 'on' }), true);
});

test('buildStaticItems 与今日表达式逐字节等价', () => {
  for (const msgs of [
    [],
    [{ role: 'user', content: 'hi' }],
    [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'notice', content: 'c' }],
  ]) {
    assert.deepEqual(memo.buildStaticItems(msgs), legacyBuild(msgs), 'buildStaticItems 应与今日 concat/map 一致');
  }
});

test('包装项 msg 为原对象引用(不复制)', () => {
  const m0 = { role: 'user', content: 'hi' };
  const items = memo.buildStaticItems([m0]);
  assert.equal(items[0].key, 'banner');
  assert.equal(items[1].msg, m0, 'msg 应是原 message 对象引用');
  assert.equal(items[1].key, 'm0');
});

test('门控开:messages 引用命中 → 复用同一 items 引用', () => {
  const msgs = [{ role: 'user', content: 'x' }];
  const r1 = memo.reconcileStaticItems(null, msgs, ON);
  const r2 = memo.reconcileStaticItems(r1.cache, msgs, ON); // 同引用
  assert.equal(r2.items, r1.items, '引用命中应复用同一 items(零重建)');
  assert.deepEqual(r1.items, legacyBuild(msgs));
});

test('门控开:messages 引用变 → 重建新 items', () => {
  const a = [{ role: 'user', content: 'x' }];
  const b = a.concat([{ role: 'assistant', content: 'y' }]); // 新数组(append)
  const r1 = memo.reconcileStaticItems(null, a, ON);
  const r2 = memo.reconcileStaticItems(r1.cache, b, ON);
  assert.notEqual(r2.items, r1.items, '内容变(新引用)应重建');
  assert.deepEqual(r2.items, legacyBuild(b));
});

test('门控关:每次都重建(引用每次不同、内容逐字节相同)', () => {
  const msgs = [{ role: 'user', content: 'x' }];
  const r1 = memo.reconcileStaticItems(null, msgs, OFF);
  const r2 = memo.reconcileStaticItems(r1.cache, msgs, OFF); // 即便同引用
  assert.notEqual(r2.items, r1.items, '门控关应每次新数组');
  assert.equal(r1.cache, null, '门控关不缓存');
  assert.deepEqual(r1.items, legacyBuild(msgs));
  assert.deepEqual(r2.items, legacyBuild(msgs));
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

test('坏输入:null/非数组不抛,退化为仅 banner', () => {
  assert.deepEqual(memo.buildStaticItems(null), [{ kind: 'banner', key: 'banner' }]);
  assert.deepEqual(memo.buildStaticItems(undefined), [{ kind: 'banner', key: 'banner' }]);
  const r = memo.reconcileStaticItems(null, null, ON);
  assert.deepEqual(r.items, [{ kind: 'banner', key: 'banner' }]);
});
