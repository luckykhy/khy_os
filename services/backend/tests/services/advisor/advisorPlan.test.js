'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const leaf = require('../../../src/services/advisor/advisorPlan');

// ── 语法解析 ──────────────────────────────────────────────────────────────
test('parseAdvisorArgs: 空参 = recommend', () => {
  assert.deepStrictEqual(leaf.parseAdvisorArgs([]), { action: 'recommend', valid: true, parseError: null });
});
test('parseAdvisorArgs: recommend / 推荐 / best 同义', () => {
  for (const w of ['recommend', '推荐', 'best', 'suggest']) {
    assert.strictEqual(leaf.parseAdvisorArgs([w]).action, 'recommend', w);
  }
});
test('parseAdvisorArgs: status / 状态 / list 同义', () => {
  for (const w of ['status', '状态', 'list', 'show']) {
    assert.strictEqual(leaf.parseAdvisorArgs([w]).action, 'status', w);
  }
});
test('parseAdvisorArgs: help', () => {
  assert.strictEqual(leaf.parseAdvisorArgs(['--help']).action, 'help');
});
test('parseAdvisorArgs: 未知 → recommend + parseError', () => {
  const r = leaf.parseAdvisorArgs(['zzz']);
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.parseError, 'unknown_action');
});
test('parseAdvisorArgs: 非数组防呆', () => {
  assert.strictEqual(leaf.parseAdvisorArgs(null).action, 'recommend');
  assert.strictEqual(leaf.parseAdvisorArgs(undefined).action, 'recommend');
});

// ── buildRecommendation ───────────────────────────────────────────────────
test('buildRecommendation: 有证据时按 UCB value 降序,首选取最高', () => {
  const candidates = [
    { adapter: 'alpha', model: 'a-1' },
    { adapter: 'beta', model: 'b-1' },
  ];
  const ranking = [
    { adapter: 'beta', value: 0.9, mean: 0.8, pulls: 5 },
    { adapter: 'alpha', value: 0.4, mean: 0.3, pulls: 3 },
  ];
  const rec = leaf.buildRecommendation({ candidates, ranking });
  assert.strictEqual(rec.hasEvidence, true);
  assert.strictEqual(rec.recommended.adapter, 'beta');
  assert.strictEqual(rec.recommended.model, 'b-1');
  assert.strictEqual(rec.ranked[0].adapter, 'beta');
  assert.strictEqual(rec.ranked[1].adapter, 'alpha');
  assert.match(rec.reason, /成功率/);
});

test('buildRecommendation: 无臂统计(pulls=0) → hasEvidence=false,按候选次序', () => {
  const candidates = [
    { adapter: 'alpha', model: 'a-1' },
    { adapter: 'beta', model: 'b-1' },
  ];
  const ranking = [
    { adapter: 'alpha', value: 0, mean: 0, pulls: 0 },
    { adapter: 'beta', value: 0, mean: 0, pulls: 0 },
  ];
  const rec = leaf.buildRecommendation({ candidates, ranking });
  assert.strictEqual(rec.hasEvidence, false);
  assert.strictEqual(rec.recommended.adapter, 'alpha'); // 稳定:保候选次序
  assert.match(rec.reason, /尚无足够实测数据/);
});

test('buildRecommendation: 候选模型对齐到其 adapter 的 UCB 统计(同 adapter 多模型)', () => {
  const candidates = [
    { adapter: 'alpha', model: 'a-1' },
    { adapter: 'alpha', model: 'a-2' },
  ];
  const ranking = [{ adapter: 'alpha', value: 0.5, mean: 0.5, pulls: 2 }];
  const rec = leaf.buildRecommendation({ candidates, ranking });
  assert.strictEqual(rec.ranked.length, 2);
  assert.strictEqual(rec.ranked[0].mean, 0.5);
  assert.strictEqual(rec.ranked[0].pulls, 2);
  assert.strictEqual(rec.ranked[1].mean, 0.5); // 第二个模型同 adapter,共享统计
});

test('buildRecommendation: 无候选 → recommended=null + 诚实理由', () => {
  const rec = leaf.buildRecommendation({ candidates: [], ranking: [] });
  assert.strictEqual(rec.recommended, null);
  assert.match(rec.reason, /无可执行模型/);
});

test('buildRecommendation: 防呆 —— 非对象/缺字段不抛', () => {
  assert.doesNotThrow(() => leaf.buildRecommendation(null));
  assert.doesNotThrow(() => leaf.buildRecommendation({}));
  assert.doesNotThrow(() => leaf.buildRecommendation({ candidates: [{}], ranking: [{}] }));
  const rec = leaf.buildRecommendation({ candidates: [{ adapter: '' }], ranking: null });
  assert.strictEqual(rec.recommended, null); // 空 adapter 被过滤
});

// ── 文本渲染 ──────────────────────────────────────────────────────────────
test('buildRecommendText: 含首选 + 理由 + 不自动切换说明', () => {
  const rec = leaf.buildRecommendation({
    candidates: [{ adapter: 'alpha', model: 'a-1' }, { adapter: 'beta', model: 'b-1' }],
    ranking: [{ adapter: 'alpha', value: 0.9, mean: 0.8, pulls: 4 }, { adapter: 'beta', value: 0.2, mean: 0.1, pulls: 1 }],
  });
  const txt = leaf.buildRecommendText(rec);
  assert.match(txt, /首选/);
  assert.match(txt, /a-1/);
  assert.match(txt, /不会自动切换|人工确认/);
});

test('buildRecommendText: 无候选 → 诚实空态', () => {
  const txt = leaf.buildRecommendText(leaf.buildRecommendation({ candidates: [], ranking: [] }));
  assert.match(txt, /无可推荐|无可执行/);
});

test('buildStatusText: 有证据列出均值/样本;无候选诚实留白', () => {
  const recWith = leaf.buildRecommendation({
    candidates: [{ adapter: 'alpha', model: 'a-1' }],
    ranking: [{ adapter: 'alpha', value: 0.5, mean: 0.6, pulls: 7 }],
  });
  const txt = leaf.buildStatusText(recWith);
  assert.match(txt, /样本 7/);
  const empty = leaf.buildStatusText(leaf.buildRecommendation({ candidates: [], ranking: [] }));
  assert.match(empty, /无可执行候选/);
});

test('buildHelpText / buildUnknownText 非空且含 /advisor', () => {
  assert.match(leaf.buildHelpText(), /\/advisor/);
  assert.match(leaf.buildUnknownText(), /未知子命令/);
});

// ── 门控梯(默认开 · 字节回退) ──────────────────────────────────────────────
test('isEnabled: 默认开(未设/空对象/缺键)', () => {
  assert.strictEqual(leaf.isEnabled(undefined), true);
  assert.strictEqual(leaf.isEnabled({}), true);
  assert.strictEqual(leaf.isEnabled({ KHY_ADVISOR_COMMAND: undefined }), true);
});
test('isEnabled: 关值 0/false/off/no/空串', () => {
  for (const v of ['0', 'false', 'off', 'no', '', '  OFF  ']) {
    assert.strictEqual(leaf.isEnabled({ KHY_ADVISOR_COMMAND: v }), false, JSON.stringify(v));
  }
});
test('isEnabled: 其它值视为开', () => {
  for (const v of ['1', 'true', 'on', 'yes', 'whatever']) {
    assert.strictEqual(leaf.isEnabled({ KHY_ADVISOR_COMMAND: v }), true, v);
  }
});
