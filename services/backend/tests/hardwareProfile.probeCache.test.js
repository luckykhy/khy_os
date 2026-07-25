/**
 * Cross-launch hardware-probe cache (KHY_HW_PROBE_CACHE).
 *
 * detectProfile() runs three process-spawning probes on the blocking startup
 * path — detectGpu() (nvidia-smi), detectSwap() (`free`/`sysctl`/PowerShell
 * CIM), and parseCpuInfo()'s Linux `grep /proc/cpuinfo` for AVX2. On Windows
 * each is a full CreateProcess + Defender scan, and the in-memory _cachedProfile
 * only elides them WITHIN one process, so every fresh `khy chat` re-paid them.
 *
 * The outputs describe static hardware, so they are cached to disk keyed on a
 * spawn-free host signature. These tests prove: (1) a warm launch skips the
 * probe spawns, (2) a cold launch spawns and writes the cache, (3) a signature
 * mismatch / corrupt cache / disabled gate all fail open to the real probes.
 *
 * child_process.execSync is mocked BEFORE require because the service captures
 * it via destructuring at load time (a post-hoc spy on the module property
 * would not affect the bound reference). Only execSync is replaced; spawnSync
 * and friends stay real so unrelated modules are unaffected.
 */

jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return { ...actual, execSync: jest.fn(() => '') };
});

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Isolate the data home (and thus the cache file) into a throwaway dir BEFORE
// anything resolves dataHome. Set once for the whole file so dataHome's own
// internal cache stays consistent; the per-test reset deletes the cache file.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-hwprobe-'));
process.env.KHY_DATA_HOME = TMP_HOME;

const hw = require('../src/services/hardwareProfileService');
const T = hw.__test__;

// execSync calls that are one of the three hardware probes we cache.
const PROBE_RE = /nvidia-smi|free -m|swapusage|PageFileUsage|proc\/cpuinfo/;
function probeSpawnCount() {
  return execSync.mock.calls.filter((c) => PROBE_RE.test(String(c[0]))).length;
}

function cacheFile() {
  return T._hwProbeCacheFile();
}

describe('hardwareProfileService — cross-launch probe cache', () => {
  beforeEach(() => {
    execSync.mockClear();
    hw.resetCache(); // clear in-memory _cachedProfile → force the disk-cache path
    try { fs.unlinkSync(cacheFile()); } catch { /* absent is fine */ }
    delete process.env.KHY_HW_PROBE_CACHE;
  });

  // ── signature ──────────────────────────────────────────────────────────
  test('_hwProbeSignature is a stable, spawn-free join of cheap invariants', () => {
    const sig = T._hwProbeSignature({
      platform: 'linux', arch: 'x64', cpuModel: 'Test CPU', cpuCount: 8, totalRamMB: 16000,
    });
    expect(sig).toBe('1|linux|x64|Test CPU|8|16000');
    expect(probeSpawnCount()).toBe(0);
  });

  // ── gate ───────────────────────────────────────────────────────────────
  test('KHY_HW_PROBE_CACHE gate is default-on and only {0,false,off,no} disable it', () => {
    expect(T._hwProbeCacheEnabled()).toBe(true);
    for (const off of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
      process.env.KHY_HW_PROBE_CACHE = off;
      expect(T._hwProbeCacheEnabled()).toBe(false);
    }
    process.env.KHY_HW_PROBE_CACHE = '1';
    expect(T._hwProbeCacheEnabled()).toBe(true);
  });

  // ── load/save roundtrip + fail-open ──────────────────────────────────────
  test('save then load returns the cached triple for a matching signature', () => {
    const sig = 'sig-A';
    const probes = {
      cpuInfo: { brand: 'Intel', generation: 12, hasAvx2: true },
      gpu: { name: 'RTX 4090', vramMB: 24576, available: true },
      swap: { totalMB: 8192, usedMB: 100, freeMB: 8092 },
    };
    T._saveHwProbeCache(sig, probes);
    expect(T._loadHwProbeCache(sig)).toEqual(probes);
    // A different signature (RAM upgrade, new CPU…) must not match.
    expect(T._loadHwProbeCache('sig-B')).toBeNull();
  });

  test('a null gpu (host with no discrete GPU) roundtrips and is accepted', () => {
    const sig = 'sig-nogpu';
    const probes = {
      cpuInfo: { brand: 'AMD', generation: 5, hasAvx2: true },
      gpu: null,
      swap: { totalMB: 0, usedMB: 0, freeMB: 0 },
    };
    T._saveHwProbeCache(sig, probes);
    expect(T._loadHwProbeCache(sig)).toEqual(probes);
  });

  test('corrupt cache JSON fails open (returns null, never throws)', () => {
    fs.writeFileSync(cacheFile(), '{ not valid json', 'utf-8');
    expect(T._loadHwProbeCache('any')).toBeNull();
  });

  test('shape-invalid cache (missing hasAvx2 / swap.totalMB) fails open', () => {
    fs.writeFileSync(cacheFile(), JSON.stringify({
      signature: 'sig-X', cpuInfo: { brand: 'Intel' }, gpu: null, swap: { totalMB: 1 },
    }), 'utf-8');
    expect(T._loadHwProbeCache('sig-X')).toBeNull();
  });

  test('gate disabled → load returns null even with a valid cache on disk', () => {
    const sig = 'sig-gate';
    T._saveHwProbeCache(sig, {
      cpuInfo: { brand: 'Intel', generation: 12, hasAvx2: true },
      gpu: null,
      swap: { totalMB: 1024, usedMB: 0, freeMB: 1024 },
    });
    process.env.KHY_HW_PROBE_CACHE = 'off';
    expect(T._loadHwProbeCache(sig)).toBeNull();
  });

  // ── the spawn-reduction contract, end-to-end through detectProfile ───────
  test('cold launch spawns the probes and writes the cache; warm launch skips them', () => {
    // Cold: no cache file → the real probes run (≥1 spawn on this host).
    const cold = hw.detectProfile();
    expect(probeSpawnCount()).toBeGreaterThan(0);
    expect(fs.existsSync(cacheFile())).toBe(true);

    // Warm: same host, fresh process (in-memory cache cleared) but the disk
    // cache is intact → detectProfile must NOT spawn any probe.
    execSync.mockClear();
    hw.resetCache();
    const warm = hw.detectProfile();
    expect(probeSpawnCount()).toBe(0);

    // The cached hardware fields are identical to the cold detection.
    expect(warm.gpu).toEqual(cold.gpu);
    expect(warm.swap).toEqual(cold.swap);
    expect(warm.cpu.hasAvx2).toBe(cold.cpu.hasAvx2);
  });

  test('gate off → warm launch re-spawns the probes (no caching)', () => {
    process.env.KHY_HW_PROBE_CACHE = '0';
    hw.detectProfile();
    const first = probeSpawnCount();
    expect(first).toBeGreaterThan(0);

    execSync.mockClear();
    hw.resetCache();
    hw.detectProfile();
    // With the gate off, the second launch pays the probes again.
    expect(probeSpawnCount()).toBeGreaterThan(0);
  });

  afterAll(() => {
    try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
});
