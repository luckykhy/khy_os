'use strict';

/**
 * envSymbiosis.test.js — 环境共生引擎验收。
 *
 * 验证：①指纹刺探确定性识别 5 环境 + 未知环境安全降级；②原生亲和路由按指纹分裂执行路径
 * （防呆①绝不 Polyfill / 防呆③无指纹拒绝盲调 / 防呆④同输入同结果）；③兼容性即特长淬火产
 * 出带 env_scope 的 EvoRequirement（防呆②不污染全局，且锁 L1 不擅升 L2）；④特长熔断器幂等
 * （防呆⑤）；⑤门面闭环 + 监控进程多环境场景表 + 需求池哈希链。
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_HOME = path.join(os.tmpdir(), `khy-envsym-test-${process.pid}`);
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;   // evoLedger 落盘认此变量，须在 require 前设置

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  EnvSymbiosis, EnvFingerprintScanner, NativeAffinityRouter,
  CompatibilityQuencher, SpecialtyBreaker, ROUTE_STATUS, FUSE_CAUSE, PLATFORM,
} = require('../../../src/services/envSymbiosis');
const evoRequirement = require('../../../src/services/evoEngine/evoRequirement');
const evoLevels = require('../../../src/services/evoEngine/evoLevels');

after(() => { try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best-effort */ } });

let _branchSeq = 0;
const freshBranch = () => `envsym_test_${process.pid}_${_branchSeq++}`;

// —— 各环境注入探针（在一台 Linux CI 上精确模拟 5 大环境）——
const PROBES = {
  [PLATFORM.LINUX]: { nodePlatform: () => 'linux', osType: () => 'Linux', isAndroid: () => false, hasCapability: () => true, computeMode: () => 'server' },
  [PLATFORM.WINDOWS]: { nodePlatform: () => 'win32', osType: () => 'Windows_NT', isAndroid: () => false, hasCapability: () => true, computeMode: () => 'desktop' },
  [PLATFORM.MACOS]: { nodePlatform: () => 'darwin', osType: () => 'Darwin', isAndroid: () => false, hasCapability: () => true, computeMode: () => 'desktop' },
  [PLATFORM.ANDROID]: { nodePlatform: () => 'linux', osType: () => 'Linux', isAndroid: () => true, hasCapability: () => true, computeMode: () => 'mobile' },
  [PLATFORM.HARMONY]: { nodePlatform: () => 'linux', osType: () => 'HarmonyOS', runtime: () => 'arkts', isAndroid: () => false, hasCapability: () => true, computeMode: () => 'mobile' },
};
const UNKNOWN_PROBE = { nodePlatform: () => 'sunos', osType: () => 'SunOS', isAndroid: () => false };

const scanWith = (probe) => new EnvFingerprintScanner({ probe }).scan();

describe('EnvFingerprintScanner — 环境刺探与指纹（§3.1）', () => {
  for (const plat of Object.values(PLATFORM)) {
    test(`识别 ${plat}：platform/kernel/topology 就位`, () => {
      const fp = scanWith(PROBES[plat]);
      assert.equal(fp.platform, plat);
      assert.equal(fp.recognized, true);
      assert.notEqual(fp.kernel, 'unknown');
      assert.ok(fp.topology.length > 0, '原生长板拓扑不应为空');
      assert.ok(fp.capabilities.length > 0, '高特权能力清单应被探测到');
    });
  }

  test('未知环境 → recognized=false、platform=unknown、能力清单空（防呆③ 不臆造）', () => {
    const fp = scanWith(UNKNOWN_PROBE);
    assert.equal(fp.recognized, false);
    assert.equal(fp.platform, 'unknown');
    assert.equal(fp.capabilities.length, 0);
  });

  test('能力探针返回子集 → capabilities 仅含可用项', () => {
    const fp = scanWith(Object.assign({}, PROBES[PLATFORM.LINUX], {
      hasCapability: (p, c) => c === 'cgroup' || c === 'ebpf',
    }));
    assert.deepEqual([...fp.capabilities].sort(), ['cgroup', 'ebpf']);
  });

  test('探针抛错 → 永不崩，降级为 unknown', () => {
    const fp = scanWith({ nodePlatform: () => { throw new Error('probe boom'); } });
    assert.equal(fp.recognized, false);
    assert.equal(fp.platform, 'unknown');
  });
});

describe('NativeAffinityRouter — 原生亲和路由（§3.3）', () => {
  const router = new NativeAffinityRouter();

  test('open_url 在 5 环境分裂为各自原生工具（防呆① 路径分裂非 Polyfill）', () => {
    const want = {
      [PLATFORM.LINUX]: 'xdg-open', [PLATFORM.MACOS]: 'open', [PLATFORM.WINDOWS]: 'start',
      [PLATFORM.ANDROID]: 'Intent.ACTION_VIEW', [PLATFORM.HARMONY]: 'Ability.startAbility',
    };
    for (const plat of Object.values(PLATFORM)) {
      const r = router.route('open_url', scanWith(PROBES[plat]));
      assert.equal(r.status, ROUTE_STATUS.NATIVE);
      assert.equal(r.native, true);
      assert.equal(r.tool, want[plat], `${plat} open_url 应路由到 ${want[plat]}`);
    }
  });

  test('monitor_process：Linux eBPF（带 /proc fallback）', () => {
    const r = router.route('monitor_process', scanWith(PROBES[PLATFORM.LINUX]));
    assert.equal(r.tool, 'eBPF');
    assert.equal(r.kind, 'kernel-probe');
    assert.ok(/proc/.test(r.fallback));
  });

  test('防呆③：无指纹 → NO_FINGERPRINT，拒绝盲调', () => {
    assert.equal(router.route('open_url', null).status, ROUTE_STATUS.NO_FINGERPRINT);
    assert.equal(router.route('open_url', scanWith(UNKNOWN_PROBE)).status, ROUTE_STATUS.NO_FINGERPRINT);
  });

  test('防呆①：未知意图 → ORGAN_VOID（器官空洞，绝不回退统一 API）', () => {
    const r = router.route('frobnicate', scanWith(PROBES[PLATFORM.LINUX]));
    assert.equal(r.status, ROUTE_STATUS.ORGAN_VOID);
    assert.equal(r.native, false);
    assert.equal(r.specialty, 'frobnicate@Linux');
  });

  test('防呆⑤：特长已熔断 → DEGRADED_SAFE，降级通用安全', () => {
    const breaker = new SpecialtyBreaker();
    breaker.fuse(PLATFORM.LINUX, 'open_url@Linux', FUSE_CAUSE.CRASH);
    const r = new NativeAffinityRouter({ breaker }).route('open_url', scanWith(PROBES[PLATFORM.LINUX]));
    assert.equal(r.status, ROUTE_STATUS.DEGRADED_SAFE);
    assert.equal(r.native, false);
    assert.equal(r.kind, 'safe-fallback');
  });

  test('防呆④：同意图 + 同指纹 → 路由结果完全一致（无状态）', () => {
    const fp = scanWith(PROBES[PLATFORM.WINDOWS]);
    assert.deepEqual(router.route('monitor_process', fp), router.route('monitor_process', fp));
  });
});

describe('CompatibilityQuencher — 兼容性即特长淬火（§3.4 / 防呆②）', () => {
  const q = new CompatibilityQuencher();

  test('器官空洞淬火 → 器官新生需求，带 env_scope 且锁 L1（不擅升 L2）', () => {
    const fp = scanWith(PROBES[PLATFORM.ANDROID]);
    const out = q.quenchOrganVoid({ intent: 'read_sensors', specialty: 'read_sensors@Android' }, fp);
    assert.equal(out.kind, 'organ-newborn');
    assert.equal(out.env_scope, PLATFORM.ANDROID);
    assert.equal(out.requirement.env_scope, PLATFORM.ANDROID);   // 防呆②：钉进需求本体
    assert.equal(out.requirement.envSpecific, true);
    assert.equal(out.requirement.level, evoLevels.LEVELS.L1);     // 器官新生级，绝不 L2
    assert.equal(evoRequirement.validate(out.requirement).valid, true);
  });

  test('器官新生需求 proposedModules 取材于该环境长板拓扑（§3.2 方向指引）', () => {
    const out = q.quenchOrganVoid({ intent: 'read_sensors', specialty: 'read_sensors@Android' }, scanWith(PROBES[PLATFORM.ANDROID]));
    assert.ok(out.requirement.proposedModules.some((m) => /Android/.test(m)));
  });

  test('特长回滚淬火（防呆⑤）→ rollback=true，带 env_scope，L1', () => {
    const out = q.quenchRollback({ specialty: 'open_url@Linux', cause: FUSE_CAUSE.SECURITY_DEGRADE }, { platform: PLATFORM.LINUX });
    assert.equal(out.kind, 'specialty-rollback');
    assert.equal(out.rollback, true);
    assert.equal(out.requirement.env_scope, PLATFORM.LINUX);
    assert.equal(out.requirement.rollback, true);
    assert.equal(out.requirement.level, evoLevels.LEVELS.L1);
    assert.equal(evoRequirement.validate(out.requirement).valid, true);
  });

  test('防呆②③：无 env_scope（未识别环境）→ 拒绝铸造，绝不外溢全局', () => {
    assert.throws(() => q.quenchOrganVoid({ intent: 'x', specialty: 'x@unknown' }, { platform: 'unknown' }), /env_scope/);
  });
});

describe('SpecialtyBreaker — 特长熔断（防呆⑤）', () => {
  test('首次熔断 newlyFused=true，重复熔断幂等只累加计数', () => {
    const b = new SpecialtyBreaker();
    const f1 = b.fuse(PLATFORM.WINDOWS, 'open_url@Windows', FUSE_CAUSE.CRASH);
    assert.equal(f1.newlyFused, true);
    assert.equal(f1.count, 1);
    const f2 = b.fuse(PLATFORM.WINDOWS, 'open_url@Windows', FUSE_CAUSE.CRASH);
    assert.equal(f2.newlyFused, false);
    assert.equal(f2.count, 2);
  });

  test('isFused / reset', () => {
    const b = new SpecialtyBreaker();
    b.fuse(PLATFORM.MACOS, 'monitor_process@macOS');
    assert.equal(b.isFused(PLATFORM.MACOS, 'monitor_process@macOS'), true);
    assert.equal(b.reset(PLATFORM.MACOS, 'monitor_process@macOS'), true);
    assert.equal(b.isFused(PLATFORM.MACOS, 'monitor_process@macOS'), false);
  });
});

describe('EnvSymbiosis — 门面闭环', () => {
  test('命中原生器官 → routed（Linux open_url → xdg-open）', () => {
    const eco = new EnvSymbiosis({ probe: PROBES[PLATFORM.LINUX], branch: freshBranch() });
    const r = eco.dispatch('open_url');
    assert.equal(r.status, 'routed');
    assert.equal(r.route.tool, 'xdg-open');
  });

  test('器官空洞 → quenched，需求入池且带 env_scope（防呆①②）', () => {
    const eco = new EnvSymbiosis({ probe: PROBES[PLATFORM.HARMONY], branch: freshBranch() });
    const r = eco.dispatch('frobnicate');
    assert.equal(r.status, 'quenched');
    assert.equal(r.quench.env_scope, PLATFORM.HARMONY);
    assert.equal(r.quench.requirement.env_scope, PLATFORM.HARMONY);
    assert.equal(evoRequirement.validate(r.quench.requirement).valid, true);
    const pool = eco.pool();
    assert.ok(pool.length >= 1);
    assert.equal(pool[pool.length - 1].payload.env_scope, PLATFORM.HARMONY);
  });

  test('防呆③：未识别环境 → blocked，不淬火（无 env_scope 不臆造需求）', () => {
    const eco = new EnvSymbiosis({ probe: UNKNOWN_PROBE, branch: freshBranch() });
    const r = eco.dispatch('open_url');
    assert.equal(r.status, 'blocked');
    assert.equal(r.quench, undefined);
    assert.equal(eco.pool().length, 0);
  });

  test('防呆⑤：reportFault 首次熔断淬出回滚需求，再报幂等；其后该意图降级安全', () => {
    const eco = new EnvSymbiosis({ probe: PROBES[PLATFORM.LINUX], branch: freshBranch() });
    const f1 = eco.reportFault({ platform: PLATFORM.LINUX, specialty: 'open_url@Linux', cause: FUSE_CAUSE.SECURITY_DEGRADE });
    assert.equal(f1.status, 'fused');
    assert.equal(f1.quench.rollback, true);
    assert.equal(f1.quench.env_scope, PLATFORM.LINUX);

    const f2 = eco.reportFault({ platform: PLATFORM.LINUX, specialty: 'open_url@Linux', cause: FUSE_CAUSE.CRASH });
    assert.equal(f2.status, 'already-fused');
    assert.equal(f2.quench, undefined);

    // 熔断后再派发同意图 → 降级通用安全（防呆⑤）。
    const r = eco.dispatch('open_url');
    assert.equal(r.status, 'degraded');
    assert.equal(r.route.status, ROUTE_STATUS.DEGRADED_SAFE);
  });

  test('需求池哈希链完整（防呆⑤ 复用 evoLedger）', () => {
    const eco = new EnvSymbiosis({ probe: PROBES[PLATFORM.ANDROID], branch: freshBranch() });
    eco.dispatch('frobnicate');
    eco.reportFault({ platform: PLATFORM.ANDROID, specialty: 'read_sensors@Android' });
    assert.equal(eco.verifyPool().ok, true);
  });

  test('防呆④：跨实例同意图同指纹 → route 一致（核心状态机无状态跨平台一致）', () => {
    const a = new EnvSymbiosis({ probe: PROBES[PLATFORM.WINDOWS], branch: freshBranch() });
    const b = new EnvSymbiosis({ probe: PROBES[PLATFORM.WINDOWS], branch: freshBranch() });
    assert.deepEqual(a.dispatch('monitor_process').route, b.dispatch('monitor_process').route);
  });
});

describe('场景验证（§4）：意图「监控系统进程」的多环境原生亲和 + 淬火', () => {
  test('monitor_process 在各环境分裂为原生路径（Linux eBPF / Win WMI / Android /proc / macOS sysctl / Harmony 分布式）', () => {
    const want = {
      [PLATFORM.LINUX]: /eBPF/, [PLATFORM.WINDOWS]: /WMI/, [PLATFORM.ANDROID]: /proc/,
      [PLATFORM.MACOS]: /sysctl/, [PLATFORM.HARMONY]: /HiDumper|分布式/,
    };
    for (const plat of Object.values(PLATFORM)) {
      const eco = new EnvSymbiosis({ probe: PROBES[plat], branch: freshBranch() });
      const r = eco.dispatch('monitor_process');
      assert.equal(r.status, 'routed', `${plat} 应原生命中`);
      assert.match(r.route.tool, want[plat], `${plat} monitor_process 原生工具不符`);
    }
  });

  test('遇兼容性问题即淬火新器官：Android 缺 read_sensors → 仅 env_scope=Android 长出器官，不污染全局', () => {
    const eco = new EnvSymbiosis({ probe: PROBES[PLATFORM.ANDROID], branch: freshBranch() });
    const r = eco.dispatch('read_sensors');
    assert.equal(r.status, 'quenched');
    assert.equal(r.quench.requirement.env_scope, PLATFORM.ANDROID);
    assert.equal(r.quench.requirement.envSpecific, true);
    // 同一意图在 Linux 上是另一套 env_scope，互不污染。
    const ecoLinux = new EnvSymbiosis({ probe: PROBES[PLATFORM.LINUX], branch: freshBranch() });
    const rl = ecoLinux.dispatch('read_sensors');
    assert.equal(rl.quench.requirement.env_scope, PLATFORM.LINUX);
    assert.notEqual(r.quench.requirement.env_scope, rl.quench.requirement.env_scope);
  });
});
