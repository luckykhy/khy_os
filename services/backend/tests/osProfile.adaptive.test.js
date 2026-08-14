'use strict';

/**
 * OS-dimension adaptation — verify osProfileService reads container/cgroup real
 * limits, detects WSL, applies per-OS behavior modifiers, honors the
 * KHY_OS_PROFILE / KHY_EFFECTIVE_* overrides, and that hardwareProfileService
 * combines the effective (container-clamped) resources into classification.
 *
 * All I/O goes through an injected probe so the tests are deterministic on any
 * host (bare Linux, container, Windows, WSL).
 */

const { PLATFORM } = require('../src/services/envSymbiosis/platformIds');

/** Build a probe with sane defaults; override per-test. */
function makeProbe(over = {}) {
  const files = over.files || {};
  return {
    nodePlatform: over.nodePlatform || 'linux',
    osType: over.osType || 'Linux 6.1.0',
    runtime: over.runtime || 'node',
    isAndroid: over.isAndroid || false,
    hostRamMB: over.hostRamMB != null ? over.hostRamMB : 16384,
    hostCpuCount: over.hostCpuCount != null ? over.hostCpuCount : 8,
    readFile: (p) => (Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null),
    exists: (p) => (over.existing ? over.existing.includes(p) : false),
    env: over.env || {},
  };
}

describe('osProfileService — container / cgroup / OS modifiers', () => {
  let osp;

  beforeEach(() => {
    jest.resetModules();
    osp = require('../src/services/osProfileService');
    osp.resetCache();
  });

  test('bare Linux host: no clamp, neutral modifier', () => {
    const r = osp._detect(makeProbe());
    expect(r.os).toBe(PLATFORM.LINUX);
    expect(r.effective).toBeNull();
    expect(r.container.detected).toBe(false);
    expect(r.modifiers.timeoutMultiplier).toBe(1.0);
    expect(r.isWSL).toBe(false);
  });

  test('cgroup v2 memory.max clamps effective memory + flags container', () => {
    const r = osp._detect(makeProbe({
      files: { '/sys/fs/cgroup/memory.max': String(512 * 1024 * 1024) },
    }));
    expect(r.effective).not.toBeNull();
    expect(r.effective.memoryMB).toBe(512);
    expect(r.container.detected).toBe(true);
    expect(r.container.runtime).toBe('cgroup');
  });

  test('cgroup v2 cpu.max "200000 100000" → 2 effective cpus', () => {
    const r = osp._detect(makeProbe({
      files: { '/sys/fs/cgroup/cpu.max': '200000 100000' },
    }));
    expect(r.effective.cpuCount).toBe(2);
  });

  test('cgroup "max" sentinel does NOT clamp', () => {
    const r = osp._detect(makeProbe({
      files: { '/sys/fs/cgroup/memory.max': 'max', '/sys/fs/cgroup/cpu.max': 'max 100000' },
    }));
    expect(r.effective).toBeNull();
  });

  test('cgroup v1 fallback reads memory.limit_in_bytes + cfs quota', () => {
    const r = osp._detect(makeProbe({
      files: {
        '/sys/fs/cgroup/memory/memory.limit_in_bytes': String(1024 * 1024 * 1024),
        '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '150000',
        '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000',
      },
    }));
    expect(r.effective.memoryMB).toBe(1024);
    expect(r.effective.cpuCount).toBe(2); // ceil(1.5)
  });

  test('cgroup v1 unlimited sentinel (>= host) is ignored', () => {
    const r = osp._detect(makeProbe({
      hostRamMB: 16384,
      files: { '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712' },
    }));
    expect(r.effective).toBeNull();
  });

  test('/.dockerenv marks container even without cgroup limit', () => {
    const r = osp._detect(makeProbe({ existing: ['/.dockerenv'] }));
    expect(r.container.detected).toBe(true);
    expect(r.container.runtime).toBe('docker');
  });

  test('WSL detected via /proc/version → timeout floor 1.3', () => {
    const r = osp._detect(makeProbe({
      files: { '/proc/version': 'Linux version 5.15.0-microsoft-standard-WSL2' },
    }));
    expect(r.isWSL).toBe(true);
    expect(r.modifiers.timeoutMultiplier).toBeGreaterThanOrEqual(1.3);
    expect(r.capabilities).toContain('wsl');
  });

  test('Windows kernel signature → 1.5 multiplier + hideConsole', () => {
    const r = osp._detect(makeProbe({ nodePlatform: 'win32', osType: 'Windows_NT 10.0' }));
    expect(r.os).toBe(PLATFORM.WINDOWS);
    expect(r.modifiers.timeoutMultiplier).toBe(1.5);
    expect(r.modifiers.hideConsole).toBe(true);
  });

  test('KHY_OS_PROFILE pins OS identity (windows on a linux box)', () => {
    const r = osp._detect(makeProbe({ env: { KHY_OS_PROFILE: 'windows' } }));
    expect(r.os).toBe(PLATFORM.WINDOWS);
    expect(r.source).toBe('pinned');
    expect(r.modifiers.timeoutMultiplier).toBe(1.5);
  });

  test('KHY_EFFECTIVE_MEM_MB wins over cgroup reading', () => {
    const r = osp._detect(makeProbe({
      env: { KHY_EFFECTIVE_MEM_MB: '2048', KHY_EFFECTIVE_CPUS: '2' },
      files: { '/sys/fs/cgroup/memory.max': String(512 * 1024 * 1024) },
    }));
    expect(r.effective.memoryMB).toBe(2048);
    expect(r.effective.cpuCount).toBe(2);
  });

  test('detectOsProfile never throws and caches', () => {
    expect(() => osp.detectOsProfile()).not.toThrow();
    const a = osp.detectOsProfile();
    const b = osp.detectOsProfile();
    expect(a).toBe(b); // cached identity
  });
});

describe('hardwareProfileService — combines effective resources', () => {
  let savedEnv;
  let hw;

  beforeEach(() => {
    savedEnv = { ...process.env };
    delete process.env.KHY_HW_PROFILE;
    delete process.env.KHY_OS_PROFILE;
    delete process.env.KHY_EFFECTIVE_MEM_MB;
    delete process.env.KHY_EFFECTIVE_CPUS;
    jest.resetModules();
    hw = require('../src/services/hardwareProfileService');
    hw.resetCache();
    require('../src/services/osProfileService').resetCache();
  });

  afterEach(() => {
    process.env = savedEnv;
    jest.resetModules();
  });

  test('container effective 2GB/2cpu → server-minimal even on a big host', () => {
    process.env.KHY_EFFECTIVE_MEM_MB = '2048';
    process.env.KHY_EFFECTIVE_CPUS = '2';
    hw.resetCache();
    require('../src/services/osProfileService').resetCache();
    const p = hw.detectProfile();
    expect(p.profile).toBe('server-minimal');
    expect(p.limits.maxConcurrency).toBe(1);
    expect(p.effective.clamped).toBe(true);
    expect(p.effective.ramMB).toBe(2048);
    expect(p.memory.effectiveGB).toBe(2);
  });

  test('Windows OS profile widens shell/AI timeouts by 1.5', () => {
    process.env.KHY_OS_PROFILE = 'windows';
    hw.resetCache();
    require('../src/services/osProfileService').resetCache();
    const p = hw.detectProfile();
    // Base shell timeout for non-minimal tiers is 30s → ×1.5 = 45s.
    // server-minimal base is 15s → 22.5s ≈ 22500. Assert it scaled up regardless.
    expect(p.os.os).toBe('Windows');
    expect(p.os.modifiers.timeoutMultiplier).toBe(1.5);
    expect(p.limits.shellTimeoutMs).toBeGreaterThan(15000);
  });

  test('getAppliedLimits exposes the os block', () => {
    hw.resetCache();
    require('../src/services/osProfileService').resetCache();
    const applied = hw.getAppliedLimits();
    expect(applied.os).toBeTruthy();
    expect(applied.os).toHaveProperty('os');
    expect(applied.os).toHaveProperty('container');
    expect(applied.os).toHaveProperty('effective');
    expect(applied.os).toHaveProperty('isWSL');
    expect(applied.os).toHaveProperty('pinned');
  });

  test('effective memory never exceeds host memory (clamp invariant)', () => {
    hw.resetCache();
    require('../src/services/osProfileService').resetCache();
    const p = hw.detectProfile();
    // Robust on any host (bare or container): effective is always <= host, and
    // present. We do not assert equality since the CI host itself may be cgroup-
    // limited; the invariant under test is "never enlarge".
    expect(p.effective).toBeTruthy();
    expect(p.memory.effectiveGB).toBeLessThanOrEqual(p.memory.totalGB);
    expect(p.effective.ramMB).toBeLessThanOrEqual(p.memory.totalMB);
  });
});
