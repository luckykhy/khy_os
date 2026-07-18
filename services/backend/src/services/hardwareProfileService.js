/**
 * Hardware Profile Service — detect and profile hardware capabilities.
 *
 * Guides model selection, memory limits, and feature enablement
 * based on actual hardware rather than guesswork.
 *
 * Profiles:
 *   - server-minimal: 4C/4G Ubuntu VPS (lightweight mode)
 *   - desktop-cpu:    i5/Ryzen, 8-16G RAM, no GPU
 *   - desktop-gpu:    with NVIDIA GPU (4-8G VRAM)
 *   - workstation:    32G+ RAM, 12G+ VRAM
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Suppress stderr on all execSync calls to prevent Windows error messages
const EXEC_OPTS = { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] };

let _cachedProfile = null;

// Named tiers a user may pin via KHY_HW_PROFILE. Keep in sync with the cases in
// classifyProfile()/calculateLimits()/recommendLocalModels().
const VALID_PROFILES = new Set([
  'server-minimal',
  'server-standard',
  'desktop-cpu',
  'desktop-gpu',
  'workstation',
]);

/**
 * Read a user-pinned profile tier from KHY_HW_PROFILE.
 * @returns {string|null} a valid tier name, or null for auto/empty/invalid.
 */
function _pinnedProfile() {
  const raw = String(process.env.KHY_HW_PROFILE || '').trim().toLowerCase();
  if (!raw || raw === 'auto') return null;
  return VALID_PROFILES.has(raw) ? raw : null;
}

// ── Cross-launch hardware-probe cache ────────────────────────────────────────
// detectProfile() runs three process-spawning probes on the blocking startup
// path (via prefetch.js applyLimits): detectGpu() → nvidia-smi, detectSwap() →
// `free -m` / `sysctl` / PowerShell CIM, and parseCpuInfo()'s Linux `grep
// /proc/cpuinfo` for AVX2. On Windows each is a full CreateProcess + Defender
// scan, and the in-memory `_cachedProfile` only elides them within one process
// — every fresh `khy chat` paid them again. Their outputs (GPU model, swap
// size, AVX2 support) are static for a given host, so we cache them to disk keyed
// on a cheap, spawn-free machine signature and skip the probes while it matches.
// Fail-open: any miss/mismatch/error falls through to the authoritative probes.
const HW_PROBE_CACHE_VERSION = 1;

/**
 * KHY_HW_PROBE_CACHE gate (default-on). Falsy = {0,false,off,no}; when off the
 * probes run every launch exactly as before (a pure escape hatch).
 * @returns {boolean}
 */
function _hwProbeCacheEnabled() {
  const raw = String(process.env.KHY_HW_PROBE_CACHE ?? '').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

function _hwProbeCacheFile() {
  return path.join(require('../utils/dataHome').getDataHome(), 'hw_probe_cache.json');
}

/**
 * Cheap, spawn-free host signature. GPU model / AVX2 support / swap size are
 * static for a given (platform, arch, CPU model, core count, total RAM) host, so
 * an equal signature means the cached probe outputs are still authoritative.
 * @returns {string}
 */
function _hwProbeSignature({ platform, arch, cpuModel, cpuCount, totalRamMB }) {
  return [HW_PROBE_CACHE_VERSION, platform, arch, cpuModel, cpuCount, totalRamMB].join('|');
}

/**
 * Load cached probe outputs when the signature matches.
 * @returns {{cpuInfo:object, gpu:(object|null), swap:object}|null} the cached
 *   triple, or null on any miss/mismatch/shape-error (fail-open).
 */
function _loadHwProbeCache(signature) {
  if (!_hwProbeCacheEnabled()) return null;
  try {
    const data = JSON.parse(fs.readFileSync(_hwProbeCacheFile(), 'utf-8'));
    if (!data || data.signature !== signature) return null;
    if (!data.cpuInfo || typeof data.cpuInfo.hasAvx2 !== 'boolean') return null;
    if (!data.swap || typeof data.swap.totalMB !== 'number') return null;
    // gpu is legitimately null on a host with no discrete GPU.
    if (data.gpu !== null && typeof data.gpu !== 'object') return null;
    return { cpuInfo: data.cpuInfo, gpu: data.gpu, swap: data.swap };
  } catch {
    return null;
  }
}

/**
 * Persist probe outputs for the given signature. Best-effort: a read-only home
 * just means the probes run again next launch.
 */
function _saveHwProbeCache(signature, { cpuInfo, gpu, swap }) {
  if (!_hwProbeCacheEnabled()) return;
  try {
    fs.writeFileSync(_hwProbeCacheFile(), JSON.stringify({ signature, cpuInfo, gpu, swap }), 'utf-8');
  } catch {
    /* best-effort */
  }
}

/**
 * Detect full hardware profile.
 * @returns {object} Complete hardware profile
 */
function detectProfile() {
  if (_cachedProfile) return _cachedProfile;

  const totalRamMB = Math.round(os.totalmem() / (1024 * 1024));
  const freeRamMB = Math.round(os.freemem() / (1024 * 1024));
  const totalRamGB = Math.round(totalRamMB / 1024);
  const cpuCount = os.cpus().length;
  const cpuModel = os.cpus()[0]?.model?.trim() || 'unknown';
  const platform = os.platform();
  const arch = os.arch();

  // Detect CPU generation/capabilities (AVX2), GPU, and swap. Each spawns a
  // process (cpuinfo grep on Linux, nvidia-smi, `free`/`sysctl`/PowerShell CIM),
  // but all three describe STATIC hardware — cache them across launches keyed on
  // a spawn-free host signature so a fresh `khy chat` skips the spawns entirely.
  // Dynamic fields (free RAM, disk usage) are always recomputed live below.
  const probeSignature = _hwProbeSignature({ platform, arch, cpuModel, cpuCount, totalRamMB });
  let cpuInfo;
  let gpu;
  let swap;
  const cachedProbes = _loadHwProbeCache(probeSignature);
  if (cachedProbes) {
    ({ cpuInfo, gpu, swap } = cachedProbes);
  } else {
    cpuInfo = parseCpuInfo(cpuModel);
    gpu = detectGpu();
    swap = detectSwap();
    _saveHwProbeCache(probeSignature, { cpuInfo, gpu, swap });
  }

  // Detect disk space (cheap statfs, no shell — always live for free space).
  const disk = detectDisk();

  // Combine the OS dimension. os.totalmem()/os.cpus() report HOST values, so a
  // 2GB container on a big host would mis-classify as a workstation and OOM. The
  // OS profile reads cgroup/container limits to give the *effective* resources
  // the process is actually allowed, plus per-OS behavior modifiers. Fail-soft:
  // a neutral profile on any error → today's host-value behavior.
  let osProfile;
  try {
    osProfile = require('./osProfileService').detectOsProfile();
  } catch {
    osProfile = null;
  }
  const effMemFromOs = osProfile && osProfile.effective ? osProfile.effective.memoryMB : null;
  const effCpuFromOs = osProfile && osProfile.effective ? osProfile.effective.cpuCount : null;
  const effectiveRamMB = (effMemFromOs != null) ? Math.min(totalRamMB, effMemFromOs) : totalRamMB;
  const effectiveCpu = (effCpuFromOs != null) ? Math.min(cpuCount, effCpuFromOs) : cpuCount;
  const effectiveRamGB = Math.round(effectiveRamMB / 1024);
  const effectiveFreeMB = Math.min(freeRamMB, effectiveRamMB);
  const clamped = effectiveRamMB < totalRamMB || effectiveCpu < cpuCount;

  // Determine profile tier. A user may pin a tier via KHY_HW_PROFILE to force
  // a lighter/heavier behavior than auto-classification would pick (e.g. run a
  // beefy laptop in power-saving "server-minimal" mode). Auto-detection still
  // populates the display fields (CPU/RAM/GPU); only the tier + limits are
  // overridden. An invalid/"auto"/empty value falls back to auto-classification.
  // Classification/limits use the EFFECTIVE (container-clamped) resources.
  const pinned = _pinnedProfile();
  const profile = pinned || classifyProfile({ totalRamGB: effectiveRamGB, cpuCount: effectiveCpu, gpu, cpuInfo });

  // Calculate safe limits from effective resources, then apply OS behavior
  // modifiers (Windows AV / WSL interop widen timeouts; never tighten).
  const limits = calculateLimits(profile, { totalRamMB: effectiveRamMB, freeRamMB: effectiveFreeMB, cpuCount: effectiveCpu, gpu });
  const timeoutMult = osProfile && osProfile.modifiers ? osProfile.modifiers.timeoutMultiplier : 1;
  if (Number.isFinite(timeoutMult) && timeoutMult > 1) {
    limits.shellTimeoutMs = Math.round(limits.shellTimeoutMs * timeoutMult);
    limits.aiTimeoutMs = Math.round(limits.aiTimeoutMs * timeoutMult);
  }

  // Determine recommended local models
  const localModels = recommendLocalModels(profile, { totalRamGB, gpu, cpuInfo });

  _cachedProfile = {
    profile,
    cpu: {
      model: cpuModel,
      cores: cpuCount,
      generation: cpuInfo.generation,
      brand: cpuInfo.brand,
      hasAvx2: cpuInfo.hasAvx2,
    },
    memory: {
      totalMB: totalRamMB,
      totalGB: totalRamGB,
      freeMB: freeRamMB,
      freeGB: Math.round(freeRamMB / 1024),
      // Effective (container-clamped) RAM the process is actually allowed.
      // Equals totalGB on a bare host; smaller inside a memory-limited cgroup.
      effectiveGB: effectiveRamGB,
    },
    gpu,
    disk,
    swap,
    platform,
    arch,
    limits,
    localModels,
    // OS dimension: identity, container/cgroup limits, behavior modifiers.
    os: osProfile,
    // Effective resources used for classification (container-aware).
    effective: { ramMB: effectiveRamMB, cpuCount: effectiveCpu, clamped },
    isServer: profile === 'server-minimal' || profile === 'server-standard',
    isLightweight: effectiveRamGB <= 4 || profile === 'server-minimal',
  };

  return _cachedProfile;
}

/**
 * Parse CPU model string for useful info.
 */
function parseCpuInfo(cpuModel) {
  const lower = cpuModel.toLowerCase();
  let brand = 'unknown', generation = 0, hasAvx2 = false;

  // Intel detection
  const intelMatch = cpuModel.match(/i([3579])-(\d{2,5})/);
  if (intelMatch) {
    brand = `Intel Core i${intelMatch[1]}`;
    const modelNum = parseInt(intelMatch[2]);
    // Intel generations: 10xxx=10th, 11xxx=11th, 12xxx=12th, 13xxx=13th, 14xxx=14th
    if (modelNum >= 14000) generation = 14;
    else if (modelNum >= 13000) generation = 13;
    else if (modelNum >= 12000) generation = 12;
    else if (modelNum >= 11000) generation = 11;
    else if (modelNum >= 10000) generation = 10;
    else if (modelNum >= 8000) generation = 8;
    hasAvx2 = generation >= 4; // Haswell (4th gen) introduced AVX2
  }

  // AMD detection
  const amdMatch = cpuModel.match(/Ryzen\s+([3579])\s+(\d{4})/i);
  if (amdMatch) {
    brand = `AMD Ryzen ${amdMatch[1]}`;
    const modelNum = parseInt(amdMatch[2]);
    if (modelNum >= 7000) generation = 7;
    else if (modelNum >= 5000) generation = 5;
    else if (modelNum >= 3000) generation = 3;
    hasAvx2 = true; // All Ryzen have AVX2
  }

  // ARM detection (Apple Silicon / server ARM)
  if (lower.includes('apple m') || lower.includes('arm') || lower.includes('aarch64')) {
    brand = 'ARM';
    hasAvx2 = false; // ARM uses NEON instead
  }

  // Check AVX2 on Linux if not already determined
  if (!hasAvx2 && os.platform() === 'linux') {
    try {
      const flags = execSync('grep -m1 flags /proc/cpuinfo 2>/dev/null', EXEC_OPTS);
      hasAvx2 = flags.includes('avx2');
    } catch { /* ignore */ }
  }

  return { brand, generation, hasAvx2 };
}

/**
 * Detect NVIDIA GPU if present.
 */
function detectGpu() {
  try {
    // nvidia-smi is available on Linux/Windows with NVIDIA drivers;
    // use platform-appropriate null device for stderr suppression.
    const nullDev = os.platform() === 'win32' ? 'NUL' : '/dev/null';
    const output = execSync(
      `nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits 2>${nullDev}`,
      { ...EXEC_OPTS, shell: true }
    ).trim();

    if (!output) return null;

    const [name, vramMB, driver] = output.split(', ').map(s => s.trim());
    return {
      name,
      vramMB: parseInt(vramMB) || 0,
      vramGB: Math.round((parseInt(vramMB) || 0) / 1024),
      driver,
      available: true,
    };
  } catch {
    return null;
  }
}

/**
 * Detect available disk space.
 *
 * Uses fs.statfsSync (stable since Node 18) — cross-platform with no shell,
 * so it works on Windows (incl. 24H2 without wmic), macOS/BSD (no GNU df -BM),
 * and minimal Linux alike.
 */
function detectDisk() {
  try {
    const root = os.platform() === 'win32' ? process.cwd().slice(0, 3) : '/';
    const st = fs.statfsSync(root);
    const blockMB = st.bsize / (1024 * 1024);
    const totalMB = Math.round(st.blocks * blockMB);
    const availMB = Math.round(st.bavail * blockMB);
    const usedMB = Math.round((st.blocks - st.bfree) * blockMB);
    const usePercent = totalMB > 0 ? Math.round((usedMB / totalMB) * 100) : 0;
    return { totalMB, usedMB, availMB, usePercent };
  } catch {
    return { totalMB: 0, usedMB: 0, availMB: 0, usePercent: 0 };
  }
}

/**
 * Detect swap configuration.
 *
 * Linux: `free -m`. macOS: `sysctl vm.swapusage`. Windows: pagefile via
 * PowerShell CIM (no wmic, so it survives 24H2). Each branch degrades to zero
 * on failure.
 */
function detectSwap() {
  const platform = os.platform();
  try {
    if (platform === 'darwin') {
      // e.g. "vm.swapusage: total = 2048.00M  used = 512.00M  free = 1536.00M"
      const output = execSync('sysctl -n vm.swapusage 2>/dev/null', EXEC_OPTS);
      const total = output.match(/total\s*=\s*([\d.]+)M/i);
      const used = output.match(/used\s*=\s*([\d.]+)M/i);
      const free = output.match(/free\s*=\s*([\d.]+)M/i);
      return {
        totalMB: total ? Math.round(parseFloat(total[1])) : 0,
        usedMB: used ? Math.round(parseFloat(used[1])) : 0,
        freeMB: free ? Math.round(parseFloat(free[1])) : 0,
      };
    }
    if (platform === 'win32') {
      const ps = 'powershell -NoProfile -Command "(Get-CimInstance Win32_PageFileUsage | '
        + 'Measure-Object -Property AllocatedBaseSize,CurrentUsage -Sum).Sum -join \',\'"';
      const output = execSync(ps, EXEC_OPTS).trim();
      const [allocated, current] = output.split(',').map((n) => parseInt(n, 10) || 0);
      return { totalMB: allocated, usedMB: current, freeMB: Math.max(0, allocated - current) };
    }
    // Linux
    const output = execSync('free -m 2>/dev/null | grep Swap', EXEC_OPTS);
    const parts = output.trim().split(/\s+/);
    return {
      totalMB: parseInt(parts[1]) || 0,
      usedMB: parseInt(parts[2]) || 0,
      freeMB: parseInt(parts[3]) || 0,
    };
  } catch {
    return { totalMB: 0, usedMB: 0, freeMB: 0 };
  }
}

/**
 * Classify hardware into a named profile.
 */
function classifyProfile({ totalRamGB, cpuCount, gpu, cpuInfo }) {
  if (gpu && gpu.vramGB >= 12) return 'workstation';
  if (gpu && gpu.vramGB >= 4) return 'desktop-gpu';
  if (totalRamGB <= 4 || cpuCount <= 2) return 'server-minimal';
  if (totalRamGB <= 8) return 'server-standard';
  if (totalRamGB <= 16) return 'desktop-cpu';
  if (totalRamGB <= 32) return 'desktop-cpu';     // no GPU, lots of RAM
  return 'workstation';
}

/**
 * Calculate safe resource limits based on profile.
 */
function calculateLimits(profile, { totalRamMB, freeRamMB, cpuCount, gpu }) {
  switch (profile) {
    case 'server-minimal':
      return {
        nodeHeapMB: Math.min(256, Math.round(totalRamMB * 0.3)),
        ollamaRamMB: 0,      // no local model on 4G server
        maxConcurrency: 1,    // single request at a time
        maxAgents: 1,         // no parallel agents
        enableBacktest: false,
        enableLocalModel: false,
        enableMultiAgent: false,
        enablePeriodicScan: false,   // save resources
        cleanupIntervalMs: 7200_000, // every 2h
        shellTimeoutMs: 15_000,
        aiTimeoutMs: 60_000,
      };
    case 'server-standard':
      return {
        nodeHeapMB: Math.min(512, Math.round(totalRamMB * 0.4)),
        ollamaRamMB: Math.min(2048, Math.round(totalRamMB * 0.4)),
        maxConcurrency: 2,
        maxAgents: 2,
        enableBacktest: true,
        enableLocalModel: true,
        enableMultiAgent: false,
        enablePeriodicScan: true,
        cleanupIntervalMs: 3600_000,
        shellTimeoutMs: 30_000,
        aiTimeoutMs: 120_000,
      };
    case 'desktop-cpu':
      return {
        nodeHeapMB: Math.min(1024, Math.round(totalRamMB * 0.3)),
        ollamaRamMB: Math.min(8192, Math.round(totalRamMB * 0.5)),
        maxConcurrency: Math.min(3, cpuCount),
        maxAgents: 3,
        enableBacktest: true,
        enableLocalModel: true,
        enableMultiAgent: true,
        enablePeriodicScan: true,
        cleanupIntervalMs: 7200_000,
        shellTimeoutMs: 30_000,
        aiTimeoutMs: 120_000,
      };
    case 'desktop-gpu':
      return {
        nodeHeapMB: Math.min(1024, Math.round(totalRamMB * 0.25)),
        ollamaRamMB: gpu ? gpu.vramMB : 4096,
        maxConcurrency: Math.min(4, cpuCount),
        maxAgents: 4,
        enableBacktest: true,
        enableLocalModel: true,
        enableMultiAgent: true,
        enablePeriodicScan: true,
        cleanupIntervalMs: 7200_000,
        shellTimeoutMs: 30_000,
        aiTimeoutMs: 120_000,
      };
    case 'workstation':
    default:
      return {
        nodeHeapMB: Math.min(2048, Math.round(totalRamMB * 0.2)),
        ollamaRamMB: gpu ? gpu.vramMB : Math.min(16384, Math.round(totalRamMB * 0.5)),
        maxConcurrency: Math.min(6, cpuCount),
        maxAgents: 6,
        enableBacktest: true,
        enableLocalModel: true,
        enableMultiAgent: true,
        enablePeriodicScan: true,
        cleanupIntervalMs: 7200_000,
        shellTimeoutMs: 30_000,
        aiTimeoutMs: 120_000,
      };
  }
}

/**
 * Recommend local models that will run well on this hardware.
 */
function recommendLocalModels(profile, { totalRamGB, gpu, cpuInfo }) {
  const models = [];

  switch (profile) {
    case 'server-minimal':
      // 4GB RAM: no local models, use API only
      models.push({
        recommendation: 'api-only',
        reason: '4GB RAM 不足以运行本地模型，建议使用云端 API (Gemini/Qwen/GLM 免费额度)',
        models: [],
      });
      break;

    case 'server-standard':
      models.push(
        { id: 'qwen2.5:1.5b', name: 'Qwen 2.5 1.5B', sizeGB: 1.0, reason: '极轻量，8GB 服务器可用' },
        { id: 'phi3:mini', name: 'Phi-3 Mini 3.8B', sizeGB: 2.3, reason: '微软小模型，推理高效' },
      );
      break;

    case 'desktop-cpu':
      // i5 11th, 16GB RAM, no GPU — CPU inference, max ~7B quantized
      if (cpuInfo.hasAvx2) {
        models.push(
          { id: 'qwen2.5:3b', name: 'Qwen 2.5 3B', sizeGB: 2.0, reason: '推荐首选 — 中文好，CPU 友好', recommended: true },
          { id: 'qwen2.5:7b-q4_0', name: 'Qwen 2.5 7B (Q4)', sizeGB: 4.0, reason: '4-bit 量化，16GB 可跑但较慢' },
          { id: 'llama3.2:3b', name: 'Llama 3.2 3B', sizeGB: 2.0, reason: '英文优秀，速度快' },
          { id: 'phi3:mini', name: 'Phi-3 Mini', sizeGB: 2.3, reason: '微软推理模型，平衡好' },
          { id: 'deepseek-coder:1.3b', name: 'DeepSeek Coder 1.3B', sizeGB: 0.8, reason: '代码分析专用，极轻量' },
        );
      } else {
        models.push(
          { id: 'qwen2.5:1.5b', name: 'Qwen 2.5 1.5B', sizeGB: 1.0, reason: '无 AVX2 环境推荐' },
          { id: 'phi3:mini', name: 'Phi-3 Mini', sizeGB: 2.3, reason: '兼容性好' },
        );
      }
      break;

    case 'desktop-gpu':
      // With GPU — can run larger models
      if (gpu && gpu.vramGB >= 8) {
        models.push(
          { id: 'qwen2.5:7b', name: 'Qwen 2.5 7B', sizeGB: 4.7, reason: '推荐首选 — GPU 加速，中文最佳', recommended: true },
          { id: 'llama3.1:8b', name: 'Llama 3.1 8B', sizeGB: 4.7, reason: '通用能力强' },
          { id: 'deepseek-coder-v2:lite', name: 'DeepSeek Coder V2', sizeGB: 8.9, reason: '代码分析利器' },
        );
      } else {
        models.push(
          { id: 'qwen2.5:3b', name: 'Qwen 2.5 3B', sizeGB: 2.0, reason: '推荐 — 小显存首选', recommended: true },
          { id: 'qwen2.5:7b', name: 'Qwen 2.5 7B', sizeGB: 4.7, reason: '需要 6GB+ VRAM' },
        );
      }
      break;

    case 'workstation':
      models.push(
        { id: 'qwen2.5:14b', name: 'Qwen 2.5 14B', sizeGB: 9.0, reason: '推荐首选 — 中文量化分析最佳', recommended: true },
        { id: 'qwen2.5:32b', name: 'Qwen 2.5 32B', sizeGB: 20, reason: '顶级中文模型' },
        { id: 'deepseek-v3:latest', name: 'DeepSeek V3', sizeGB: 16, reason: '最强中文开源' },
        { id: 'llama3.1:70b', name: 'Llama 3.1 70B', sizeGB: 39, reason: '需要 48GB+ RAM/VRAM' },
      );
      break;
  }

  return models;
}

/**
 * Get a human-readable hardware summary for display.
 */
function getHardwareSummary() {
  const p = detectProfile();
  const lines = [];

  lines.push(`CPU: ${p.cpu.model} (${p.cpu.cores} cores)`);
  lines.push(`RAM: ${p.memory.totalGB}GB (${p.memory.freeGB}GB free)`);

  if (p.gpu) {
    lines.push(`GPU: ${p.gpu.name} (${p.gpu.vramGB}GB VRAM)`);
  } else {
    lines.push('GPU: none (CPU inference only)');
  }

  if (p.swap.totalMB > 0) {
    lines.push(`Swap: ${Math.round(p.swap.totalMB / 1024)}GB`);
  }

  if (p.disk.availMB > 0) {
    lines.push(`Disk: ${Math.round(p.disk.availMB / 1024)}GB free`);
  }

  lines.push(`Profile: ${p.profile}`);

  return { lines, profile: p };
}

/**
 * Build the hardware-derived environment map from a detected profile.
 *
 * This is the single source of truth for every runtime knob that scales with
 * hardware. Values are strings (env semantics). Consumers read these env vars
 * with their own fallback defaults, so the map never hardcodes behavior — it
 * only nudges existing defaults to match the machine's class.
 *
 * @param {object} p - a profile from detectProfile()
 * @returns {Record<string,string>}
 */
function _hardwareEnvMap(p) {
  const lim = p.limits;
  const map = {
    KHY_MAX_HEAP_MB: String(lim.nodeHeapMB),
    KHY_LIGHTWEIGHT: p.isLightweight ? 'true' : 'false',
    // Concurrency & parallel agents
    KHY_USER_MAX_CONCURRENT: String(lim.maxConcurrency),
    KHY_MAX_SUBAGENTS: String(lim.maxAgents),
    // Timeouts (process-level behavior scales with the machine's class)
    KHY_SHELL_TIMEOUT_MS: String(lim.shellTimeoutMs),
    KHY_AI_TIMEOUT_MS: String(lim.aiTimeoutMs),
    // Background task cadence
    KHY_CLEANUP_INTERVAL_MS: String(lim.cleanupIntervalMs),
    KHY_ENABLE_PERIODIC_SCAN: lim.enablePeriodicScan ? 'true' : 'false',
    // Feature gates
    KHY_ENABLE_MULTI_AGENT: lim.enableMultiAgent ? 'true' : 'false',
    KHY_ENABLE_BACKTEST: lim.enableBacktest ? 'true' : 'false',
    KHY_ENABLE_LOCAL_MODEL: lim.enableLocalModel ? 'true' : 'false',
  };
  // Fold in the local-AI tuning env (token budgets / warmup timeouts), reusing
  // the existing recommender so there is one place that decides those values.
  try {
    const tuning = recommendLocalAiTuning('auto');
    if (tuning && tuning.env) Object.assign(map, tuning.env);
  } catch { /* tuning env is best-effort */ }
  return map;
}

/**
 * Apply hardware-based limits to the current process environment.
 *
 * Call during startup. Each knob is written **only if the user has not already
 * set it** — explicit env always wins over hardware-derived values. Combined
 * with KHY_HW_PROFILE (which pins the tier), this gives full auto-adaptation
 * with a clean override path. Never throws.
 */
function applyLimits() {
  try {
    const p = detectProfile();
    const map = _hardwareEnvMap(p);
    for (const [key, value] of Object.entries(map)) {
      // undefined check (not falsy) so a user's explicit "0"/"false" is honored.
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
    return p.limits;
  } catch {
    return null;
  }
}

/**
 * Report the effective value of every hardware-derived knob plus its source
 * ('hardware' = auto-derived, 'user-override' = explicit env differs). Used by
 * the /hardware command for transparency. Never throws.
 *
 * @returns {{ env: Record<string,string>, source: Record<string,string>, profile: string, pinned: boolean }}
 */
function getAppliedLimits() {
  try {
    const p = detectProfile();
    const map = _hardwareEnvMap(p);
    const env = {};
    const source = {};
    for (const [key, hwVal] of Object.entries(map)) {
      const userVal = process.env[key];
      if (userVal !== undefined && userVal !== hwVal) {
        env[key] = userVal;
        source[key] = 'user-override';
      } else {
        env[key] = userVal !== undefined ? userVal : hwVal;
        source[key] = 'hardware';
      }
    }
    const osInfo = p.os ? {
      os: p.os.os,
      kernel: p.os.kernel,
      isWSL: p.os.isWSL,
      container: p.os.container,
      effective: p.effective,
      pinned: p.os.source === 'pinned',
      timeoutMultiplier: p.os.modifiers ? p.os.modifiers.timeoutMultiplier : 1,
    } : null;
    return { env, source, profile: p.profile, pinned: _pinnedProfile() !== null, os: osInfo };
  } catch {
    return { env: {}, source: {}, profile: 'unknown', pinned: false, os: null };
  }
}

/**
 * Clear cached profile (for testing or after hardware changes).
 */
function resetCache() {
  _cachedProfile = null;
}

function _localAiPresetBase(mode = 'balanced') {
  const presets = {
    fast: {
      mode: 'fast',
      label: 'Fast',
      warmupOnce: true,
      localWarmupWaitMs: 6000,
      ollamaWarmupWaitMs: 4000,
      coldMaxTokens: 768,
      warmMaxTokens: 1536,
      ollamaMaxTokens: 1536,
      disableTokenCap: false,
      hotAttachTimeoutMs: 700,
      runnerHealthTimeoutMs: 800,
      runnerStartTimeoutMs: 10000,
      runnerLoadTimeoutMs: 90000,
    },
    balanced: {
      mode: 'balanced',
      label: 'Balanced',
      warmupOnce: true,
      localWarmupWaitMs: 8000,
      ollamaWarmupWaitMs: 5000,
      coldMaxTokens: 1024,
      warmMaxTokens: 2048,
      ollamaMaxTokens: 2048,
      disableTokenCap: false,
      hotAttachTimeoutMs: 900,
      runnerHealthTimeoutMs: 1000,
      runnerStartTimeoutMs: 12000,
      runnerLoadTimeoutMs: 120000,
    },
    quality: {
      mode: 'quality',
      label: 'Quality',
      warmupOnce: true,
      localWarmupWaitMs: 12000,
      ollamaWarmupWaitMs: 8000,
      coldMaxTokens: 1536,
      warmMaxTokens: 3072,
      ollamaMaxTokens: 3072,
      disableTokenCap: false,
      hotAttachTimeoutMs: 1200,
      runnerHealthTimeoutMs: 1200,
      runnerStartTimeoutMs: 15000,
      runnerLoadTimeoutMs: 150000,
    },
  };
  return presets[mode] || presets.balanced;
}

function _toEnvMap(preset) {
  return {
    KHY_LOCAL_WARMUP_ONCE: preset.warmupOnce ? 'true' : 'false',
    KHY_LOCAL_WARMUP_WAIT_MS: String(preset.localWarmupWaitMs),
    KHY_OLLAMA_WARMUP_WAIT_MS: String(preset.ollamaWarmupWaitMs),
    KHY_LOCAL_COLD_MAX_TOKENS: String(preset.coldMaxTokens),
    KHY_LOCAL_WARM_MAX_TOKENS: String(preset.warmMaxTokens),
    KHY_OLLAMA_MAX_TOKENS: String(preset.ollamaMaxTokens),
    KHY_LOCAL_DISABLE_TOKEN_CAP: preset.disableTokenCap ? 'true' : 'false',
    KHY_LOCAL_HOT_ATTACH_TIMEOUT_MS: String(preset.hotAttachTimeoutMs),
    KHY_LOCAL_RUNNER_HEALTH_TIMEOUT_MS: String(preset.runnerHealthTimeoutMs),
    KHY_LOCAL_RUNNER_START_TIMEOUT_MS: String(preset.runnerStartTimeoutMs),
    KHY_LOCAL_RUNNER_LOAD_TIMEOUT_MS: String(preset.runnerLoadTimeoutMs),
  };
}

/**
 * Recommend local AI tuning preset from hardware profile.
 * @param {'auto'|'fast'|'balanced'|'quality'} mode
 * @returns {{mode: string, label: string, reason: string, profile: string, values: object, env: object}}
 */
function recommendLocalAiTuning(mode = 'auto') {
  const p = detectProfile();
  const normalized = String(mode || 'auto').trim().toLowerCase();
  let preset;
  let reason = '';

  if (normalized === 'fast' || normalized === 'balanced' || normalized === 'quality') {
    preset = _localAiPresetBase(normalized);
    reason = `manual mode: ${normalized}`;
  } else {
    switch (p.profile) {
      case 'server-minimal': {
        preset = {
          ..._localAiPresetBase('fast'),
          mode: 'auto/server-minimal',
          label: 'Auto-Minimal',
          localWarmupWaitMs: 4500,
          ollamaWarmupWaitMs: 3000,
          coldMaxTokens: 512,
          warmMaxTokens: 1024,
          ollamaMaxTokens: 1024,
          hotAttachTimeoutMs: 600,
          runnerHealthTimeoutMs: 900,
          runnerStartTimeoutMs: 9000,
        };
        reason = '4GB/low-core server: prioritize low latency and memory safety';
        break;
      }
      case 'server-standard':
        preset = _localAiPresetBase('fast');
        preset.mode = 'auto/server-standard';
        preset.label = 'Auto-Server';
        reason = '8GB class server: prioritize responsiveness';
        break;
      case 'desktop-gpu': {
        preset = {
          ..._localAiPresetBase('balanced'),
          mode: 'auto/desktop-gpu',
          label: 'Auto-GPU',
          warmMaxTokens: 3072,
          ollamaMaxTokens: 3072,
          localWarmupWaitMs: 7000,
          ollamaWarmupWaitMs: 4500,
          hotAttachTimeoutMs: 800,
          runnerStartTimeoutMs: 10000,
          runnerLoadTimeoutMs: 100000,
        };
        reason = 'desktop GPU detected: allow larger responses with good latency';
        break;
      }
      case 'workstation': {
        preset = {
          ..._localAiPresetBase('quality'),
          mode: 'auto/workstation',
          label: 'Auto-Workstation',
          warmMaxTokens: 4096,
          ollamaMaxTokens: 4096,
          runnerLoadTimeoutMs: 180000,
        };
        reason = 'high-end workstation: prefer richer output capacity';
        break;
      }
      case 'desktop-cpu':
      default:
        preset = _localAiPresetBase('balanced');
        preset.mode = 'auto/desktop-cpu';
        preset.label = 'Auto-Desktop';
        reason = 'CPU desktop (8-16GB): balanced speed and completeness';
        break;
    }
  }

  return {
    mode: preset.mode,
    label: preset.label,
    reason,
    profile: p.profile,
    values: preset,
    env: _toEnvMap(preset),
  };
}

module.exports = {
  detectProfile,
  getHardwareSummary,
  applyLimits,
  getAppliedLimits,
  resetCache,
  recommendLocalModels,
  recommendLocalAiTuning,
  detectDisk,
  detectSwap,
  // Test-only surface for the cross-launch probe cache.
  __test__: {
    _hwProbeCacheEnabled,
    _hwProbeCacheFile,
    _hwProbeSignature,
    _loadHwProbeCache,
    _saveHwProbeCache,
  },
};
