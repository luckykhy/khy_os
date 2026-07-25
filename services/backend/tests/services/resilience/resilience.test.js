'use strict';

/**
 * resilience.test.js — 「有限窗口降级与强制兜底」执行协议验收测试（DESIGN-ARCH-029）。
 *
 * 全程零网络、零真实工具：runner 全部注入纯内存桩，按 Plan/参数返回成败。
 * 覆盖核心验收点（对应 /goal Goal13 五大交付物 + 防呆）：
 *   - 降级树：深度硬上限 = 3，超限抛错绝不静默截断；maxRetry 恒 1 写死。
 *   - 死循环检测：同一调用判死强制跳过；只有"换了输入"才放行那唯一一次重试。
 *   - 预算感知：低于地板/不足以支撑剩余节点 → 立即熔断兜底；地板默认 10%。
 *   - 强制兜底：穷尽路径输出 failed_with_salvage JSON，字段齐全、attempted_paths 非空、带残料与建议。
 *   - 端到端：模拟"获取网页连续失败"，Agent 在 ≤3 步内停止、输出兜底 JSON、无死循环、无第二遍循环。
 *   - 降级上下文注入：每次降级喊话模型"禁止道歉/禁止再试一次/直接下一个 Plan"。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ResilienceCoordinator,
  makeToolRunner,
  makeStepBudget,
  makeTokenBudget,
  BudgetAwareExecutor,
  FallbackTreeBuilder,
  FallbackTreeError,
  MAX_FALLBACK_DEPTH,
  MAX_RETRY_PER_PLAN,
  DeadLoopDetector,
  SalvageProtector,
  getIntentTree,
  buildWebContentTree,
  classifyFailure,
  callSignature,
} = require('../../../src/services/resilience');

// ── 测试桩：可编排每个工具成功/失败的内存 runner ───────────────────────
// outcomes: { [tool]: (params, meta) => result }  —— 缺省全失败。
function stubRunner(outcomes = {}, log = []) {
  return async function runner(tool, params, meta) {
    log.push({ tool, params, retry: meta && meta.retry });
    const fn = outcomes[tool];
    if (typeof fn === 'function') return fn(params, meta);
    return { success: false, error: `${tool} unavailable` };
  };
}

// ── 降级树：深度与重试硬约束 ──────────────────────────────────────────

describe('FallbackTree — 有限深度硬约束', () => {
  test('深度硬上限 = 3', () => {
    assert.equal(MAX_FALLBACK_DEPTH, 3);
    assert.equal(MAX_RETRY_PER_PLAN, 1);
  });

  test('第 4 个 Plan 抛 FallbackTreeError，绝不静默截断', () => {
    const b = new FallbackTreeBuilder('x')
      .plan('A', { tool: 'A' }).plan('B', { tool: 'B' }).plan('C', { tool: 'C' });
    assert.throws(() => b.plan('D', { tool: 'D' }), FallbackTreeError);
  });

  test('maxRetry 写死为 1，外部放大无效', () => {
    const tree = FallbackTreeBuilder.from('x', [{ plan: 'A', tool: 'A', maxRetry: 99 }]);
    assert.equal(tree.plans[0].maxRetry, 1);
  });

  test('空树拒绝构建', () => {
    assert.throws(() => new FallbackTreeBuilder('x').build(), FallbackTreeError);
  });
});

// ── 死循环检测 ────────────────────────────────────────────────────────

describe('DeadLoopDetector — 同一发子弹判死', () => {
  test('连续相同调用 → dead', () => {
    const d = new DeadLoopDetector();
    assert.equal(d.inspect('WebFetch', { url: 'u' }).dead, false);
    assert.equal(d.inspect('WebFetch', { url: 'u' }).dead, true);
  });

  test('changed: 仅签名变化才算真的换了输入', () => {
    const d = new DeadLoopDetector();
    assert.equal(d.changed('T', { a: 1 }, 'T', { a: 1 }), false);
    assert.equal(d.changed('T', { a: 1 }, 'T', { a: 2 }), true);
  });

  test('callSignature 与键序无关', () => {
    assert.equal(callSignature('T', { a: 1, b: 2 }), callSignature('T', { b: 2, a: 1 }));
  });
});

// ── 错误归类 ──────────────────────────────────────────────────────────

describe('classifyFailure — 结构化归类', () => {
  test('http 403 → http-403，不可瞬态重试', () => {
    const c = classifyFailure({ success: false, error: 'Request failed with status 403' });
    assert.equal(c.reason, 'http-403');
    assert.equal(c.retryable, false);
  });

  test('timeout → 可瞬态重试', () => {
    assert.equal(classifyFailure(new Error('socket ETIMEDOUT')).retryable, true);
  });

  test('missing dependency 抽出依赖名', () => {
    const c = classifyFailure({ success: false, error: 'puppeteer is not installed, run npm install puppeteer' });
    assert.equal(c.reason, 'missing-dependency');
    assert.equal(c.missingDependency, 'puppeteer');
  });
});

// ── 预算感知熔断 ──────────────────────────────────────────────────────

describe('BudgetAwareExecutor — 预算感知熔断', () => {
  test('低于地板（10%）立即熔断到兜底，不开新 Plan', async () => {
    // total=100, spent=95 → 5% < 10% 地板。
    const log = [];
    const exec = new BudgetAwareExecutor({
      runner: stubRunner({}, log),
      budget: makeTokenBudget({ total: 100, spent: () => 95 }),
    });
    const out = await exec.run(buildWebContentTree(), { url: 'u', query: 'q' });
    assert.equal(out.ok, false);
    assert.equal(out.circuit, 'budget-floor');
    assert.equal(log.length, 0, '预算见底时绝不真正调用工具');
    assert.equal(out.salvage.status, 'failed_with_salvage');
  });

  test('剩余步数不足以支撑剩余节点 → budget-insufficient 熔断', async () => {
    const log = [];
    // 步数预算只给 1 步，但树有 3 个 Plan。
    const exec = new BudgetAwareExecutor({
      runner: stubRunner({}, log),
      budget: makeStepBudget(1),
    });
    const out = await exec.run(buildWebContentTree(), { url: 'u', query: 'q' });
    assert.equal(out.ok, false);
    assert.match(out.circuit, /budget-(insufficient|floor)/);
  });
});

// ── 端到端：网页获取连续失败 ──────────────────────────────────────────

describe('端到端 — 获取网页连续失败', () => {
  test('3 步内停止、输出兜底 JSON、无死循环、无第二遍循环', async () => {
    const log = [];
    const degradeMsgs = [];
    // 三个 Web 工具全部失败，但各自吐一点残料。
    const runner = stubRunner({
      WebBrowser: () => ({ success: false, error: 'puppeteer is not installed' }),
      WebFetch: () => ({ success: false, error: 'Request failed with status 403', html: '<title>Partial</title>' }),
      WebSearch: () => ({ success: false, error: 'network ENOTFOUND', results: [{ title: '线索A', url: 'http://a' }] }),
    }, log);

    const coord = new ResilienceCoordinator({
      runner,
      budget: makeStepBudget(3),
      onDegrade: (text) => degradeMsgs.push(text),
    });
    const out = await coord.run('fetch-web-content', { url: 'http://x', query: 'q' });

    // 失败但已交差。
    assert.equal(out.ok, false);
    assert.equal(out.circuit, 'tree-exhausted');

    // ≤3 步停止：三个工具各打一次，绝不超。
    assert.equal(log.length, 3);
    assert.deepEqual(log.map((l) => l.tool), ['WebBrowser', 'WebFetch', 'WebSearch']);

    // 无死循环：没有任何工具被同参数连发两次。
    const sigs = log.map((l) => callSignature(l.tool, l.params));
    assert.equal(new Set(sigs).size, sigs.length);

    // 强制兜底 JSON 形状齐全。
    const s = out.salvage;
    assert.equal(s.status, 'failed_with_salvage');
    assert.equal(s.intent, '获取网页内容');
    assert.equal(s.attempted_paths.length, 3);
    assert.deepEqual(s.attempted_paths.map((p) => p.plan), ['WebBrowser', 'WebFetch', 'WebSearch']);
    assert.ok('salvage_data' in s);
    assert.ok(s.salvage_data.length > 0, '应抠到残料（部分标题/线索）');
    assert.ok(s.next_action_suggestion.length > 0);

    // 每次降级都注入了"禁止道歉/禁止再试一次"上下文（A→B、B→C 两次）。
    assert.equal(degradeMsgs.length, 2);
    for (const m of degradeMsgs) {
      assert.match(m, /禁止道歉/);
      assert.match(m, /剩余预算/);
    }
  });

  test('第一个 Plan 成功即返回，不继续降级', async () => {
    const log = [];
    const runner = stubRunner({
      WebBrowser: () => ({ success: true, content: '完整正文' }),
    }, log);
    const coord = new ResilienceCoordinator({ runner, budget: makeStepBudget(3) });
    const out = await coord.run('fetch-web-content', { url: 'http://x', query: 'q' });
    assert.equal(out.ok, true);
    assert.equal(out.plan, 'WebBrowser');
    assert.equal(log.length, 1, '成功后绝不多打一枪');
  });

  test('同类错误严禁死缠：无修复时每个 Plan 只打一次', async () => {
    const log = [];
    const runner = stubRunner({
      WebBrowser: () => ({ success: false, error: 'status 500' }),
      WebFetch: () => ({ success: false, error: 'status 500' }),
      WebSearch: () => ({ success: false, error: 'status 500' }),
    }, log);
    const coord = new ResilienceCoordinator({ runner, budget: makeStepBudget(3) });
    const out = await coord.run('fetch-web-content', { url: 'http://x', query: 'q' });
    assert.equal(out.ok, false);
    // 每个 Plan retry 恒 0（未提供 repair），总调用恰 3。
    assert.equal(log.length, 3);
    assert.ok(out.salvage.attempted_paths.every((p) => p.retry === 0));
  });
});

// ── 修复后那唯一一次重试 ──────────────────────────────────────────────

describe('max_retry=1 — 仅"修复输入后"放行一次重试', () => {
  test('repair 真正改变参数 → 重试一次并成功', async () => {
    const log = [];
    let calls = 0;
    const runner = stubRunner({
      WebBrowser: (params) => {
        calls += 1;
        // 第一次缺 token 失败；带上 token 的第二次成功。
        if (params.token) return { success: true, content: '修复后拿到正文' };
        return { success: false, error: 'unauthorized 401' };
      },
    }, log);
    const tree = FallbackTreeBuilder.from('t', [
      { plan: 'WebBrowser', tool: 'WebBrowser', buildParams: (c) => ({ url: c.url }) },
    ]);
    const exec = new BudgetAwareExecutor({ runner, budget: makeStepBudget(2) });
    const out = await exec.run(tree, {
      url: 'http://x',
      // 修复器：把缺失的 token 补进参数（真正改变了签名）。
      repair: ({ params }) => ({ changed: true, params: { ...params, token: 'T' } }),
    });
    assert.equal(out.ok, true);
    assert.equal(calls, 2, '首发 + 修复后重试一次');
    assert.equal(out.attempted[0].retry, 1);
  });

  test('repair 没真正改变参数 → 拒绝重试（视为死缠）', async () => {
    const log = [];
    let calls = 0;
    const runner = stubRunner({
      WebBrowser: () => { calls += 1; return { success: false, error: 'status 500' }; },
    }, log);
    const tree = FallbackTreeBuilder.from('t', [{ plan: 'WebBrowser', tool: 'WebBrowser', buildParams: (c) => ({ url: c.url }) }]);
    const exec = new BudgetAwareExecutor({ runner, budget: makeStepBudget(2) });
    const out = await exec.run(tree, {
      url: 'http://x',
      repair: ({ params }) => ({ changed: true, params: { ...params } }), // 同参数
    });
    assert.equal(out.ok, false);
    assert.equal(calls, 1, '参数没真的变 → 不放行重试');
  });
});

// ── SalvageProtector 防呆 ─────────────────────────────────────────────

describe('SalvageProtector — 兜底必须交差', () => {
  test('attempted 为空也补一条合成记录，字段恒全', () => {
    const s = SalvageProtector.assemble({ intent: 'i', attempted: [], circuit: 'budget-floor' });
    assert.equal(s.status, 'failed_with_salvage');
    assert.equal(s.attempted_paths.length, 1);
    assert.match(s.attempted_paths[0].reason, /aborted:budget-floor/);
    assert.ok('salvage_data' in s);
    assert.ok('next_action_suggestion' in s);
  });

  test('挑最长残料作 salvage_data', () => {
    const s = SalvageProtector.assemble({ intent: 'i', attempted: [{ plan: 'A', reason: 'x', retry: 0 }], salvageData: ['短', '这是更长的残料片段'] });
    assert.equal(s.salvage_data, '这是更长的残料片段');
  });

  test('missing-dependency 给出装依赖建议', () => {
    const s = SalvageProtector.assemble({
      intent: 'i', attempted: [{ plan: 'A', reason: 'missing-dependency', retry: 0 }],
      lastFailure: { reason: 'missing-dependency', missingDependency: 'puppeteer' },
      circuit: 'tree-exhausted',
    });
    assert.match(s.next_action_suggestion, /puppeteer/);
  });
});

// ── 门面：未知意图也交差 + makeToolRunner 适配 ────────────────────────

describe('ResilienceCoordinator 门面', () => {
  test('未知意图返回兜底而非抛错', async () => {
    const coord = new ResilienceCoordinator({ runner: stubRunner() });
    const out = await coord.run('no-such-intent', {});
    assert.equal(out.ok, false);
    assert.equal(out.circuit, 'unknown-intent');
    assert.equal(out.salvage.status, 'failed_with_salvage');
  });

  test('makeToolRunner 把 executeTool 包成 runner 并透传 plan 元数据', async () => {
    const seen = [];
    const fakeExecuteTool = async (tool, params, trace) => { seen.push({ tool, trace }); return { success: true, content: 'ok' }; };
    const runner = makeToolRunner(fakeExecuteTool, { sessionId: 's1' });
    const r = await runner('WebFetch', { url: 'u' }, { plan: 'WebFetch', retry: 0 });
    assert.equal(r.success, true);
    assert.equal(seen[0].trace.sessionId, 's1');
    assert.equal(seen[0].trace.resiliencePlan, 'WebFetch');
  });

  test('getIntentTree 返回内置 web 树', () => {
    const t = getIntentTree('fetch-web-content');
    assert.equal(t.plans.length, 3);
    assert.deepEqual(t.plans.map((p) => p.tool), ['WebBrowser', 'WebFetch', 'WebSearch']);
  });
});
