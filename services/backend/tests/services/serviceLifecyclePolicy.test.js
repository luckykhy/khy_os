'use strict';

/**
 * serviceLifecyclePolicy.test.js — 生命周期边界 纯叶子契约(node:test)。
 *
 * 覆盖:主门 isPolicyEnabled(默认开 / 显式关 / 注册表回退)、tier/process 查询、gateEnabled
 * (无 gate / 默认开式 / 禁用式 KHY_DISABLE_*)、perIdOverride(主门开生效 / 主门关忽略)、
 * isResident(tier 判定 + gate + per-id + 主门 escape hatch)、listStartupSchedule(mode 过滤 +
 * 延迟升序 + immediate 排末 + 主门关回退全量)、返回值与冻结表隔离、junk 绝不抛、
 * LIVE 接线(prefetch RUNNERS === cli-startup id、gate ∈ 源码、aiGateway 不在冷路径、tools 门在)。
 * 零 IO、确定性、绝不抛。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const policy = require('../../src/services/serviceLifecyclePolicy');

const ON = {};
const OFF = { KHY_LIFECYCLE_POLICY: '0' };

test('isPolicyEnabled:默认开;显式关闭词关;其它值仍开', () => {
  assert.strictEqual(policy.isPolicyEnabled({}), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
    assert.strictEqual(policy.isPolicyEnabled({ KHY_LIFECYCLE_POLICY: v }), false, v);
  }
  assert.strictEqual(policy.isPolicyEnabled({ KHY_LIFECYCLE_POLICY: '1' }), true);
});

test('isPolicyEnabled:注册表关时回退本地判定(逐字节等价)', () => {
  assert.strictEqual(policy.isPolicyEnabled({ KHY_FLAG_REGISTRY: '0' }), true);
  assert.strictEqual(policy.isPolicyEnabled({ KHY_FLAG_REGISTRY: '0', KHY_LIFECYCLE_POLICY: 'off' }), false);
});

test('listByTier / listByProcess:分类正确', () => {
  const resident = policy.listByTier('resident').map((e) => e.id);
  assert.ok(resident.includes('cleanupService'));
  assert.ok(resident.includes('resourceGuard'));
  assert.ok(resident.includes('immediateServices'));
  assert.ok(resident.includes('aiManagementServer'));
  const oneshot = policy.listByTier('startup-oneshot').map((e) => e.id);
  assert.ok(oneshot.includes('fileIntegrity'));
  assert.ok(oneshot.includes('gatewayWarmup'));
  const onDemand = policy.listByTier('on-demand').map((e) => e.id);
  assert.ok(onDemand.includes('aiGateway'));
  assert.ok(onDemand.includes('toolsRegistry'));

  const cli = policy.listByProcess('cli-startup').map((e) => e.id);
  assert.ok(cli.includes('cleanupService') && cli.includes('gatewayWarmup'));
  const daemon = policy.listByProcess('daemon').map((e) => e.id);
  assert.ok(daemon.includes('aiManagementServer') && daemon.includes('changeWatch'));
});

test('返回值与冻结表隔离:改返回值不污染 SSoT', () => {
  const a = policy.listByTier('resident');
  a[0].id = 'MUTATED';
  const b = policy.listByTier('resident');
  assert.notStrictEqual(b[0].id, 'MUTATED');
});

test('gateEnabled:无 gate 恒真;默认开式;禁用式 KHY_DISABLE_*', () => {
  // 无 gate 条目。
  assert.strictEqual(policy.gateEnabled('cleanupService', {}), true);
  // 默认开式(gatewayWarmup / KHY_GATEWAY_WARMUP_ON_BOOT)。
  assert.strictEqual(policy.gateEnabled('gatewayWarmup', {}), true);
  assert.strictEqual(policy.gateEnabled('gatewayWarmup', { KHY_GATEWAY_WARMUP_ON_BOOT: 'off' }), false);
  // 禁用式(apiKeyPoolWatcher / KHY_DISABLE_KEYPOOL_WATCH):未置=启用,置真=关闭。
  assert.strictEqual(policy.gateEnabled('apiKeyPoolWatcher', {}), true);
  assert.strictEqual(policy.gateEnabled('apiKeyPoolWatcher', { KHY_DISABLE_KEYPOOL_WATCH: '1' }), false);
  assert.strictEqual(policy.gateEnabled('apiKeyPoolWatcher', { KHY_DISABLE_KEYPOOL_WATCH: 'true' }), false);
  // 禁用式的关闭词 → 视为未禁用 = 启用。
  assert.strictEqual(policy.gateEnabled('apiKeyPoolWatcher', { KHY_DISABLE_KEYPOOL_WATCH: '0' }), true);
  // 未知 id → 保守恒真。
  assert.strictEqual(policy.gateEnabled('nope', {}), true);
});

test('perIdOverride:主门开生效;主门关忽略', () => {
  assert.strictEqual(policy.perIdOverride('cleanupService', {}), null);
  assert.strictEqual(policy.perIdOverride('cleanupService', { KHY_LIFECYCLE_CLEANUPSERVICE: 'off' }), false);
  assert.strictEqual(policy.perIdOverride('cleanupService', { KHY_LIFECYCLE_CLEANUPSERVICE: '1' }), true);
  // 主门关 → per-id 覆盖被忽略(返 null)。
  assert.strictEqual(policy.perIdOverride('cleanupService', { KHY_LIFECYCLE_POLICY: '0', KHY_LIFECYCLE_CLEANUPSERVICE: 'off' }), null);
});

test('isResident:tier + gate + per-id + 主门 escape hatch', () => {
  assert.strictEqual(policy.isResident('cleanupService', {}), true);
  // on-demand / startup-oneshot 不是常驻。
  assert.strictEqual(policy.isResident('aiGateway', {}), false);
  assert.strictEqual(policy.isResident('fileIntegrity', {}), false);
  // per-id 覆盖关。
  assert.strictEqual(policy.isResident('cleanupService', { KHY_LIFECYCLE_CLEANUPSERVICE: 'off' }), false);
  // 禁用式 gate 关。
  assert.strictEqual(policy.isResident('apiKeyPoolWatcher', { KHY_DISABLE_KEYPOOL_WATCH: '1' }), false);
  // 主门关 → 忽略 per-id 覆盖(escape hatch,回今日行为)。
  assert.strictEqual(policy.isResident('cleanupService', { KHY_LIFECYCLE_POLICY: '0', KHY_LIFECYCLE_CLEANUPSERVICE: 'off' }), true);
  // 未知 id。
  assert.strictEqual(policy.isResident('nope', {}), false);
});

test('listStartupSchedule:完整模式条目/顺序/延迟与 prefetch 现值逐条对应', () => {
  const full = policy.listStartupSchedule({}).map((e) => `${e.id}@${e.immediate ? 'immediate' : e.delayMs}`);
  assert.deepStrictEqual(full, [
    'hardwareProfileNotice@2000',
    'cleanupService@3000',
    'resourceGuard@4000',
    'projectMemoryPrune@4000',
    'fileIntegrity@5000',
    'versionUpdateNotice@5000',
    'ideAdapterRecovery@6000',
    'skillLearning@8000',
    'immediateServices@immediate',
  ]);
});

test('listStartupSchedule:轻量模式只含 gatewayWarmup@300', () => {
  const light = policy.listStartupSchedule({}, 'khy').map((e) => `${e.id}@${e.delayMs}`);
  assert.deepStrictEqual(light, ['gatewayWarmup@300']);
});

test('listStartupSchedule:主门开时 per-id 覆盖剔除条目', () => {
  const withoutCleanup = policy.listStartupSchedule({ KHY_LIFECYCLE_CLEANUPSERVICE: 'off' }).map((e) => e.id);
  assert.ok(!withoutCleanup.includes('cleanupService'));
  assert.strictEqual(withoutCleanup.length, 8);
});

test('listStartupSchedule:主门关回退全量(忽略 per-id 覆盖)= escape hatch', () => {
  const off = policy.listStartupSchedule({ KHY_LIFECYCLE_POLICY: '0' });
  assert.strictEqual(off.length, 9);
  const offWithOverride = policy.listStartupSchedule({ KHY_LIFECYCLE_POLICY: '0', KHY_LIFECYCLE_CLEANUPSERVICE: 'off' });
  assert.strictEqual(offWithOverride.length, 9); // 覆盖被忽略。
});

test('allGates:含各子系统直读门,去重', () => {
  const gates = policy.allGates();
  assert.ok(gates.includes('KHY_GATEWAY_WARMUP_ON_BOOT'));
  assert.ok(gates.includes('KHY_DISABLE_KEYPOOL_WATCH'));
  assert.ok(gates.includes('KHY_CHANGE_WATCH'));
  assert.strictEqual(gates.length, new Set(gates).size); // 去重。
});

test('describe / allIds', () => {
  assert.strictEqual(policy.describe('cleanupService').tier, 'resident');
  assert.strictEqual(policy.describe('nope'), null);
  const ids = policy.allIds();
  assert.ok(ids.includes('aiGateway') && ids.includes('cleanupService'));
});

test('绝不抛:junk 输入', () => {
  assert.doesNotThrow(() => policy.isPolicyEnabled(null));
  assert.doesNotThrow(() => policy.listByTier(null));
  assert.doesNotThrow(() => policy.listByProcess(undefined));
  assert.doesNotThrow(() => policy.gateEnabled(42, null));
  assert.doesNotThrow(() => policy.perIdOverride(null, null));
  assert.doesNotThrow(() => policy.isResident(undefined, null));
  assert.doesNotThrow(() => policy.listStartupSchedule(null, 42));
  assert.doesNotThrow(() => policy.describe(null));
});

test('LIVE 接线:prefetch RUNNERS === cli-startup id;gate ∈ flagRegistry 主门;on-demand 边界', () => {
  const srcRoot = path.join(__dirname, '../../src');
  const prefetchSrc = fs.readFileSync(path.join(srcRoot, 'bootstrap/prefetch.js'), 'utf8');

  // RUNNERS 键提取(与守卫同法)。
  const start = prefetchSrc.indexOf('const RUNNERS = {');
  assert.ok(start !== -1, 'prefetch.js 应含 const RUNNERS = {');
  const end = prefetchSrc.indexOf('\n  };', start);
  const block = end === -1 ? prefetchSrc.slice(start) : prefetchSrc.slice(start, end);
  const re = / {4}(\w+):\s*(?:async\s*)?\(\)\s*=>/g;
  const runnerKeys = new Set();
  let m;
  while ((m = re.exec(block)) !== null) runnerKeys.add(m[1]);

  const cliIds = new Set(policy.listByProcess('cli-startup').map((e) => e.id));
  assert.deepStrictEqual([...runnerKeys].sort(), [...cliIds].sort());

  // 主门在 flagRegistry。
  const flagSrc = fs.readFileSync(path.join(srcRoot, 'services/flagRegistry.js'), 'utf8');
  assert.match(flagSrc, /KHY_LIFECYCLE_POLICY/);

  // on-demand 边界:aiGateway 不在 bootstrap.js 顶部 require;tools 门在。
  const bootstrapSrc = fs.readFileSync(path.join(srcRoot, 'cli/bootstrap.js'), 'utf8');
  assert.ok(!/require\([^)]*gateway\/aiGateway[^)]*\)/.test(bootstrapSrc), 'aiGateway 不应进 cli/bootstrap.js 冷路径');
  const toolsSrc = fs.readFileSync(path.join(srcRoot, 'tools/index.js'), 'utf8');
  assert.match(toolsSrc, /KHY_DEFER_TOOLS/);

  // daemon startSymbol 在源码可见。
  const daemonSrc = fs.readFileSync(path.join(srcRoot, 'services/daemonEntry.js'), 'utf8')
    + fs.readFileSync(path.join(srcRoot, 'services/aiManagementServer.js'), 'utf8');
  for (const e of policy.listByProcess('daemon')) {
    if (e.startSymbol) assert.ok(daemonSrc.includes(e.startSymbol), `daemon startSymbol 缺失: ${e.startSymbol}`);
  }
});
