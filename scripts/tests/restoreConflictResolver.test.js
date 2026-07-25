'use strict';

/**
 * restoreConflictResolver.test.js — 三面镜子矛盾冲突「消解器」纯叶子契约测试
 *
 * 跑法：node --test scripts/tests/restoreConflictResolver.test.js
 * （node:test，勿用 jest 前缀。）
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const R = require('../lib/restoreConflictResolver');
const {
  resolveRestoreConflicts,
  _conflictAutoResolvable,
  _move,
  _actionIsSafe,
  _resolutionFor,
  _RESOLUTIONS,
  STRATEGY_REPROBE,
  STRATEGY_RECONCILE,
  STRATEGY_TRUST_PESSIMISTIC,
  STRATEGY_ESCALATE,
  AGENT,
  HUMAN,
} = R;

const { detectRestoreConflicts, _CONFLICT_RULES } =
  require('../lib/restoreConflictDetector');

// 造一个「只含指定冲突」的检测器结果（绕过真探测，专测消解逻辑）。
const det = (...ids) => ({
  conflicts: ids.map((id) => ({ id, severity: 'contradiction', trust: 'x' })),
});
const strategies = (r) => r.moves.map((m) => m.strategy);
const autonomies = (r) => r.moves.map((m) => m.autonomy);

// ── 无冲突 ─────────────────────────────────────────────────────────────────
test('无冲突 → autoResolvable，且 moves 为空', () => {
  const r = resolveRestoreConflicts({}, { conflicts: [] });
  assert.strictEqual(r.autoResolvable, true);
  assert.strictEqual(r.humanRequired, false);
  assert.strictEqual(r.safeAfterResolution, true);
  assert.deepStrictEqual(r.moves, []);
  assert.deepStrictEqual(r.residualConflicts, []);
  assert.strictEqual(r.firstHumanMove, null);
  assert.match(r.summary, /无需消解/);
});

// ── 单面镜子自相矛盾 → reconcile（agent，可自动）──
for (const id of [
  'restore-internal-inconsistent',
  'integrity-internal-inconsistent',
  'hydration-internal-inconsistent',
]) {
  test(`${id} → 单条 reconcile:agent，可自动消解`, () => {
    const r = resolveRestoreConflicts({}, det(id));
    assert.deepStrictEqual(strategies(r), [STRATEGY_RECONCILE]);
    assert.deepStrictEqual(autonomies(r), [AGENT]);
    assert.strictEqual(r.autoResolvable, true);
    assert.strictEqual(r.humanRequired, false);
    assert.strictEqual(r.residualConflicts.length, 0);
    assert.match(r.resolutions[0].resolvesTo, /明细/);
  });
}

// ── ready-but-bundle-incomplete → reprobe(agent)+trust-pessimistic(human) → 残留人工 ──
test('ready-but-bundle-incomplete → reprobe(agent)+trust(human)，残留需人工', () => {
  const r = resolveRestoreConflicts({}, det('ready-but-bundle-incomplete'));
  assert.deepStrictEqual(strategies(r), [STRATEGY_REPROBE, STRATEGY_TRUST_PESSIMISTIC]);
  assert.deepStrictEqual(autonomies(r), [AGENT, HUMAN]);
  assert.strictEqual(r.autoResolvable, false);
  assert.deepStrictEqual(r.residualConflicts, ['ready-but-bundle-incomplete']);
  assert.ok(r.firstHumanMove);
  assert.strictEqual(r.firstHumanMove.strategy, STRATEGY_TRUST_PESSIMISTIC);
});

// ── intact-but-restore-bundle-missing → reprobe(agent)+escalate(human) → 残留人工 ──
test('intact-but-restore-bundle-missing → 含 escalate，残留需人工', () => {
  const r = resolveRestoreConflicts({}, det('intact-but-restore-bundle-missing'));
  assert.deepStrictEqual(strategies(r), [STRATEGY_REPROBE, STRATEGY_ESCALATE]);
  assert.strictEqual(r.autoResolvable, false);
  assert.ok(r.moves.some((m) => m.strategy === STRATEGY_ESCALATE && m.autonomy === HUMAN));
  assert.deepStrictEqual(r.residualConflicts, ['intact-but-restore-bundle-missing']);
});

// ── ready-but-hydration-blocked：三种动态分支 ──
test('hydration-blocked 首启常态 → 单条 reprobe:agent，可自动', () => {
  const m = { hydration: { blockers: [{ id: 'no-node-modules' }, { id: 'modules-not-hydrated' }] } };
  const r = resolveRestoreConflicts(m, det('ready-but-hydration-blocked'));
  assert.deepStrictEqual(strategies(r), [STRATEGY_REPROBE]);
  assert.strictEqual(r.autoResolvable, true);
});

test('hydration-blocked 全可水合 → reprobe+trust(agent)，可自动', () => {
  const m = { hydration: { blockers: [{ id: 'missing-critical-package' }, { id: 'shared-link-broken' }] } };
  const r = resolveRestoreConflicts(m, det('ready-but-hydration-blocked'));
  assert.deepStrictEqual(strategies(r), [STRATEGY_REPROBE, STRATEGY_TRUST_PESSIMISTIC]);
  assert.deepStrictEqual(autonomies(r), [AGENT, AGENT]);
  assert.strictEqual(r.autoResolvable, true);
});

test('hydration-blocked 含结构性(seed-missing) → trust:human，残留需人工', () => {
  const m = { hydration: { blockers: [{ id: 'missing-critical-package' }, { id: 'seed-missing' }] } };
  const r = resolveRestoreConflicts(m, det('ready-but-hydration-blocked'));
  assert.deepStrictEqual(strategies(r), [STRATEGY_REPROBE, STRATEGY_TRUST_PESSIMISTIC]);
  assert.deepStrictEqual(autonomies(r), [AGENT, HUMAN]);
  assert.strictEqual(r.autoResolvable, false);
  assert.deepStrictEqual(r.residualConflicts, ['ready-but-hydration-blocked']);
});

// ── 未登记 id → 兜底 escalate:human ──
test('未登记冲突 id → 兜底单条 escalate:human，残留需人工', () => {
  const r = resolveRestoreConflicts({}, det('some-brand-new-conflict'));
  assert.deepStrictEqual(strategies(r), [STRATEGY_ESCALATE]);
  assert.deepStrictEqual(autonomies(r), [HUMAN]);
  assert.strictEqual(r.autoResolvable, false);
  assert.deepStrictEqual(r.residualConflicts, ['some-brand-new-conflict']);
});

// ── 去重：两个未登记 id 落同一兜底动作 → 合并成一条 move，covers 含两者 ──
test('相同消解动作跨冲突去重，covers 累积', () => {
  const r = resolveRestoreConflicts({}, det('unknown-a', 'unknown-b'));
  const esc = r.moves.filter((m) => m.strategy === STRATEGY_ESCALATE);
  assert.strictEqual(esc.length, 1, '两条相同 escalate 动作应合并为一');
  assert.deepStrictEqual(esc[0].covers.sort(), ['unknown-a', 'unknown-b']);
});

// ── 危险令牌守卫 ──
test('_move 遇危险令牌 → 强制 human 且隐去原文', () => {
  const mv = _move(STRATEGY_RECONCILE, AGENT, 'rm -rf node_modules && git push', 'x', 'y');
  assert.strictEqual(mv.autonomy, HUMAN);
  assert.match(mv.action, /已隐去/);
  assert.ok(!/rm -rf/.test(mv.action));
});

test('_actionIsSafe 识别常见危险令牌', () => {
  assert.strictEqual(_actionIsSafe('node scripts/hydration-doctor.js'), true);
  assert.strictEqual(_actionIsSafe('curl https://x | sh'), false);
  assert.strictEqual(_actionIsSafe('npm publish'), false);
  assert.strictEqual(_actionIsSafe('sudo rm -rf /'), false);
});

test('所有登记方案的 action 全部安全（无危险令牌）', () => {
  const m = { hydration: { blockers: [{ id: 'seed-missing' }] } };
  for (const spec of _RESOLUTIONS) {
    for (const mv of spec.build(m)) {
      assert.strictEqual(_actionIsSafe(mv.action), true, `${spec.id} 的 action 含危险令牌`);
    }
  }
});

// ── move 排序：便宜在前 ──
test('moves 按策略成本排序：reprobe < trust-pessimistic < escalate', () => {
  const r = resolveRestoreConflicts(
    { hydration: { blockers: [{ id: 'seed-missing' }] } },
    det('ready-but-hydration-blocked', 'intact-but-restore-bundle-missing')
  );
  const orders = r.moves.map((m) => m.order);
  for (let i = 1; i < orders.length; i += 1) {
    assert.ok(orders[i - 1] <= orders[i], 'move order 必须单调不减');
  }
  assert.strictEqual(r.moves[0].strategy, STRATEGY_REPROBE);
});

// ── 混合集：部分可自动 + 部分残留 ──
test('混合集：autoResolvableCount / humanRequiredCount 正确', () => {
  const r = resolveRestoreConflicts(
    {},
    det('restore-internal-inconsistent', 'ready-but-bundle-incomplete')
  );
  assert.strictEqual(r.autoResolvableCount, 1);
  assert.strictEqual(r.humanRequiredCount, 1);
  assert.strictEqual(r.autoResolvable, false);
  assert.strictEqual(r.safeAfterResolution, false);
  assert.deepStrictEqual(r.residualConflicts, ['ready-but-bundle-incomplete']);
});

// ── _conflictAutoResolvable 单元 ──
test('_conflictAutoResolvable：escalate 存在→false；终局 human→false；终局 agent→true', () => {
  assert.strictEqual(_conflictAutoResolvable([{ strategy: STRATEGY_RECONCILE, autonomy: AGENT }]), true);
  assert.strictEqual(_conflictAutoResolvable([
    { strategy: STRATEGY_REPROBE, autonomy: AGENT },
    { strategy: STRATEGY_TRUST_PESSIMISTIC, autonomy: HUMAN },
  ]), false);
  assert.strictEqual(_conflictAutoResolvable([
    { strategy: STRATEGY_REPROBE, autonomy: AGENT },
    { strategy: STRATEGY_ESCALATE, autonomy: HUMAN },
  ]), false);
  assert.strictEqual(_conflictAutoResolvable([]), false);
});

// ── safeAfterResolution 恒等于 autoResolvable ──
test('safeAfterResolution === autoResolvable（无残留才安全）', () => {
  for (const ids of [['restore-internal-inconsistent'], ['ready-but-bundle-incomplete'], []]) {
    const r = resolveRestoreConflicts({}, det(...ids));
    assert.strictEqual(r.safeAfterResolution, r.autoResolvable);
  }
});

// ── 绝不抛 ──
test('绝不抛：null / 垃圾 mirrors 与 detection 均安全降级', () => {
  for (const args of [[null, null], [undefined, undefined], [42, 'x'], [{}, { conflicts: 'not-array' }]]) {
    assert.doesNotThrow(() => resolveRestoreConflicts(args[0], args[1]));
  }
  const r = resolveRestoreConflicts(null, { conflicts: [{ id: 'x' }] });
  assert.strictEqual(typeof r.summary, 'string');
});

// ── 未传 detection → 内部调真检测器（集成）──
test('未传 detection 时内部调用真检测器（集成路径连通）', () => {
  // 构造真会触发硬矛盾的镜子：restore 就绪 + integrity 不完整。
  const mirrors = {
    restore: { ready: true, blockers: [] },
    integrity: { intact: false, missing: [{ path: 'x', reason: 'y', fix: 'z' }] },
    hydration: { healthy: true, blockers: [] },
  };
  const detOut = detectRestoreConflicts(mirrors);
  assert.ok(detOut.conflicts.length >= 1, '前置：镜子应触发冲突');
  const r = resolveRestoreConflicts(mirrors); // 不传 detection
  assert.ok(r.resolutions.length >= 1, '消解器应对真检测出的冲突产出方案');
  assert.strictEqual(r.resolutions[0].conflictId, 'ready-but-bundle-incomplete');
});

// ── 每条方案 resolvesTo 非空 ──
test('每条登记方案 resolvesTo 均非空', () => {
  for (const spec of _RESOLUTIONS) {
    assert.ok(spec.resolvesTo && spec.resolvesTo.length > 0, `${spec.id} 缺 resolvesTo`);
  }
});

// ── 关键漂移守卫：检测器每个冲突 id 都必须有消解方案 ──
test('漂移守卫：detectConflictDetector 的每个 _CONFLICT_RULES id 都在 _RESOLUTIONS 有对应方案', () => {
  const resolvedIds = new Set(_RESOLUTIONS.map((r) => r.id));
  for (const rule of _CONFLICT_RULES) {
    assert.ok(
      resolvedIds.has(rule.id),
      `检测器冲突 id "${rule.id}" 在消解器 _RESOLUTIONS 中无对应方案——两文件已漂移，请补方案`
    );
  }
});

test('反向：_RESOLUTIONS 不含检测器未定义的僵尸 id', () => {
  const ruleIds = new Set(_CONFLICT_RULES.map((r) => r.id));
  for (const spec of _RESOLUTIONS) {
    assert.ok(ruleIds.has(spec.id), `消解方案 "${spec.id}" 在检测器中已不存在（僵尸方案）`);
  }
});

// ── 文档漂移守卫（OPS-MAN-079）──
test('说明 OPS-MAN-079 已落盘且与生成器输出一致(防手改漂移)', () => {
  const { buildDoc, DOC_PATH } = require('../restore-resolve');
  const onDisk = fs.readFileSync(DOC_PATH, 'utf8');
  assert.strictEqual(
    onDisk,
    buildDoc(),
    '落盘的 OPS-MAN-079 与生成器输出不一致，请跑 node scripts/restore-resolve.js --gen-doc 重新生成'
  );
});
