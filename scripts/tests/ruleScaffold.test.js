'use strict';

/**
 * ruleScaffold 叶子的单元测试。
 *
 * ⚠ 本文件**必须**包含「应拦 + 应放行」双向断言（[DESIGN-ARCH-127] 公理 3 / §5.7）：
 * 只测「会拦」等于给了一个恒真断言 —— 把 `auditRule` 改成恒返回 `{ok:true}` 也能全绿。
 */

const assert = require('assert/strict');
const test = require('node:test');

const guard = require('../lib/ruleScaffold.js');

// ── 契约：断言不得接受「AI 自称」，只看客观事实 ──────────────

test('auditRule：全部触点齐备 ⇒ ok（应放行方向）', () => {
  const rule = {
    id: 'TEST-001',
    name: '测试规则',
    ssot: 'docs/10_规范/其它规范/[DESIGN-TEST-001] 测试规范.md',
    exec: { script: 'scripts/ci/check-test.js' },
  };
  const ctx = {
    registryPath: 'docs/10_规范/registry/RULES-REGISTRY.json',
    exists: () => true,
    hasAliasFor: () => true,
    hasRegistryMarker: () => true,
  };
  const r = guard.auditRule(rule, ctx);
  assert.equal(r.ok, true, '全部齐备时必须判 ok');
  assert.equal(r.gaps.length, 0);
});

test('auditRule：缺执行器 ⇒ 报 gap（应拦方向）', () => {
  const rule = { id: 'TEST-002', name: 'x', exec: { script: 'scripts/ci/check-gone.js' } };
  const ctx = {
    registryPath: 'reg.json',
    exists: (p) => p !== 'scripts/ci/check-gone.js',
    hasAliasFor: () => true,
    hasRegistryMarker: () => true,
  };
  const r = guard.auditRule(rule, ctx);
  assert.equal(r.ok, false);
  assert.ok(r.gaps.some((g) => g.id === 'executor'));
});

test('auditRule：缺 package.json 别名 ⇒ 报 gap（check-wiring 的口径）', () => {
  const rule = { id: 'TEST-003', name: 'x', exec: { script: 'scripts/ci/check-x.js' } };
  const ctx = {
    registryPath: 'reg.json',
    exists: () => true,
    hasAliasFor: () => false, // 无别名 = check-wiring 判零接线
    hasRegistryMarker: () => true,
  };
  const r = guard.auditRule(rule, ctx);
  assert.ok(r.gaps.some((g) => g.id === 'alias'));
});

test('auditRule：纯规范规则（无 exec.script）不报「执行器缺失」', () => {
  const rule = { id: 'TEST-004', name: 'x', gate: 'manual' };
  const ctx = {
    registryPath: 'reg.json',
    exists: () => true,
    hasAliasFor: () => null,
    hasRegistryMarker: () => true,
  };
  const r = guard.auditRule(rule, ctx);
  assert.equal(r.gaps.some((g) => g.id === 'executor'), false, 'manual 规则无执行器是合法的');
  assert.equal(r.gaps.some((g) => g.id === 'alias'), false, '无执行器则无需别名');
});

test('auditRule：ctx 缺方法时绝不抛，且不误报', () => {
  const rule = { id: 'TEST-005', name: 'x', exec: { script: 's.js' } };
  // 空 ctx：所有事实未知（null）⇒ 不报 gap（未知 ≠ 缺失）
  const r = guard.auditRule(rule, {});
  assert.equal(r.ok, true, '未知事实不得当作缺失');
});

test('auditRule：畸形输入不抛', () => {
  for (const bad of [null, undefined, {}, { id: '' }, 42, 'x', []]) {
    assert.doesNotThrow(() => guard.auditRule(bad, {}));
  }
});

// ── ssot 解析：本仓最易写错的一处（实测初版 37 条全误报）─────

test('targetPath：剥离段尾修饰，只留文件路径', () => {
  assert.equal(guard.targetPath('CLAUDE.md#一红线-r1-r4（R4）'), 'CLAUDE.md');
  assert.equal(
    guard.targetPath('services/backend/src/services/riskGate.js isUnbypassableGate'),
    'services/backend/src/services/riskGate.js'
  );
  assert.equal(
    guard.targetPath('docs/10_规范/其它规范/[DESIGN-SOURCING-001] 借鉴与实现统一规则.md §4 B-U2/B-U4'),
    'docs/10_规范/其它规范/[DESIGN-SOURCING-001] 借鉴与实现统一规则.md'
  );
});

test('targetPath：纯命令 / 纯锚点摘不出路径 ⇒ null', () => {
  assert.equal(guard.targetPath('npm run check:duplication'), null);
  assert.equal(guard.targetPath('§1'), null);
});

test('targetPath：`.json` 不被截断成 `.js`（扩展名按长度降序）', () => {
  assert.equal(guard.targetPath('docs/10_规范/registry/RULES-REGISTRY.json'), 'docs/10_规范/registry/RULES-REGISTRY.json');
  assert.equal(guard.targetPath('package.json'), 'package.json');
});

test('ssotFilePaths：与既有守卫 check-rules-registry 的解析逐例一致', () => {
  // 三个真实样本照抄登记表；期望值来自既有权威守卫的同款算法
  const cases = [
    [
      'CLAUDE.md#一红线-r1-r4（R3）/ AGENTS.md#版本同步 / scripts/ci/check-version-sync.js specs',
      ['CLAUDE.md', 'scripts/ci/check-version-sync.js'],
    ],
    [
      'docs/10_规范/其它规范/[DESIGN-ACP-001] ACP消息元数据与终态契约.md / scripts/ci/validate-json-schemas.js',
      ['docs/10_规范/其它规范/[DESIGN-ACP-001] ACP消息元数据与终态契约.md', 'scripts/ci/validate-json-schemas.js'],
    ],
    [
      'AGENTS.md#工程规则-规则4 / docs/04_IMPL_实现/IMPL-RPT/[IMPL-RPT-015] 修复记录时间线.md',
      ['AGENTS.md', 'docs/04_IMPL_实现/IMPL-RPT/[IMPL-RPT-015] 修复记录时间线.md'],
    ],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(guard.ssotFilePaths({ ssot: input }), expected, input);
  }
});

test('ssotFilePaths：数组形式的 ssot 也要处理 + 去重', () => {
  const got = guard.ssotFilePaths({ ssot: ['a.md', 'a.md', 'b.md §1'] });
  assert.deepEqual(got, ['a.md', 'b.md']);
});

// ── 登记表自洽 ──────────────────────────────────────────────

test('checkRegistrySelfConsistency：ruleCount 漂移必须报（第一处会漂移的真源）', () => {
  const bad = { meta: { ruleCount: 3 }, rules: [{ id: 'A-001' }, { id: 'A-002' }] };
  const r = guard.checkRegistrySelfConsistency(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('ruleCount')));
});

test('checkRegistrySelfConsistency：id 重复必须报', () => {
  const bad = { meta: { ruleCount: 2 }, rules: [{ id: 'A-001' }, { id: 'A-001' }] };
  const r = guard.checkRegistrySelfConsistency(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('重复')));
});

test('checkRegistrySelfConsistency：健康登记表放行（应放行方向）', () => {
  const good = { meta: { ruleCount: 2 }, rules: [{ id: 'A-001' }, { id: 'A-002' }] };
  assert.equal(guard.checkRegistrySelfConsistency(good).ok, true);
});

// ── M2：advisory 永不执行（结构性判据）──────────────────────

test('findNeverExecuting：只挑 gate=advisory，并给出可区分有无执行器的修复建议', () => {
  const reg = {
    rules: [
      { id: 'A-001', name: 'a', priority: 'P1', domain: 'LAYOUT', gate: 'advisory', exec: { script: 's.js', args: ['--changed'] } },
      { id: 'A-002', name: 'b', priority: 'P2', domain: 'OPS', gate: 'advisory' },
      { id: 'A-003', name: 'c', priority: 'P1', domain: 'LAYOUT', gate: 'pr', exec: { script: 's.js' } },
    ],
  };
  const hit = guard.findNeverExecuting(reg);
  assert.equal(hit.length, 2, '只挑 advisory');
  assert.equal(hit.find((r) => r.id === 'A-001').hasChangedFlag, true);
  assert.equal(hit.find((r) => r.id === 'A-001').hasExecutor, true);
  assert.equal(hit.find((r) => r.id === 'A-002').hasExecutor, false);
  // 有执行器 ⇒ 建议改 gate；无执行器 ⇒ 建议保持 manual + 人工兜底
  assert.ok(hit.find((r) => r.id === 'A-001').fix.includes("gate"));
  assert.ok(hit.find((r) => r.id === 'A-002').fix.includes('manual'));
});

test('findNeverExecuting：无 advisory 时返回空（应放行方向）', () => {
  const reg = { rules: [{ id: 'A-001', gate: 'pr', exec: { script: 's' } }] };
  assert.equal(guard.findNeverExecuting(reg).length, 0);
});

test('sortByPriority：P0 → P3 确定性排序，未知优先级排最后', () => {
  const out = guard.sortByPriority([
    { id: 'Z-009', priority: 'P2' },
    { id: 'A-001', priority: 'P0' },
    { id: 'M-005', priority: 'P1' },
    { id: 'X-002', priority: 'P9' },
  ]).map((r) => r.id);
  assert.deepEqual(out, ['A-001', 'M-005', 'Z-009', 'X-002']);
});

// ── 触点清单自身的契约 ──────────────────────────────────────

test('TOUCHPOINTS 是 13 处硬触点的声明式真源（唯一入口）', () => {
  assert.ok(guard.TOUCHPOINTS.length > 0);
  const ids = guard.TOUCHPOINTS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, '触点 id 不得重复');
  for (const t of guard.TOUCHPOINTS) {
    assert.ok(t.id && t.label && typeof t.resolve === 'function', t.id);
    assert.ok([guard.KIND.AUTO, guard.KIND.MANUAL].includes(t.kind), t.id);
  }
});

test('auditRegistry：汇总计数与逐条结果自洽', () => {
  const reg = {
    rules: [
      { id: 'A-001', name: 'a', exec: { script: 'ok.js' } },
      { id: 'A-002', name: 'b', exec: { script: 'gone.js' } },
    ],
  };
  const ctx = {
    registryPath: 'reg.json',
    exists: (p) => p !== 'gone.js',
    hasAliasFor: () => true,
    hasRegistryMarker: () => true,
  };
  const a = guard.auditRegistry(reg, ctx);
  assert.equal(a.total, 2);
  assert.equal(a.okCount + a.withGaps, a.total, '计数必须加起来等于总数');
  assert.equal(a.withGaps, 1);
});
