'use strict';

/**
 * agentRestorePlan.test.js — 还原方案合成器纯叶子的 node:test 覆盖。
 * 跑法：node --test scripts/tests/agentRestorePlan.test.js（勿用 jest 前缀）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  buildRestorePlan,
  _collectItems,
  _policyFor,
  _actionIsSafe,
  _CONCERN_POLICY,
  _FALLBACK_POLICY,
  _DANGER_TOKENS,
  LEVEL_BLOCKER,
  LEVEL_WARNING,
  AUTONOMY_AGENT,
  AUTONOMY_HUMAN,
} = require('../lib/agentRestorePlan');

// ── 构造三面镜子评估对象的便捷器 ─────────────────────────────────────────────
const restore = (blockers = [], warnings = []) => ({ ready: blockers.length === 0, blockers, warnings });
const hydration = (blockers = [], warnings = []) => ({ healthy: blockers.length === 0, blockers, warnings });
const integrity = (missing = [], intact) => ({
  intact: intact === undefined ? missing.length === 0 : intact,
  missing,
  present: [],
});
const B = (id, title = id) => ({ id, level: LEVEL_BLOCKER, title, fix: `修 ${id}` });
const W = (id, title = id) => ({ id, level: LEVEL_WARNING, title, fix: `修 ${id}` });

// ── 基本形状 ─────────────────────────────────────────────────────────────────

test('空输入 → 就绪、零步、summary 说无需步骤', () => {
  const p = buildRestorePlan({});
  assert.strictEqual(p.ready, true);
  assert.strictEqual(p.stepCount, 0);
  assert.strictEqual(p.steps.length, 0);
  assert.strictEqual(p.firstHumanStep, null);
  assert.ok(p.summary.includes('无需'));
});

test('全 null/非法输入 → 不抛，安全空方案', () => {
  for (const bad of [null, undefined, 42, 'x', [], { restore: 1, integrity: 'y', hydration: null }]) {
    const p = buildRestorePlan(bad);
    assert.strictEqual(p.ready, true);
    assert.strictEqual(p.stepCount, 0);
  }
});

test('返回结构字段齐全', () => {
  const p = buildRestorePlan({ restore: restore([B('node-missing')]) });
  for (const k of ['ready', 'steps', 'stepCount', 'agentActionable', 'humanRequired', 'firstHumanStep', 'summary']) {
    assert.ok(k in p, `缺字段 ${k}`);
  }
  const s = p.steps[0];
  for (const k of ['step', 'concern', 'level', 'autonomy', 'title', 'action', 'verify', 'sources', 'ids', 'depOrder']) {
    assert.ok(k in s, `步骤缺字段 ${k}`);
  }
});

// ── autonomy 分类（创新核心）────────────────────────────────────────────────

test('node-missing 判 AGENT（khy 首启自动下载便携 Node）', () => {
  const p = buildRestorePlan({ restore: restore([B('node-missing')]) });
  assert.strictEqual(p.steps[0].autonomy, AUTONOMY_AGENT);
  assert.strictEqual(p.agentActionable, 1);
  assert.strictEqual(p.humanRequired, 0);
});

test('bundle-missing / tar-missing / install-readonly / single-channel 判 HUMAN', () => {
  const p = buildRestorePlan({
    restore: restore(
      [B('bundle-missing')],
      [W('tar-missing'), W('install-readonly'), W('single-channel')]
    ),
  });
  const human = p.steps.filter((s) => s.autonomy === AUTONOMY_HUMAN).map((s) => s.concern);
  assert.ok(human.includes('bundle-source'));
  assert.ok(human.includes('tar-tool'));
  assert.ok(human.includes('writable-install'));
  assert.ok(human.includes('channel-redundancy'));
});

test('versions-drift / hydrate 判 AGENT', () => {
  const p = buildRestorePlan({
    restore: restore([], [W('versions-drift'), W('modules-not-hydrated')]),
  });
  for (const s of p.steps) assert.strictEqual(s.autonomy, AUTONOMY_AGENT);
});

// ── 依赖排序 ─────────────────────────────────────────────────────────────────

test('拦路步骤排在优化步骤之前', () => {
  const p = buildRestorePlan({
    restore: restore([B('bundle-missing')], [W('single-channel')]),
  });
  assert.strictEqual(p.steps[0].level, LEVEL_BLOCKER);
  assert.strictEqual(p.steps[p.steps.length - 1].level, LEVEL_WARNING);
});

test('同级内按 depOrder 升序（node-runtime 先于 version-sync）', () => {
  const p = buildRestorePlan({
    restore: restore([], [W('versions-drift')]),
    hydration: hydration([], [W('portable-node-missing')]),
  });
  const idx = (c) => p.steps.findIndex((s) => s.concern === c);
  assert.ok(idx('node-runtime') < idx('version-sync'));
});

test('step 从 1 连续编号', () => {
  const p = buildRestorePlan({
    restore: restore([B('node-missing'), B('bundle-missing')], [W('single-channel')]),
  });
  assert.deepStrictEqual(p.steps.map((s) => s.step), [1, 2, 3]);
});

// ── 跨镜子去重（按 concern 合并）─────────────────────────────────────────────

test('三面镜子命中同一 concern → 合并成一步，sources 合并', () => {
  const p = buildRestorePlan({
    restore: restore([], [W('modules-not-hydrated')]),
    hydration: hydration([], [W('no-node-modules'), W('missing-critical-package')]),
  });
  const hydrateSteps = p.steps.filter((s) => s.concern === 'hydrate-modules');
  assert.strictEqual(hydrateSteps.length, 1, '同 concern 必须合并成一步');
  assert.deepStrictEqual(hydrateSteps[0].sources, ['hydration', 'restore']);
  assert.ok(hydrateSteps[0].ids.length >= 2);
});

test('合并步的级别取最严（掺一个 blocker → 整步 blocker）', () => {
  const p = buildRestorePlan({
    restore: restore([], [W('no-node-modules')]),
    hydration: hydration([B('missing-critical-package')], []),
  });
  const step = p.steps.find((s) => s.concern === 'hydrate-modules');
  assert.strictEqual(step.level, LEVEL_BLOCKER);
});

// ── installIntegrity 形状适配 ───────────────────────────────────────────────

test('integrity.missing[] → bundle-source 步、判 HUMAN、标题含路径', () => {
  const p = buildRestorePlan({
    integrity: integrity([{ path: 'services/backend/bin/khy.js', reason: '缺失', fix: '重装官方包' }]),
  });
  const s = p.steps.find((x) => x.concern === 'bundle-source');
  assert.ok(s);
  assert.strictEqual(s.autonomy, AUTONOMY_HUMAN);
  assert.strictEqual(s.level, LEVEL_BLOCKER);
});

test('integrity 整包无法定位（intact=false 且 missing 空）→ bundle-unresolved', () => {
  const items = _collectItems({ integrity: integrity([], false) });
  assert.ok(items.some((i) => i.id === 'bundle-unresolved'));
});

test('integrity.intact=true → 不产出 bundle 步', () => {
  const p = buildRestorePlan({ integrity: integrity([], true) });
  assert.ok(!p.steps.some((s) => s.concern === 'bundle-source'));
});

// ── 未登记 id → 保守兜底 ─────────────────────────────────────────────────────

test('未登记 id → 保守 human、排最后、concern=unclassified', () => {
  assert.strictEqual(_policyFor('totally-unknown-id').autonomy, AUTONOMY_HUMAN);
  assert.strictEqual(_policyFor('totally-unknown-id'), _FALLBACK_POLICY);
  const p = buildRestorePlan({ restore: restore([], [W('some-future-rule')]) });
  const s = p.steps.find((x) => x.concern === 'unclassified');
  assert.ok(s);
  assert.strictEqual(s.autonomy, AUTONOMY_HUMAN);
});

// ── 危险动作防越界 ───────────────────────────────────────────────────────────

test('所有 concern 的确认命令都不含危险动作', () => {
  const { _CONCERN_VERIFY } = require('../lib/agentRestorePlan');
  for (const [c, v] of Object.entries(_CONCERN_VERIFY)) {
    assert.ok(_actionIsSafe(v), `确认命令含危险动作: ${c} → ${v}`);
  }
});

test('来源修法含危险动作 → 隐去且强制该步 HUMAN', () => {
  const p = buildRestorePlan({
    restore: restore([], [{ id: 'versions-drift', level: LEVEL_WARNING, title: 'x', fix: 'git push --force' }]),
  });
  const s = p.steps.find((x) => x.concern === 'version-sync');
  assert.ok(s);
  assert.ok(_actionIsSafe(s.action), '危险动作必须被隐去');
  assert.ok(!s.action.includes('git push'));
  assert.strictEqual(s.autonomy, AUTONOMY_HUMAN, '含危险动作的步骤必须强制交人');
});

test('_DANGER_TOKENS 覆盖红线动作', () => {
  for (const t of ['git commit', 'git push', 'rm -', 'curl ', 'npm publish']) {
    assert.ok(_DANGER_TOKENS.includes(t), `红线缺 ${t}`);
  }
});

// ── firstHumanStep 边界 ──────────────────────────────────────────────────────

test('firstHumanStep = 第一处 HUMAN 步的编号；全 agent 则为 null', () => {
  const allAgent = buildRestorePlan({ restore: restore([B('node-missing')]) });
  assert.strictEqual(allAgent.firstHumanStep, null);

  const mixed = buildRestorePlan({
    restore: restore([B('node-missing'), B('bundle-missing')]),
  });
  // node-runtime(agent) 排第 1，bundle-source(human) 排第 2
  assert.strictEqual(mixed.firstHumanStep, 2);
});

// ── 确定性 / 幂等 ────────────────────────────────────────────────────────────

test('同输入恒同输出（确定性）', () => {
  const input = {
    restore: restore([B('node-missing')], [W('single-channel')]),
    hydration: hydration([], [W('splitbrain-marker')]),
    integrity: integrity([{ path: 'a', reason: 'r', fix: 'f' }]),
  };
  const a = JSON.stringify(buildRestorePlan(input));
  const b = JSON.stringify(buildRestorePlan(input));
  assert.strictEqual(a, b);
});

test('不改入参', () => {
  const input = { restore: restore([B('node-missing')]) };
  const snap = JSON.stringify(input);
  buildRestorePlan(input);
  assert.strictEqual(JSON.stringify(input), snap);
});

// ── 汇总计数自洽 ─────────────────────────────────────────────────────────────

test('agentActionable + humanRequired === stepCount', () => {
  const p = buildRestorePlan({
    restore: restore([B('node-missing'), B('bundle-missing')], [W('tar-missing'), W('versions-drift')]),
  });
  assert.strictEqual(p.agentActionable + p.humanRequired, p.stepCount);
});

// ── 策略表健康 ───────────────────────────────────────────────────────────────

test('_CONCERN_POLICY 每条 autonomy 合法、order 为正数', () => {
  for (const [id, pol] of Object.entries(_CONCERN_POLICY)) {
    assert.ok([AUTONOMY_AGENT, AUTONOMY_HUMAN].includes(pol.autonomy), `${id} autonomy 非法`);
    assert.ok(typeof pol.order === 'number' && pol.order > 0, `${id} order 非法`);
    assert.ok(typeof pol.concern === 'string' && pol.concern, `${id} concern 非法`);
  }
});

// ── 文档漂移守卫 ─────────────────────────────────────────────────────────────

test('方案说明 OPS-MAN-075 已落盘且与生成器输出一致(防手改漂移)', () => {
  const fs = require('node:fs');
  const { buildDoc, DOC_PATH } = require('../restore/restore-plan');
  const onDisk = fs.readFileSync(DOC_PATH, 'utf8');
  const generated = buildDoc();
  assert.strictEqual(
    onDisk,
    generated,
    '落盘的 OPS-MAN-075 与生成器输出不一致，请跑 node scripts/restore-plan.js --gen-doc 重新生成'
  );
  // 内容锚点：真实包名、autonomy 判据、红线均在
  assert.ok(generated.includes('@khy-os/khy-os'));
  assert.ok(generated.includes('khy-os'));
  assert.ok(generated.includes('autonomy'));
  assert.ok(generated.includes('commit/push'));
});
