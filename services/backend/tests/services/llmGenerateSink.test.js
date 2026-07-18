'use strict';

/**
 * llmGenerateSink — behavior lock for the best-effort LLM-generate provider sink
 * and the SCC decoupling cut it enables (node:test).
 *
 * The leaf inverts the sessionTraceSummary -> gateway/aiGateway edge
 * ([DESIGN-ARCH-051] §6.9): aiGateway publishes generate() here at load;
 * sessionTraceSummary pulls the provider through the leaf instead of importing
 * the 6000-line gateway. Cutting that single opt-in, best-effort query edge
 * detaches sessionTraceSummary + traceAuditService from the giant SCC
 * (giant 37 → 32; total cyclic 43 → 40, all remaining fragments baseline-drift).
 * This suite pins the sink contract, the best-effort absence semantics, and the
 * default-OFF / no-provider behavior of session-trace LLM compression.
 */

const test = require('node:test');
const assert = require('node:assert');

test('无 provider → getLlmGenerateProvider 返回 null', () => {
  const sink = require('../../src/services/llmGenerateSink');
  sink.setLlmGenerateProvider(null);
  assert.strictEqual(sink.getLlmGenerateProvider(), null);
});

test('注册 provider 后原样返回该函数（由调用方 await 调用）', () => {
  const sink = require('../../src/services/llmGenerateSink');
  const fn = async () => ({ success: true, content: 'ok' });
  sink.setLlmGenerateProvider(fn);
  assert.strictEqual(sink.getLlmGenerateProvider(), fn);
  sink.setLlmGenerateProvider(null);
});

test('传非函数 → 清空 provider', () => {
  const sink = require('../../src/services/llmGenerateSink');
  sink.setLlmGenerateProvider(async () => ({}));
  sink.setLlmGenerateProvider('not-a-fn');
  assert.strictEqual(sink.getLlmGenerateProvider(), null);
});

test('compressSummaryWithLLM 默认关闭（未启用）→ null，绝不触碰 provider', async () => {
  const sink = require('../../src/services/llmGenerateSink');
  let called = false;
  sink.setLlmGenerateProvider(async () => { called = true; return { success: true, content: 'X' }; });
  const sts = require('../../src/services/sessionTraceSummary');
  // 不传 useLLM 且未设 env → 默认关闭，提前返回 null，不调用 provider。
  delete process.env.KHY_SESSION_SUMMARY_USE_LLM;
  const r = await sts.compressSummaryWithLLM({ sessionId: 's', totalEvents: 1 });
  assert.strictEqual(r, null);
  assert.strictEqual(called, false, '关闭态绝不应调用 LLM provider');
  sink.setLlmGenerateProvider(null);
});

test('启用但无 provider（sink 未注册）→ null（best-effort 缺省，等同不可用）', async () => {
  const sink = require('../../src/services/llmGenerateSink');
  sink.setLlmGenerateProvider(null);
  const sts = require('../../src/services/sessionTraceSummary');
  const r = await sts.compressSummaryWithLLM({ sessionId: 's', totalEvents: 1 }, { useLLM: true });
  assert.strictEqual(r, null);
});

test('启用且有 provider → 经 sink 走通，返回压缩文本', async () => {
  const sink = require('../../src/services/llmGenerateSink');
  sink.setLlmGenerateProvider(async (prompt) => ({ success: true, content: '# Highlights\n- ok' }));
  const sts = require('../../src/services/sessionTraceSummary');
  const r = await sts.compressSummaryWithLLM({ sessionId: 's', totalEvents: 1 }, { useLLM: true });
  assert.match(String(r), /Highlights/);
  sink.setLlmGenerateProvider(null);
});

test('provider 抛错 → compressSummaryWithLLM 吞错返回 null（不升级为崩溃）', async () => {
  const sink = require('../../src/services/llmGenerateSink');
  sink.setLlmGenerateProvider(async () => { throw new Error('boom'); });
  const sts = require('../../src/services/sessionTraceSummary');
  const r = await sts.compressSummaryWithLLM({ sessionId: 's', totalEvents: 1 }, { useLLM: true });
  assert.strictEqual(r, null);
  sink.setLlmGenerateProvider(null);
});

test('aiGateway 加载即自注册为 provider', () => {
  require('../../src/services/gateway/aiGateway');
  const sink = require('../../src/services/llmGenerateSink');
  assert.strictEqual(typeof sink.getLlmGenerateProvider(), 'function');
});

test('叶子零依赖（含注释也无 require 调用语法——防架构债扫描器幽灵边回退）', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../../src/services/llmGenerateSink.js'), 'utf8');
  assert.strictEqual(/\brequire\s*\(/.test(src), false, 'llmGenerateSink leaf source (incl. comments) must contain no require-call syntax');
});
