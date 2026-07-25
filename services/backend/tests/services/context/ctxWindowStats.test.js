'use strict';

/**
 * ctxWindowStats.test.js — 纯叶子 computeContextStats 契约单测(node:test,零 IO)。
 *
 * 锁定:
 *   - 上限来源:适配器真值优先(adapter);缺失走 env.KHY_CONTEXT_WINDOW(env-fallback,默认 128000);
 *   - 占用百分比 = round(used/limit*100) 截顶 100;剩余 = max(0, limit-used);
 *   - 健康分级阈值 env 可覆盖(KHY_CTX_WARN_PCT/KHY_CTX_CRIT_PCT,默认 75/90),crit≥warn;
 *   - 绝不硬编码 model→上限表(上限只来自入参或注入 env);
 *   - 防呆:负/非有限/缺字段 → 0,绝不抛。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { computeContextStats } = require('../../../src/services/context/ctxWindowStats');

describe('上限来源', () => {
  test('适配器真值优先 → limitSource=adapter', () => {
    const s = computeContextStats({ used: 1000, limit: 200000 }, {});
    assert.equal(s.limit, 200000);
    assert.equal(s.limitSource, 'adapter');
  });

  test('上限缺失 → env.KHY_CONTEXT_WINDOW 回退', () => {
    const s = computeContextStats({ used: 1000, limit: 0 }, { KHY_CONTEXT_WINDOW: '64000' });
    assert.equal(s.limit, 64000);
    assert.equal(s.limitSource, 'env-fallback');
  });

  test('上限缺失且无 env → 默认 128000', () => {
    const s = computeContextStats({ used: 1000, limit: 0 }, {});
    assert.equal(s.limit, 128000);
    assert.equal(s.limitSource, 'env-fallback');
  });
});

describe('占用率/余量', () => {
  test('百分比与剩余正确', () => {
    const s = computeContextStats({ used: 50000, limit: 100000 }, {});
    assert.equal(s.percentUsed, 50);
    assert.equal(s.remaining, 50000);
  });

  test('used 超过 limit → 百分比截顶 100,剩余 0', () => {
    const s = computeContextStats({ used: 150000, limit: 100000 }, {});
    assert.equal(s.percentUsed, 100);
    assert.equal(s.remaining, 0);
  });
});

describe('健康分级', () => {
  test('低占用 → healthy', () => {
    assert.equal(computeContextStats({ used: 10000, limit: 100000 }, {}).status, 'healthy');
  });
  test('≥75% → warning', () => {
    assert.equal(computeContextStats({ used: 80000, limit: 100000 }, {}).status, 'warning');
  });
  test('≥90% → critical', () => {
    assert.equal(computeContextStats({ used: 95000, limit: 100000 }, {}).status, 'critical');
  });
  test('阈值 env 可覆盖', () => {
    const s = computeContextStats({ used: 60000, limit: 100000 }, { KHY_CTX_WARN_PCT: '50', KHY_CTX_CRIT_PCT: '80' });
    assert.equal(s.warnPct, 50);
    assert.equal(s.critPct, 80);
    assert.equal(s.status, 'warning'); // 60% ≥ 50 warn, < 80 crit
  });
  test('crit 阈值被夹到至少 ≥ warn', () => {
    const s = computeContextStats({ used: 0, limit: 100000 }, { KHY_CTX_WARN_PCT: '80', KHY_CTX_CRIT_PCT: '50' });
    assert.equal(s.critPct, 80, 'crit 不得小于 warn');
  });
});

describe('会话透传 + 防呆', () => {
  test('会话累计与请求数透传,sessionTotal=in+out', () => {
    const s = computeContextStats({ used: 0, limit: 100000, sessionInput: 1200, sessionOutput: 800, requestCount: 3, model: 'm' }, {});
    assert.equal(s.sessionInput, 1200);
    assert.equal(s.sessionOutput, 800);
    assert.equal(s.sessionTotal, 2000);
    assert.equal(s.requestCount, 3);
    assert.equal(s.model, 'm');
  });

  test('负/非有限/缺字段 → 0,绝不抛', () => {
    const s = computeContextStats({ used: -5, limit: NaN, sessionInput: 'x', requestCount: -9 }, {});
    assert.equal(s.used, 0);
    assert.equal(s.limit, 128000); // limit 无效 → 回退
    assert.equal(s.sessionInput, 0);
    assert.equal(s.requestCount, 0);
  });

  test('空入参不抛', () => {
    assert.doesNotThrow(() => computeContextStats());
    const s = computeContextStats();
    assert.equal(s.used, 0);
    assert.equal(s.status, 'healthy');
  });
});
