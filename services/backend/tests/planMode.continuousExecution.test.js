'use strict';

/**
 * planMode.continuousExecution.test.js — P7 of the KHY⇄CC mode-alignment work.
 *
 * CC runs an approved plan inside the SAME agent loop, so context flows across
 * steps. KHY's legacy executor calls aiModule.chat() once per step (N isolated
 * turns → cross-step fragmentation).
 *
 * P7 (KHY_PLAN_CONTINUOUS, default off): when '1', the approved plan is
 * serialized into ONE structured task message and handed to a single
 * aiModule.chat() call whose tool loop runs the steps continuously. Human-gate
 * steps are still confirmed up front and excluded if denied. Default ('0'/unset)
 * keeps the legacy per-step executor — zero behavior change.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-plan-continuous-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const { describe, test, afterEach, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const planModeService = require('../src/services/planModeService');

// ── Minimal renderer stub (continuous + legacy paths only touch these) ──
function makeRenderer() {
  class TaskPlanTracker {
    constructor() { this.tasks = []; }
    addTask(label) { this.tasks.push(label); }
    render() {}
    start() {}
    complete() {}
    fail() {}
    skip() {}
  }
  return {
    TaskPlanTracker,
    printStepLine() {},
    printStepDetail() {},
    renderAiResponse: (t) => String(t || ''),
  };
}

// aiModule.chat spy: records every call; returns a passing result by default.
function makeAi(captured, reply = '已完成。') {
  captured.calls = [];
  return {
    chat: async (message, opts) => {
      captured.calls.push({ message, opts });
      return { reply, provider: 'mock', tokenUsage: null };
    },
  };
}

function makePlan(steps) {
  return {
    steps: steps.map((s, i) => ({
      id: i + 1,
      description: s.description,
      status: 'pending',
      stepType: s.stepType || 'flexible',
      blocks: [],
      blockedBy: [],
    })),
  };
}

describe('plan continuous main-loop execution (P7)', () => {
  beforeEach(() => { planModeService.reset(); });
  afterEach(() => {
    delete process.env.KHY_PLAN_CONTINUOUS;
    delete process.env.KHY_PLAN_STEP_RETRY;
    delete process.env.KHY_HUMAN_GATE;
    planModeService.reset();
  });

  test('continuous path runs the whole plan in a SINGLE chat() call with cross-step context', async () => {
    process.env.KHY_PLAN_CONTINUOUS = '1';
    process.env.KHY_HUMAN_GATE = 'off';
    const captured = {};
    const plan = makePlan([
      { description: '创建 config 模块骨架' },
      { description: '为 config 模块补充边界检查' },
      { description: '编写并运行单元测试' },
    ]);
    const stepResults = [];
    const results = await planModeService.executePlanSteps(plan, {
      ai: makeAi(captured),
      renderer: makeRenderer(),
      rl: null,
      onStepResult: (r) => stepResults.push(r),
    });

    // Exactly one model call drives the entire plan.
    assert.equal(captured.calls.length, 1, 'continuous path must issue a single chat() call');
    const msg = captured.calls[0].message;
    // The single message carries every step (cross-step context in one turn).
    assert.match(msg, /创建 config 模块骨架/);
    assert.match(msg, /为 config 模块补充边界检查/);
    assert.match(msg, /编写并运行单元测试/);
    assert.match(msg, /连续执行已批准的计划/);
    // No ANSI color codes leaked from stepTypeTag into the prompt.
    assert.ok(!/\[/.test(msg), 'serialized message must be plain text (no ANSI)');
    // One result per step, all completed.
    assert.equal(results.length, 3);
    assert.ok(results.every(r => r.step.status === 'completed'));
    assert.equal(stepResults.length, 3);
  });

  test('continuous path: a denied human-gate step pauses, is skipped, and excluded from the run message', async () => {
    process.env.KHY_PLAN_CONTINUOUS = '1';
    const captured = {};
    const plan = makePlan([
      { description: '只读分析现有代码', stepType: 'flexible' },
      { description: '删除旧的迁移脚本', stepType: 'human-gate' },
      { description: '更新文档', stepType: 'flexible' },
    ]);
    const asked = [];
    const rl = {
      question: (prompt, cb) => { asked.push(prompt); cb('n'); }, // user declines the gate
    };
    const results = await planModeService.executePlanSteps(plan, {
      ai: makeAi(captured),
      renderer: makeRenderer(),
      rl,
    });

    // The human-gate step paused for explicit confirmation.
    assert.equal(asked.length, 1, 'human-gate step must prompt the user');
    // Still a single continuous call for the surviving steps.
    assert.equal(captured.calls.length, 1);
    const msg = captured.calls[0].message;
    assert.match(msg, /只读分析现有代码/);
    assert.match(msg, /更新文档/);
    // The denied step is NOT handed to the model.
    assert.ok(!/删除旧的迁移脚本/.test(msg), 'denied human-gate step must be excluded from the run message');
    // Plan reports the gated step as skipped.
    const gated = results.find(r => r.step.description === '删除旧的迁移脚本');
    assert.ok(gated && gated.result.skipped === true);
  });

  test('default (flag off): legacy executor issues one chat() call PER step', async () => {
    // KHY_PLAN_CONTINUOUS unset → legacy path.
    process.env.KHY_PLAN_STEP_RETRY = '0'; // exactly one attempt per step
    process.env.KHY_HUMAN_GATE = 'off';
    const captured = {};
    const plan = makePlan([
      { description: '步骤一' },
      { description: '步骤二' },
    ]);
    const results = await planModeService.executePlanSteps(plan, {
      ai: makeAi(captured),
      renderer: makeRenderer(),
      rl: null,
    });

    // Legacy = N isolated calls (one per step), not a single continuous loop.
    assert.equal(captured.calls.length, 2, 'legacy path must call chat() once per step');
    // Each call carries a single step prompt, not the whole serialized plan.
    assert.ok(!captured.calls[0].message.includes('连续执行已批准的计划'));
    assert.equal(results.length, 2);
  });
});
