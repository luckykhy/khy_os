'use strict';

/**
 * answerDirectionSynthesis.test.js — 「拿到用户回答后组合调整方向」纯叶子单测(node:test)。
 *
 * 覆盖:门控、buildBaseLines 明细格式、OFF 逐字节回退 base、空答案回退、单卡 vs 多卡措辞、
 * 多选/留白信号条件塑形、绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert');

const ads = require('../../src/services/answerDirectionSynthesis');

test('isEnabled: 默认开,仅显式 falsy 关', () => {
  assert.equal(ads.isEnabled({}), true);
  assert.equal(ads.isEnabled({ KHY_ANSWER_DIRECTION_SYNTHESIS: '1' }), true);
  assert.equal(ads.isEnabled({ KHY_ANSWER_DIRECTION_SYNTHESIS: 'true' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
    assert.equal(ads.isEnabled({ KHY_ANSWER_DIRECTION_SYNTHESIS: off }), false, off);
  }
});

test('buildBaseLines: Q:/A: 块间空行连接;非对象→空串', () => {
  const answers = { '选择目标产物?': '报告', '范围?': '仅后端' };
  assert.equal(ads.buildBaseLines(answers), 'Q: 选择目标产物?\nA: 报告\n\nQ: 范围?\nA: 仅后端');
  assert.equal(ads.buildBaseLines(null), '');
  assert.equal(ads.buildBaseLines([]), '');
  assert.equal(ads.buildBaseLines('x'), '');
});

test('OFF → buildAnswerFeedback 逐字节回退 base(revert oracle)', () => {
  const answers = { '目标?': '报告', '风格?': '简洁' };
  const base = ads.buildBaseLines(answers);
  const off = ads.buildAnswerFeedback({ answers, env: { KHY_ANSWER_DIRECTION_SYNTHESIS: '0' } });
  assert.strictEqual(off, base);
});

test('空答案(count===0)→ 返回 base,不追加块', () => {
  const out = ads.buildAnswerFeedback({ answers: {}, env: {} });
  assert.equal(out, '');
  // null 答案同样安全回退
  assert.equal(ads.buildAnswerFeedback({ answers: null, env: {} }), '');
});

test('ON 单卡:措辞不带「组合」,含综合/校准/复述', () => {
  const answers = { '目标产物?': '一份报告' };
  const out = ads.buildAnswerFeedback({ answers, env: {} });
  assert.ok(out.startsWith(ads.buildBaseLines(answers) + '\n\n'), '应以 base + 空行开头');
  assert.match(out, /据此回答调整方向/);
  assert.doesNotMatch(out, /组合决策/);
  assert.match(out, /先综合/);
  assert.match(out, /再校准/);
  assert.match(out, /复述/);
});

test('ON 多卡:措辞用「组合决策」', () => {
  const answers = { '目标?': '报告', '范围?': '后端', '格式?': 'md' };
  const out = ads.buildAnswerFeedback({ answers, env: {} });
  assert.match(out, /把这些回答当作「一个组合决策」/);
  assert.match(out, /相互关联的决策整体/);
});

test('hasMulti:多选(", " 连接≥2项)→ 出现多选组合语义行;否则不出现', () => {
  const multi = { '范围?': '后端, 前端', '格式?': 'md' };
  const outMulti = ads.buildAnswerFeedback({ answers: multi, env: {} });
  assert.match(outMulti, /多选/);
  assert.match(outMulti, /同时满足|按优先级取舍/);

  const single = { '范围?': '后端', '格式?': 'md' };
  const outSingle = ads.buildAnswerFeedback({ answers: single, env: {} });
  assert.doesNotMatch(outSingle, /多选项的组合语义/);
});

test('hasDeferred:「可讨论」→ 出现留白项行;否则不出现', () => {
  const deferred = { '风格?': ads.DISCUSS_LABEL, '范围?': '后端' };
  const outDef = ads.buildAnswerFeedback({ answers: deferred, env: {} });
  assert.match(outDef, /留白项照顾/);
  assert.match(outDef, /可讨论/);

  const noDef = { '风格?': '简洁', '范围?': '后端' };
  const outNo = ads.buildAnswerFeedback({ answers: noDef, env: {} });
  assert.doesNotMatch(outNo, /留白项照顾/);
});

test('_analyzeAnswers: count/hasMulti/hasDeferred 信号正确', () => {
  const a = ads._analyzeAnswers({ q1: 'x, y', q2: '可讨论', q3: 'z' });
  assert.equal(a.count, 3);
  assert.equal(a.hasMulti, true);
  assert.equal(a.hasDeferred, true);

  const b = ads._analyzeAnswers({ q1: 'only' });
  assert.equal(b.count, 1);
  assert.equal(b.hasMulti, false);
  assert.equal(b.hasDeferred, false);

  // 单 token(", " 分割后仅1项)不算多选
  const c = ads._analyzeAnswers({ q1: '后端' });
  assert.equal(c.hasMulti, false);
});

test('绝不抛:畸形输入 fail-soft', () => {
  assert.doesNotThrow(() => ads.buildAnswerFeedback({ answers: 12345, env: {} }));
  assert.doesNotThrow(() => ads.buildAnswerFeedback({}));
  assert.doesNotThrow(() => ads._analyzeAnswers(null));
  assert.doesNotThrow(() => ads.buildSynthesisBlock(null));
  assert.equal(typeof ads.buildAnswerFeedback({ answers: null }), 'string');
  assert.equal(typeof ads.buildSynthesisBlock(undefined), 'string');
});

test('E2E:2卡含多选+留白 → base + 块(综合/校准/多选/留白全在);OFF 字节回退', () => {
  const answers = { '范围?': '后端, 前端', '风格?': ads.DISCUSS_LABEL };
  const base = ads.buildBaseLines(answers);

  const on = ads.buildAnswerFeedback({ answers, env: {} });
  assert.ok(on.startsWith(base + '\n\n'));
  assert.match(on, /把这些回答当作「一个组合决策」/);
  assert.match(on, /先综合/);
  assert.match(on, /多选项的组合语义/);
  assert.match(on, /再校准/);
  assert.match(on, /留白项照顾/);
  assert.match(on, /复述/);

  const off = ads.buildAnswerFeedback({ answers, env: { KHY_ANSWER_DIRECTION_SYNTHESIS: 'off' } });
  assert.strictEqual(off, base);
});
