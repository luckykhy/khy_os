/**
 * OS Profile Service — operating-system identity, container/cgroup real limits,
 * and OS behavior modifiers. The single source of truth for the "OS dimension"
 * that combines with the hardware tier in hardwareProfileService.
 *
 * Why this exists (three gaps it closes):
 *   1. Container/cgroup real limits — os.totalmem()/os.cpus() report the HOST
 *      values, so a 2GB container on a 64GB host mis-classifies as a workstation
 *      and OOMs. We read cgroup v2/v1 to compute the *effective* memory/CPU the
 *      process is actually allowed, and clamp only when the limit is finite and
 *      smaller than the host (never enlarge, never block startup).
 *   2. OS behavior modifiers — Windows antivirus (Defender real-time scan) slows
 *      child-process spawn and file IO; WSL cross-/mnt IO is slow. Per-OS
 *      coefficients widen timeouts conservatively (never tighten).
 *   3. OS identity single source — OS name is resolved via the canonical
 *      envSymbiosis/platformIds KERNEL_SIGNATURES table, so resource tuning and
 *      capability routing share one OS-identity authority (no second os.platform()
 *      table). This is the "接 envSymbiosis 能力路由" dimension.
 *
 * Design rules (mirrors hardwareProfileService): single source of truth, explicit
 * override wins, transparent state, fail-soft. Iron rule: if OS/container probing
 * fails, fall back to today's host-value behavior — never fabricate a limit
 * (aligns with envSymbiosis "no fingerprint, no blind tuning").
 */
'use strict';

const os = require('os');
const fs = require('fs');
const { PLATFORM, KERNEL_SIGNATURES } = require('./envSymbiosis/platformIds');

let _cachedProfile = null;

// KHY_OS_PROFILE accepted aliases → canonical PLATFORM value. Symmetric to
// KHY_HW_PROFILE: lets a user pin the OS identity (e.g. to select Windows
// modifiers on a CI Linux box, or for deterministic tests).
const OS_ALIASES = Object.freeze({
  linux: PLATFORM.LINUX,
  windows: PLATFORM.WINDOWS,
  win32: PLATFORM.WINDOWS,
  win: PLATFORM.WINDOWS,
  macos: PLATFORM.MACOS,
  mac: PLATFORM.MACOS,
  darwin: PLATFORM.MACOS,
  osx: PLATFORM.MACOS,
  android: PLATFORM.ANDROID,
  harmony: PLATFORM.HARMONY,
  harmonyos: PLATFORM.HARMONY,
  ohos: PLATFORM.HARMONY,
});

/**
 * OS behavior modifiers (pure data). timeoutMultiplier widens shell/AI timeouts
 * to absorb antivirus / interop slowness; conservative — only ever >= 1.0.
 * hideConsole / gpuProbe are hint bits for display and future use.
 */
const OS_MODIFIERS = Object.freeze({
  [PLATFORM.WINDOWS]: Object.freeze({ timeoutMultiplier: 1.5, hideConsole: true, gpuProbe: 'nvidia' }),
  [PLATFORM.MACOS]: Object.freeze({ timeoutMultiplier: 1.0, hideConsole: false, gpuProbe: 'metal' }),
  [PLATFORM.LINUX]: Object.freeze({ timeoutMultiplier: 1.0, hideConsole: false, gpuProbe: 'nvidia' }),
  [PLATFORM.ANDROID]: Object.freeze({ timeoutMultiplier: 1.2, hideConsole: false, gpuProbe: 'none' }),
  [PLATFORM.HARMONY]: Object.freeze({ timeoutMultiplier: 1.2, hideConsole: false, gpuProbe: 'none' }),
});

// WSL runs a Linux kernel but pays interop/-/mnt IO cost. When detected, the
// timeout multiplier is raised to at least this floor.
const WSL_TIMEOUT_MULTIPLIER = 1.3;

const DEFAULT_MODIFIERS = Object.freeze({ timeoutMultiplier: 1.0, hideConsole: false, gpuProbe: 'none' });

/**
 * Build the default real-environment probe. Every field is read defensively and
 * is overridable for deterministic testing. Never throws.
 */
function _defaultProbe() {
  const safeRead = (p) => {
    try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
  };
  const safeExists = (p) => {
    try { return fs.existsSync(p); } catch { return false; }
  };
  let osType = '';
  let release = '';
  try { osType = os.type(); } catch { /* ignore */ }
  try { release = os.release(); } catch { /* ignore */ }
  let hostRamMB = 0;
  try { hostRamMB = Math.round(os.totalmem() / (1024 * 1024)); } catch { /* ignore */ }
  let hostCpuCount = 0;
  try { hostCpuCount = os.cpus().length; } catch { /* ignore */ }
  return {
    nodePlatform: os.platform(),
    osType: `${osType} ${release}`.trim(),
    runtime: process.release && process.release.name ? process.release.name : 'node',
    isAndroid: /android/i.test(`${osType} ${release}`),
    hostRamMB,
    hostCpuCount,
    readFile: safeRead,
    exists: safeExists,
    env: process.env,
  };
}

/**
 * Resolve canonical OS name from the probe via the envSymbiosis KERNEL_SIGNATURES
 * single source. A user pin (KHY_OS_PROFILE) takes precedence. Returns
 * { os, kernel, source }.
 */
function _resolveOs(probe) {
  const env = probe.env || {};
  const rawPin = String(env.KHY_OS_PROFILE || '').trim().toLowerCase();
  if (rawPin && rawPin !== 'auto' && OS_ALIASES[rawPin]) {
    const pinned = OS_ALIASES[rawPin];
    const sig = KERNEL_SIGNATURES.find((s) => s.platform === pinned);
    return { os: pinned, kernel: sig ? sig.kernel : 'pinned', source: 'pinned' };
  }
  const sig = KERNEL_SIGNATURES.find((s) => {
    try { return s.match(probe); } catch { return false; }
  });
  if (sig) return { os: sig.platform, kernel: sig.kernel, source: 'auto' };
  return { os: PLATFORM.LINUX, kernel: 'unknown', source: 'auto' };
}

/**
 * Parse a cgroup memory limit file value to MB, or null when unlimited/invalid.
 * Handles cgroup v2 "max" sentinel and cgroup v1's huge "unlimited" magic value.
 */
function _parseMemBytes(raw, hostRamMB) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || s === 'max') return null;
  const bytes = Number(s);
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const mb = Math.round(bytes / (1024 * 1024));
  // cgroup v1 unlimited is a giant sentinel; anything >= host RAM is "no limit".
  if (hostRamMB > 0 && mb >= hostRamMB) return null;
  return mb;
}

/** Parse cgroup v2 cpu.max ("quota period" | "max period") → cpu count or null. */
function _parseCpuMaxV2(raw) {
  if (raw == null) return null;
  const parts = String(raw).trim().split(/\s+/);
  if (parts.length < 2) return null;
  const [quota, period] = parts;
  if (quota === 'max') return null;
  const q = Number(quota), pr = Number(period);
  if (!Number.isFinite(q) || !Number.isFinite(pr) || q <= 0 || pr <= 0) return null;
  return Math.max(1, Math.ceil(q / pr));
}

/** Parse cgroup v1 cfs quota/period → cpu count or null (quota -1 = unlimited). */
function _parseCpuV1(quotaRaw, periodRaw) {
  if (quotaRaw == null || periodRaw == null) return null;
  const q = Number(String(quotaRaw).trim());
  const pr = Number(String(periodRaw).trim());
  if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(pr) || pr <= 0) return null;
  return Math.max(1, Math.ceil(q / pr));
}

/**
 * Detect container memory/CPU limits from cgroup v2 then v1. Returns
 * { detected, runtime, memoryMB|null, cpuCount|null }. Defensive: any read
 * failure yields nulls (no clamp). hostRamMB lets us ignore "no limit" sentinels.
 */
function _detectContainerLimits(probe) {
  const read = probe.readFile;
  const exists = probe.exists;
  const hostRamMB = probe.hostRamMB || 0;

  let memoryMB = null;
  let cpuCount = null;
  let runtime = null;

  // cgroup v2 (unified hierarchy)
  const memMaxV2 = read('/sys/fs/cgroup/memory.max');
  if (memMaxV2 != null) {
    memoryMB = _parseMemBytes(memMaxV2, hostRamMB);
  }
  const cpuMaxV2 = read('/sys/fs/cgroup/cpu.max');
  if (cpuMaxV2 != null) {
    cpuCount = _parseCpuMaxV2(cpuMaxV2);
  }

  // cgroup v1 fallback (only fill what v2 didn't provide)
  if (memoryMB == null) {
    const memV1 = read('/sys/fs/cgroup/memory/memory.limit_in_bytes');
    if (memV1 != null) memoryMB = _parseMemBytes(memV1, hostRamMB);
  }
  if (cpuCount == null) {
    const quotaV1 = read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us');
    const periodV1 = read('/sys/fs/cgroup/cpu/cpu.cfs_period_us');
    if (quotaV1 != null && periodV1 != null) cpuCount = _parseCpuV1(quotaV1, periodV1);
  }

  // Container signal: explicit docker marker, or a real (finite, sub-host) limit.
  const dockerMarker = exists('/.dockerenv');
  const detected = dockerMarker || memoryMB != null || cpuCount != null;
  if (detected) runtime = dockerMarker ? 'docker' : 'cgroup';

  return { detected, runtime, memoryMB, cpuCount };
}

/** WSL detection via /proc/version content. */
function _detectWsl(probe) {
  const v = probe.readFile('/proc/version');
  return v != null && /microsoft|wsl/i.test(v);
}

/**
 * Core detection (pure-ish: all I/O goes through the injected probe). Never throws.
 * @param {object} [probe] - override probe for deterministic testing.
 */
function _detect(probe) {
  const p = probe || _defaultProbe();
  const env = p.env || {};

  const { os: osName, kernel, source } = _resolveOs(p);
  const isWSL = _detectWsl(p);

  const container = _detectContainerLimits(p);

  // Effective resources: explicit env override wins over cgroup reading.
  const envMem = parseInt(env.KHY_EFFECTIVE_MEM_MB, 10);
  const envCpu = parseInt(env.KHY_EFFECTIVE_CPUS, 10);
  let memoryMB = Number.isFinite(envMem) && envMem > 0 ? envMem : container.memoryMB;
  let cpuCount = Number.isFinite(envCpu) && envCpu > 0 ? envCpu : container.cpuCount;
  if (memoryMB == null && cpuCount == null) {
    // nothing to clamp
    memoryMB = null;
    cpuCount = null;
  }
  const effective = (memoryMB != null || cpuCount != null)
    ? { memoryMB: memoryMB != null ? memoryMB : null, cpuCount: cpuCount != null ? cpuCount : null }
    : null;

  // OS modifiers, with WSL widening the timeout floor.
  const base = OS_MODIFIERS[osName] || DEFAULT_MODIFIERS;
  let timeoutMultiplier = base.timeoutMultiplier;
  if (isWSL) timeoutMultiplier = Math.max(timeoutMultiplier, WSL_TIMEOUT_MULTIPLIER);
  const modifiers = {
    timeoutMultiplier,
    hideConsole: base.hideConsole,
    gpuProbe: base.gpuProbe,
  };

  // Lightweight capability hints (display/transparency only; routing stays in
  // envSymbiosis.dispatch). Kept minimal and OS-derived to avoid duplicating the
  // full fingerprint scanner.
  const capabilities = [];
  if (osName === PLATFORM.LINUX) capabilities.push('cgroup');
  if (container.detected) capabilities.push('container');
  if (isWSL) capabilities.push('wsl');

  return {
    os: osName,
    kernel,
    isWSL,
    container,
    effective,
    modifiers,
    capabilities,
    source,
  };
}

/**
 * Detect (cached) the OS profile. Never throws — on any failure returns a safe
 * host-value profile with neutral modifiers.
 */
/**
 * envSymbiosis observe-mode 接线（DESIGN-ARCH-039）。默认关闭、fail-soft：
 *   - 环境变量 KHY_ENV_SYMBIOSIS=1|on 开启（默认关）。
 *
 * observe：osProfileService 是环境画像的天然家（已复用 envSymbiosis/platformIds 常量）。
 *   启用后用 EnvSymbiosis 引擎刺探当前环境指纹 + 该平台原生长板拓扑，**加性**挂到
 *   profile.symbiosis 供观测/下游能力路由；绝不改写既有 profile 字段、绝不抛
 *   （EnvSymbiosis.scan/dispatch 自身永不抛，这里再包一层兜底）。原生亲和路由的
 *   侵入式接管（dispatch 真正改执行路径）留后续 PR。
 */
function _maybeAttachSymbiosis(result) {
  const raw = String(process.env.KHY_ENV_SYMBIOSIS || '').trim().toLowerCase();
  if (!(raw === '1' || raw === 'on' || raw === 'true')) return result;
  try {
    // 不转发 osProfileService 的 probe：其契约（nodePlatform/osType/readFile…）与
    // envFingerprintScanner 的探针契约不同；observe 独立刺探真实环境，topology 则
    // 复用本服务已裁定的 result.os（尊重 KHY_OS_PROFILE 钉选/测试探针）。
    const { EnvSymbiosis } = require('./envSymbiosis');
    const engine = new EnvSymbiosis();
    const fingerprint = engine.scan();
    const topology = engine.topology(result && result.os);
    result.symbiosis = { fingerprint, topology };
  } catch { /* observe must never break OS profiling */ }
  return result;
}

function detectOsProfile(probe) {
  if (!probe && _cachedProfile) return _cachedProfile;
  let result;
  try {
    result = _detect(probe);
  } catch {
    result = {
      os: PLATFORM.LINUX,
      kernel: 'unknown',
      isWSL: false,
      container: { detected: false, runtime: null, memoryMB: null, cpuCount: null },
      effective: null,
      modifiers: { ...DEFAULT_MODIFIERS },
      capabilities: [],
      source: 'auto',
    };
  }
  _maybeAttachSymbiosis(result);
  if (!probe) _cachedProfile = result;
  return result;
}

/** Clear cached profile (for testing or after environment changes). */
function resetCache() {
  _cachedProfile = null;
}

module.exports = {
  detectOsProfile,
  resetCache,
  // Exposed for testing / advanced callers.
  _detect,
  _defaultProbe,
  _maybeAttachSymbiosis, // envSymbiosis observe-mode 接线（DESIGN-ARCH-039）— 导出供接线测试

  OS_MODIFIERS,
  WSL_TIMEOUT_MULTIPLIER,
};
