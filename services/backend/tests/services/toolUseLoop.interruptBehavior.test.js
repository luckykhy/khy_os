'use strict';

/**
 * toolUseLoop.interruptBehavior.test.js — interruptBehavior 循环消费接线
 *
 * 声明层（_baseTool BEHAVIOR_DEFAULTS / registry 透传）早已完备，缺口在执行循环
 * 零消费。本套件锁定 toolUseLoopCore 新增的唯一消费点：
 *   - _buildToolInterruptPlan：'cancel'（默认）/ 门控关 / 无父信号 → 原 parent
 *     signal 逐字节透传（现状不变）；'block' → 派生信号把用户中断压到工具跑完，
 *     等待上界 KHY_TOOL_INTERRUPT_BLOCK_MAX_MS，超时强制中止（兜底转 cancel）。
 *   - _annotateInterruptTimeout / _formatInterruptTimeoutNotice：超时后的如实
 *     中文上报（动作+目标+进度）。
 *
 * Hermetic 隔离策略：不驱动真实核心循环、不读写真实 ~/.khy/。行为解析器与 env
 * 全部依赖注入（resolveBehavior / env 参数），不 mutate process.env；jest 全局
 * setup（jest.taskStoreIsolation / jest.logIsolation）已把数据目录钉到临时目录，
 * 集成冒烟仅做导出面与注册表解析验证。所有等待均有显式上界（jest per-test
 * timeout + 小步 ms 常量加速）。
 */

const loop = require('../../src/services/toolUseLoop');
const flagRegistry = require('../../src/services/flagRegistry');

// Small, deterministic step sizes (ms) so every wait is bounded and fast.
const BLOCK_MAX_FAST = 100;   // shrunk KHY_TOOL_INTERRUPT_BLOCK_MAX_MS for tests
const TOOL_FAST = 30;         // stub tool that finishes within the block window
const TOOL_SLOW = 5000;       // stub tool that outlives the block window
const SETTLE_EXTRA = 120;     // post-cleanup observation window
const TEST_TIMEOUT = 3000;    // hard upper bound per test
const REGISTRY_TIMEOUT = 30000; // registry smoke loads the full tool registry (slow, still bounded)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Controllable stub tool: resolves after durationMs unless the signal aborts first. */
function runStubTool(durationMs, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve({ success: true, output: 'done' }), durationMs);
    if (signal) {
      const onAbort = () => {
        clearTimeout(t);
        reject(new Error(String((signal.reason !== undefined && signal.reason !== null) ? signal.reason : 'aborted')));
      };
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

beforeEach(() => {
  jest.resetModules();
});

describe('registry declarations (工程红线: 两个新 env 已登记)', () => {
  test('KHY_TOOL_INTERRUPT_BEHAVIOR is a registered default-on boolean', () => {
    const spec = flagRegistry.FLAGS.KHY_TOOL_INTERRUPT_BEHAVIOR;
    expect(spec).toBeDefined();
    expect(spec.mode).toBe('default-on');
    expect(spec.default).toBe(true);
    expect(flagRegistry.isFlagEnabled('KHY_TOOL_INTERRUPT_BEHAVIOR', {})).toBe(true);
    expect(flagRegistry.isFlagEnabled('KHY_TOOL_INTERRUPT_BEHAVIOR', { KHY_TOOL_INTERRUPT_BEHAVIOR: 'off' })).toBe(false);
  });

  test('KHY_TOOL_INTERRUPT_BLOCK_MAX_MS is a registered numeric, default 10000', () => {
    const spec = flagRegistry.FLAGS.KHY_TOOL_INTERRUPT_BLOCK_MAX_MS;
    expect(spec).toBeDefined();
    expect(spec.mode).toBe('numeric');
    expect(spec.default).toBe(10000);
    expect(flagRegistry.resolveNumeric('KHY_TOOL_INTERRUPT_BLOCK_MAX_MS', {})).toBe(10000);
    expect(flagRegistry.resolveNumeric('KHY_TOOL_INTERRUPT_BLOCK_MAX_MS', { KHY_TOOL_INTERRUPT_BLOCK_MAX_MS: String(BLOCK_MAX_FAST) })).toBe(BLOCK_MAX_FAST);
  });
});

describe('路径 1 — cancel（现状）: 即时中止, 原信号逐字节透传', () => {
  test("'cancel' tool → plan.signal IS the parent signal (immediate abort semantics)", async () => {
    const parent = new AbortController();
    const plan = loop._buildToolInterruptPlan('stub_tool', parent.signal, {}, () => 'cancel');
    expect(plan.signal).toBe(parent.signal);
    expect(plan.timedOut()).toBe(false);

    const p = runStubTool(TOOL_SLOW, plan.signal);
    parent.abort('interrupt');
    await expect(p).rejects.toThrow('interrupt'); // aborted at once, no grace window
    plan.cleanup();
    expect(plan.timedOut()).toBe(false);
  }, TEST_TIMEOUT);

  test("gate off → even a 'block' tool falls back to the raw cancel path", () => {
    const parent = new AbortController();
    const env = { KHY_TOOL_INTERRUPT_BEHAVIOR: 'off' };
    const plan = loop._buildToolInterruptPlan('stub_tool', parent.signal, env, () => 'block');
    expect(plan.signal).toBe(parent.signal);
    plan.cleanup();
  });

  test('no parent signal (KHY_TOOL_ABORT_SIGNAL off) → null passthrough', () => {
    const plan = loop._buildToolInterruptPlan('stub_tool', null, {}, () => 'block');
    expect(plan.signal).toBeNull();
    expect(plan.timedOut()).toBe(false);
    plan.cleanup();
  });
});

describe("路径 2 — block: 中断到达时让执行中的工具跑完再处理", () => {
  test('tool finishing inside the block window completes; derived signal never aborts', async () => {
    const parent = new AbortController();
    const env = { KHY_TOOL_INTERRUPT_BLOCK_MAX_MS: String(BLOCK_MAX_FAST) };
    const plan = loop._buildToolInterruptPlan('stub_tool', parent.signal, env, () => 'block');
    expect(plan.signal).not.toBe(parent.signal);
    expect(plan.maxMs).toBe(BLOCK_MAX_FAST);

    const p = runStubTool(TOOL_FAST, plan.signal);
    parent.abort('interrupt');                  // user interrupt arrives mid-run
    expect(plan.signal.aborted).toBe(false);    // withheld from the running tool

    await expect(p).resolves.toEqual({ success: true, output: 'done' });
    plan.cleanup();                             // disarm timer after the tool settled
    expect(plan.timedOut()).toBe(false);

    await sleep(BLOCK_MAX_FAST + SETTLE_EXTRA); // past the would-be deadline
    expect(plan.signal.aborted).toBe(false);    // cleanup really disarmed the force-cancel
  }, TEST_TIMEOUT);

  test('parent already aborted BEFORE the tool starts → grace window still applies', async () => {
    const parent = new AbortController();
    parent.abort('interrupt');
    const env = { KHY_TOOL_INTERRUPT_BLOCK_MAX_MS: String(BLOCK_MAX_FAST) };
    const plan = loop._buildToolInterruptPlan('stub_tool', parent.signal, env, () => 'block');
    expect(plan.signal.aborted).toBe(false);

    const p = runStubTool(TOOL_FAST, plan.signal);
    await expect(p).resolves.toEqual({ success: true, output: 'done' });
    plan.cleanup();
    expect(plan.timedOut()).toBe(false);
  }, TEST_TIMEOUT);
});

describe('路径 3 — block 超时兜底: 上界到期强制中止并如实上报', () => {
  test('tool outliving KHY_TOOL_INTERRUPT_BLOCK_MAX_MS is force-cancelled with the CN notice', async () => {
    const parent = new AbortController();
    const env = { KHY_TOOL_INTERRUPT_BLOCK_MAX_MS: String(BLOCK_MAX_FAST) };
    const plan = loop._buildToolInterruptPlan('stub_tool', parent.signal, env, () => 'block');

    const p = runStubTool(TOOL_SLOW, plan.signal);
    parent.abort('interrupt');

    await expect(p).rejects.toThrow(/等待工具 stub_tool 完成超时\(100ms\)，已强制中止/);
    plan.cleanup();
    expect(plan.timedOut()).toBe(true);

    // The call-site annotation carries the honest report onto the tool result.
    const result = loop._annotateInterruptTimeout({ success: false, error: 'aborted' }, 'stub_tool', plan.maxMs);
    expect(result._interruptTimeoutNotice).toBe('等待工具 stub_tool 完成超时(100ms)，已强制中止');
    expect(result.error).toContain('等待工具 stub_tool 完成超时(100ms)，已强制中止');
  }, TEST_TIMEOUT);

  test('notice formatting: whole seconds render as Ns (default 10000 → 10s)', () => {
    expect(loop._formatInterruptTimeoutNotice('X', 10000)).toBe('等待工具 X 完成超时(10s)，已强制中止');
    expect(loop._formatInterruptTimeoutNotice('X', 250)).toBe('等待工具 X 完成超时(250ms)，已强制中止');
  });

  test('a tool that ignored the forced abort and still succeeded keeps its success shape', () => {
    const result = loop._annotateInterruptTimeout({ success: true, output: 'done' }, 'stub_tool', 100);
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result._interruptTimeoutNotice).toContain('已强制中止');
  });
});

describe('集成冒烟 — 导出面与 registry 解析', () => {
  test('helpers are exported through the toolUseLoop facade', () => {
    expect(typeof loop._resolveInterruptBehavior).toBe('function');
    expect(typeof loop._buildToolInterruptPlan).toBe('function');
    expect(typeof loop._annotateInterruptTimeout).toBe('function');
    expect(typeof loop._formatInterruptTimeoutNotice).toBe('function');
  });

  test("registry-backed resolution: no built-in tool declares 'block' today (零行为变化)", () => {
    // Unknown tool + a known read tool both resolve 'cancel' — the default-on
    // gate is therefore behavior-neutral until a tool opts into 'block'.
    expect(loop._resolveInterruptBehavior('definitely_not_a_tool_xyz')).toBe('cancel');
    expect(loop._resolveInterruptBehavior('read_file')).toBe('cancel');
  }, REGISTRY_TIMEOUT);

  test("default production wiring resolves 'block' plans only via declarations", () => {
    // Real resolver (registry) + real env: a 'cancel' tool must get passthrough.
    const parent = new AbortController();
    const plan = loop._buildToolInterruptPlan('read_file', parent.signal, {});
    expect(plan.signal).toBe(parent.signal);
    plan.cleanup();
  }, REGISTRY_TIMEOUT);
});
