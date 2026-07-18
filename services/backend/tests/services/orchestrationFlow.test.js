'use strict';

const {
  runHardenedFlow,
  resolveStepType,
  _buildSummary,
} = require('../../src/services/orchestrationFlow');

describe('orchestrationFlow — step type derivation (B2)', () => {
  test('explicit stepType wins over derivation', () => {
    expect(resolveStepType({ stepType: 'flexible', risk: 'high' })).toBe('flexible');
    expect(resolveStepType({ stepType: 'human-gate' })).toBe('human-gate');
  });

  test('derives from risk signals via riskGate', () => {
    expect(resolveStepType({ risk: 'high' })).toBe('human-gate');
    expect(resolveStepType({ isDestructive: true })).toBe('human-gate');
    expect(resolveStepType({ isReadOnly: true })).toBe('hardened');
    expect(resolveStepType({ risk: 'low' })).toBe('hardened');
    expect(resolveStepType({ risk: 'medium' })).toBe('flexible');
  });

  test('an unspecified subtask derives flexible from riskGate (medium default)', () => {
    // With no risk signals, riskGate ranks risk as medium → flexible. The
    // run-mode fallback only applies if riskGate itself is unavailable.
    expect(resolveStepType({}, 'hardened')).toBe('flexible');
    expect(resolveStepType({}, 'mixed')).toBe('flexible');
  });
});

describe('orchestrationFlow — hardened SOP execution (B2)', () => {
  test('runs subtasks strictly in declared order', async () => {
    const order = [];
    const out = await runHardenedFlow({
      subtasks: [
        { name: 'a', stepType: 'hardened' },
        { name: 'b', stepType: 'hardened' },
        { name: 'c', stepType: 'hardened' },
      ],
      executeSubtask: async (st) => { order.push(st.name); return { success: true, text: st.name }; },
    });
    expect(order).toEqual(['a', 'b', 'c']);
    expect(out.state).toBe('completed');
    expect(out.summary.successCount).toBe(3);
    expect(out.summary.byStepType).toEqual({ hardened: 3 });
  });

  test('a failed hardened step stops the SOP (later steps skipped)', async () => {
    const ran = [];
    const out = await runHardenedFlow({
      subtasks: [
        { name: 'a', stepType: 'hardened' },
        { name: 'b', stepType: 'hardened' },
        { name: 'c', stepType: 'hardened' },
      ],
      executeSubtask: async (st) => {
        ran.push(st.name);
        return { success: st.name !== 'b', error: st.name === 'b' ? 'boom' : null };
      },
    });
    expect(ran).toEqual(['a', 'b']); // 'c' never runs
    expect(out.state).toBe('failed');
    expect(out.summary.failCount).toBe(1);
    expect(out.summary.subtasks.map(s => s.status)).toEqual(['completed', 'failed', 'skipped']);
  });

  test('a failed flexible step is non-fatal — the run continues', async () => {
    const ran = [];
    const out = await runHardenedFlow({
      subtasks: [
        { name: 'a', stepType: 'flexible' },
        { name: 'b', stepType: 'flexible' },
        { name: 'c', stepType: 'flexible' },
      ],
      executeSubtask: async (st) => {
        ran.push(st.name);
        return { success: st.name !== 'b', error: st.name === 'b' ? 'x' : null };
      },
    });
    expect(ran).toEqual(['a', 'b', 'c']);
    expect(out.state).toBe('completed');
    expect(out.summary.successCount).toBe(2);
    expect(out.summary.failCount).toBe(1);
  });

  test('a human-gate step parks the flow in WAITING until signalled', async () => {
    let released = false;
    const out = await runHardenedFlow({
      subtasks: [
        { name: 'a', stepType: 'hardened' },
        { name: 'gate', stepType: 'human-gate' },
        { name: 'c', stepType: 'hardened' },
      ],
      executeSubtask: async (st) => ({ success: true, text: st.name }),
      isGateReleased: () => released,
    });
    expect(out.waiting).toBe(true);
    expect(out.state).toBe('waiting');
    expect(out.summary.successCount).toBe(1); // only 'a' ran before the gate

    released = true;
    const resumed = await out.instance.signal({});
    expect(resumed.resumed).toBe(true);
    expect(resumed.state).toBe('completed');
  });

  test('empty subtask list completes immediately with a zeroed summary', async () => {
    const out = await runHardenedFlow({ subtasks: [], executeSubtask: async () => ({ success: true }) });
    expect(out.state).toBe('completed');
    expect(out.summary).toEqual({
      subtaskCount: 0, successCount: 0, failCount: 0, totalDurationMs: 0,
      byStepType: {}, byExecutor: {}, subtasks: [],
    });
  });

  test('summary shape matches SubAgentOrchestrator.summarize() contract', () => {
    const state = {
      results: [{ success: true }, { success: false }],
      timings: [10, 20],
      statuses: ['completed', 'failed'],
      types: ['hardened', 'flexible'],
      executors: ['claude', 'codex'],
    };
    const summary = _buildSummary([{ name: 'x' }, { name: 'y' }], state);
    expect(summary.subtaskCount).toBe(2);
    expect(summary.successCount).toBe(1);
    expect(summary.failCount).toBe(1);
    expect(summary.totalDurationMs).toBe(30);
    expect(summary.byStepType).toEqual({ hardened: 1, flexible: 1 });
    expect(summary.byExecutor).toEqual({ claude: 1, codex: 1 });
    expect(summary.subtasks).toHaveLength(2);
    expect(summary.subtasks[0]).toMatchObject({ executor: 'claude', stepType: 'hardened', durationMs: 10, status: 'completed' });
  });
});
