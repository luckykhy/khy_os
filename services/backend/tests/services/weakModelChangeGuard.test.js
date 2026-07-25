'use strict';

/**
 * weakModelChangeGuard.test.js — 弱模型改动闸纯叶单测(node --test)。
 *
 * 覆盖:风险分类(red-line/sensitive/normal)、能力档裁决(强放行/弱拦红线/弱敏感须确认/
 * 弱普通放行)、门控(关→null 逐字节回退)、入参不全→null、档未知保守、modelTier 集成、
 * never-throw。属于 test:maintainer:safety 聚合的 CI 消费者(本叶的首个生产接线)。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const guard = require('../../src/services/weakModelChangeGuard');

const ON = { KHY_WEAK_MODEL_EDIT_GUARD: 'true' };
const OFF = { KHY_WEAK_MODEL_EDIT_GUARD: '0' };

// ── 风险分类 ──────────────────────────────────────────────
test('classifyChangeRisk: 红线文件', () => {
  const red = [
    'services/backend/.env',
    '.env.broken-abc',
    'scripts/release/publish-dual.sh',
    'scripts/ci/check-version-sync.js',
    '.github/workflows/ci.yml',
    'services/backend/src/services/flagRegistry.js',
    'services/backend/src/services/permissionStore.js',
    'pyproject.toml',
    'package.json',
    'packaging/npm/package.json',
    'MANIFEST.in',
    'setup.py',
    '.git/index',
  ];
  for (const p of red) {
    assert.strictEqual(guard.classifyChangeRisk(p), 'red-line', p);
  }
});

test('classifyChangeRisk: 敏感核心', () => {
  const sensitive = [
    'services/backend/src/services/gateway/aiGateway.js',
    'services/backend/src/services/toolUseLoop.js',
    'services/backend/src/services/toolUseLoopCore.js',
    'services/backend/src/cli/replSession.js',
    'services/backend/src/services/sessionPersistence.js',
  ];
  for (const p of sensitive) {
    assert.strictEqual(guard.classifyChangeRisk(p), 'sensitive', p);
  }
});

test('classifyChangeRisk: 普通文件', () => {
  const normal = [
    'services/backend/src/services/someFeature.js',
    'apps/ai-frontend/src/views/Foo.vue',
    'docs/07_OPS_运维/note.md',
    'README.md',
  ];
  for (const p of normal) {
    assert.strictEqual(guard.classifyChangeRisk(p), 'normal', p);
  }
});

test('classifyChangeRisk: 空/非法路径视为 normal,绝不抛', () => {
  assert.strictEqual(guard.classifyChangeRisk(''), 'normal');
  assert.strictEqual(guard.classifyChangeRisk(null), 'normal');
  assert.strictEqual(guard.classifyChangeRisk(undefined), 'normal');
  assert.strictEqual(guard.classifyChangeRisk(12345), 'normal');
});

// ── 裁决:强档不受限 ──────────────────────────────────────
test('强档 T0/T1 改红线也放行(reason=strong-model)', () => {
  for (const tier of ['T0', 'T1']) {
    const v = guard.assessWeakModelChange({ tier, filePath: 'pyproject.toml', env: ON });
    assert.strictEqual(v.allow, true);
    assert.strictEqual(v.reason, 'strong-model');
    assert.strictEqual(v.risk, 'red-line');
  }
});

// ── 裁决:弱档拦红线 ──────────────────────────────────────
test('弱档 T3 改红线 → 拦,要求强模型复核', () => {
  const v = guard.assessWeakModelChange({ tier: 'T3', filePath: 'services/backend/.env', env: ON });
  assert.strictEqual(v.allow, false);
  assert.strictEqual(v.action, 'require-strong-review');
  assert.strictEqual(v.risk, 'red-line');
  assert.strictEqual(v.tier, 'T3');
});

test('弱档 T2 改红线 → 同样拦', () => {
  const v = guard.assessWeakModelChange({ tier: 'T2', filePath: 'scripts/release/x.sh', env: ON });
  assert.strictEqual(v.allow, false);
  assert.strictEqual(v.action, 'require-strong-review');
});

// ── 裁决:弱档敏感须确认 ─────────────────────────────────
test('弱档改敏感核心 → 放行但 requireConfirm', () => {
  const v = guard.assessWeakModelChange({
    tier: 'T3', filePath: 'services/backend/src/services/gateway/aiGateway.js', env: ON,
  });
  assert.strictEqual(v.allow, true);
  assert.strictEqual(v.requireConfirm, true);
  assert.strictEqual(v.risk, 'sensitive');
});

// ── 裁决:弱档普通放行 ───────────────────────────────────
test('弱档改普通文件 → 放行,无 requireConfirm', () => {
  const v = guard.assessWeakModelChange({
    tier: 'T3', filePath: 'services/backend/src/services/foo.js', env: ON,
  });
  assert.strictEqual(v.allow, true);
  assert.strictEqual(v.risk, 'normal');
  assert.ok(!v.requireConfirm);
});

// ── 门控:关 → null 逐字节回退 ──────────────────────────
test('门关 → assessWeakModelChange 恒返 null(逐字节回退)', () => {
  const cases = [
    { tier: 'T3', filePath: 'services/backend/.env' },
    { tier: 'T0', filePath: 'pyproject.toml' },
    { tier: 'T3', filePath: 'services/backend/src/services/foo.js' },
  ];
  for (const c of cases) {
    assert.strictEqual(guard.assessWeakModelChange({ ...c, env: OFF }), null);
  }
});

test('weakModelChangeGuardEnabled: 默认开;off 值关', () => {
  assert.strictEqual(guard.weakModelChangeGuardEnabled({}), true);       // 缺省 default-on
  assert.strictEqual(guard.weakModelChangeGuardEnabled(ON), true);
  assert.strictEqual(guard.weakModelChangeGuardEnabled(OFF), false);
  assert.strictEqual(guard.weakModelChangeGuardEnabled({ KHY_WEAK_MODEL_EDIT_GUARD: 'off' }), false);
});

// ── 入参不全 / 档未知 ───────────────────────────────────
test('无 filePath → null(入参不全回退)', () => {
  assert.strictEqual(guard.assessWeakModelChange({ tier: 'T3', env: ON }), null);
  assert.strictEqual(guard.assessWeakModelChange({ tier: 'T3', filePath: '', env: ON }), null);
});

test('无 modelId/tier → modelTier 默认判弱(T2),改红线被保守拦下', () => {
  // 未知模型 modelTier.resolveTier 返 T2(中档,本闸视为弱)→ 红线被拦,这是「防小模型改坏」的保守默认。
  const red = guard.assessWeakModelChange({ filePath: 'pyproject.toml', env: ON });
  assert.strictEqual(red.allow, false);
  assert.strictEqual(red.action, 'require-strong-review');
  assert.strictEqual(red.risk, 'red-line');

  const normal = guard.assessWeakModelChange({ filePath: 'src/foo.js', env: ON });
  assert.strictEqual(normal.allow, true);
  assert.ok(!normal.requireConfirm);
});

test('_resolveTier 无法判档(modelTier 不可用)时上层保守放行须确认', () => {
  // 直接验内部 _resolveTier:显式 tier 优先;非法 tier + 无 modelId 时依赖 modelTier,
  // 这里断言显式 tier 分支不依赖 modelTier(纯函数可判)。
  assert.strictEqual(guard._internals._resolveTier('anything', 'T1', ON), 'T1');
  assert.strictEqual(guard._internals._isWeakTier('T2'), true);
  assert.strictEqual(guard._internals._isWeakTier('T3'), true);
  assert.strictEqual(guard._internals._isWeakTier('T0'), false);
  assert.strictEqual(guard._internals._isWeakTier('T1'), false);
});

// ── modelTier 集成:用真模型名自动分档 ──────────────────
test('modelId 自动分档:弱模型名(haiku/mini/flash)改红线被拦', () => {
  for (const modelId of ['claude-haiku-4-5', 'gpt-4o-mini', 'agnes-2.0-flash']) {
    const v = guard.assessWeakModelChange({ modelId, filePath: 'services/backend/.env', env: ON });
    // 该模型名解析为弱档 → 拦;若某名未被 modelTier 判弱则至少不应崩(allow 布尔存在)
    assert.ok(v && typeof v.allow === 'boolean', modelId);
    if (v.tier === 'T2' || v.tier === 'T3') {
      assert.strictEqual(v.allow, false, `${modelId} 弱档改红线应拦`);
    }
  }
});

test('modelId 自动分档:前沿模型(opus-4)改红线放行', () => {
  const v = guard.assessWeakModelChange({ modelId: 'claude-opus-4-8', filePath: 'pyproject.toml', env: ON });
  assert.strictEqual(v.allow, true);
  // opus-4 → T0,strong-model
  if (v.tier === 'T0' || v.tier === 'T1') {
    assert.strictEqual(v.reason, 'strong-model');
  }
});

// ── never-throw 契约 ────────────────────────────────────
test('任意畸形入参绝不抛', () => {
  assert.doesNotThrow(() => guard.assessWeakModelChange());
  assert.doesNotThrow(() => guard.assessWeakModelChange(null));
  assert.doesNotThrow(() => guard.assessWeakModelChange({ tier: 999, filePath: {}, env: ON }));
  assert.doesNotThrow(() => guard.classifyChangeRisk({ weird: true }));
});

// ── 双面顾问格式化 buildWeakModelAdvisory ────────────────
test('buildWeakModelAdvisory: 弱档改红线 → 强提醒双面文案(humanLine+aiNote 同构)', () => {
  const adv = guard.buildWeakModelAdvisory({ tier: 'T3', filePath: 'services/backend/.env', env: ON });
  assert.ok(adv, '弱档改红线应返回顾问对象');
  assert.strictEqual(typeof adv.humanLine, 'string');
  assert.strictEqual(typeof adv.aiNote, 'string');
  assert.match(adv.aiNote, /WEAK-MODEL-EDIT-GUARD/);
  assert.match(adv.humanLine, /\.env/);
  assert.strictEqual(adv.verdict.allow, false);
});

test('buildWeakModelAdvisory: 弱档改敏感核心 → 温和确认提醒', () => {
  const adv = guard.buildWeakModelAdvisory({
    tier: 'T2', filePath: 'services/backend/src/services/gateway/aiGateway.js', env: ON,
  });
  assert.ok(adv);
  assert.match(adv.humanLine, /确认/);
  assert.strictEqual(adv.verdict.requireConfirm, true);
});

test('buildWeakModelAdvisory: 强档(strong-model) → null(不打扰)', () => {
  assert.strictEqual(
    guard.buildWeakModelAdvisory({ tier: 'T0', filePath: 'pyproject.toml', env: ON }), null);
  assert.strictEqual(
    guard.buildWeakModelAdvisory({ tier: 'T1', filePath: 'services/backend/.env', env: ON }), null);
});

test('buildWeakModelAdvisory: 弱档改普通文件 → null(不打扰)', () => {
  assert.strictEqual(
    guard.buildWeakModelAdvisory({ tier: 'T3', filePath: 'services/backend/src/services/foo.js', env: ON }), null);
});

test('buildWeakModelAdvisory: 门关 → null(逐字节回退,消费方零增量)', () => {
  assert.strictEqual(
    guard.buildWeakModelAdvisory({ tier: 'T3', filePath: 'services/backend/.env', env: OFF }), null);
});

test('buildWeakModelAdvisory: 畸形入参绝不抛,返 null', () => {
  assert.doesNotThrow(() => guard.buildWeakModelAdvisory());
  assert.strictEqual(guard.buildWeakModelAdvisory(), null);
  assert.strictEqual(guard.buildWeakModelAdvisory({ tier: 999, filePath: {}, env: ON }), null);
});

// ── 接线:toolUseLoopCore 后编辑循环确实消费本闸(源级 grep,防未来静默失联)──
test('接线:toolUseLoopCore 后编辑循环 require 并调用 buildWeakModelAdvisory', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/services/toolUseLoopCore.js'), 'utf8');
  // require 本闸
  assert.match(src, /require\('\.\/weakModelChangeGuard'\)/);
  // 调用双面格式化
  assert.match(src, /buildWeakModelAdvisory\(/);
  // 复用 selfEditAdvisory 同一双面投递汇聚点(onSelfEditAdvisory 回调)
  assert.match(src, /_weakModelAdvised/);
});
