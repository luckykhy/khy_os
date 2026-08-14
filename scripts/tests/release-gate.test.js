'use strict';
/**
 * 发布门禁纯叶子契约测试。覆盖:阶段排序不变量、tier 选择、verdict 阻断语义、
 * 报告三态渲染、JSON 形状、environment 阶段永不算 PASS。
 *
 * 只测纯叶子(scripts/release/lib/releaseGateStages.js)——不真跑任何重命令,
 * 因此确定性、快速、无副作用。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const gate = require('../release/lib/releaseGateStages');

test('STAGES: 稳定形状与唯一 id', () => {
  assert.ok(Array.isArray(gate.STAGES) && gate.STAGES.length > 0);
  const ids = gate.STAGES.map((s) => s.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'id 必须唯一');
  for (const s of gate.STAGES) {
    assert.ok(gate.TIERS.includes(s.tier), `未知 tier: ${s.tier}`);
    assert.ok(gate.KINDS.includes(s.kind), `未知 kind: ${s.kind}`);
    assert.ok(typeof s.command === 'string' && s.command.length, 'command 必填');
    assert.ok(typeof s.title === 'string' && s.title.length, 'title 必填');
  }
});

test('STAGES: 排序不变量 —— version/manifest 先于语法与重命令', () => {
  const idx = (id) => gate.STAGES.findIndex((s) => s.id === id);
  assert.ok(idx('version-sync') < idx('node-syntax'));
  assert.ok(idx('manifest-sync') < idx('node-syntax'));
  // 重命令(测试集/纯度审计)排在轻量检查之后
  assert.ok(idx('node-syntax') < idx('maintainer-tests'));
  assert.ok(idx('doctor-preflight') < idx('maintainer-tests'));
});

test('doctor 阶段用只读 --check,绝不用会自愈写盘的裸 doctor', () => {
  const d = gate.STAGES.find((s) => s.id === 'doctor-preflight');
  assert.ok(d, 'doctor-preflight 阶段应存在');
  assert.match(d.command, /doctor\s+--check\b/);
});

test('离机还原门:restore-readiness / install-integrity 为 must 确定性阶段', () => {
  // 离机渠道(pip / npm)的核心承诺 = 装完能完整简单还原。这两条自检必须在门禁内,
  // 且为 must 硬门槛,否则单人维护者发包前无法自动得到还原就绪的 Go/No-Go。
  const rr = gate.STAGES.find((s) => s.id === 'restore-readiness');
  const ii = gate.STAGES.find((s) => s.id === 'install-integrity');
  assert.ok(rr, 'restore-readiness 阶段应存在');
  assert.ok(ii, 'install-integrity 阶段应存在');
  for (const s of [rr, ii]) {
    assert.strictEqual(s.tier, 'must', `${s.id} 必须是 must 硬门槛`);
    assert.strictEqual(s.kind, 'deterministic', `${s.id} 必须本机确定性执行`);
    assert.match(s.command, /^npm run /, `${s.id} 应复用既有 npm 脚本`);
  }
  // 排序:两条还原自检在体检之后、重命令(测试集)之前。
  const idx = (id) => gate.STAGES.findIndex((s) => s.id === id);
  assert.ok(idx('doctor-preflight') < idx('restore-readiness'));
  assert.ok(idx('restore-readiness') < idx('maintainer-tests'));
  assert.ok(idx('install-integrity') < idx('maintainer-tests'));
});

test('selectStages(must): 仅 must 确定性阶段 + 全部环境门', () => {
  const { runnable, manual } = gate.selectStages('must');
  assert.ok(runnable.every((s) => s.kind === 'deterministic' && s.tier === 'must'));
  // recommended 的确定性阶段在 must 下被排除
  assert.ok(!runnable.some((s) => s.id === 'maintainer-tests'));
  assert.ok(!runnable.some((s) => s.id === 'pip-purity'));
  // 环境门始终保留
  assert.ok(manual.every((s) => s.kind === 'environment'));
  assert.ok(manual.some((s) => s.id === 'fresh-install'));
});

test('selectStages(all): 纳入 recommended 确定性阶段', () => {
  const { runnable } = gate.selectStages('all');
  assert.ok(runnable.some((s) => s.id === 'maintainer-tests'));
  assert.ok(runnable.some((s) => s.id === 'pip-purity'));
});

test('computeVerdict: must 失败 => NO-GO', () => {
  const s = gate.STAGES.find((x) => x.tier === 'must' && x.kind === 'deterministic');
  const results = [gate.makeResult(s, { status: 'fail', code: 1, detail: 'boom' })];
  const v = gate.computeVerdict(results);
  assert.strictEqual(v.automatedGo, false);
  assert.strictEqual(v.blockers.length, 1);
});

test('computeVerdict: recommended 失败不翻转 GO,只计 warning', () => {
  const rec = gate.STAGES.find((x) => x.tier === 'recommended' && x.kind === 'deterministic');
  const results = [gate.makeResult(rec, { status: 'fail', code: 1 })];
  const v = gate.computeVerdict(results);
  assert.strictEqual(v.automatedGo, true, 'recommended 失败不应阻断');
  assert.strictEqual(v.warnings.length, 1);
  assert.strictEqual(v.blockers.length, 0);
});

test('computeVerdict: 全 pass + 环境门 manual => GO 但 manualRequired>0', () => {
  const { runnable, manual } = gate.selectStages('must');
  const results = [
    ...runnable.map((s) => gate.makeResult(s, { status: 'pass', ms: 5 })),
    ...manual.map((s) => gate.makeResult(s, { status: 'manual' })),
  ];
  const v = gate.computeVerdict(results);
  assert.strictEqual(v.automatedGo, true);
  assert.ok(v.manualRequired.length > 0, '环境门 must 应计入 manualRequired');
  assert.strictEqual(v.blockers.length, 0);
});

test('environment 阶段的 manual 状态永不算 pass', () => {
  const env = gate.STAGES.find((s) => s.kind === 'environment');
  const r = gate.makeResult(env, { status: 'manual' });
  const v = gate.computeVerdict([r]);
  // manual 不进 blockers 也不进 warnings,但进 manualRequired(若 must)
  assert.strictEqual(v.blockers.length, 0);
  assert.strictEqual(v.warnings.length, 0);
  const json = gate.toJson([r], v);
  assert.strictEqual(json.counts.pass, 0, 'manual 绝不计为 pass');
  assert.strictEqual(json.counts.manual, 1);
});

test('formatReport: 渲染 PASS/FAIL 与 NO-GO 定位', () => {
  const mustStage = gate.STAGES.find((x) => x.tier === 'must' && x.kind === 'deterministic');
  const results = [gate.makeResult(mustStage, { status: 'fail', code: 2, detail: 'line-a\nline-b' })];
  const report = gate.formatReport(results);
  assert.match(report, /\[FAIL\]/);
  assert.match(report, /NO-GO/);
  assert.match(report, /定位/);
  assert.match(report, /line-a/);
});

test('toJson: schema 与 verdict 字段稳定', () => {
  const { runnable, manual } = gate.selectStages('must');
  const results = [
    ...runnable.map((s) => gate.makeResult(s, { status: 'pass', ms: 3 })),
    ...manual.map((s) => gate.makeResult(s, { status: 'manual' })),
  ];
  const json = gate.toJson(results);
  assert.strictEqual(json.schema, 'khy.release-gate/v1');
  assert.strictEqual(json.verdict, 'GO');
  assert.strictEqual(typeof json.counts.total, 'number');
  assert.strictEqual(json.stages.length, results.length);
});

test('firstLines: 折成单行摘要并限行数', () => {
  const out = gate.firstLines('a\n\nb\nc\nd', 2);
  assert.strictEqual(out, 'a | b');
});

test('makeResult 不改入参 stage', () => {
  const stage = gate.STAGES[0];
  const snapshot = JSON.stringify(stage);
  gate.makeResult(stage, { status: 'pass', ms: 1 });
  assert.strictEqual(JSON.stringify(stage), snapshot, 'makeResult 必须是纯函数');
});
