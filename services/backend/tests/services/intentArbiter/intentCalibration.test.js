'use strict';

/**
 * intentCalibration.test.js — 纯叶子「确定性历史校准」决策契约(Phase C-2 第 2 层)。
 *
 * 验证:门控梯、lexicalSimilarity 对称/自反/无交集为 0/bigram 重叠、
 *      selectCalibration 仅对 CONFIRM 带生效、相似误触样本 → 降 CHAT、低相似不调、
 *      **结构上绝无升档路径**(防呆②)、门控关字节回退、空样本安全、阈值 env 覆盖。
 */

const test = require('node:test');
const assert = require('node:assert');
const cal = require('../../../src/services/intentArbiter/intentCalibration');
const { BANDS } = require('../../../src/services/intentArbiter/intentLexicon');

function confirmAnalysis(text) {
  return { text, band: BANDS.CONFIRM, confidence: 0.5, reasons: [], features: { targets: [] } };
}

test('isEnabled: 默认开;{0,false,off,no} 关闭', () => {
  assert.strictEqual(cal.isEnabled({}), true);
  assert.strictEqual(cal.isEnabled({ KHY_INTENT_CALIBRATION: '' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.strictEqual(cal.isEnabled({ KHY_INTENT_CALIBRATION: v }), false, v);
  }
});

test('lexicalSimilarity: 自反=1、对称、无交集=0', () => {
  assert.strictEqual(cal.lexicalSimilarity('看看本地模式', '看看本地模式'), 1);
  assert.strictEqual(
    cal.lexicalSimilarity('看看本地模式', '本地模式看看'),
    cal.lexicalSimilarity('本地模式看看', '看看本地模式'),
  );
  assert.strictEqual(cal.lexicalSimilarity('执行扫描', '聊天天气'), 0);
  assert.strictEqual(cal.lexicalSimilarity('', '执行'), 0);
});

test('lexicalSimilarity: 部分 bigram 重叠 ∈ (0,1)', () => {
  const s = cal.lexicalSimilarity('看看本地模式', '看看本地工具');
  assert.ok(s > 0 && s < 1, `期望部分重叠,实得 ${s}`);
});

test('selectCalibration: 相似误触样本 → 歧义带降到 CHAT', () => {
  const c = cal.selectCalibration(confirmAnalysis('看看本地模式'),
    [{ originalText: '看看本地模式' }], {});
  assert.strictEqual(c.adjusted, true);
  assert.strictEqual(c.band, BANDS.CHAT);
  assert.ok(c.confidence < 0.3, `CHAT 带置信度应 <0.3,实得 ${c.confidence}`);
  assert.ok(c.reason.includes('历史误触校准'));
});

test('selectCalibration: 低相似度 → 不调整', () => {
  const c = cal.selectCalibration(confirmAnalysis('看看本地模式'),
    [{ originalText: '部署生产网关' }], {});
  assert.strictEqual(c.adjusted, false);
});

test('selectCalibration: 仅对 CONFIRM 带生效(CHAT/EXECUTION 不动)', () => {
  const exemplars = [{ originalText: '看看本地模式' }];
  for (const band of [BANDS.CHAT, BANDS.EXECUTION]) {
    const a = { text: '看看本地模式', band, confidence: 0.9, reasons: [] };
    assert.strictEqual(cal.selectCalibration(a, exemplars, {}).adjusted, false, band);
  }
});

test('结构安全(防呆②): selectCalibration 绝无升档路径 —— 任何返回 band 非 EXECUTION', () => {
  // 遍历多种输入/样本组合,断言永不产出 EXECUTION。
  const cases = [
    [confirmAnalysis('执行扫描系统'), [{ originalText: '执行扫描系统' }]],
    [confirmAnalysis('立刻执行'), [{ originalText: '立刻执行' }]],
    [confirmAnalysis('随便什么'), [{ originalText: '随便什么' }]],
  ];
  for (const [a, ex] of cases) {
    const c = cal.selectCalibration(a, ex, {});
    if (c.adjusted) assert.strictEqual(c.band, BANDS.CHAT, '调整只能降到 CHAT');
    assert.notStrictEqual(c.band, BANDS.EXECUTION);
  }
});

test('selectCalibration 门控关: 返回 {adjusted:false}(字节回退)', () => {
  const c = cal.selectCalibration(confirmAnalysis('看看本地模式'),
    [{ originalText: '看看本地模式' }], { KHY_INTENT_CALIBRATION: 'off' });
  assert.deepStrictEqual(c, { adjusted: false });
});

test('selectCalibration 防呆: 空样本/非法 analysis/非数组 → 不调且不抛', () => {
  assert.strictEqual(cal.selectCalibration(confirmAnalysis('x'), [], {}).adjusted, false);
  assert.strictEqual(cal.selectCalibration(confirmAnalysis('x'), null, {}).adjusted, false);
  assert.strictEqual(cal.selectCalibration(null, [{ originalText: 'x' }], {}).adjusted, false);
  assert.strictEqual(cal.selectCalibration(confirmAnalysis(''), [{ originalText: 'x' }], {}).adjusted, false);
  // 字符串样本与含杂质样本均容错。
  assert.strictEqual(
    cal.selectCalibration(confirmAnalysis('看看本地模式'), ['看看本地模式', null, 42], {}).adjusted,
    true,
  );
});

test('阈值 env 覆盖: KHY_INTENT_CALIBRATION_MIN 提高门槛 → 同输入由调变不调', () => {
  const a = confirmAnalysis('看看本地模式');
  const ex = [{ originalText: '看看本地工具' }]; // 部分重叠
  const base = cal.selectCalibration(a, ex, {});
  // 把阈值抬到 0.99 → 部分重叠不再命中;非法值回退默认(仍按默认判定)。
  const strict = cal.selectCalibration(a, ex, { KHY_INTENT_CALIBRATION_MIN: '0.99' });
  assert.strictEqual(strict.adjusted, false);
  const bad = cal.selectCalibration(a, ex, { KHY_INTENT_CALIBRATION_MIN: 'nope' });
  assert.strictEqual(bad.adjusted, base.adjusted); // 非法 → 回退默认
});
