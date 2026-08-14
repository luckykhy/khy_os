'use strict';

/**
 * cacheMetricsTruth.test.js — 「缓存命中率如实上报」叶子的单元 + 门控字节回退 + E2E(node:test)。
 *
 * 立场(goal 2026-07-04 截图:用户问「你的缓存命中率是多少 / ai 模型的命中率」,khy 答「我不
 * 确定……我没有访问实时缓存监控数据的工具」并转移话题)。覆盖四面 ——
 *   ① 命中率提问识别(CJK 两种问法 + 英文;零假阳性:无关请求不算);
 *   ② 搪塞判定(不确定 / 无监控工具 / 取决于… / 没给数字 → 搪塞;已给百分比 → 不算);
 *   ③ 真实遥测归一 + 真值脚注 + A 层指令构造,含 ON/OFF 逐字节回退与零编造降级;
 *   ④ E2E:命中率提问 + 搪塞答复 → 追加真实本轮/累计命中率;OFF → 不追加。
 */

const test = require('node:test');
const assert = require('node:assert');

const cmt = require('../../src/services/cacheMetricsTruth');

// 本轮 usage:input 1000、cacheRead 3000、cacheWrite 0 → 命中率 3000/4000 = 75%。
const TURN_USAGE = { inputTokens: 1000, cacheReadInputTokens: 3000, cacheWriteInputTokens: 0 };
// getReport() 形状:hitRate 为 0..1 小数。
const REPORT = {
  adapters: {
    sensenova: { requests: 42, hitRate: 0.58, verdict: 'transparent_caching', totalInputTokens: 100000, totalCacheReadTokens: 58000 },
    openrouter: { requests: 7, hitRate: 0.03, verdict: 'no_cache_benefit', totalInputTokens: 20000, totalCacheReadTokens: 600 },
  },
};

test('isEnabled: 默认开,仅显式 0/false/off/no 关', () => {
  assert.strictEqual(cmt.isEnabled({}), true);
  assert.strictEqual(cmt.isEnabled({ KHY_CACHE_METRICS_TRUTH: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(cmt.isEnabled({ KHY_CACHE_METRICS_TRUTH: off }), false, `off=${off}`);
  }
});

test('isCacheMetricsQuestion: 截图两问 + 其它命中率问法命中', () => {
  for (const q of [
    '你的缓存命中率是多少', 'ai模型的命中率', '缓存命中率是多少', '命中率多少',
    'khy 的命中率怎么样', '当前会话的命中率', '你们的缓存命中率高吗',
    'what is your cache hit rate', 'what is the hit rate', 'how high is the cache hit rate',
  ]) {
    assert.strictEqual(cmt.isCacheMetricsQuestion(q), true, `pos: ${q}`);
  }
});

test('isCacheMetricsQuestion: 无关 → false(零假阳性)', () => {
  for (const q of [
    '帮我写个斐波那契函数', '推荐一个开源大模型', '今天天气怎么样',
    'help me debug this', 'what time is it', '', '   ', null, undefined,
  ]) {
    assert.strictEqual(cmt.isCacheMetricsQuestion(q), false, `neg: ${q}`);
  }
});

test('resolveMetrics: 本轮命中率 + 各渠道累计归一(0..100、按 requests 降序、过滤无样本)', () => {
  const m = cmt.resolveMetrics({ turnUsage: TURN_USAGE, report: REPORT, activeAdapter: 'sensenova' });
  assert.strictEqual(Math.round(m.turnRate), 75);
  assert.strictEqual(m.hasData, true);
  assert.strictEqual(m.activeKey, 'sensenova');
  assert.strictEqual(m.adapters.length, 2);
  // 降序:sensenova(42)在前
  assert.strictEqual(m.adapters[0].key, 'sensenova');
  assert.strictEqual(Math.round(m.adapters[0].ratePct), 58);
  assert.strictEqual(m.adapters[1].key, 'openrouter');
});

test('resolveMetrics: 无样本渠道被过滤;全无遥测 → hasData:false', () => {
  const m1 = cmt.resolveMetrics({ report: { adapters: { x: { requests: 0, hitRate: 0.9 } } } });
  assert.strictEqual(m1.adapters.length, 0);
  assert.strictEqual(m1.hasData, false);
  const m2 = cmt.resolveMetrics({});
  assert.strictEqual(m2.hasData, false);
  assert.strictEqual(m2.turnRate, null);
});

test('resolveMetrics: 本轮无缓存字段 → turnRate null(不臆造)', () => {
  const m = cmt.resolveMetrics({ turnUsage: { inputTokens: 500 }, report: { adapters: {} } });
  assert.strictEqual(m.turnRate, null);
  assert.strictEqual(m.hasData, false);
});

test('detectDeflection: 截图搪塞答复 → deflected', () => {
  const m = cmt.resolveMetrics({ turnUsage: TURN_USAGE, report: REPORT, activeAdapter: 'sensenova' });
  const v1 = cmt.detectDeflection('我不确定你的缓存命中率是多少。这个指标通常取决于具体的系统配置。', m);
  assert.strictEqual(v1.deflected, true);
  const v2 = cmt.detectDeflection('我没有访问实时缓存监控数据的工具。', m);
  assert.strictEqual(v2.deflected, true);
  const vEn = cmt.detectDeflection("I don't have access to real-time cache monitoring tools.", m);
  assert.strictEqual(vEn.deflected, true);
});

test('detectDeflection: 通篇无百分比数字 → deflected(no-figure)', () => {
  const m = cmt.resolveMetrics({ turnUsage: TURN_USAGE, report: REPORT });
  const v = cmt.detectDeflection('缓存命中率会随查询模式变化而波动。', m);
  assert.strictEqual(v.deflected, true);
  assert.strictEqual(v.reason, 'no-figure');
});

test('detectDeflection: 答复已给具体百分比且不搪塞 → 不追加(stated)', () => {
  const m = cmt.resolveMetrics({ turnUsage: TURN_USAGE, report: REPORT });
  const v = cmt.detectDeflection('当前缓存命中率约为 75%。', m);
  assert.strictEqual(v.deflected, false);
  assert.strictEqual(v.reason, 'stated');
});

test('detectDeflection: 无真实遥测 → 不介入(no-data)', () => {
  const m = cmt.resolveMetrics({});
  const v = cmt.detectDeflection('我不确定。', m);
  assert.strictEqual(v.deflected, false);
  assert.strictEqual(v.reason, 'no-data');
});

test('buildMetricsFooter: 含真实本轮+当前渠道累计+标记;zh', () => {
  const m = cmt.resolveMetrics({ turnUsage: TURN_USAGE, report: REPORT, activeAdapter: 'sensenova' });
  const f = cmt.buildMetricsFooter(m, { locale: 'zh' });
  assert.ok(f.includes(cmt.METRICS_MARKER));
  assert.ok(f.includes('75%'));           // 本轮
  assert.ok(f.includes('sensenova') && f.includes('58%') && f.includes('42'));
});

test('buildMetricsFooter: 无 active 渠道 → 回退各渠道累计;en', () => {
  const m = cmt.resolveMetrics({ turnUsage: TURN_USAGE, report: REPORT, activeAdapter: 'unknown-x' });
  const fe = cmt.buildMetricsFooter(m, { locale: 'en' });
  assert.ok(fe.includes('real supply channel') === false); // 这是身份叶子的措辞,本叶子不含
  assert.ok(fe.includes('cache-billing probe'));
  assert.ok(fe.includes('sensenova'));
});

test('buildMetricsFooter: 无遥测 → null;门控关 → null(字节回退)', () => {
  assert.strictEqual(cmt.buildMetricsFooter(cmt.resolveMetrics({}), { locale: 'zh' }), null);
  const m = cmt.resolveMetrics({ turnUsage: TURN_USAGE, report: REPORT });
  assert.strictEqual(cmt.buildMetricsFooter(m, { env: { KHY_CACHE_METRICS_TRUTH: '0' } }), null);
});

test('formatMetricsDirective: 含反搪塞指令;门控关 → 空串', () => {
  const dir = cmt.formatMetricsDirective({});
  assert.ok(dir.includes('缓存命中率可观测'));
  assert.ok(dir.includes('如实回答') || dir.includes('据实'));
  const dirEn = cmt.formatMetricsDirective({ locale: 'en' });
  assert.ok(dirEn.toLowerCase().includes('cache hit rate'));
  assert.strictEqual(cmt.formatMetricsDirective({ env: { KHY_CACHE_METRICS_TRUTH: 'no' } }), '');
});

test('pickUserText / pickLocale', () => {
  assert.strictEqual(cmt.pickUserText('你的缓存命中率', {}), '你的缓存命中率');
  assert.strictEqual(cmt.pickUserText('', { messages: [{ role: 'user', content: 'hit rate?' }] }), 'hit rate?');
  assert.strictEqual(cmt.pickLocale('你的命中率'), 'zh');
  assert.strictEqual(cmt.pickLocale('hit rate?'), 'en');
});

// ── E2E:模拟 aiGateway.finishResult 成功分支的缓存命中率脚注块 ─────────────────
function simulateSeam({ prompt, options, result, report, env }) {
  if (!(result && result.success === true)) return result;
  try {
    if (cmt.isEnabled(env) && !String(result.content || '').includes(cmt.METRICS_MARKER)) {
      const userText = cmt.pickUserText(prompt, options);
      if (cmt.isCacheMetricsQuestion(userText)) {
        const metrics = cmt.resolveMetrics({
          turnUsage: result.tokenUsage,
          report,
          activeAdapter: result.adapter,
        });
        const verdict = cmt.detectDeflection(result.content, metrics);
        if (verdict && verdict.deflected) {
          const footer = cmt.buildMetricsFooter(metrics, { locale: cmt.pickLocale(userText), env });
          if (footer) result.content = `${String(result.content || '')}${footer}`;
        }
      }
    }
  } catch { /* fail-soft */ }
  return result;
}

test('E2E: 命中率提问 + 搪塞答复 → 追加真实本轮+累计命中率', () => {
  const out = simulateSeam({
    prompt: '你的缓存命中率是多少',
    options: {},
    result: { success: true, content: '我不确定你的缓存命中率是多少,这个指标取决于系统配置。', adapter: 'sensenova', tokenUsage: TURN_USAGE },
    report: REPORT,
    env: {},
  });
  assert.ok(out.content.includes(cmt.METRICS_MARKER));
  assert.ok(out.content.includes('75%') && out.content.includes('sensenova') && out.content.includes('58%'));
});

test('E2E: 已如实给出百分比 → 不追加(避免重复)', () => {
  const original = '当前缓存命中率约 75%,当前渠道 sensenova 累计约 58%。';
  const out = simulateSeam({
    prompt: '你的缓存命中率是多少',
    options: {},
    result: { success: true, content: original, adapter: 'sensenova', tokenUsage: TURN_USAGE },
    report: REPORT,
    env: {},
  });
  assert.strictEqual(out.content, original);
});

test('E2E: 非命中率问题 → 不追加(字节不变)', () => {
  const original = '这是斐波那契数列的实现。';
  const out = simulateSeam({
    prompt: '帮我写个斐波那契函数',
    options: {},
    result: { success: true, content: original, adapter: 'sensenova', tokenUsage: TURN_USAGE },
    report: REPORT,
    env: {},
  });
  assert.strictEqual(out.content, original);
});

test('E2E: 无任何遥测 → 不追加(零编造,搪塞答复保持原样)', () => {
  const original = '我不确定缓存命中率是多少。';
  const out = simulateSeam({
    prompt: '你的缓存命中率是多少',
    options: {},
    result: { success: true, content: original, adapter: 'ollama', tokenUsage: { inputTokens: 500 } },
    report: { adapters: {} },
    env: {},
  });
  assert.strictEqual(out.content, original);
});

test('E2E: 门控关 → 即使搪塞也不追加(逐字节回退)', () => {
  const original = '我没有访问实时缓存监控数据的工具。';
  const out = simulateSeam({
    prompt: '你的缓存命中率是多少',
    options: {},
    result: { success: true, content: original, adapter: 'sensenova', tokenUsage: TURN_USAGE },
    report: REPORT,
    env: { KHY_CACHE_METRICS_TRUTH: '0' },
  });
  assert.strictEqual(out.content, original);
});

test('E2E: 失败结果(success!==true)→ 不介入', () => {
  const original = '网络连接出现问题。';
  const out = simulateSeam({
    prompt: '你的缓存命中率是多少',
    options: {},
    result: { success: false, content: original, adapter: 'sensenova', tokenUsage: TURN_USAGE },
    report: REPORT,
    env: {},
  });
  assert.strictEqual(out.content, original);
});

test('E2E: 英文命中率提问 + 搪塞 → 英文脚注', () => {
  const out = simulateSeam({
    prompt: 'what is your cache hit rate?',
    options: {},
    result: { success: true, content: "I don't have access to real-time cache monitoring tools.", adapter: 'sensenova', tokenUsage: TURN_USAGE },
    report: REPORT,
    env: {},
  });
  assert.ok(out.content.includes('cache-billing probe'));
  assert.ok(out.content.includes('75%') && out.content.includes('sensenova'));
});
