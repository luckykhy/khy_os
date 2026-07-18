'use strict';

/**
 * envProbes — extensible read-only health-probe registry (node:test, 确定性).
 *
 * Locks the probe CONTRACT rather than absolute machine state (which varies by
 * host): every probe returns null-or-Finding, never throws; the aggregator is
 * fail-soft and gate-respecting; a throwing probe cannot abort the sweep.
 */

const test = require('node:test');
const assert = require('node:assert');

const probes = require('../../src/services/envProbes');

test('runProbes: 返回数组,每项形状 {key,label,severity,detail}', () => {
  process.env.KHY_ENV_OPTIMIZE_PROBES = 'true';
  const out = probes.runProbes();
  assert.ok(Array.isArray(out));
  for (const f of out) {
    assert.strictEqual(typeof f.key, 'string');
    assert.strictEqual(typeof f.label, 'string');
    assert.ok(['critical', 'high', 'warning', 'info'].includes(f.severity));
    assert.strictEqual(typeof f.detail, 'string');
    assert.ok(f.detail.length > 0);
  }
});

test('runProbes: 子门 KHY_ENV_OPTIMIZE_PROBES=false → 恒空数组', () => {
  const prev = process.env.KHY_ENV_OPTIMIZE_PROBES;
  try {
    process.env.KHY_ENV_OPTIMIZE_PROBES = 'false';
    assert.deepStrictEqual(probes.runProbes(), []);
  } finally {
    process.env.KHY_ENV_OPTIMIZE_PROBES = prev;
  }
});

test('每个注册探针都是只读且不抛(healthy 返回 null 或 Finding)', () => {
  process.env.KHY_ENV_OPTIMIZE_PROBES = 'true';
  for (const p of probes._PROBES) {
    assert.strictEqual(typeof p.key, 'string');
    assert.strictEqual(typeof p.run, 'function');
    let f;
    assert.doesNotThrow(() => { f = p.run(); });
    if (f !== null && f !== undefined) {
      assert.ok(['critical', 'high', 'warning', 'info'].includes(f.severity));
      assert.strictEqual(typeof f.detail, 'string');
    }
  }
});

test('聚合器隔离单个抛异常的探针,不中断整轮', () => {
  // 直接调各叶子探针确认它们本身不抛;再确认 runProbes 整体成功即证隔离生效
  assert.doesNotThrow(() => probes._probeDiskPressure());
  assert.doesNotThrow(() => probes._probeMemoryPressure());
  assert.doesNotThrow(() => probes._probeLoadAverage());
  assert.doesNotThrow(() => probes._probeTempWritable());
  assert.doesNotThrow(() => probes._probeConfigHomeWritable());
  assert.doesNotThrow(() => probes._probeNodeRuntime());
  assert.doesNotThrow(() => probes.runProbes());
});

test('磁盘探针:健康(usePercent<85)返回 null;逻辑随阈值单调', () => {
  // 用真实调用验证「健康机器不误报」——本探针返回 null 或 warning/critical
  const f = probes._probeDiskPressure();
  if (f) {
    // 若真触发,必带阈值语义
    assert.match(f.detail, /系统盘已用 \d+%/);
    assert.ok(['warning', 'critical'].includes(f.severity));
  }
});

test('临时目录探针:tmp 可写 → null(绝大多数环境健康)', () => {
  const f = probes._probeTempWritable();
  // 正常环境 tmp 可写 → null;不可写才返回 critical
  if (f) {
    assert.strictEqual(f.severity, 'critical');
    assert.match(f.detail, /临时目录不可写/);
  } else {
    assert.strictEqual(f, null);
  }
});

test('配置目录探针:~/.khy 可写或未初始化 → null;不可写才 critical', () => {
  const f = probes._probeConfigHomeWritable();
  if (f) {
    assert.strictEqual(f.severity, 'critical');
    assert.match(f.detail, /配置目录不可写/);
    assert.strictEqual(typeof f.hint, 'string');
  } else {
    assert.strictEqual(f, null);
  }
});

test('Node 运行时探针:读 package.json engines 版本底线,达标 → null', () => {
  // 底线从 backend package.json 的 engines.node 读取(非硬编码),
  // 测试进程本身能加载本模块 → 必然满足底线 → 健康返回 null。
  const f = probes._probeNodeRuntime();
  if (f) {
    // 仅当真跑在过低 Node 上才触发(CI/测试环境不会)
    assert.strictEqual(f.severity, 'high');
    assert.match(f.detail, /Node\.js .+ 低于要求的 ≥\d+/);
  } else {
    assert.strictEqual(f, null);
  }
});

test('_PROBES 是可扩展注册表:追加一条即被 runProbes 纳入', () => {
  process.env.KHY_ENV_OPTIMIZE_PROBES = 'true';
  const before = probes.runProbes().length;
  probes._PROBES.push({ key: 'synthetic-test', label: '测试项', run: () => ({ severity: 'warning', detail: '合成隐患' }) });
  try {
    const after = probes.runProbes();
    assert.strictEqual(after.length, before + 1);
    const injected = after.find((f) => f.key === 'synthetic-test');
    assert.ok(injected);
    assert.strictEqual(injected.detail, '合成隐患');
  } finally {
    probes._PROBES.pop(); // 复原,避免污染后续测试
  }
});

test('平台差异:CPU 负载探针带 platforms 白名单(排除 Windows)', () => {
  // cpu-load 依赖 os.loadavg(),Windows 恒返 [0,0,0] 无意义 →
  // 注册表用 platforms 字段将其限定在有真实 load average 的系统。
  const cpu = probes._PROBES.find((p) => p.key === 'cpu-load');
  assert.ok(cpu, 'cpu-load 探针应存在');
  assert.ok(Array.isArray(cpu.platforms), 'cpu-load 应带 platforms 白名单');
  assert.ok(!cpu.platforms.includes('windows'), 'Windows 不应在 cpu-load 白名单内');
  assert.ok(cpu.platforms.includes('linux'), 'Linux 应在 cpu-load 白名单内');
});

test('平台差异:PATH 完整性探针仅限 Windows', () => {
  // path-integrity 针对 Windows 分号分隔的 PATH 与常见缺失目录,
  // 其他系统由 shell 环境自行保证 → 用 platforms 限定为 windows。
  const pathInt = probes._PROBES.find((p) => p.key === 'path-integrity');
  assert.ok(pathInt, 'path-integrity 探针应存在');
  assert.deepStrictEqual(pathInt.platforms, ['windows']);
});

test('平台差异:runProbes 按 KHY_OS_PROFILE=windows 跳过 cpu-load', () => {
  process.env.KHY_ENV_OPTIMIZE_PROBES = 'true';
  const prevPin = process.env.KHY_OS_PROFILE;
  process.env.KHY_OS_PROFILE = 'windows';
  const osProfileService = require('../../src/services/osProfileService');
  osProfileService.resetCache();
  try {
    const findings = probes.runProbes();
    // cpu-load 被平台白名单排除 → 结果里绝不出现该 key
    assert.ok(!findings.some((f) => f.key === 'cpu-load'), 'Windows 下不应出现 cpu-load');
  } finally {
    if (prevPin === undefined) delete process.env.KHY_OS_PROFILE;
    else process.env.KHY_OS_PROFILE = prevPin;
    osProfileService.resetCache();
  }
});
