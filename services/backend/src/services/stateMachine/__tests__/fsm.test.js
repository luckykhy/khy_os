'use strict';

/**
 * fsm.test.js — FiniteStateMachine 核心契约(node:test)。
 *
 * 覆盖:合法转移推进;非法转移 fail-soft(保持原状态 + illegal 历史,绝不抛);
 * 历史环形缓冲上限;onStateChange 微任务异步派发(fire 返回后才执行)且钩子
 * 抛异常不影响 FSM;flag 禁用时 no-op 同形行为;toJSON 形状。
 */

const assert = require('node:assert');
const { test } = require('node:test');

const { FiniteStateMachine, NoopFsm, createFsm, DEFAULT_HISTORY_LIMIT } = require('../fsm');

/** Minimal traffic-light style fixture. */
function makeFsm(overrides = {}) {
  return new FiniteStateMachine({
    name: 'test',
    states: ['a', 'b', 'c'],
    transitions: {
      a: { go: 'b' },
      b: { go: 'c', back: 'a' },
    },
    initial: 'a',
    ...overrides,
  });
}

test('合法转移:按转移表推进,返回 {ok:true, from, to, event}', () => {
  const fsm = makeFsm();
  assert.equal(fsm.getState(), 'a');
  const r = fsm.fire('go', { note: 'x' });
  assert.deepEqual(r, { ok: true, from: 'a', to: 'b', event: 'go' });
  assert.equal(fsm.getState(), 'b');
  const h = fsm.getHistory();
  assert.equal(h.length, 1);
  assert.equal(h[0].from, 'a');
  assert.equal(h[0].to, 'b');
  assert.equal(h[0].event, 'go');
  assert.deepEqual(h[0].meta, { note: 'x' });
  assert.equal(typeof h[0].at, 'number');
  assert.ok(!h[0].illegal);
});

test('非法转移:保持原状态,历史含 illegal 记录,绝不抛(fail-soft 红线)', () => {
  const fsm = makeFsm();
  // 'back' has no edge from 'a'
  const r = fsm.fire('back', { why: 'test' });
  assert.equal(r.ok, false);
  assert.equal(r.from, 'a');
  assert.equal(r.to, 'a'); // state kept
  assert.equal(fsm.getState(), 'a');
  const h = fsm.getHistory();
  assert.equal(h.length, 1);
  assert.equal(h[0].illegal, true);
  assert.equal(h[0].from, 'a');
  assert.equal(h[0].event, 'back');
  assert.deepEqual(h[0].meta, { why: 'test' });
  // 完全未知事件、终态出边均不抛
  assert.doesNotThrow(() => fsm.fire('nonsense'));
  assert.doesNotThrow(() => fsm.fire(undefined));
});

test('历史环形缓冲:超过 historyLimit 只保留最近 N 条,顺序为旧→新', () => {
  const fsm = makeFsm({ historyLimit: 3 });
  // a→b, b→a, a→b, b→c: 4 entries, limit 3
  fsm.fire('go');
  fsm.fire('back');
  fsm.fire('go');
  fsm.fire('go');
  const h = fsm.getHistory();
  assert.equal(h.length, 3);
  // Oldest (a→b) evicted; remaining: b→a, a→b, b→c
  assert.deepEqual(
    h.map((e) => `${e.from}>${e.to}`),
    ['b>a', 'a>b', 'b>c']
  );
});

test('historyLimit 缺省为 50', () => {
  const fsm = makeFsm();
  assert.equal(DEFAULT_HISTORY_LIMIT, 50);
  for (let i = 0; i < 60; i++) {
    fsm.fire(i % 2 === 0 ? 'go' : 'back'); // a↔b bounce
  }
  assert.equal(fsm.getHistory().length, 50);
});

test('onStateChange:queueMicrotask 异步派发,fire 返回后才执行', async () => {
  const fsm = makeFsm();
  const calls = [];
  fsm.onStateChange = (prev, next, event, meta) => {
    calls.push({ prev, next, event, meta });
  };
  const r = fsm.fire('go', { m: 1 });
  // Synchronously after fire: hook has NOT run yet
  assert.equal(r.ok, true);
  assert.equal(calls.length, 0);
  await Promise.resolve(); // drain microtasks
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { prev: 'a', next: 'b', event: 'go', meta: { m: 1 } });
});

test('onStateChange:钩子抛异常被吞掉,不影响 FSM 与后续转移', async () => {
  const fsm = makeFsm();
  let hookRan = false;
  fsm.onStateChange = () => {
    hookRan = true;
    throw new Error('hook boom');
  };
  assert.doesNotThrow(() => fsm.fire('go'));
  await Promise.resolve();
  assert.equal(hookRan, true);
  assert.equal(fsm.getState(), 'b');
  // FSM still fully functional afterwards
  const r = fsm.fire('back');
  assert.equal(r.ok, true);
  await Promise.resolve();
  assert.equal(fsm.getState(), 'a');
});

test('非法转移不触发 onStateChange', async () => {
  const fsm = makeFsm();
  let called = 0;
  fsm.onStateChange = () => {
    called++;
  };
  fsm.fire('back'); // illegal from 'a'
  await Promise.resolve();
  assert.equal(called, 0);
});

test('toJSON:{name, state, since, history} 形状', () => {
  const fsm = makeFsm();
  fsm.fire('go');
  const j = fsm.toJSON();
  assert.equal(j.name, 'test');
  assert.equal(j.state, 'b');
  assert.equal(typeof j.since, 'number');
  assert.ok(Array.isArray(j.history));
  assert.equal(j.history.length, 1);
});

test('构造校验:initial 不在 states / 转移表指向未声明状态 → 构造抛(仅配置期,fire 期绝不抛)', () => {
  assert.throws(
    () => new FiniteStateMachine({ name: 'x', states: ['a'], transitions: {}, initial: 'zz' })
  );
  assert.throws(
    () =>
      new FiniteStateMachine({
        name: 'x',
        states: ['a'],
        transitions: { a: { go: 'ghost' } },
        initial: 'a',
      })
  );
});

test('flag 禁用:createFsm 返回 no-op 同形 FSM(fire 恒 {ok:false, disabled:true},getHistory 恒 [])', () => {
  // createFsm reads process.env; simulate the off-branch on this process
  const prev = process.env.KHY_FSM_ENABLED;
  process.env.KHY_FSM_ENABLED = '0';
  try {
    const fsm = createFsm({
      name: 'gated',
      states: ['a', 'b'],
      transitions: { a: { go: 'b' } },
      initial: 'a',
    });
    assert.ok(fsm instanceof NoopFsm);
    assert.equal(fsm.disabled, true); // read-only "gate off" marker
    const r = fsm.fire('go');
    assert.equal(r.ok, false);
    assert.equal(r.disabled, true);
    assert.equal(fsm.getState(), 'a'); // never advances
    assert.deepEqual(fsm.getHistory(), []);
    const j = fsm.toJSON();
    assert.equal(j.name, 'gated');
    assert.deepEqual(j.history, []);
    assert.equal(j.disabled, true); // toJSON exposes the disabled marker
  } finally {
    if (prev === undefined) {
      delete process.env.KHY_FSM_ENABLED;
    } else {
      process.env.KHY_FSM_ENABLED = prev;
    }
  }
});

test('flag 默认开:createFsm 返回真 FSM', () => {
  const prev = process.env.KHY_FSM_ENABLED;
  delete process.env.KHY_FSM_ENABLED;
  try {
    const fsm = createFsm({
      name: 'live',
      states: ['a', 'b'],
      transitions: { a: { go: 'b' } },
      initial: 'a',
    });
    assert.ok(fsm instanceof FiniteStateMachine);
    assert.equal(fsm.fire('go').ok, true);
    assert.equal(fsm.getState(), 'b');
  } finally {
    if (prev !== undefined) {
      process.env.KHY_FSM_ENABLED = prev;
    }
  }
});
