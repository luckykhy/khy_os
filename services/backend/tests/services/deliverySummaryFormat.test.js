'use strict';

/**
 * deliverySummaryFormat.test.js — 「收尾总结用『根因/改动/验证』三段式」意图指令叶子的
 * 单元 + 门控字节回退 + 意图零假阳性 + E2E 接缝(node:test)。
 *
 * 立场(goal 2026-07-04「总结我希望也是和你一样结构化的:根因,改动,验证」):当本轮是实质
 * 工程任务时,注入一段 protocol-tier 指令,命模型按三段式收尾;纯提问/闲聊/检索不注入。
 * 覆盖:
 *   ① 门控默认开,仅显式 0/false/off/no 关;
 *   ② detectDeliveryTask:工程动作动词命中 / 纯提问·闲聊不命中(零假阳性);
 *   ③ buildDeliverySummaryDirective:含三段标题 + 诚实红线 + 自限适用范围 + 无表格;
 *   ④ pickLocale:CJK→zh、纯英→en;
 *   ⑤ routeDeliverySummary:门控关字节回退({shouldInject:false, directive:''});
 *   ⑥ 复刻 ai.js 接缝:注入串非空且携三段标题。
 */

const test = require('node:test');
const assert = require('node:assert');

const dsf = require('../../src/services/deliverySummaryFormat');

test('isEnabled: 默认开,仅显式 0/false/off/no 关', () => {
  assert.strictEqual(dsf.isEnabled({}), true);
  assert.strictEqual(dsf.isEnabled({ KHY_DELIVERY_SUMMARY_FORMAT: '1' }), true);
  assert.strictEqual(dsf.isEnabled({ KHY_DELIVERY_SUMMARY_FORMAT: 'yes' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(dsf.isEnabled({ KHY_DELIVERY_SUMMARY_FORMAT: off }), false, `off=${off}`);
  }
});

test('detectDeliveryTask: 工程动作动词命中(中/英)', () => {
  for (const t of [
    '修复这个登录 bug',
    '帮我实现一个缓存层',
    '重构 toolCalling 的执行路径',
    '优化一下命中率',
    '把这两个模块集成到一起',
    '给 TUI 做这个对齐',
    'fix the race condition in the loop',
    'implement a retry with backoff',
    'refactor the gateway adapter',
    'wire the directive into ai.js',
    'add a new gated leaf',
  ]) {
    assert.strictEqual(dsf.detectDeliveryTask(t).shouldInject, true, `should fire: ${t}`);
  }
});

test('detectDeliveryTask: 纯提问 / 闲聊 / 检索不命中(零假阳性)', () => {
  for (const t of [
    '为什么我从没看见过 khy 使用 update',
    '这个函数是做什么的?',
    '解释一下 prompt 缓存的原理',
    'what is the difference between guard and protocol tier?',
    '你好,今天天气不错',
    'khy 的命中率是多少',
    '',
    '   ',
  ]) {
    assert.strictEqual(dsf.detectDeliveryTask(t).shouldInject, false, `should NOT fire: ${t}`);
  }
});

test('detectDeliveryTask: 代码块内的字样不干扰意图识别', () => {
  const t = '这段代码是啥意思?\n```js\nfunction fix() { return implement(); }\n```';
  assert.strictEqual(dsf.detectDeliveryTask(t).shouldInject, false);
});

test('pickLocale: CJK→zh、纯英→en', () => {
  assert.strictEqual(dsf.pickLocale('修复 bug'), 'zh');
  assert.strictEqual(dsf.pickLocale('fix the bug'), 'en');
  assert.strictEqual(dsf.pickLocale(''), 'en');
});

test('buildDeliverySummaryDirective(zh): 含三段标题 + 诚实红线 + 自限适用范围 + 无表格', () => {
  const d = dsf.buildDeliverySummaryDirective({ locale: 'zh' });
  assert.ok(d.includes('根因'), '含「根因」');
  assert.ok(d.includes('改动'), '含「改动」');
  assert.ok(d.includes('验证'), '含「验证」');
  assert.ok(d.includes('诚实红线'), '含诚实红线');
  assert.ok(/绝不.*编造/.test(d), '含「绝不编造」红线');
  assert.ok(d.includes('闲聊') || d.includes('无需套用'), '含自限适用范围子句');
  assert.ok(!d.includes('|---|') && !/\|.*\|.*\|/.test(d), '不含 markdown 表格');
});

test('buildDeliverySummaryDirective(en): 含三段标题 + 诚实红线', () => {
  const d = dsf.buildDeliverySummaryDirective({ locale: 'en' });
  assert.ok(d.includes('Root cause'), 'has Root cause');
  assert.ok(d.includes('Changes'), 'has Changes');
  assert.ok(d.includes('Verification'), 'has Verification');
  assert.ok(/NEVER fabricate/i.test(d), 'has honesty red line');
});

test('routeDeliverySummary: 命中工程任务 → shouldInject + 携指令(中文任务 → zh 模板)', () => {
  const r = dsf.routeDeliverySummary({ text: '修复登录 bug', env: {} });
  assert.strictEqual(r.shouldInject, true);
  assert.ok(r.directive.includes('根因') && r.directive.includes('验证'));
});

test('routeDeliverySummary: 纯提问 → 不注入', () => {
  const r = dsf.routeDeliverySummary({ text: '这个是什么意思?', env: {} });
  assert.strictEqual(r.shouldInject, false);
  assert.strictEqual(r.directive, '');
});

test('routeDeliverySummary: 门控关 → 逐字节回退(即使是工程任务)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    const r = dsf.routeDeliverySummary({ text: '重构这个模块', env: { KHY_DELIVERY_SUMMARY_FORMAT: off } });
    assert.strictEqual(r.shouldInject, false, `off=${off}`);
    assert.strictEqual(r.directive, '', `off=${off}`);
  }
});

test('routeDeliverySummary: 异常/空输入不抛', () => {
  assert.doesNotThrow(() => dsf.routeDeliverySummary({}));
  assert.strictEqual(dsf.routeDeliverySummary({}).shouldInject, false);
  assert.strictEqual(dsf.routeDeliverySummary({ text: null, env: {} }).shouldInject, false);
});

// ── 复刻 ai.js 接缝:compute → attach → compose ─────────────────────────────
test('E2E 接缝: 工程任务经 directiveComposer 注入且携三段标题;OFF 不注入', () => {
  const { composeDirectives } = require('../../src/services/directiveComposer');

  const on = dsf.routeDeliverySummary({ text: '实现一个新的门控叶子', env: {} });
  const composedOn = composeDirectives({
    entries: [{ key: 'deliverySummaryFormat', directive: on.directive }],
    options: {},
  });
  assert.ok(composedOn.includes('根因') && composedOn.includes('改动') && composedOn.includes('验证'));

  const off = dsf.routeDeliverySummary({ text: '实现一个新的门控叶子', env: { KHY_DELIVERY_SUMMARY_FORMAT: 'off' } });
  const composedOff = composeDirectives({
    entries: [{ key: 'deliverySummaryFormat', directive: off.directive }],
    options: {},
  });
  assert.strictEqual(composedOff, '', '门控关 → 空 directive → 整合层过滤为空串');
});
