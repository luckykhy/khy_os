'use strict';

/**
 * localBrainEnvOptimize — 「打造最佳环境」自然语言处理器特征化测试（node:test，确定性）。
 *
 * 锁定三拍(detect → execute → format)与门控/降级行为。execute 会跑真实自检
 * (baseSelfCheckService.runOnce),故这里**不测** execute 的真实运行结果(那属集成),
 * 只测:
 *   1. 意图识别是纯函数,门控 KHY_ENV_OPTIMIZE 生效。
 *   2. detect 三向路由正确。
 *   3. format 在合成 report 上确定性成文(成功/无问题/有修复/失败/skip)。
 *   4. localBrainService 仍以同名 `_`-前缀别名接线,且注册表含 env_optimize。
 *   5. pluginDoctorPort 仍是零依赖叶子(TUI 侧按需触发 plugin-dev 注册的前提)。
 */

const test = require('node:test');
const assert = require('node:assert');

const env = require('../../src/services/localBrainEnvOptimize');

test('isEnvOptimizeIntent: 命中「打造当前系统最佳环境」及近义,非意图不误判', () => {
  process.env.KHY_ENV_OPTIMIZE = 'true';
  assert.strictEqual(env.isEnvOptimizeIntent('打造当前系统最佳环境'), true);
  assert.strictEqual(env.isEnvOptimizeIntent('把系统调到最佳状态'), true);
  assert.strictEqual(env.isEnvOptimizeIntent('优化运行环境'), true);
  assert.strictEqual(env.isEnvOptimizeIntent('optimize the system environment'), true);
  // 缺 target 或缺 action → 不命中
  assert.strictEqual(env.isEnvOptimizeIntent('打造一个网站'), false);
  assert.strictEqual(env.isEnvOptimizeIntent('系统时间是多少'), false);
  // 空/超长 → 不命中(避免吞掉长段落)
  assert.strictEqual(env.isEnvOptimizeIntent(''), false);
  assert.strictEqual(env.isEnvOptimizeIntent('打造最佳环境' + 'x'.repeat(90)), false);
});

test('门控 KHY_ENV_OPTIMIZE=false → 逐字节回退(意图恒 false)', () => {
  const prev = process.env.KHY_ENV_OPTIMIZE;
  try {
    process.env.KHY_ENV_OPTIMIZE = 'false';
    assert.strictEqual(env.isEnvOptimizeIntent('打造当前系统最佳环境'), false);
    assert.strictEqual(env.detectEnvOptimize('打造当前系统最佳环境'), null);
  } finally {
    process.env.KHY_ENV_OPTIMIZE = prev;
  }
});

test('detectEnvOptimize: 命中返回 env_optimize plan,不命中返回 null', () => {
  process.env.KHY_ENV_OPTIMIZE = 'true';
  const plan = env.detectEnvOptimize('打造当前系统最佳环境');
  assert.ok(plan);
  assert.strictEqual(plan.type, 'env_optimize');
  assert.strictEqual(env.detectEnvOptimize('随便聊聊'), null);
});

test('formatEnvOptimize: 无问题 → 「已是最佳状态」', () => {
  const out = env.formatEnvOptimize({
    type: 'env_optimize', success: true, score: 100, severity: 'healthy',
    durationMs: 42, issues: [], repairs: [], checks: {},
  });
  assert.match(out, /当前环境已是最佳状态/);
  assert.match(out, /100\/100/);
});

test('formatEnvOptimize: 有问题+有修复 → 修复计数与「仍需关注」', () => {
  const out = env.formatEnvOptimize({
    type: 'env_optimize', success: true, score: 82, severity: 'degraded',
    durationMs: 88,
    issues: [{ source: 'plugin', message: 'khy-chain doctor warnings: 1' }],
    repairs: [{ action: 'reset', from: 'a', to: 'b' }],
    checks: {},
  });
  assert.match(out, /1 项自检问题（已自动修复 1 项）/);
  assert.match(out, /khy-chain doctor warnings: 1/);
});

test('formatEnvOptimize: 环境健康+有垃圾 → 结论合并 + 「垃圾文件污染」段 + 安全清理指引', () => {
  const out = env.formatEnvOptimize({
    type: 'env_optimize', success: true, score: 94, severity: 'healthy',
    durationMs: 200, issues: [], repairs: [], checks: {},
    junk: {
      selectedCount: 2, selectedBytes: 2085776520, selectedHuman: '1.9 GB',
      reviewCount: 1, reviewHuman: '820 MB',
      byCategory: { 'pkg-cache': { count: 2, bytes: 2085776520 } },
      driveRoots: ['/'],
    },
  });
  assert.match(out, /环境健康，另有 1\.9 GB 垃圾可回收/);
  assert.match(out, /垃圾文件污染/);
  assert.match(out, /pkg-cache/);
  assert.match(out, /涉可恢复数据，需确认/);
  // 结论只给出安全指引,绝不自动删除(破坏性动作留给人工确认闸)
  assert.match(out, /磁盘清理/);
  assert.doesNotMatch(out, /已删除|已清理[0-9]/);
});

test('formatEnvOptimize: 无垃圾(selectedCount=0)→ 不出「垃圾文件污染」段,退回原结论', () => {
  const out = env.formatEnvOptimize({
    type: 'env_optimize', success: true, score: 100, severity: 'healthy',
    durationMs: 10, issues: [], repairs: [], checks: {},
    junk: { selectedCount: 0, selectedBytes: 0, selectedHuman: '0 B', reviewCount: 0, reviewHuman: '0 B', byCategory: {}, driveRoots: ['/'] },
  });
  assert.match(out, /当前环境已是最佳状态/);
  assert.doesNotMatch(out, /垃圾文件污染/);
});

test('formatEnvOptimize: junk 为 null(子门关/引擎缺失)→ 逐字节退回自检-only 报告', () => {
  const base = {
    type: 'env_optimize', success: true, score: 100, severity: 'healthy',
    durationMs: 10, issues: [], repairs: [], checks: {},
  };
  const withNull = env.formatEnvOptimize({ ...base, junk: null });
  const without = env.formatEnvOptimize(base);
  assert.strictEqual(withNull, without);
  assert.doesNotMatch(withNull, /垃圾文件污染/);
});

test('_junkLines: 有问题+有垃圾 → 结论同时提两者', () => {
  const out = env.formatEnvOptimize({
    type: 'env_optimize', success: true, score: 70, severity: 'degraded',
    durationMs: 50,
    issues: [{ source: 'service', message: 'x not loaded' }],
    repairs: [],
    junk: { selectedCount: 1, selectedBytes: 1048576, selectedHuman: '1.0 MB', reviewCount: 0, reviewHuman: '0 B', byCategory: { 'system-temp': { count: 1, bytes: 1048576 } }, driveRoots: ['/'] },
  });
  assert.match(out, /1 项自检问题/);
  assert.match(out, /1\.0 MB 垃圾可回收/);
});

test('formatEnvOptimize: 有环境隐患(probes)→ 结论计数 + 「环境隐患（自动排查）」段 + 隐患明细', () => {
  const out = env.formatEnvOptimize({
    type: 'env_optimize', success: true, score: 72, severity: 'degraded',
    durationMs: 130, issues: [], repairs: [], checks: {},
    probes: [
      { key: 'disk-pressure', label: '磁盘空间', severity: 'critical', detail: '系统盘已用 96%，剩余仅 3.2 GB', hint: '清理垃圾或迁移大文件' },
      { key: 'memory-pressure', label: '内存压力', severity: 'warning', detail: '内存已用 91%，可用 900 MB', hint: '内存偏紧' },
    ],
  });
  assert.match(out, /2 项环境隐患/);
  assert.match(out, /环境隐患（自动排查）/);
  assert.match(out, /系统盘已用 96%/);
  assert.match(out, /内存已用 91%/);
  // hint 随明细呈现
  assert.match(out, /清理垃圾或迁移大文件/);
});

test('formatEnvOptimize: probes 空数组 → 不出「环境隐患」段(健康机器不啰嗦)', () => {
  const out = env.formatEnvOptimize({
    type: 'env_optimize', success: true, score: 100, severity: 'healthy',
    durationMs: 10, issues: [], repairs: [], checks: {}, probes: [],
  });
  assert.match(out, /当前环境已是最佳状态/);
  assert.doesNotMatch(out, /环境隐患/);
});

test('formatEnvOptimize: 自检问题 + 环境隐患 + 垃圾 三者并存 → 结论逐项列举', () => {
  const out = env.formatEnvOptimize({
    type: 'env_optimize', success: true, score: 55, severity: 'critical',
    durationMs: 300,
    issues: [{ source: 'plugin', message: 'doctor errors: 1' }],
    repairs: [{ action: 'reset', from: 'x', to: 'y' }],
    junk: { selectedCount: 3, selectedBytes: 3145728, selectedHuman: '3.0 MB', reviewCount: 0, reviewHuman: '0 B', byCategory: {}, driveRoots: ['/'] },
    probes: [{ key: 'temp-writable', label: '临时目录', severity: 'critical', detail: '临时目录不可写: /tmp', hint: '修复权限' }],
  });
  assert.match(out, /1 项自检问题（已自动修复 1 项）/);
  assert.match(out, /1 项环境隐患/);
  assert.match(out, /3\.0 MB 垃圾可回收/);
  assert.match(out, /临时目录不可写/);
});

test('formatEnvOptimize: probes 缺失(旧结果无该字段)→ 逐字节退回,不出隐患段', () => {
  const base = {
    type: 'env_optimize', success: true, score: 100, severity: 'healthy',
    durationMs: 10, issues: [], repairs: [], checks: {},
  };
  const withUndef = env.formatEnvOptimize(base);
  const withEmpty = env.formatEnvOptimize({ ...base, probes: [] });
  assert.strictEqual(withUndef, withEmpty);
  assert.doesNotMatch(withUndef, /环境隐患/);
});

test('_runProbes: 委托 envProbes.runProbes,fail-soft 返回数组', () => {
  process.env.KHY_ENV_OPTIMIZE_PROBES = 'true';
  const out = env._runProbes();
  assert.ok(Array.isArray(out));
});

test('formatEnvOptimize: 有环境修复(changed)→ 结论「已修复」+「环境修复（缺失损坏）」段 + ✓', () => {
  const out = env.formatEnvOptimize({
    type: 'env_optimize', success: true, score: 100, severity: 'healthy',
    durationMs: 120, issues: [], repairs: [], checks: {},
    envRepairs: [{ key: 'config-home', label: '配置目录', ok: true, changed: true, detail: '已创建缺失的配置目录: /home/x/.khy' }],
  });
  assert.match(out, /已修复 1 项环境缺失/);
  assert.match(out, /环境修复（缺失损坏）/);
  assert.match(out, /已创建缺失的配置目录/);
  assert.match(out, /✓ \[配置目录\]/);
});

test('formatEnvOptimize: 修复失败(损坏交人工·ok:false·changed:false)→ 出段带 ! 但结论不计「已修复」', () => {
  const out = env.formatEnvOptimize({
    type: 'env_optimize', success: true, score: 100, severity: 'healthy',
    durationMs: 30, issues: [], repairs: [], checks: {},
    envRepairs: [{ key: 'config-home', label: '配置目录', ok: false, changed: false, detail: '配置目录路径被文件占用，需人工处理: /home/x/.khy' }],
  });
  // changed=false → 不计入「已修复 N」计数
  assert.doesNotMatch(out, /已修复 \d+ 项环境缺失/);
  assert.match(out, /环境修复（缺失损坏）/);
  assert.match(out, /! \[配置目录\]/);
  assert.match(out, /需人工处理/);
});

test('formatEnvOptimize: envRepairs 缺失/空 → 逐字节退回,不出修复段', () => {
  const base = {
    type: 'env_optimize', success: true, score: 100, severity: 'healthy',
    durationMs: 10, issues: [], repairs: [], checks: {},
  };
  const withUndef = env.formatEnvOptimize(base);
  const withEmpty = env.formatEnvOptimize({ ...base, envRepairs: [] });
  assert.strictEqual(withUndef, withEmpty);
  assert.doesNotMatch(withUndef, /环境修复/);
  assert.match(withUndef, /当前环境已是最佳状态/);
});

test('formatEnvOptimize: platform 存在 → 报告头带「平台」标签', () => {
  const out = env.formatEnvOptimize({
    type: 'env_optimize', success: true, score: 100, severity: 'healthy',
    durationMs: 12, issues: [], repairs: [], checks: {},
    platform: { id: 'windows', label: 'Windows', sandboxed: false, hasLoadAvg: false, source: 'pinned' },
  });
  assert.match(out, /平台/);
  assert.match(out, /Windows/);
});

test('formatEnvOptimize: platform 缺失 → 逐字节退回,不出「平台」标签', () => {
  const base = {
    type: 'env_optimize', success: true, score: 100, severity: 'healthy',
    durationMs: 12, issues: [], repairs: [], checks: {},
  };
  const withNull = env.formatEnvOptimize({ ...base, platform: null });
  const without = env.formatEnvOptimize(base);
  assert.strictEqual(withNull, without);
  assert.doesNotMatch(without, /平台/);
});

test('_detectPlatform: fail-soft 返回平台上下文或 null', () => {
  const p = env._detectPlatform();
  if (p !== null) {
    assert.strictEqual(typeof p.id, 'string');
    assert.strictEqual(typeof p.label, 'string');
  }
});

test('_runRepairs: 委托 envRepair.runRepairs,fail-soft 返回数组', () => {
  process.env.KHY_ENV_OPTIMIZE_REPAIR = 'true';
  const out = env._runRepairs();
  assert.ok(Array.isArray(out));
});

test('_scanJunk: 只读探针不抛,返回 null 或形状完整的对象', () => {
  process.env.KHY_ENV_OPTIMIZE_JUNK_SCAN = 'true';
  const j = env._scanJunk();
  // 引擎在本平台可用则返回对象,否则 null;两者都不得抛
  if (j !== null) {
    assert.strictEqual(typeof j.selectedCount, 'number');
    assert.strictEqual(typeof j.selectedHuman, 'string');
    assert.ok(j.byCategory && typeof j.byCategory === 'object');
    assert.ok(Array.isArray(j.driveRoots));
  }
});

test('_scanJunk: 子门 KHY_ENV_OPTIMIZE_JUNK_SCAN=false → 恒 null(不跑扫描)', () => {
  const prev = process.env.KHY_ENV_OPTIMIZE_JUNK_SCAN;
  try {
    process.env.KHY_ENV_OPTIMIZE_JUNK_SCAN = 'false';
    assert.strictEqual(env._scanJunk(), null);
  } finally {
    process.env.KHY_ENV_OPTIMIZE_JUNK_SCAN = prev;
  }
});

test('formatEnvOptimize: 失败与 skip 走纯文本分支,不抛', () => {
  assert.match(env.formatEnvOptimize({ type: 'env_optimize', success: false, error: 'boom' }), /打造最佳环境失败：boom/);
  assert.match(env.formatEnvOptimize({ type: 'env_optimize', success: false, skipped: true }), /已有自检任务在运行/);
  // 完全畸形入参不抛
  assert.doesNotThrow(() => env.formatEnvOptimize(null));
  assert.doesNotThrow(() => env.formatEnvOptimize(undefined));
});

test('localBrainService: 注册表接线含 env_optimize,且 detect/execute/format 三拍路由', () => {
  process.env.KHY_ENV_OPTIMIZE = 'true';
  const lb = require('../../src/services/localBrainService');
  const plan = lb.detectDeterministic('打造当前系统最佳环境', { cwd: process.cwd() });
  assert.ok(plan, 'detectDeterministic 应识别 env_optimize');
  assert.strictEqual(plan.type, 'env_optimize');
  // format 路由:合成 result 应经 localBrainService.formatDeterministicResult 到达同 formatter
  const formatted = lb.formatDeterministicResult({
    type: 'env_optimize', success: true, score: 100, severity: 'healthy',
    durationMs: 1, issues: [], repairs: [], checks: {},
  });
  assert.match(formatted, /当前环境已是最佳状态/);
});

test('pluginDoctorPort 仍是零依赖叶子(getPluginDoctor 未注册时返回 null)', () => {
  const port = require('../../src/services/pluginDoctorPort');
  port._resetForTest();
  assert.strictEqual(port.getPluginDoctor(), null);
  const fn = () => 'ok';
  port.registerPluginDoctor(fn);
  assert.strictEqual(port.getPluginDoctor(), fn);
  port._resetForTest();
});
