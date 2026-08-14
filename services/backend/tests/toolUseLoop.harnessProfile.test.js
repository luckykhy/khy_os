'use strict';

// Integration: the model-capability tier resolves to a harnessProfile that the
// loop threads through. First cut relaxes scaffolding for T0 (frontier) only,
// so a T0 model skips the behavioral nudges that a T1 model still receives.
//
// Probe = the "earlyEndTurn" nudge: an action request answered by a short,
// tool-less, inconclusive reply. For T1 this fires and forces a second chat
// round; for T0 (nudges off) the loop concludes at iteration 1.
//
// NOTE: the probe deliberately is NOT a "planning preface" ("我先看看…"). That
// shape now trips the tier-INDEPENDENT self-kickoff guard (Fix C / DESIGN-ARCH-050
// mirror), which fires for T0 too — so a preface probe could no longer
// differentiate tiers. The kickoff guard's own tier-independence is covered by
// the dedicated test below.

describe('toolUseLoop harness profile (model tiering)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.clearAllMocks();
  });

  function loadLoopWithStubbedTools() {
    jest.doMock('../src/services/toolCalling', () => ({
      executeTool: jest.fn(async () => ({ success: true, output: 'noop' })),
      clearPreflightContext: jest.fn(),
      setPreflightContext: jest.fn(),
    }));
    return require('../src/services/toolUseLoop');
  }

  const ACTION_MSG = '把桌面上的文件整理一下';
  // Short, tool-less, inconclusive — but NOT a planning preface (no "我先/让我…"
  // + task-verb shape), so it trips ONLY the tier-gated earlyEndTurn nudge, not
  // the tier-independent kickoff guard.
  const SHORT_INCONCLUSIVE = '这个任务有点棘手呢。';   // <200 chars, no tool, no conclusion word
  const CONCLUSIVE = '已整理完成，桌面文件已分类归档。'; // carries a conclusion word → loop ends
  // A genuine planning preface (for the kickoff-guard test): action verb + "我先".
  const PLANNING_PREFACE = '好的，我先看看桌面上有哪些文件。';

  test('T0 (opus-4-8) skips the earlyEndTurn nudge and concludes in one round', async () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    const toolUseLoop = loadLoopWithStubbedTools();

    const chat = jest.fn()
      .mockResolvedValueOnce({ reply: SHORT_INCONCLUSIVE })
      .mockResolvedValueOnce({ reply: CONCLUSIVE });

    const result = await toolUseLoop.runToolUseLoop(ACTION_MSG, {
      chat,
      maxIterations: 4,
      chatOpts: { model: 'claude-opus-4-8' },
    });

    expect(result.harnessProfile).toMatchObject({ tier: 'T0', nudges: false });
    expect(chat).toHaveBeenCalledTimes(1); // no nudge → no second round
    expect(result.finalResponse).toContain('棘手');
  });

  test('kickoff guard is tier-INDEPENDENT: T0 planning preface (no tools) is pushed to act', async () => {
    // Fix C / DESIGN-ARCH-050 mirror: the choppy "我先看看…" preface that ends the
    // turn with zero tool calls must NOT be returned to the user even on a strong
    // T0 model (whose behavioral nudges are off). The kickoff guard forces a second
    // round regardless of tier.
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    const toolUseLoop = loadLoopWithStubbedTools();

    const chat = jest.fn()
      .mockResolvedValueOnce({ reply: PLANNING_PREFACE })
      .mockResolvedValueOnce({ reply: CONCLUSIVE });

    const result = await toolUseLoop.runToolUseLoop(ACTION_MSG, {
      chat,
      maxIterations: 4,
      chatOpts: { model: 'claude-opus-4-8' }, // T0 → nudges off, but kickoff still fires
    });

    expect(result.harnessProfile).toMatchObject({ tier: 'T0', nudges: false });
    expect(chat).toHaveBeenCalledTimes(2); // kickoff guard forced a second round
    expect(result.finalResponse).toContain('已整理完成');
  });

  test('kickoff guard honors the KHY_SELF_KICKOFF=0 escape valve (preface returned as-is)', async () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    process.env.KHY_SELF_KICKOFF = '0';
    const toolUseLoop = loadLoopWithStubbedTools();

    const chat = jest.fn()
      .mockResolvedValueOnce({ reply: PLANNING_PREFACE })
      .mockResolvedValueOnce({ reply: CONCLUSIVE });

    const result = await toolUseLoop.runToolUseLoop(ACTION_MSG, {
      chat,
      maxIterations: 4,
      chatOpts: { model: 'claude-opus-4-8' },
    });

    // Escape valve off → kickoff guard disabled → T0 concludes at round 1.
    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.finalResponse).toContain('我先看看');
  });

  test('T1 (qwen-max) still receives the earlyEndTurn nudge (zero regression)', async () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    const toolUseLoop = loadLoopWithStubbedTools();

    const chat = jest.fn()
      .mockResolvedValueOnce({ reply: SHORT_INCONCLUSIVE })
      .mockResolvedValueOnce({ reply: CONCLUSIVE });

    const result = await toolUseLoop.runToolUseLoop(ACTION_MSG, {
      chat,
      maxIterations: 4,
      chatOpts: { model: 'qwen-max' },
    });

    expect(result.harnessProfile).toMatchObject({ tier: 'T1', nudges: true });
    expect(chat).toHaveBeenCalledTimes(2); // nudge fired → second round
    expect(result.finalResponse).toContain('已整理完成');
  });

  test('T0 lean verbosity skips the injected planning prompt; T1 keeps it', async () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    const toolUseLoop = loadLoopWithStubbedTools();

    // A complex, multi-step request that trips _isComplexTask → planning prompt.
    const COMPLEX = [
      '帮我重构这个后端项目，需要完成以下几步：',
      '1. 首先分析 auth 模块和 database 的依赖关系',
      '2. 然后拆分 service 层，修改相关 api endpoint',
      '3. 接着补充 test 用例并修复已知 bug',
      '4. 最后生成文档并更新 README',
    ].join('\n');
    const captured = [];
    const chat = jest.fn(async (msg) => { captured.push(msg); return { reply: '已完成重构并补齐测试与文档。' }; });

    await toolUseLoop.runToolUseLoop(COMPLEX, {
      chat, maxIterations: 4, chatOpts: { model: 'claude-opus-4-8' },
    });
    const t0FirstMsg = captured[0];

    jest.resetModules();
    const toolUseLoop2 = loadLoopWithStubbedTools();
    const captured2 = [];
    const chat2 = jest.fn(async (msg) => { captured2.push(msg); return { reply: '已完成重构并补齐测试与文档。' }; });
    await toolUseLoop2.runToolUseLoop(COMPLEX, {
      chat: chat2, maxIterations: 4, chatOpts: { model: 'qwen-max' },
    });
    const t1FirstMsg = captured2[0];

    // The injected planning scaffolding present for T1 is absent for T0.
    const PLAN_MARKER = 'This task has multiple steps';
    expect(t1FirstMsg).toContain(PLAN_MARKER);
    expect(t0FirstMsg).not.toContain(PLAN_MARKER);
  });

  test('KHY_CAPABILITY_TIER=T1 forces a frontier model back into full scaffolding', async () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    process.env.KHY_CAPABILITY_TIER = 'T1';
    const toolUseLoop = loadLoopWithStubbedTools();

    const chat = jest.fn()
      .mockResolvedValueOnce({ reply: SHORT_INCONCLUSIVE })
      .mockResolvedValueOnce({ reply: CONCLUSIVE });

    const result = await toolUseLoop.runToolUseLoop(ACTION_MSG, {
      chat,
      maxIterations: 4,
      chatOpts: { model: 'claude-opus-4-8' }, // would be T0, but env forces T1
    });

    expect(result.harnessProfile).toMatchObject({ tier: 'T1', nudges: true });
    expect(chat).toHaveBeenCalledTimes(2);
  });
});

// The unlock: a weak cloud model whose capability pre-check FAILS is no longer
// hard-refused at iteration 0 — the (now default) 'warn' gate folds the block
// reasons into context and proceeds, so the model gets to attempt delivery.
describe('toolUseLoop capability gate — weak-tier unlock (warn by default)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    try { require('../src/services/modelCapabilityPort')._resetForTest(); } catch { /* not loaded */ }
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.clearAllMocks();
  });

  function loadLoopWithStubbedTools() {
    jest.doMock('../src/services/toolCalling', () => ({
      executeTool: jest.fn(async () => ({ success: true, output: 'noop' })),
      clearPreflightContext: jest.fn(),
      setPreflightContext: jest.fn(),
    }));
    return require('../src/services/toolUseLoop');
  }

  // Force canProceed=false: 2 hard issues ≥ blockWhenHardIssueCountAtLeast(2).
  function registerFailingChecker() {
    const port = require('../src/services/modelCapabilityPort');
    port.registerModelCapabilityChecker(() => ({
      issues: ['模拟能力缺口A', '模拟能力缺口B'],
      recommendations: [],
    }));
  }

  // A complex + action request, ≥160 chars, that also fails the model pre-check.
  const HARD_TASK = [
    '帮我从零搭建一个完整的后端项目，要求完成以下所有步骤并交付可运行代码：',
    '1. 初始化项目结构与依赖；2. 实现 auth 鉴权模块与数据库 schema；',
    '3. 编写 service 层与 REST api endpoint；4. 补齐单元测试并修复全部 bug；',
    '5. 生成 README 文档并验证构建通过。请直接动手实现，不要只给建议。',
  ].join('');

  test('weak tier (qwen-max → T1) proceeds instead of hard-refusing at iter 0', async () => {
    // Gate is ENABLED here (do NOT set KHY_TASK_CAPABILITY_GATE=false).
    const toolUseLoop = loadLoopWithStubbedTools();
    registerFailingChecker();

    const chat = jest.fn().mockResolvedValue({ reply: '已完成项目搭建并通过构建与测试。' });
    let captured = null;
    const result = await toolUseLoop.runToolUseLoop(HARD_TASK, {
      chat,
      maxIterations: 3,
      chatOpts: { model: 'qwen-max' },
      onCapabilityCheck: (a) => { captured = a; },
    });

    // The pre-check DID fail (reasons were produced)...
    expect(captured && captured.reasons.length).toBeGreaterThan(0);
    // ...but the loop was NOT hard-blocked: it ran the model rather than returning
    // the capability-failure short-circuit.
    expect(result.errorType).not.toBe('capability');
    expect(chat).toHaveBeenCalled();
    expect(result.harnessProfile).toMatchObject({ tier: 'T1', capabilityGate: 'warn' });
  });

  test('KHY_HARNESS_CAPABILITY_GATE=hard restores the iteration-0 refusal', async () => {
    process.env.KHY_HARNESS_CAPABILITY_GATE = 'hard';
    const toolUseLoop = loadLoopWithStubbedTools();
    registerFailingChecker();

    const chat = jest.fn().mockResolvedValue({ reply: 'unreached' });
    const result = await toolUseLoop.runToolUseLoop(HARD_TASK, {
      chat,
      maxIterations: 3,
      chatOpts: { model: 'qwen-max' },
    });

    expect(result.errorType).toBe('capability');
    expect(result.iterations).toBe(0);
    expect(chat).not.toHaveBeenCalled();
  });
});
