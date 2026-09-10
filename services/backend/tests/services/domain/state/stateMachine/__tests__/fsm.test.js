'use strict';
/**
 * fsm.test.js �?FiniteStateMachine 核心契约(node:test)�? *
 * 覆盖:合法转移推进;非法转移 fail-soft(保持原状�?+ illegal 历史,绝不�?;
 * 历史环形缓冲上限;onStateChange 微任务异步派�?fire 返回后才执行)且钩�? * 抛异常不影响 FSM;flag 禁用�?no-op 同形行为;toJSON 形状�? */
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

describe('Fsm', () => {
  test('合法转移:按转移表推进,返回 {ok:true, from, to, event}', async () => {
      const fsm = makeFsm();
      expect(fsm.getState()).toBe('a');
      const r = fsm.fire('go', { note: 'x' });
      assert.deepEqual(r, { ok: true, from: 'a', to: 'b', event: 'go' });
      expect(fsm.getState()).toBe('b');
      const h = fsm.getHistory();
      expect(h.length).toBe(1);
      expect(h[0].from).toBe('a');
      expect(h[0].to).toBe('b');
      expect(h[0].event).toBe('go');
      assert.deepEqual(h[0].meta, { note: 'x' });
      expect(typeof h[0].at).toBe('number');
      expect(!h[0].illegal).toBeTruthy();
  });

  test('非法转移:保持原状�?历史�?illegal 记录,绝不�?fail-soft 红线)', async () => {
      const fsm = makeFsm();
      // 'back' has no edge from 'a'
      const r = fsm.fire('back', { why: 'test' });
      expect(r.ok).toBe(false);
      expect(r.from).toBe('a');
      expect(r.to).toBe('a'); // state kept
      expect(fsm.getState()).toBe('a');
      const h = fsm.getHistory();
      expect(h.length).toBe(1);
      expect(h[0].illegal).toBe(true);
      expect(h[0].from).toBe('a');
      expect(h[0].event).toBe('back');
      assert.deepEqual(h[0].meta, { why: 'test' });
      // 完全未知事件、终态出边均不抛
      expect(() => fsm.fire('nonsense').not.toThrow());
      expect(() => fsm.fire(undefined).not.toThrow());
  });

  test('历史环形缓冲:超过 historyLimit 只保留最�?N �?顺序为旧→新', async () => {
      const fsm = makeFsm({ historyLimit: 3 });
      // a→b, b→a, a→b, b→c: 4 entries, limit 3
      fsm.fire('go');
      fsm.fire('back');
      fsm.fire('go');
      fsm.fire('go');
      const h = fsm.getHistory();
      expect(h.length).toBe(3);
      // Oldest (a→b) evicted; remaining: b→a, a→b, b→c
      assert.deepEqual(
        h.map((e) => `${e.from}>${e.to}`),
        ['b>a', 'a>b', 'b>c']
      );
  });

  test('historyLimit 缺省�?50', async () => {
      const fsm = makeFsm();
      expect(DEFAULT_HISTORY_LIMIT).toBe(50);
      for (let i = 0; i < 60; i++) {
        fsm.fire(i % 2 === 0 ? 'go' : 'back'); // a↔b bounce
      }
      expect(fsm.getHistory().length).toBe(50);
  });

  test('onStateChange:queueMicrotask 异步派发,fire 返回后才执行', async () => {
      const fsm = makeFsm();
      const calls = [];
      fsm.onStateChange = (prev, next, event, meta) => {
        calls.push({ prev, next, event, meta });
      };
      const r = fsm.fire('go', { m: 1 });
      // Synchronously after fire: hook has NOT run yet
      expect(r.ok).toBe(true);
      expect(calls.length).toBe(0);
      await Promise.resolve(); // drain microtasks
      expect(calls.length).toBe(1);
      assert.deepEqual(calls[0], { prev: 'a', next: 'b', event: 'go', meta: { m: 1 } });
  });

  test('onStateChange:钩子抛异常被吞掉,不影�?FSM 与后续转�?, async () => {
      const fsm = makeFsm();
      let hookRan = false;
      fsm.onStateChange = () => {
        hookRan = true;
        throw new Error('hook boom');
      };
      expect(() => fsm.fire('go').not.toThrow());
      await Promise.resolve();
      expect(hookRan).toBe(true);
      expect(fsm.getState()).toBe('b');
      // FSM still fully functional afterwards
      const r = fsm.fire('back');
      expect(r.ok).toBe(true);
      await Promise.resolve();
      expect(fsm.getState()).toBe('a');
  });

  test('非法转移不触�?onStateChange', async () => {
      const fsm = makeFsm();
      let called = 0;
      fsm.onStateChange = () => {
        called++;
      };
      fsm.fire('back'); // illegal from 'a'
      await Promise.resolve();
      expect(called).toBe(0);
  });

  test('toJSON:{name, state, since, history} 形状', async () => {
      const fsm = makeFsm();
      fsm.fire('go');
      const j = fsm.toJSON();
      expect(j.name).toBe('test');
      expect(j.state).toBe('b');
      expect(typeof j.since).toBe('number');
      expect(Array.isArray(j.history).toBeTruthy());
      expect(j.history.length).toBe(1);
  });

  test('构造校�?initial 不在 states / 转移表指向未声明状�?�?构造抛(仅配置期,fire 期绝不抛)', async () => {
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

  test('flag 禁用:createFsm 返回 no-op 同形 FSM(fire �?{ok:false, disabled:true},getHistory �?[])', async () => {
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
        expect(fsm instanceof NoopFsm).toBeTruthy();
        expect(fsm.disabled).toBe(true); // read-only "gate off" marker
        const r = fsm.fire('go');
        expect(r.ok).toBe(false);
        expect(r.disabled).toBe(true);
        expect(fsm.getState()).toBe('a'); // never advances
        assert.deepEqual(fsm.getHistory(), []);
        const j = fsm.toJSON();
        expect(j.name).toBe('gated');
        assert.deepEqual(j.history, []);
        expect(j.disabled).toBe(true); // toJSON exposes the disabled marker
      } finally {
        if (prev === undefined) {
          delete process.env.KHY_FSM_ENABLED;
        } else {
          process.env.KHY_FSM_ENABLED = prev;
        }
      }
  });

  test('flag 默认开:createFsm 返回�?FSM', async () => {
      const prev = process.env.KHY_FSM_ENABLED;
      delete process.env.KHY_FSM_ENABLED;
      try {
        const fsm = createFsm({
          name: 'live',
          states: ['a', 'b'],
          transitions: { a: { go: 'b' } },
          initial: 'a',
        });
        expect(fsm instanceof FiniteStateMachine).toBeTruthy();
        expect(fsm.fire('go').ok).toBe(true);
        expect(fsm.getState()).toBe('b');
      } finally {
        if (prev !== undefined) {
          process.env.KHY_FSM_ENABLED = prev;
        }
      }
  });

});

