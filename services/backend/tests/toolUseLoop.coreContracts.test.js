'use strict';

/**
 * toolUseLoop.coreContracts.test.js — locks five contract gaps in
 * src/services/toolUseLoopCore.js that the 43 existing toolUseLoop.* suites
 * do not cover:
 *   1. KHY_TOOL_LOOP feature gate: exported isEnabled() is a STRICT literal
 *      check (`!== 'false'`) — 'off'/'0'/'no' do NOT disable the loop.
 *   2. Max-iterations exit: bounded run with a tool-emitting model must
 *      return maxIterationsReached + truncated + iterations === the cap,
 *      with the honest CN limit warning (action + target + progress).
 *   3. Empty tool list: a substantive (>=400 char) tool-free reply is a
 *      complete delivery — the loop concludes in ONE chat turn (no soft
 *      "are you really done?" nudge turns).
 *   4. Audit record: the loop-level toolCallLog MUST carry one entry per
 *      executed tool ({ iteration, tool, params, result, elapsed }); the
 *      auxiliary sinks (middleware/auditLog.logToolExecution, the trajectory
 *      replayLedger) are best-effort fail-soft — their absence must never
 *      break or silence the delivered result.
 *   5. Per-tool interrupt timeout helpers (_buildToolInterruptPlan /
 *      _annotateInterruptTimeout / _formatInterruptTimeoutNotice): 'block'
 *      tools get a derived abort bounded by KHY_TOOL_INTERRUPT_BLOCK_MAX_MS;
 *      'cancel'/gate-off/no-signal stay byte-identical passthrough; only
 *      FAILED results get the CN notice appended to error.
 *
 * Zero network/process: counting fake chat + monkeypatched
 * toolCalling.executeTool, same pattern as tests/toolUseLoop.circuitBreakerNoTools.test.js.
 */

const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.KHY_TASK_CAPABILITY_GATE = 'false';
process.env.KHY_EXEC_APPROVAL = 'off';
process.env.KHY_TOOL_LOOP_RECOVERY_DELAY_MS = '1';

const toolCalling = require('../src/services/toolCalling');
const toolUseLoop = require('../src/services/toolUseLoop');
const core = require('../src/services/toolUseLoopCore');

describe('toolUseLoop core contracts', () => {
  const _saved = {};

  before(() => {
    for (const k of [
      'KHY_TOOL_LOOP',
      'KHY_TASK_CAPABILITY_GATE',
      'KHY_EXEC_APPROVAL',
      'KHY_TOOL_LOOP_RECOVERY_DELAY_MS',
      'KHY_TOOL_CIRCUIT_BREAKER_THRESHOLD',
    ]) {
      _saved[k] = process.env[k];
    }
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    process.env.KHY_EXEC_APPROVAL = 'off';
    process.env.KHY_TOOL_LOOP_RECOVERY_DELAY_MS = '1';
    // Keep the global circuit breaker out of the way of the iteration-cap test
    // (distinct glob calls would otherwise be the intended trip there).
    process.env.KHY_TOOL_CIRCUIT_BREAKER_THRESHOLD = '500';
    delete process.env.KHY_TOOL_LOOP;
  });

  after(() => {
    for (const [k, v] of Object.entries(_saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // ── 1. KHY_TOOL_LOOP gate ──────────────────────────────────────────────

  test('isEnabled: 默认开；仅字面量 "false" 关闭（"off"/"0"/"no" 不关）', () => {
    delete process.env.KHY_TOOL_LOOP;
    assert.equal(toolUseLoop.isEnabled(), true, 'unset → enabled');
    process.env.KHY_TOOL_LOOP = 'false';
    assert.equal(toolUseLoop.isEnabled(), false, '"false" → disabled');
    for (const v of ['off', '0', 'no']) {
      process.env.KHY_TOOL_LOOP = v;
      assert.equal(toolUseLoop.isEnabled(), true, `"${v}" must stay enabled (strict literal check)`);
    }
    process.env.KHY_TOOL_LOOP = 'true';
    assert.equal(toolUseLoop.isEnabled(), true, '"true" → enabled');
    delete process.env.KHY_TOOL_LOOP;
  });

  // ── 2. Max-iterations exit ────────────────────────────────────────────

  test('迭代上限触发：tool-emitting 模型在 cap=5 处有界退出并附诚实限额说明', async () => {
    let n = 0;
    const chat = async (_msg, chatOpts = {}) => {
      n += 1;
      // Even the forced tools-free grace turn keeps calling a (distinct) tool —
      // worst case for convergence; the budget must still bound the run.
      return {
        reply: `Let me keep exploring with glob call ${n}`,
        toolUseBlocks: [{ type: 'tool_use', id: `x${n}`, name: 'glob', input: { pattern: `d${n}/**` } }],
        stopReason: 'tool_use',
        provider: 'mock',
        model: 'weak-mini',
      };
    };

    toolCalling.executeTool = async () => ({ success: true, output: 'no matches', results: [] });
    const result = await toolUseLoop.runToolUseLoop('持续探索仓库结构', { chat, maxIterations: 5 });

    assert.equal(result.maxIterationsReached, true, 'exits via the max-iterations branch');
    // The requested cap may be boosted by the harness profile; the contract is
    // self-consistency (iterations pinned to the effective cap) plus a floor.
    const cap = result.maxIterations;
    assert.ok(cap >= 5, `effective cap must honor the requested 5 as a floor (was ${cap})`);
    assert.equal(result.iterations, cap, 'iterations pinned to the effective cap');
    assert.equal(result.truncated, true, 'partial result must be flagged truncated');
    assert.match(
      result.finalResponse,
      new RegExp(`已达到最大执行步骤数（${cap}）`),
      'honest CN limit line names the actual cap (action + target + progress)'
    );
    assert.ok(n >= cap, `the loop actually ran to the cap (chat turns: ${n})`);
    assert.ok(n <= cap + 2, `run stays bounded incl. at most one tools-free grace turn (chat turns: ${n})`);
  });

  // ── 3. Empty tool list: substantive reply concludes in one turn ──────

  test('空工具列表：>=400 字实质性回复单轮收尾（软门抑制，不追加确认轮）', async () => {
    // Default regime (KHY_SUPPRESS_SOFT_REDRIVE default-on): a substantive,
    // already-delivered answer must not re-drive the 7 soft "are you really
    // done?" gates into extra model turns.
    // ~840 unique chars, past the 400-char bar — deliberately NON-repetitive:
    // a degenerate repeated string would trip the 重复退化检测 guard and change the path.
    const answer = Array.from(
      { length: 24 },
      (_, i) => `第 ${i + 1} 层：模块 ${i} 承担职责 ${i}，对外暴露接口 ${i}，依赖方向遵循 L${i % 7} 层规范，测试覆盖该层契约。`
    ).join('');
    let turns = 0;
    const chat = async (_msg, chatOpts = {}) => {
      turns += 1;
      return {
        reply: answer,
        stopReason: 'stop',
        provider: 'mock',
        model: 'strong',
      };
    };

    toolCalling.executeTool = async () => ({ success: true, output: 'unused', results: [] });
    const result = await toolUseLoop.runToolUseLoop('分析这个仓库的架构，给出结论', { chat, maxIterations: 8 });

    assert.equal(turns, 1, `a substantive tool-free reply must conclude in ONE chat turn (saw ${turns})`);
    assert.equal(result.iterations, 1, 'exits on the first iteration');
    assert.equal(result.maxIterationsReached, undefined, 'not a limit exit');
    assert.match(result.finalResponse, /第 24 层：模块 23/, 'the substantive answer is delivered intact');
  });

  // ── 4. Audit events ───────────────────────────────────────────────────

  test('审计记录：工具执行在 result.toolCallLog 留痕（iteration/tool/params/result/elapsed）', async () => {
    let n = 0;
    const chat = async (_msg, chatOpts = {}) => {
      n += 1;
      if (n === 1 && !chatOpts._forceNoTools) {
        return {
          reply: '读取文件内容',
          toolUseBlocks: [{ type: 'tool_use', id: 'r1', name: 'read', input: { file_path: 'a.txt' } }],
          stopReason: 'tool_use',
          provider: 'mock',
          model: 'm',
        };
      }
      return { reply: '文件内容是 hello。', stopReason: 'stop', provider: 'mock', model: 'm' };
    };

    toolCalling.executeTool = async () => ({ success: true, output: 'hello', results: [] });
    const result = await toolUseLoop.runToolUseLoop('读一下 a.txt', { chat, maxIterations: 6 });

    assert.match(result.finalResponse, /文件内容是 hello/, 'the tool output is delivered');
    // 审计口径：主 sink（middleware/auditLog.logToolExecution、trajectory replayLedger）均为
    // best-effort fail-soft（当前缺失即静默跳过，绝不阻断热路径）；循环级 toolCallLog 是必须留痕的那一层。
    assert.ok(Array.isArray(result.toolCallLog), 'toolCallLog is the loop-level audit record');
    // 工具名在记录前经注册表归一化（'read' 是 'readFile' 的别名）——锁定的是「留痕 + 归一名」。
    const entry = result.toolCallLog.find((e) => e.tool === 'readFile');
    assert.ok(entry, `an audit entry exists for the (normalized) read tool call (saw: ${result.toolCallLog.map((e) => e.tool).join(',')})`);
    assert.ok(JSON.stringify(entry.params).includes('a.txt'), 'params are recorded verbatim');
    assert.equal(entry.result.success, true, 'the recorded result is the tool result');
    assert.ok(Number.isFinite(entry.elapsed), 'elapsed timing is recorded');
    assert.ok(Number.isInteger(entry.iteration) && entry.iteration >= 1, 'the entry is stamped with its iteration');
  });

  // ── 5. Per-tool interrupt timeout helpers ─────────────────────────────

  test('中断超时文案：动作+目标+时长（10000→10s、1500→1500ms、非法值→默认 10s）', () => {
    assert.equal(core._formatInterruptTimeoutNotice('shell', 10000), '等待工具 shell 完成超时(10s)，已强制中止');
    assert.equal(core._formatInterruptTimeoutNotice('shell', 1500), '等待工具 shell 完成超时(1500ms)，已强制中止');
    assert.equal(core._formatInterruptTimeoutNotice('shell', 0), '等待工具 shell 完成超时(10s)，已强制中止');
    assert.equal(core._formatInterruptTimeoutNotice('shell', NaN), '等待工具 shell 完成超时(10s)，已强制中止');
  });

  test('block 工具：父信号 abort 后有界宽限，到 KHY_TOOL_INTERRUPT_BLOCK_MAX_MS 才强制中止', async () => {
    const ac = new AbortController();
    const env = { KHY_TOOL_INTERRUPT_BLOCK_MAX_MS: '80' };
    const plan = core._buildToolInterruptPlan('shell', ac.signal, env, () => 'block');

    assert.notEqual(plan.signal, ac.signal, 'a block tool gets a DERIVED signal, not the raw parent');
    assert.equal(plan.maxMs, 80, 'the env override on KHY_TOOL_INTERRUPT_BLOCK_MAX_MS wins (hermetic env)');
    assert.equal(plan.timedOut(), false, 'not timed out before the parent aborts');

    ac.abort('user interrupt');
    assert.equal(plan.signal.aborted, false, 'grace window: derived signal is WITHHELD right after abort');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(plan.signal.aborted, true, 'derived signal force-aborts after the bound elapses');
    assert.equal(plan.timedOut(), true, 'timedOut() reports the forced cancel');
    assert.match(String(plan.signal.reason), /等待工具 shell 完成超时\(80ms\)，已强制中止/, 'reason carries the honest CN notice');
    plan.cleanup();
    assert.doesNotThrow(() => plan.cleanup(), 'cleanup is idempotent');
  });

  test('cancel 工具 / 门控关闭 / 无父信号：逐字节透传（signal===父、maxMs=0）', async () => {
    const ac = new AbortController();
    const cancelPlan = core._buildToolInterruptPlan('glob', ac.signal, {}, () => 'cancel');
    assert.equal(cancelPlan.signal, ac.signal, 'cancel behavior → raw parent passthrough');
    assert.equal(cancelPlan.maxMs, 0);
    assert.equal(cancelPlan.timedOut(), false);

    const gateOff = core._buildToolInterruptPlan('shell', ac.signal, { KHY_TOOL_INTERRUPT_BEHAVIOR: 'off' }, () => 'block');
    assert.equal(gateOff.signal, ac.signal, 'gate KHY_TOOL_INTERRUPT_BEHAVIOR=off → passthrough even for block tools');

    const noSignal = core._buildToolInterruptPlan('shell', null, {}, () => 'block');
    assert.equal(noSignal.signal, null, 'no parent signal → null passthrough');
  });

  test('父信号已 aborted 时 block 计划立即挂宽限计时器（不等第二次 abort）', async () => {
    const ac = new AbortController();
    ac.abort('pre-aborted');
    const plan = core._buildToolInterruptPlan('shell', ac.signal, { KHY_TOOL_INTERRUPT_BLOCK_MAX_MS: '40' }, () => 'block');
    assert.equal(plan.signal.aborted, false, 'still withheld inside the grace window');
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(plan.signal.aborted, true, 'pre-aborted parent starts the bound immediately');
    plan.cleanup();
  });

  test('_annotateInterruptTimeout：失败结果 error 追加中文说明，成功结果保持原形', () => {
    const notice = core._formatInterruptTimeoutNotice('shell', 10000);
    const failed = { success: false, error: 'killed' };
    const out = core._annotateInterruptTimeout(failed, 'shell', 10000);
    assert.equal(out._interruptTimeoutNotice, notice, 'notice always lands on the result');
    assert.equal(out.error, `killed\n${notice}`, 'failed result gets the notice appended to error');

    const succeeded = { success: true, output: 'ok' };
    const out2 = core._annotateInterruptTimeout(succeeded, 'shell', 10000);
    assert.equal(out2._interruptTimeoutNotice, notice);
    assert.equal(out2.error, undefined, 'a tool that survived the forced abort keeps its success shape');
    assert.equal(out2.output, 'ok', 'no other field is mutated');

    assert.equal(core._annotateInterruptTimeout('plain', 'shell', 10000), 'plain', 'non-object results pass through untouched');
  });
});
