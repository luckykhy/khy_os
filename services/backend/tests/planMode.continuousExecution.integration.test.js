'use strict';

/**
 * planMode.continuousExecution.integration.test.js — P7 grey-rollout validation.
 *
 * The unit test (planMode.continuousExecution.test.js) proves the orchestration
 * with a mocked aiModule. This integration test validates the two properties
 * that gate flipping KHY_PLAN_CONTINUOUS on by default, against the REAL
 * machinery (real runToolUseLoop + real writeFile/readFile tools):
 *
 *   1. CROSS-STEP CONTEXT — a single continuous chat() call writes a file in
 *      "step 1" (writeFile) and reads it back in "step 2" (readFile) within the
 *      SAME tool loop; the read result (a unique token) flows into the model's
 *      next turn, proving state carries across steps in one loop rather than N
 *      isolated per-step turns.
 *
 *   2. HUMAN-GATE COMPATIBILITY — even though plan execution auto-activates Goal
 *      mode (which auto-approves tool permissions), a human-gate step STILL
 *      pauses for explicit confirmation up front; a declined step is excluded
 *      from the run and never reaches the loop.
 *
 * aiModule.chat here is a faithful mini-mirror of src/cli/ai.js chat(): it drives
 * the real toolUseLoop over the single serialized plan message. Only the model's
 * token output is scripted — orchestration, tool execution, and message flow are
 * the production code paths.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-p7-integration-home-'));
const TMP_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-p7-integration-cwd-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.KHYQUANT_CWD = TMP_CWD;
// Hermetic gates: let the real loop execute writeFile/readFile without prompts.
process.env.KHY_TASK_CAPABILITY_GATE = 'false';
process.env.KHY_EXEC_APPROVAL = 'off';
process.env.KHY_METACONSTRAINT = 'off';
process.env.KHY_SYSCALL_GATEWAY = 'off';
process.env.KHY_PERMISSION_STORE = 'false';

const { describe, test, afterEach, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const toolUseLoop = require('../src/services/toolUseLoop');
const planModeService = require('../src/services/planModeService');

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

/**
 * aiModule whose .chat() drives the REAL toolUseLoop over the message — mirroring
 * how src/cli/ai.js chat() delegates to runToolUseLoop. `scriptModel` is the
 * scripted per-turn model callback runToolUseLoop will call.
 */
function makeRealLoopAiModule(captured, scriptModel) {
  captured.chatCalls = 0;
  captured.messages = [];
  return {
    chat: async (message, opts) => {
      captured.chatCalls += 1;
      captured.messages.push(message);
      const loopResult = await toolUseLoop.runToolUseLoop(message, {
        chat: scriptModel,
        maxIterations: 8,
        sessionId: `p7-int-${captured.chatCalls}`,
        requestId: `p7-int-${captured.chatCalls}`,
        onControlRequest: (opts && opts.onControlRequest) || (async () => true),
      });
      return { reply: loopResult.finalResponse || '', provider: 'mock', tokenUsage: null };
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

describe('P7 grey-rollout validation (real toolUseLoop + real tools)', () => {
  beforeEach(() => { planModeService.reset(); process.env.KHY_PLAN_CONTINUOUS = '1'; });
  afterEach(() => {
    delete process.env.KHY_PLAN_CONTINUOUS;
    delete process.env.KHY_HUMAN_GATE;
    planModeService.reset();
  });

  test('cross-step context: step-1 write is read back by step-2 within ONE continuous loop', async () => {
    process.env.KHY_HUMAN_GATE = 'off';
    const token = 'KHY-XSTEP-7714';
    const artifact = path.join(TMP_CWD, 'p7_artifact.txt');

    const captured = {};
    // Scripted model: turn1 writeFile(token) → turn2 readFile → turn3 conclude.
    // Tool turns carry preface text (as real models do); empty-text tool turns
    // would trip the loop's forced-summary guard and suppress the 2nd tool call.
    let turn = 0;
    const scriptModel = async (message) => {
      turn += 1;
      if (turn === 1) {
        return {
          reply: '正在写入工件文件…',
          toolUseBlocks: [{ type: 'tool_use', id: 'w1', name: 'writeFile', input: { path: artifact, content: token } }],
          stopReason: 'tool_use',
          provider: 'mock',
        };
      }
      if (turn === 2) {
        return {
          reply: '正在读取工件文件…',
          toolUseBlocks: [{ type: 'tool_use', id: 'r1', name: 'readFile', input: { path: artifact } }],
          stopReason: 'tool_use',
          provider: 'mock',
        };
      }
      // turn 3: the readFile result must have flowed into this turn's message.
      if (String(message || '').includes(token)) captured.sawTokenInbound = true;
      return { reply: `PLAN-DONE token=${token}`, stopReason: 'stop', provider: 'mock' };
    };

    const plan = makePlan([
      { description: '步骤1：把配置令牌写入工件文件' },
      { description: '步骤2：读取工件文件并在结论中引用令牌' },
    ]);

    const results = await planModeService.executePlanSteps(plan, {
      ai: makeRealLoopAiModule(captured, scriptModel),
      renderer: makeRenderer(),
      rl: null,
    });

    // ① Exactly one continuous chat() call drove the WHOLE plan.
    assert.equal(captured.chatCalls, 1, 'continuous path must drive the plan in a single chat() call');
    // ② The single serialized message carried both steps.
    assert.match(captured.messages[0], /步骤1：把配置令牌写入工件文件/);
    assert.match(captured.messages[0], /步骤2：读取工件文件并在结论中引用令牌/);
    // ③ The file was actually written by the real writeFile tool.
    assert.equal(fs.readFileSync(artifact, 'utf8'), token, 'real writeFile must persist the token');
    // ④ CROSS-STEP CONTEXT: step-2's read result reached step-3's model turn in
    //    the SAME loop (would be impossible if each step were an isolated turn).
    assert.equal(captured.sawTokenInbound, true, 'read-back token must flow across steps within one loop');
    // ⑤ Final reply reflects the carried-over token; both steps marked completed.
    assert.ok(results.every(r => r.step.status === 'completed'));
    assert.match(results[results.length - 1].result.reply || '', new RegExp(token));
  });

  test('human-gate compatibility: a declined gate pauses and is excluded even with Goal mode auto-active', async () => {
    // KHY_HUMAN_GATE NOT off → gate is live. Plan execution will auto-activate
    // Goal mode (auto-approve permissions); the gate must still pause regardless.
    const goalModeService = require('../src/services/goalModeService');
    assert.equal(goalModeService.isActive(), false, 'precondition: Goal mode inactive before run');

    const captured = {};
    let sawGoalActiveDuringRun = false;
    // Trivial scripted model: just conclude (no tools needed for this assertion).
    const scriptModel = async () => {
      // Observe Goal mode state at the moment the loop actually runs.
      if (goalModeService.isActive()) sawGoalActiveDuringRun = true;
      return { reply: '步骤已完成。', stopReason: 'stop', provider: 'mock' };
    };

    const asked = [];
    const rl = {
      question: (prompt, cb) => { asked.push(prompt); cb('n'); }, // decline the gate
    };

    const plan = makePlan([
      { description: '危险步骤：删除生产数据库迁移', stepType: 'human-gate' },
      { description: '安全步骤：更新变更日志', stepType: 'flexible' },
    ]);

    const results = await planModeService.executePlanSteps(plan, {
      ai: makeRealLoopAiModule(captured, scriptModel),
      renderer: makeRenderer(),
      rl,
    });

    // Gate paused for confirmation despite Goal-mode auto-approval being active.
    assert.equal(asked.length, 1, 'human-gate must prompt the user');
    assert.equal(sawGoalActiveDuringRun, true, 'Goal mode should be auto-active during continuous run');
    // The declined step is excluded from the single run message; only the safe
    // step survives → still one continuous chat() call.
    assert.equal(captured.chatCalls, 1);
    assert.ok(!/删除生产数据库迁移/.test(captured.messages[0]), 'declined gate step must not reach the loop');
    assert.match(captured.messages[0], /更新变更日志/);
    const gated = results.find(r => r.step.description.includes('删除生产数据库迁移'));
    assert.ok(gated && gated.result.skipped === true, 'declined gate step must be marked skipped');
    // Goal mode restored after the run (no leak).
    assert.equal(goalModeService.isActive(), false, 'Goal mode must be deactivated after the run');
  });
});
