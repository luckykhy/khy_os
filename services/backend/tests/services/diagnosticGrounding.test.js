'use strict';

/**
 * diagnosticGrounding.test.js — 「追问为什么报错 → 锚定最近真因」纯叶子契约 SSoT。
 *
 * 诉求(dogfood):上一轮 model_not_found 404 已捕获,下一轮用户问「为什么报了 404」,弱模型却
 * 抓表层 token「404」去查 nginx.conf。本套件锁死叶子的纯部分:
 *   - 门控默认开;关(0/false/off/no,大小写/空格不敏感)→ detect 返 false、build 返 null(逐字节回退);
 *   - 意图识别双命中闸门(疑问触发 + 失败名词),单独一个不接管;
 *   - 捕获侧单槽 record/get 后写覆盖前写、空失败不覆盖、截断超长 cause;
 *   - build 产 [SYSTEM: 诊断锚定] pin 真因;无最近失败 → null;
 *   - 绝不抛(null / 非字符串 / junk → 安全值)。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const dg = require('../../src/services/diagnosticGrounding');

test('gate default-on', () => {
  assert.strictEqual(dg.isDiagnosticGroundingEnabled({}), true);
  assert.strictEqual(dg.isDiagnosticGroundingEnabled(undefined), true);
  assert.strictEqual(dg.isDiagnosticGroundingEnabled({ KHY_DIAGNOSTIC_GROUNDING: '1' }), true);
});

test('gate off — CANON off-words (case/space-insensitive)', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ', 'FALSE']) {
    assert.strictEqual(dg.isDiagnosticGroundingEnabled({ KHY_DIAGNOSTIC_GROUNDING: v }), false, `expected off for ${JSON.stringify(v)}`);
  }
});

test('detectWhyFailureQuestion — double-hit gate (trigger + fail noun)', () => {
  // 命中:疑问触发 + 失败名词。
  assert.strictEqual(dg.detectWhyFailureQuestion('为什么报了404错误'), true);
  assert.strictEqual(dg.detectWhyFailureQuestion('这个为什么失败了'), true);
  assert.strictEqual(dg.detectWhyFailureQuestion('为啥又出错了'), true);
  assert.strictEqual(dg.detectWhyFailureQuestion('why did this request fail'), true);
  assert.strictEqual(dg.detectWhyFailureQuestion('why is it returning a 500'), true);
  // 不命中:只有疑问触发、无失败名词。
  assert.strictEqual(dg.detectWhyFailureQuestion('怎么用这个工具列目录'), false);
  assert.strictEqual(dg.detectWhyFailureQuestion('为什么天是蓝的'), false);
  assert.strictEqual(dg.detectWhyFailureQuestion('why is this so fast'), false);
  // 不命中:只有失败名词、无疑问触发(陈述句,不接管)。
  assert.strictEqual(dg.detectWhyFailureQuestion('请修复这个报错'), false);
});

test('detectWhyFailureQuestion — never throws on junk', () => {
  assert.strictEqual(dg.detectWhyFailureQuestion(null), false);
  assert.strictEqual(dg.detectWhyFailureQuestion(undefined), false);
  assert.strictEqual(dg.detectWhyFailureQuestion(''), false);
  assert.strictEqual(dg.detectWhyFailureQuestion(123), false);
  assert.strictEqual(dg.detectWhyFailureQuestion({}), false);
});

test('detectWhyFailureQuestion — gate off → false', () => {
  assert.strictEqual(dg.detectWhyFailureQuestion('为什么报了404错误', { KHY_DIAGNOSTIC_GROUNDING: 'off' }), false);
});

test('recordFailure / getRecentFailure — last-write-wins, empty ignored, truncation', () => {
  dg._resetRecentFailure();
  assert.strictEqual(dg.getRecentFailure(), null);
  dg.recordFailure({ errorType: 'model_not_found', cause: '404 not found' });
  assert.deepStrictEqual(dg.getRecentFailure(), { errorType: 'model_not_found', cause: '404 not found' });
  // 后写覆盖前写。
  dg.recordFailure({ errorType: 'timeout', cause: 'gateway idle' });
  assert.strictEqual(dg.getRecentFailure().errorType, 'timeout');
  // 空失败不覆盖上一条有效失败。
  dg.recordFailure({ errorType: '', cause: '' });
  assert.strictEqual(dg.getRecentFailure().errorType, 'timeout');
  dg.recordFailure(null);
  assert.strictEqual(dg.getRecentFailure().errorType, 'timeout');
  // 超长 cause 截断到 600。
  dg.recordFailure({ errorType: 'x', cause: 'z'.repeat(2000) });
  assert.strictEqual(dg.getRecentFailure().cause.length, 600);
  dg._resetRecentFailure();
});

test('buildGroundingDirective — pins cause, gated, null when no failure', () => {
  dg._resetRecentFailure();
  // 无最近失败 → null。
  assert.strictEqual(dg.buildGroundingDirective(undefined, {}), null);
  // 显式失败 → 指令含真因 + 锚定标记。
  const g = dg.buildGroundingDirective(
    { errorType: 'model_not_found', cause: 'api [model_not_found]: 404 (cooldown 30s)' }, {},
  );
  assert.match(g, /诊断锚定/);
  assert.match(g, /model_not_found/);
  assert.match(g, /404/);
  // 从单槽读取。
  dg.recordFailure({ errorType: 'model_not_found', cause: 'cached 404' });
  const g2 = dg.buildGroundingDirective(undefined, {});
  assert.match(g2, /cached 404/);
  // 门控关 → null(逐字节回退不注入)。
  assert.strictEqual(dg.buildGroundingDirective(undefined, { KHY_DIAGNOSTIC_GROUNDING: 'off' }), null);
  dg._resetRecentFailure();
});

test('buildGroundingDirective — never throws on junk', () => {
  assert.strictEqual(dg.buildGroundingDirective(123, {}), null);
  assert.strictEqual(dg.buildGroundingDirective({ errorType: '', cause: '' }, {}), null);
});
