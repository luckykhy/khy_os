'use strict';

/**
 * taskStateSpec — A2A TaskState 映射与迁移合法性的回归锁。
 *
 * 核心不变量：内部三套状态机（a2aAgentLifecycle / stateMachine.agentLifecycle /
 * subAgentOrchestrator）的**每一个**状态都必须能映射到规范状态；终态不得有出边。
 * 将来有人给内部状态机加一个状态却忘了映射，这里的 `unmappedKnownStates()` 断言会
 * 立刻报出名字 —— 而不是等外部 integrator 收到一个它不认识的状态。
 */

const spec = require('../../../src/services/a2a/taskStateSpec');

describe('taskStateSpec — 状态集', () => {
  test('规范状态集与 A2A v0.3.0 完全一致（9 个）', () => {
    expect(spec.A2A_TASK_STATES).toEqual([
      'submitted',
      'working',
      'input-required',
      'completed',
      'canceled',
      'failed',
      'rejected',
      'auth-required',
      'unknown',
    ]);
  });

  test('终态集合正确（4 个）', () => {
    expect(spec.TERMINAL_TASK_STATES).toEqual(['completed', 'canceled', 'failed', 'rejected']);
  });

  test('中断态集合正确', () => {
    expect(spec.INTERRUPTED_TASK_STATES).toEqual(['input-required', 'auth-required']);
  });
});

describe('taskStateSpec — 映射完备性', () => {
  test('所有已知内部状态都有映射', () => {
    expect(spec.unmappedKnownStates()).toEqual([]);
  });

  test('映射目标全部是规范合法状态', () => {
    expect(spec.invalidMappingTargets()).toEqual([]);
  });

  test('三套内部状态机的关键状态都映射到语义合理的目标', () => {
    // a2aAgentLifecycle
    expect(spec.toA2aState('pending')).toBe('submitted');
    expect(spec.toA2aState('spawning')).toBe('submitted');
    expect(spec.toA2aState('running')).toBe('working');
    expect(spec.toA2aState('waiting')).toBe('input-required');
    expect(spec.toA2aState('completing')).toBe('working');
    expect(spec.toA2aState('killing')).toBe('working');
    expect(spec.toA2aState('killed')).toBe('canceled');
    expect(spec.toA2aState('timed_out')).toBe('failed');
    // stateMachine/agentLifecycle
    expect(spec.toA2aState('created')).toBe('submitted');
    expect(spec.toA2aState('initializing')).toBe('submitted');
    expect(spec.toA2aState('ready')).toBe('submitted');
    expect(spec.toA2aState('error')).toBe('failed');
  });

  test('规范状态本身是幂等映射', () => {
    for (const s of spec.A2A_TASK_STATES) {
      expect(spec.toA2aState(s)).toBe(s);
    }
  });

  test('未知/畸形状态降级为 unknown，绝不抛', () => {
    for (const bad of [null, undefined, '', '   ', 42, {}, 'wat', 'SPAWNING ']) {
      expect(() => spec.toA2aState(bad)).not.toThrow();
    }
    expect(spec.toA2aState('wat')).toBe('unknown');
    expect(spec.toA2aState(null)).toBe('unknown');
    // 大小写与空白被归一
    expect(spec.toA2aState('  SPAWNING  ')).toBe('submitted');
  });

  test('严格模式下未映射状态触发告警回调', () => {
    const seen = [];
    const env = { KHY_A2A_STRICT_TASK_STATE: '1' };
    spec.toA2aState('brand_new_state', { env, onUnmapped: (s) => seen.push(s) });
    expect(seen).toEqual(['brand_new_state']);
  });

  test('默认（非严格）模式不打扰调用方', () => {
    const seen = [];
    spec.toA2aState('brand_new_state', { onUnmapped: (s) => seen.push(s) });
    expect(seen).toEqual([]);
  });
});

describe('taskStateSpec — isInternalTerminal', () => {
  test('终态内部状态被识别', () => {
    expect(spec.isInternalTerminal('completed')).toBe(true);
    expect(spec.isInternalTerminal('killed')).toBe(true);
    expect(spec.isInternalTerminal('failed')).toBe(true);
    expect(spec.isInternalTerminal('timed_out')).toBe(true);
  });

  test('非终态内部状态不被误判', () => {
    expect(spec.isInternalTerminal('running')).toBe(false);
    expect(spec.isInternalTerminal('waiting')).toBe(false);
  });
});

describe('taskStateSpec — canTransition', () => {
  test('常规前进路径合法', () => {
    expect(spec.canTransition('submitted', 'working')).toBe(true);
    expect(spec.canTransition('working', 'completed')).toBe(true);
    expect(spec.canTransition('working', 'input-required')).toBe(true);
    expect(spec.canTransition('input-required', 'working')).toBe(true);
    expect(spec.canTransition('working', 'canceled')).toBe(true);
    expect(spec.canTransition('working', 'failed')).toBe(true);
  });

  test('终态不得再迁（规范硬要求）', () => {
    for (const t of spec.TERMINAL_TASK_STATES) {
      expect(spec.ALLOWED_TRANSITIONS[t]).toEqual([]);
      expect(spec.canTransition(t, 'working')).toBe(false);
      expect(spec.canTransition(t, 'submitted')).toBe(false);
      // 同态仍算幂等上报,故只在目标是**别的**终态时断言拒绝
      for (const other of spec.TERMINAL_TASK_STATES) {
        if (other !== t) expect(spec.canTransition(t, other)).toBe(false);
      }
    }
  });

  test('同态迁移幂等（重复上报同一状态是合法的）', () => {
    for (const s of spec.A2A_TASK_STATES) {
      expect(spec.canTransition(s, s)).toBe(true);
    }
  });

  test('unknown 可迁到任何状态（承认自己不知道当前状态）', () => {
    for (const s of spec.A2A_TASK_STATES) {
      expect(spec.canTransition('unknown', s)).toBe(true);
    }
  });

  test('非法状态名一律拒绝，不猜', () => {
    expect(spec.canTransition('nope', 'working')).toBe(false);
    expect(spec.canTransition('working', 'nope')).toBe(false);
    expect(spec.canTransition(null, null)).toBe(false);
    expect(spec.canTransition('', 'working')).toBe(false);
  });

  test('不允许迁回 submitted（提交是一次性的）', () => {
    expect(spec.canTransition('working', 'submitted')).toBe(false);
    expect(spec.canTransition('completed', 'submitted')).toBe(false);
  });
});

describe('taskStateSpec — buildTaskStatus', () => {
  test('产出规范 TaskStatus 形状', () => {
    expect(spec.buildTaskStatus('running')).toEqual({ state: 'working' });
  });

  test('只在显式传入时才写 timestamp（保证确定性）', () => {
    const s = spec.buildTaskStatus('running', { timestamp: '2026-09-15T00:00:00.000Z' });
    expect(s).toEqual({ state: 'working', timestamp: '2026-09-15T00:00:00.000Z' });
    expect(spec.buildTaskStatus('running', { timestamp: '   ' })).toEqual({ state: 'working' });
  });

  test('可附带伴随消息（如 input-required 的提问）', () => {
    const msg = { kind: 'message', role: 'agent', messageId: 'm1', parts: [{ kind: 'text', text: '?' }] };
    const s = spec.buildTaskStatus('waiting', { message: msg });
    expect(s.state).toBe('input-required');
    expect(s.message).toBe(msg);
  });

  test('绝不抛：畸形输入退化为 unknown', () => {
    expect(() => spec.buildTaskStatus(undefined)).not.toThrow();
    expect(spec.buildTaskStatus(undefined).state).toBe('unknown');
  });
});
