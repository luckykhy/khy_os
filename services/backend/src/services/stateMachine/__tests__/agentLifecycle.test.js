'use strict';

/**
 * agentLifecycle.test.js — agent 生命周期 FSM 契约(node:test)。
 *
 * 覆盖:完整生命周期序列 created→initializing→ready→running→completed;
 * error 分支(含从 created 直接 fail,对应 processAgent 的 depth-guard);
 * killed 分支;终态无出边(fail-soft 记录 illegal);常量与转移表导出。
 */

const assert = require('node:assert');
const { test } = require('node:test');

const {
  AGENT_STATES: S,
  AGENT_EVENTS: E,
  AGENT_TRANSITIONS,
  createAgentLifecycleFsm,
} = require('../agentLifecycle');

test('完整生命周期:created→initializing→ready→running→completed', () => {
  const fsm = createAgentLifecycleFsm();
  assert.equal(fsm.getState(), S.CREATED);

  assert.equal(fsm.fire(E.SPAWN_START).ok, true);
  assert.equal(fsm.getState(), S.INITIALIZING);

  assert.equal(fsm.fire(E.INIT_OK).ok, true);
  assert.equal(fsm.getState(), S.READY);

  assert.equal(fsm.fire(E.TASK_START).ok, true);
  assert.equal(fsm.getState(), S.RUNNING);

  assert.equal(fsm.fire(E.TASK_DONE).ok, true);
  assert.equal(fsm.getState(), S.COMPLETED);

  // 4 legal transitions recorded, none illegal
  const h = fsm.getHistory();
  assert.equal(h.length, 4);
  assert.ok(h.every((e) => !e.illegal));
});

test('error 分支:从 created 直接 fail(depth-guard 场景)', () => {
  const fsm = createAgentLifecycleFsm();
  const r = fsm.fire(E.FAIL, { reason: 'depth-guard' });
  assert.equal(r.ok, true);
  assert.equal(r.from, S.CREATED);
  assert.equal(r.to, S.ERROR);
  assert.equal(fsm.getState(), S.ERROR);
});

test('error 分支:每个非终态都可 fail 到 error', () => {
  // created → error
  assert.equal(AGENT_TRANSITIONS[S.CREATED][E.FAIL], S.ERROR);
  // initializing → error (child exit/error during init)
  assert.equal(AGENT_TRANSITIONS[S.INITIALIZING][E.FAIL], S.ERROR);
  // ready → error
  assert.equal(AGENT_TRANSITIONS[S.READY][E.FAIL], S.ERROR);
  // running → error (RESULT-path ERROR / unexpected exit)
  assert.equal(AGENT_TRANSITIONS[S.RUNNING][E.FAIL], S.ERROR);
  // 走一条实际路径:running 中失败
  const fsm = createAgentLifecycleFsm();
  fsm.fire(E.SPAWN_START);
  fsm.fire(E.INIT_OK);
  fsm.fire(E.TASK_START);
  assert.equal(fsm.fire(E.FAIL).ok, true);
  assert.equal(fsm.getState(), S.ERROR);
});

test('killed 分支:每个非终态都可 kill 到 killed', () => {
  for (const from of [S.CREATED, S.INITIALIZING, S.READY, S.RUNNING]) {
    assert.equal(AGENT_TRANSITIONS[from][E.KILL], S.KILLED, `kill from ${from}`);
  }
  // 走一条实际路径:initializing 中被 kill
  const fsm = createAgentLifecycleFsm();
  fsm.fire(E.SPAWN_START);
  assert.equal(fsm.fire(E.KILL).ok, true);
  assert.equal(fsm.getState(), S.KILLED);
});

test('终态无出边:completed/error/killed 上任何事件都 fail-soft', () => {
  const cases = [
    { drive: [E.SPAWN_START, E.INIT_OK, E.TASK_START, E.TASK_DONE], terminal: S.COMPLETED },
    { drive: [E.FAIL], terminal: S.ERROR },
    { drive: [E.KILL], terminal: S.KILLED },
  ];
  for (const { drive, terminal } of cases) {
    const fsm = createAgentLifecycleFsm();
    for (const ev of drive) {
      fsm.fire(ev);
    }
    assert.equal(fsm.getState(), terminal);
    for (const ev of Object.values(E)) {
      const r = fsm.fire(ev);
      assert.equal(r.ok, false, `${terminal} --${ev}--> must be illegal`);
      assert.equal(fsm.getState(), terminal, 'terminal state must be kept');
    }
    const illegal = fsm.getHistory().filter((e) => e.illegal);
    assert.equal(illegal.length, Object.values(E).length);
  }
});

test('乱序事件 fail-soft:created 上 task_done 不推进不抛', () => {
  const fsm = createAgentLifecycleFsm();
  const r = fsm.fire(E.TASK_DONE);
  assert.equal(r.ok, false);
  assert.equal(fsm.getState(), S.CREATED);
  assert.equal(fsm.getHistory()[0].illegal, true);
});

test('常量导出:状态集与 processAgent JSDoc 一致;工厂可命名', () => {
  assert.deepEqual(Object.values(S).sort(), [
    'completed',
    'created',
    'error',
    'initializing',
    'killed',
    'ready',
    'running',
  ]);
  const fsm = createAgentLifecycleFsm({ name: 'agent:pa-abc123' });
  assert.equal(fsm.toJSON().name, 'agent:pa-abc123');
  assert.equal(fsm.toJSON().state, S.CREATED);
});
