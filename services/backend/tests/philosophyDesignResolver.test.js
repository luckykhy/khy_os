'use strict';

/**
 * philosophyDesignResolver — 自然语言「哲学 → 软件设计落地」意图解析(单一真源)的确定性
 * 测试(node:test)。
 *
 * 锁定:① 门控默认开 / 关即字节回退;② 「哲学内容 + 想用软件实现」正确识别(中/英、多流派);
 * ③ 零假阳性(纯哲学讨论不建软件、纯建项目无哲学、寒暄、配置开关一律不误触);④ 协议指令含
 * 显式类比映射表 + 忠实非牵强 + 真用软件实现 + 诚实区分强/弱类比 + 内核提炼;⑤ 任意坏输入绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert');

const r = require('../src/services/config/philosophyDesignResolver');

const ON = { KHY_PHILOSOPHY_DESIGN: 'true' };
const OFF = { KHY_PHILOSOPHY_DESIGN: 'off' };

// ── 门控 ─────────────────────────────────────────────────────────────────────
test('isEnabled: 默认开;仅 {0,false,off,no} 关', () => {
  assert.strictEqual(r.isEnabled({}), true);
  assert.strictEqual(r.isEnabled({ KHY_PHILOSOPHY_DESIGN: undefined }), true);
  assert.strictEqual(r.isEnabled({ KHY_PHILOSOPHY_DESIGN: '1' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
    assert.strictEqual(r.isEnabled({ KHY_PHILOSOPHY_DESIGN: v }), false, `应为关:${v}`);
  }
});

test('门控关 → routePhilosophyIntent / resolvePhilosophyIntent 恒 null(字节回退)', () => {
  assert.strictEqual(r.routePhilosophyIntent({ text: '把道家无为应用到我的软件项目', env: OFF }), null);
  assert.strictEqual(r.resolvePhilosophyIntent('用斯多葛哲学设计一个系统', OFF), null);
});

// ── 正例:哲学 + 想用软件实现 ─────────────────────────────────────────────────
test('识别「哲学内容 + 想用软件实现」多种表述(中/英、多流派)', () => {
  const positives = [
    '我想把道家无为而治的思想应用到我的软件项目里',
    '用斯多葛哲学的理念设计一个系统',
    '把儒家思想做成一个软件',
    '我希望用代码实现三权分立的制衡理念',
    '能不能把康德的道德哲学转化成软件架构',
    'apply stoicism to build a software system',
    'design a project based on the philosophy of taoism',
    '帮我把社会契约论体现在系统架构里',
  ];
  for (const t of positives) {
    const out = r.routePhilosophyIntent({ text: t, env: ON });
    assert.ok(out, `应命中:${t}`);
    assert.strictEqual(out.intent.id, 'philosophy-design', `id 应为 philosophy-design:${t}`);
  }
});

test('协议指令含:内核提炼 + 显式映射表 + 忠实非牵强 + 真实现 + 诚实区分', () => {
  const out = r.routePhilosophyIntent({ text: '把道家无为应用到我的软件', env: ON });
  const d = out.directive;
  assert.ok(d.includes('[SYSTEM:'), '应为 SYSTEM 指令');
  assert.ok(/提炼.*内核|内核/.test(d), '应要求忠实提炼哲学内核');
  assert.ok(d.includes('映射表'), '应要求建立显式类比映射表');
  assert.ok(/faithful|忠实/.test(d) && /superficial|牵强/.test(d), '应区分忠实 vs 牵强');
  assert.ok(/真正用软件实现|用软件真正实现|可运行/.test(d), '应要求真用软件实现,非比喻散文');
  assert.ok(/绝不.*编造|绝不假托/.test(d), '应有诚实边界(不编造教义)');
  assert.ok(/工程现实为准|工程为准|正确性/.test(d), '应在诗意与正确性冲突时以工程为准');
  // 内置示例映射仅为锚定,须明确标注非封闭清单
  assert.ok(/非封闭清单/.test(d), '示例映射须标注为非封闭清单');
});

// ── 零假阳性 ─────────────────────────────────────────────────────────────────
test('零假阳性:纯哲学讨论 / 纯建项目无哲学 / 寒暄 / 配置开关 一律不误触', () => {
  const negatives = [
    '我们讨论一下康德的伦理学',          // 纯哲学讨论,不想建软件
    '解释一下什么是存在主义',            // 纯问答
    '老子和庄子有什么区别',              // 哲学但无应用到软件
    '帮我建一个待办项目',                // 建项目但无哲学
    '用 react 写一个登录系统',           // 建软件但无哲学
    '你好,在吗',                        // 寒暄
    '把流式渲染打开',                    // 配置开关(归 nlConfig)
    '帮我修复这段代码的 bug',            // 动作(归 nlAction)
    '',                                  // 空
  ];
  for (const t of negatives) {
    assert.strictEqual(r.routePhilosophyIntent({ text: t, env: ON }), null, `应不误触:${t}`);
  }
});

test('matchPhilosophyDesign:两类信号须同时命中(单侧不成立)', () => {
  // 只有哲学信号,无应用到软件
  assert.strictEqual(r.matchPhilosophyDesign('道家的无为而治很有智慧'), false);
  // 只有应用到软件,无哲学信号
  assert.strictEqual(r.matchPhilosophyDesign('帮我用代码实现一个系统'), false);
  // 两者皆有
  assert.strictEqual(r.matchPhilosophyDesign('把无为而治的哲学用软件实现'), true);
});

// ── fail-soft ────────────────────────────────────────────────────────────────
test('绝不抛:坏输入一律 fail-soft', () => {
  for (const bad of [null, undefined, 123, {}, [], { toString() { throw new Error('boom'); } }]) {
    assert.doesNotThrow(() => r.resolvePhilosophyIntent(bad, ON));
    assert.strictEqual(r.resolvePhilosophyIntent(bad, ON), null);
    assert.doesNotThrow(() => r.matchPhilosophyDesign(bad));
  }
  assert.doesNotThrow(() => r.routePhilosophyIntent({}));
  assert.doesNotThrow(() => r.routePhilosophyIntent(null));
});

test('代码块内的关键词不应触发(只看自然语言指令)', () => {
  const t = '帮我看这段 ```js\n// 把道家无为应用到软件架构\nbuild(system)\n```';
  assert.strictEqual(r.routePhilosophyIntent({ text: t, env: ON }), null);
});

test('PHILOSOPHY_DESIGN_DIRECTIVE / SUMMARY 为模块级单一真源', () => {
  assert.ok(typeof r.PHILOSOPHY_DESIGN_DIRECTIVE === 'string' && r.PHILOSOPHY_DESIGN_DIRECTIVE.length > 0);
  assert.ok(typeof r.PHILOSOPHY_DESIGN_SUMMARY === 'string' && r.PHILOSOPHY_DESIGN_SUMMARY.length > 0);
  const out = r.routePhilosophyIntent({ text: '用斯多葛哲学设计一个软件系统', env: ON });
  assert.strictEqual(out.directive, r.PHILOSOPHY_DESIGN_DIRECTIVE, '命中指令须等于模块级 SSOT');
});
