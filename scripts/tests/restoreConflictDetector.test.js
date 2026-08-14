'use strict';

/**
 * restoreConflictDetector.test.js — 三面镜子矛盾检测纯叶子的 node:test 覆盖。
 * 跑法：node --test scripts/tests/restoreConflictDetector.test.js（勿用 jest 前缀）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  detectRestoreConflicts,
  _CONFLICT_RULES,
  _adviceIsSafe,
  _hasBlocker,
  _hydrationBlockersAllNormal,
  _DANGER_TOKENS,
  SEVERITY_CONTRADICTION,
  SEVERITY_DISAGREEMENT,
} = require('../lib/restoreConflictDetector');

// ── 三面镜子评估对象构造器 ───────────────────────────────────────────────────
const restore = (ready, blockers = []) => ({ ready, blockers, warnings: [] });
const integrity = (intact, missing = []) => ({ intact, missing, present: [] });
const hydration = (healthy, blockers = []) => ({ healthy, blockers, warnings: [] });
const Bk = (id) => ({ id, level: 'blocker', title: id, fix: `修 ${id}` });

// ── 一致（无冲突）── ────────────────────────────────────────────────────────

test('三面全绿 → 一致、可自动还原', () => {
  const r = detectRestoreConflicts({
    restore: restore(true),
    integrity: integrity(true),
    hydration: hydration(true),
  });
  assert.strictEqual(r.consistent, true);
  assert.strictEqual(r.safeToAutodrive, true);
  assert.strictEqual(r.conflicts.length, 0);
  assert.ok(r.summary.includes('一致'));
});

test('三面镜子一致地报同一坏事实（都判 bad）→ 不算冲突', () => {
  // restore 不就绪 + integrity 不完整 + hydration 不健康：都同意「坏」，无相悖。
  const r = detectRestoreConflicts({
    restore: restore(false, [Bk('bundle-missing')]),
    integrity: integrity(false, [{ path: 'x', reason: 'r', fix: 'f' }]),
    hydration: hydration(false, [Bk('no-node-modules')]),
  });
  // ready-but-* 规则都要求 restore.ready===true，此处 false → 不触发那些矛盾。
  // integrity 不完整但 restore 也不就绪 → 无 ready-but-bundle-incomplete。
  assert.strictEqual(r.contradictions, 0);
});

// ── 硬矛盾：ready ✕ integrity ── ─────────────────────────────────────────────

test('restore 就绪 但 integrity 不完整 → 硬矛盾、禁止自动、信 integrity', () => {
  const r = detectRestoreConflicts({
    restore: restore(true),
    integrity: integrity(false, [{ path: 'services/backend/bin/khy.js', reason: '缺', fix: '重装' }]),
    hydration: hydration(true),
  });
  const c = r.conflicts.find((x) => x.id === 'ready-but-bundle-incomplete');
  assert.ok(c);
  assert.strictEqual(c.severity, SEVERITY_CONTRADICTION);
  assert.strictEqual(c.trust, 'integrity');
  assert.strictEqual(c.autonomy, 'human');
  assert.strictEqual(r.safeToAutodrive, false);
});

// ── 硬矛盾：integrity 完整 但 restore 说 bundle 缺失（互斥）── ─────────────────

test('integrity 完整 但 restore 报 bundle-missing → 互斥硬矛盾、信 restore', () => {
  const r = detectRestoreConflicts({
    restore: restore(false, [Bk('bundle-missing')]),
    integrity: integrity(true),
    hydration: hydration(true),
  });
  const c = r.conflicts.find((x) => x.id === 'intact-but-restore-bundle-missing');
  assert.ok(c);
  assert.strictEqual(c.severity, SEVERITY_CONTRADICTION);
  assert.strictEqual(c.trust, 'restore');
  assert.strictEqual(r.safeToAutodrive, false);
});

// ── ready ✕ hydration 的动态降级 ── ──────────────────────────────────────────

test('restore 就绪 但 hydration 仅 node_modules 未水合(首启常态) → 降为分级分歧、不阻断', () => {
  const r = detectRestoreConflicts({
    restore: restore(true),
    integrity: integrity(true),
    hydration: hydration(false, [Bk('no-node-modules')]),
  });
  const c = r.conflicts.find((x) => x.id === 'ready-but-hydration-blocked');
  assert.ok(c);
  assert.strictEqual(c.severity, SEVERITY_DISAGREEMENT, '首启常态应降为分级分歧');
  assert.strictEqual(r.safeToAutodrive, true, '分级分歧不阻断自动还原');
});

test('restore 就绪 但 hydration 有真问题(裂脑/缺关键包) → 维持硬矛盾、禁止自动', () => {
  const r = detectRestoreConflicts({
    restore: restore(true),
    integrity: integrity(true),
    hydration: hydration(false, [Bk('no-node-modules'), Bk('splitbrain-marker')]),
  });
  const c = r.conflicts.find((x) => x.id === 'ready-but-hydration-blocked');
  assert.ok(c);
  assert.strictEqual(c.severity, SEVERITY_CONTRADICTION, '掺入非首启常态 blocker → 硬矛盾');
  assert.strictEqual(r.safeToAutodrive, false);
});

// ── 单面镜子自一致性 ── ──────────────────────────────────────────────────────

test('restore 顶层就绪却带非空 blockers → 自相矛盾硬冲突', () => {
  const r = detectRestoreConflicts({ restore: { ready: true, blockers: [Bk('node-missing')], warnings: [] } });
  const c = r.conflicts.find((x) => x.id === 'restore-internal-inconsistent');
  assert.ok(c);
  assert.strictEqual(c.severity, SEVERITY_CONTRADICTION);
  assert.strictEqual(r.safeToAutodrive, false);
});

test('integrity 完整却带非空 missing → 自相矛盾硬冲突', () => {
  const r = detectRestoreConflicts({ integrity: { intact: true, missing: [{ path: 'x' }], present: [] } });
  assert.ok(r.conflicts.some((x) => x.id === 'integrity-internal-inconsistent'));
});

test('hydration 健康却带非空 blockers → 自相矛盾硬冲突', () => {
  const r = detectRestoreConflicts({ hydration: { healthy: true, blockers: [Bk('seed-missing')], warnings: [] } });
  assert.ok(r.conflicts.some((x) => x.id === 'hydration-internal-inconsistent'));
});

// ── 排序 / 计数 ── ───────────────────────────────────────────────────────────

test('硬矛盾排在分级分歧之前', () => {
  const r = detectRestoreConflicts({
    restore: restore(true, [Bk('anything')]), // restore-internal-inconsistent (硬)
    integrity: integrity(true),
    hydration: hydration(false, [Bk('no-node-modules')]), // ready-but-hydration → severity
  });
  assert.ok(r.conflicts.length >= 2);
  assert.strictEqual(r.conflicts[0].severity, SEVERITY_CONTRADICTION);
  assert.strictEqual(r.conflicts[r.conflicts.length - 1].severity, SEVERITY_DISAGREEMENT);
});

test('contradictions + disagreements === conflicts.length', () => {
  const r = detectRestoreConflicts({
    restore: restore(true),
    integrity: integrity(false, [{ path: 'x', reason: 'r', fix: 'f' }]),
    hydration: hydration(false, [Bk('no-node-modules')]),
  });
  assert.strictEqual(r.contradictions + r.disagreements, r.conflicts.length);
});

// ── 每条冲突 autonomy 恒 human ── ────────────────────────────────────────────

test('所有冲突的 autonomy 恒为 human（矛盾一律止步交人）', () => {
  const r = detectRestoreConflicts({
    restore: restore(true),
    integrity: integrity(false, [{ path: 'x', reason: 'r', fix: 'f' }]),
    hydration: hydration(false, [Bk('splitbrain-marker')]),
  });
  assert.ok(r.conflicts.length > 0);
  for (const c of r.conflicts) assert.strictEqual(c.autonomy, 'human');
});

// ── fail-soft ── ─────────────────────────────────────────────────────────────

test('null/非法输入 → 不抛，保守不放行自动还原', () => {
  for (const bad of [null, undefined, 42, 'x', [], { restore: 1, integrity: 'y' }]) {
    const r = detectRestoreConflicts(bad);
    assert.ok(typeof r.safeToAutodrive === 'boolean');
    assert.ok(Array.isArray(r.conflicts));
  }
});

test('空对象 → 无冲突可判、可自动（无镜子=无矛盾）', () => {
  const r = detectRestoreConflicts({});
  assert.strictEqual(r.conflicts.length, 0);
  assert.strictEqual(r.safeToAutodrive, true);
});

test('谓词读到畸形镜子对象不冒泡', () => {
  const r = detectRestoreConflicts({ restore: { ready: true }, integrity: { intact: false } });
  // integrity.missing 缺失也不抛
  assert.ok(r.conflicts.some((x) => x.id === 'ready-but-bundle-incomplete'));
});

// ── 危险动作防越界 ── ────────────────────────────────────────────────────────

test('所有规则的 advice 都不含危险动作', () => {
  for (const r of _CONFLICT_RULES) {
    assert.ok(_adviceIsSafe(r.advice), `规则 ${r.id} 的 advice 含危险动作`);
  }
});

test('_DANGER_TOKENS 覆盖红线动作', () => {
  for (const t of ['git commit', 'git push', 'rm -', 'curl ', 'npm publish']) {
    assert.ok(_DANGER_TOKENS.includes(t), `红线缺 ${t}`);
  }
});

// ── 辅助函数 ── ──────────────────────────────────────────────────────────────

test('_hasBlocker 精确匹配 id、异常输入 → false', () => {
  assert.strictEqual(_hasBlocker({ blockers: [Bk('a')] }, 'a'), true);
  assert.strictEqual(_hasBlocker({ blockers: [Bk('a')] }, 'b'), false);
  assert.strictEqual(_hasBlocker(null, 'a'), false);
  assert.strictEqual(_hasBlocker({}, 'a'), false);
});

test('_hydrationBlockersAllNormal：全首启常态 true，掺一个真问题 false，空 false', () => {
  assert.strictEqual(_hydrationBlockersAllNormal({ blockers: [Bk('no-node-modules')] }), true);
  assert.strictEqual(_hydrationBlockersAllNormal({ blockers: [Bk('no-node-modules'), Bk('shared-link-broken')] }), false);
  assert.strictEqual(_hydrationBlockersAllNormal({ blockers: [] }), false);
});

// ── 确定性 / 不改入参 ── ─────────────────────────────────────────────────────

test('同输入恒同输出（确定性）', () => {
  const input = {
    restore: restore(true),
    integrity: integrity(false, [{ path: 'x', reason: 'r', fix: 'f' }]),
    hydration: hydration(false, [Bk('splitbrain-marker')]),
  };
  assert.strictEqual(JSON.stringify(detectRestoreConflicts(input)), JSON.stringify(detectRestoreConflicts(input)));
});

test('不改入参', () => {
  const input = { restore: restore(true), integrity: integrity(false, [{ path: 'x', reason: 'r', fix: 'f' }]) };
  const snap = JSON.stringify(input);
  detectRestoreConflicts(input);
  assert.strictEqual(JSON.stringify(input), snap);
});

// ── 文档漂移守卫 ── ──────────────────────────────────────────────────────────

test('说明 OPS-MAN-076 已落盘且与生成器输出一致(防手改漂移)', () => {
  const fs = require('node:fs');
  const { buildDoc, DOC_PATH } = require('../restore/restore-conflicts');
  const onDisk = fs.readFileSync(DOC_PATH, 'utf8');
  const generated = buildDoc();
  assert.strictEqual(
    onDisk,
    generated,
    '落盘的 OPS-MAN-076 与生成器输出不一致，请跑 node scripts/restore-conflicts.js --gen-doc 重新生成'
  );
  assert.ok(generated.includes('@khy-os/khy-os'));
  assert.ok(generated.includes('safeToAutodrive'));
  assert.ok(generated.includes('commit/push'));
  // 表格行数 === 规则数
  const rows = generated.split('\n').filter((l) => /^\| `[a-z-]+` \|/.test(l));
  assert.strictEqual(rows.length, _CONFLICT_RULES.length);
});
