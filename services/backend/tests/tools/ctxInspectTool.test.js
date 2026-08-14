'use strict';

/**
 * ctxInspectTool.test.js — CtxInspectTool 薄壳契约(node:test,隔离 process.env)。
 *
 * 锁定:
 *   - 门控 KHY_CTX_INSPECT=off → {success:false, disabled:true}(等价工具缺席,字节回退);
 *   - 默认开:读 HUD 会话态(经 require.cache 注入 stub hudRenderer)→ 喂叶子 → 成功结果;
 *   - HUD 不可用(getState 抛/缺)→ 退化空态,hudAvailable:false,绝不抛;
 *   - 只读/并发安全声明;可选 text → 估算 token(query 字段)。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const TOOL_PATH = require.resolve('../../src/tools/CtxInspectTool');
const HUD_PATH = require.resolve('../../src/cli/hudRenderer');

function freshTool() {
  delete require.cache[TOOL_PATH];
  const Tool = require('../../src/tools/CtxInspectTool');
  return new Tool();
}

function stubHud(state) {
  require.cache[HUD_PATH] = {
    id: HUD_PATH,
    filename: HUD_PATH,
    loaded: true,
    exports: { getState: () => state },
  };
}

describe('CtxInspectTool', () => {
  let savedInspect;
  beforeEach(() => {
    savedInspect = process.env.KHY_CTX_INSPECT;
  });
  afterEach(() => {
    if (savedInspect === undefined) delete process.env.KHY_CTX_INSPECT;
    else process.env.KHY_CTX_INSPECT = savedInspect;
    delete require.cache[HUD_PATH]; // 让真 hudRenderer 后续可恢复
  });

  test('只读/并发安全声明', () => {
    const t = freshTool();
    assert.equal(t.isReadOnly(), true);
    assert.equal(t.isConcurrencySafe(), true);
    assert.equal(t.constructor.toolName, 'CtxInspect');
  });

  test('门控 off → disabled,字节回退', async () => {
    process.env.KHY_CTX_INSPECT = 'off';
    const t = freshTool();
    const r = await t.execute({});
    assert.equal(r.success, false);
    assert.equal(r.disabled, true);
  });

  test('默认开:读 HUD → 喂叶子 → 成功结果', async () => {
    delete process.env.KHY_CTX_INSPECT;
    stubHud({
      contextWindow: { used: 60000, limit: 100000 },
      sessionTokens: { input: 1000, output: 500, total: 1500 },
      requestCount: 4,
      lastModel: 'demo-model',
      sessionCostUSD: 0.12,
    });
    const t = freshTool();
    const r = await t.execute({});
    assert.equal(r.success, true);
    assert.equal(r.hudAvailable, true);
    assert.equal(r.used, 60000);
    assert.equal(r.limit, 100000);
    assert.equal(r.limitSource, 'adapter');
    assert.equal(r.percentUsed, 60);
    assert.equal(r.remaining, 40000);
    assert.equal(r.sessionTotal, 1500);
    assert.equal(r.requestCount, 4);
    assert.equal(r.model, 'demo-model');
    assert.equal(r.sessionCostUSD, 0.12);
  });

  test('HUD getState 抛 → 退化空态,hudAvailable:false,不抛', async () => {
    delete process.env.KHY_CTX_INSPECT;
    require.cache[HUD_PATH] = {
      id: HUD_PATH,
      filename: HUD_PATH,
      loaded: true,
      exports: { getState: () => { throw new Error('hud not ready'); } },
    };
    const t = freshTool();
    let r;
    await assert.doesNotReject(async () => { r = await t.execute({}); });
    assert.equal(r.success, true);
    assert.equal(r.hudAvailable, false);
    assert.equal(r.used, 0);
    assert.equal(r.limitSource, 'env-fallback'); // 无适配器上限 → env 回退
  });

  test('可选 text → 估算 token(query 字段)', async () => {
    delete process.env.KHY_CTX_INSPECT;
    stubHud({ contextWindow: { used: 0, limit: 100000 }, sessionTokens: { input: 0, output: 0 } });
    const t = freshTool();
    const r = await t.execute({ text: 'hello world, this is some text' });
    assert.equal(r.success, true);
    assert.ok(r.query, 'query 字段应存在');
    assert.equal(r.query.textLength, 'hello world, this is some text'.length);
    assert.ok(Number.isFinite(r.query.estimatedTokens) && r.query.estimatedTokens > 0);
  });

  test('breakdown:true → per-category 分解(真实 System tools + Free space + 网格图例行)', async () => {
    let savedBd;
    savedBd = process.env.KHY_CONTEXT_BREAKDOWN;
    delete process.env.KHY_CTX_INSPECT;
    delete process.env.KHY_CONTEXT_BREAKDOWN;
    stubHud({ contextWindow: { used: 0, limit: 128000 }, sessionTokens: { input: 0, output: 0 }, lastModel: 'demo-model' });
    const t = freshTool();
    const r = await t.execute({ breakdown: true });
    assert.equal(r.success, true);
    assert.ok(r.breakdown, 'breakdown 字段应存在');
    const names = r.breakdown.categories.map((c) => c.name);
    assert.ok(names.includes('System tools'), 'System tools 类别来自真实 getToolDefinitions');
    assert.ok(names.includes('Free space'));
    assert.equal(r.breakdown.contextWindow, 128000);
    assert.ok(Array.isArray(r.breakdown.lines) && r.breakdown.lines.length > 10, '含 10 网格行 + 图例');
    assert.ok(r.breakdown.lines.some((l) => l.includes('System tools:')));
    if (savedBd === undefined) delete process.env.KHY_CONTEXT_BREAKDOWN;
    else process.env.KHY_CONTEXT_BREAKDOWN = savedBd;
  });

  test('breakdown 门控关(KHY_CONTEXT_BREAKDOWN=off)→ 无 breakdown 字段(字节回退)', async () => {
    let savedBd = process.env.KHY_CONTEXT_BREAKDOWN;
    delete process.env.KHY_CTX_INSPECT;
    process.env.KHY_CONTEXT_BREAKDOWN = 'off';
    stubHud({ contextWindow: { used: 0, limit: 128000 }, sessionTokens: { input: 0, output: 0 } });
    const t = freshTool();
    const r = await t.execute({ breakdown: true });
    assert.equal(r.success, true);
    assert.equal(r.breakdown, undefined, '门控关 → breakdown 缺失');
    if (savedBd === undefined) delete process.env.KHY_CONTEXT_BREAKDOWN;
    else process.env.KHY_CONTEXT_BREAKDOWN = savedBd;
  });

  test('无 breakdown 参数 → 结果不含 breakdown(向后兼容)', async () => {
    delete process.env.KHY_CTX_INSPECT;
    stubHud({ contextWindow: { used: 0, limit: 128000 }, sessionTokens: { input: 0, output: 0 } });
    const t = freshTool();
    const r = await t.execute({});
    assert.equal(r.breakdown, undefined);
  });
});
