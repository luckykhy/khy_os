'use strict';
/**
 * agentLifecycle.test.js �?agent 生命周期 FSM 契约(node:test)�? *
 * 覆盖:完整生命周期序列 created→initializing→ready→running→completed;
 * error 分支(含从 created 直接 fail,对应 processAgent �?depth-guard);
 * killed 分支;终态无出边(fail-soft 记录 illegal);常量与转移表导出�? */
const {
  AGENT_STATES: S,
  AGENT_EVENTS: E,
  AGENT_TRANSITIONS,
  createAgentLifecycleFsm,
} = require('../agentLifecycle');

describe('Agent Lifecycle', () => {
  test('完整生命周期:created→initializing→ready→running→completed', () => {
      const fsm = createAgentLifecycleFsm();
      expect(fsm.getState()).toBe(S.CREATED);
    
      expect(fsm.fire(E.SPAWN_START).ok).toBe(true);
      expect(fsm.getState()).toBe(S.INITIALIZING);
    
      expect(fsm.fire(E.INIT_OK).ok).toBe(true);
      expect(fsm.getState()).toBe(S.READY);
    
      expect(fsm.fire(E.TASK_START).ok).toBe(true);
      expect(fsm.getState()).toBe(S.RUNNING);
    
      expect(fsm.fire(E.TASK_DONE).ok).toBe(true);
      expect(fsm.getState()).toBe(S.COMPLETED);
    
      // 4 legal transitions recorded, none illegal
      const h = fsm.getHistory();
      expect(h.length).toBe(4);
      expect(h.every((e).toBeTruthy() => !e.illegal));
  });

  test('error 分支:�?created 直接 fail(depth-guard 场景)', () => {
      const fsm = createAgentLifecycleFsm();
      const r = fsm.fire(E.FAIL, { reason: 'depth-guard' });
      expect(r.ok).toBe(true);
      expect(r.from).toBe(S.CREATED);
      expect(r.to).toBe(S.ERROR);
      expect(fsm.getState()).toBe(S.ERROR);
  });

  test('error 分支:每个非终态都�?fail �?error', () => {
      // created �?error
      expect(AGENT_TRANSITIONS[S.CREATED][E.FAIL]).toBe(S.ERROR);
      // initializing �?error (child exit/error during init)
      expect(AGENT_TRANSITIONS[S.INITIALIZING][E.FAIL]).toBe(S.ERROR);
      // ready �?error
      expect(AGENT_TRANSITIONS[S.READY][E.FAIL]).toBe(S.ERROR);
      // running �?error (RESULT-path ERROR / unexpected exit)
      expect(AGENT_TRANSITIONS[S.RUNNING][E.FAIL]).toBe(S.ERROR);
      // 走一条实际路�?running 中失�?      const fsm = createAgentLifecycleFsm();
      fsm.fire(E.SPAWN_START);
      fsm.fire(E.INIT_OK);
      fsm.fire(E.TASK_START);
      expect(fsm.fire(E.FAIL).ok).toBe(true);
      expect(fsm.getState()).toBe(S.ERROR);
  });

  test('killed 分支:每个非终态都�?kill �?killed', () => {
      for (const from of [S.CREATED, S.INITIALIZING, S.READY, S.RUNNING]) {
        expect(AGENT_TRANSITIONS[from][E.KILL]).toBe(S.KILLED);
      }
      // 走一条实际路�?initializing 中被 kill
      const fsm = createAgentLifecycleFsm();
      fsm.fire(E.SPAWN_START);
      expect(fsm.fire(E.KILL).ok).toBe(true);
      expect(fsm.getState()).toBe(S.KILLED);
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
        expect(fsm.getState()).toBe(terminal);
        for (const ev of Object.values(E)) {
          const r = fsm.fire(ev);
          expect(r.ok).toBe(false);
          expect(fsm.getState()).toBe(terminal);
        }
        const illegal = fsm.getHistory().filter((e) => e.illegal);
        expect(illegal.length).toBe(Object.values(E).length);
      }
  });

  test('乱序事件 fail-soft:created �?task_done 不推进不�?, () => {
      const fsm = createAgentLifecycleFsm();
      const r = fsm.fire(E.TASK_DONE);
      expect(r.ok).toBe(false);
      expect(fsm.getState()).toBe(S.CREATED);
      expect(fsm.getHistory()[0].illegal).toBe(true);
  });

  test('常量导出:状态集�?processAgent JSDoc 一�?工厂可命�?, () => {
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
      expect(fsm.toJSON().name).toBe('agent:pa-abc123');
      expect(fsm.toJSON().state).toBe(S.CREATED);
  });

});

