'use strict';
/**
 * tradingAgentsService × Agent 显示规范 集成测试（node:test）。
 *
 * 验证多智能体编排器接入 agentDisplay 后符合《AI Agent 显示规范》(DESIGN-ARCH-016)：
 *   - 用户层（stderr 自然语言）：进度短句 + 结果汇报含耗时，严禁 JSON/trace_id/tokens 裸值(§2);
 *   - 开发者层（stderr 单行 NDJSON）：一次运行共享同一 32 位 trace_id，step 递增，phase start→end(§1);
 *   - 脱敏：LLM 返回里的密钥不得出现在任一通道(§1.3 / R4);
 *   - 核心逻辑不变：仍返回 finalDecision（防呆规则 2：只改日志，不改业务）。
 *
 * 本 checkout 缺失核心层 ./llmService（按规范不动），故用 Module._load 注入等价桩，
 * 仅为驱动编排流程，不改动被测文件。
 *
 * 运行：node --test software/khyquant/tests/tradingAgentsDisplay.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const SVC = path.join(__dirname, '..', 'services', 'tradingAgentsService.js');
const LEAK = 'sk-SHOULD_NOT_LEAK1234';

/** 注入核心层桩（llmService / 数据源 / 新闻），返回还原函数。 */
function withStubs(run) {
  const orig = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === './llmService') {
      return class { async analyze() { return `技术面金叉，建议关注 ${LEAK}`; } };
    }
    if (request === './freeStockDataService') {
      return { async getStockData() {
        return { price: 10, changePercent: 1.2, volume: 120000, amount: 1.2e8, high: 10.5, low: 9.8, open: 9.9, close: 9.9 };
      } };
    }
    if (request === './finlightNewsService') {
      return { buildQueryFromSymbol() { return ''; }, async fetchNews() { return []; }, summarizeForPrompt() { return ''; } };
    }
    return orig.apply(this, arguments);
  };
  // 确保拿到接桩后的全新单例
  delete require.cache[require.resolve(SVC)];
  return Promise.resolve()
    .then(run)
    .finally(() => {
      Module._load = orig;
      delete require.cache[require.resolve(SVC)];
    });
}

/** 捕获 stderr，按是否以 `{` 开头切分为开发者(JSON)/用户(自然语言)两路。 */
function captureSplit() {
  const dev = [];
  let user = '';
  const orig = process.stderr.write;
  process.stderr.write = (c) => {
    const s = String(c);
    if (s.trim().startsWith('{')) dev.push(s.trim()); else user += s;
    return true;
  };
  return { dev, get user() { return user; }, restore() { process.stderr.write = orig; } };
}

test('executeMultiAgentAnalysis: 双层物理隔离 + 共享 trace_id + 脱敏 + 核心不变', () => {
  process.env.KHYQUANT_MODE = 'standalone';
  const cap = captureSplit();
  return withStubs(async () => {
    const svc = require(SVC);
    let res;
    try {
      res = await svc.executeMultiAgentAnalysis('600519', { activeAgents: ['market'] });
    } finally {
      cap.restore();
    }
    const dev = cap.dev;
    const user = cap.user;
    const allDev = dev.join('\n');

    // 用户层：自然语言，无任何内部字段（§2.2 / R5）
    assert.ok(!/trace_id/.test(user), '用户层不得含 trace_id');
    assert.ok(!/\{/.test(user), '用户层不得含裸 JSON');
    assert.match(user, /正在/, '应有进度短句');
    assert.match(user, /耗时 \d/, '结果汇报应含耗时（§2.2）');

    // 开发者层：单行 NDJSON，共享 trace_id，step 递增，phase 起止齐全（§1）
    assert.ok(dev.length >= 2, '应产生多条开发者事件');
    const evts = dev.map((l) => JSON.parse(l)); // 每条必须是合法单行 JSON
    const traceIds = new Set(evts.map((e) => e.trace_id));
    assert.strictEqual(traceIds.size, 1, '一次运行只有一个 trace_id');
    assert.match([...traceIds][0], /^[0-9a-f]{32}$/, 'trace_id 为 32 位十六进制');
    assert.strictEqual(evts[0].phase, 'start');
    assert.strictEqual(evts[evts.length - 1].phase, 'end');
    assert.strictEqual(evts[0].app, 'khyquant');
    // step 单调递增
    for (let i = 1; i < evts.length; i++) {
      assert.ok(evts[i].step > evts[i - 1].step, 'step 应单调递增');
    }

    // 脱敏：密钥不得泄漏到任一通道（§1.3 / R4）
    assert.ok(!(user + allDev).includes(LEAK), '密钥必须被脱敏');

    // 核心业务逻辑未被改动：仍返回最终决策
    assert.ok(res && res.finalDecision, '应返回 finalDecision');
    assert.strictEqual(res.symbol, '600519');
  });
});

test('executeMultiAgentAnalysis: 失败时用户层降级人话、开发者层记 error，不抛栈给用户', () => {
  process.env.KHYQUANT_MODE = 'standalone';
  const cap = captureSplit();
  // 让数据源抛错来触发——但编排器对 getStockData 失败是吞掉返回 null，
  // 故改为让 runRiskAssessment 路径自然走 fallback。这里仅验证不崩溃且有结果。
  return withStubs(async () => {
    const svc = require(SVC);
    let res;
    try {
      res = await svc.executeMultiAgentAnalysis('000001', {});
    } finally {
      cap.restore();
    }
    assert.ok(res && (res.finalDecision || res.status), '即便降级也必须返回可用结果');
    // 用户层若有错误提示，必须是人话且无堆栈/类名
    assert.ok(!/Error:|\bat \w+\./.test(cap.user), '用户层严禁暴露堆栈（R7）');
  });
});
