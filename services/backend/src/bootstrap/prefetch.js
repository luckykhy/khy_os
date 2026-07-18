/**
 * Prefetch Orchestration — parallel startup tasks and deferred background work.
 *
 * parallelPrefetch()  — runs during init/setup phase (before REPL prompt).
 * deferredPrefetch()  — runs after REPL prompt is displayed (user can type).
 *
 * Consolidates the scattered setTimeout chains from repl.js into a single
 * managed module.  Returns timer IDs so they can be cancelled on shutdown.
 *
 * Usage:
 *   const { parallelPrefetch, deferredPrefetch } = require('./prefetch');
 *   await parallelPrefetch({ mode: 'khyquant' });
 *   const timers = deferredPrefetch({ mode: 'khyquant', onOutput, isBusy });
 */

const { checkpoint } = require('./startupProfiler');

/**
 * Run critical prefetch tasks in parallel during startup.
 * Each task is individually error-isolated.
 *
 * @param {{ mode?: string }} options
 */
async function parallelPrefetch(options = {}) {
  const { mode = 'khyquant' } = options;
  checkpoint('prefetch:parallel:start');

  const tasks = [];

  // Hardware profile detection (both modes)
  tasks.push(
    (async () => {
      try {
        const hw = require('../services/hardwareProfileService');
        hw.detectProfile();
      } catch { /* non-critical */ }
    })()
  );

  if (mode === 'khyquant') {
    // Network detector (full mode only)
    tasks.push(
      (async () => {
        try {
          const networkDetector = require('../services/networkDetector');
          await networkDetector.init();
        } catch { /* non-critical */ }
      })()
    );

    // Cache service warmup (full mode only)
    tasks.push(
      (async () => {
        try {
          const cache = require('../services/cacheService');
          await cache.getStats();
        } catch { /* non-critical */ }
      })()
    );
  }

  await Promise.allSettled(tasks);
  checkpoint('prefetch:parallel:done');

  // 会话临时目录：创建 + 注册退出清理
  try {
    const { ensureSessionTmpDir, cleanupSessionTmpDir } = require('../tools/platformUtils');
    ensureSessionTmpDir();
    const { addShutdownHook } = require('./shutdown');
    addShutdownHook('session-tmpdir', cleanupSessionTmpDir);
  } catch { /* non-critical */ }
}

/**
 * Schedule deferred background tasks after REPL is ready.
 *
 * Returns an array of timer IDs that can be cleared on shutdown:
 *   const timers = deferredPrefetch({ ... });
 *   // on exit: timers.forEach(clearTimeout);
 *
 * @param {{ mode?: string, onOutput?: (msg: string) => void, isBusy?: () => boolean }} options
 * @returns {Array<NodeJS.Timeout>}
 */
function deferredPrefetch(options = {}) {
  const { mode = 'khyquant', onOutput, isBusy } = options;
  const timers = [];
  const busy = () => (typeof isBusy === 'function' ? isBusy() : false);
  const emit = (msg) => {
    if (typeof onOutput === 'function' && !busy()) onOutput(msg);
  };

  // Apply hardware-derived runtime limits SYNCHRONOUSLY up front (idempotent;
  // honors user/env overrides). This must precede the deferred cleanup/agent
  // timers and the first request so concurrency, timeout and background-cadence
  // consumers read already-adapted env. detectProfile() is cached, so the later
  // deferred call that emits the lightweight notice is effectively free.
  try {
    require('../services/hardwareProfileService').applyLimits();
  } catch { /* non-critical — falls back to fixed defaults */ }

  // 生命周期策略驱动(操作化):策略决定「跑什么 / 何时 / 是否启用」,本模块只持有「怎么跑」。
  // RUNNERS 每个 body 与改造前的 setTimeout/setImmediate 回调逐字节一致;id 必须与
  // serviceLifecyclePolicy 的 cli-startup 条目一一对应,scripts/check-lifecycle-policy.js 守卫防漂移。
  const policy = require('../services/serviceLifecyclePolicy');

  const RUNNERS = {
    // ── Lightweight mode (khy):+300ms 预热 gateway(门判定保留在 body 内)──────
    gatewayWarmup: () => {
      try {
        const shouldWarmGateway = String(
          process.env.KHY_GATEWAY_WARMUP_ON_BOOT || 'true'
        ).toLowerCase() !== 'false';
        if (!shouldWarmGateway) return;
        const gw = require('../services/gateway/aiGateway');
        gw.init().catch(() => {});
      } catch { /* non-critical */ }
    },

    // ── Full mode (khyquant): all deferred tasks ────────────────────────────
    // 2s: Surface the detected profile (limits already applied synchronously above)
    hardwareProfileNotice: () => {
      try {
        const hw = require('../services/hardwareProfileService');
        const profile = hw.detectProfile();
        if (profile.isLightweight) {
          try {
            const chalk = require('chalk').default || require('chalk');
            emit(chalk.dim(`  ℹ 轻量模式: ${profile.profile} (${profile.memory.totalGB}GB RAM, ${profile.cpu.cores} cores)`));
          } catch { /* chalk not available */ }
        }
      } catch { /* non-critical */ }
    },

    // 3s: Data cleanup + periodic cleanup
    cleanupService: () => {
      try {
        const cleanup = require('../services/cleanupService');
        const result = cleanup.runCleanup({ trigger: 'startup' });
        cleanup.startPeriodicCleanup({ skipInitial: true });
        if (result.summary && result.summary.actions && result.summary.actions.length > 0) {
          try {
            const chalk = require('chalk').default || require('chalk');
            emit(chalk.dim(`  ℹ 自动清理: ${result.summary.actions.join(', ')} (释放 ${result.summary.freedHuman})`));
          } catch { /* chalk not available */ }
        }
      } catch { /* non-critical */ }
    },

    // 4s: Resource guard memory monitor
    resourceGuard: () => {
      try {
        const { startMemoryMonitor } = require('../services/resourceGuard');
        startMemoryMonitor();
      } catch { /* non-critical */ }
    },

    // 4s: Project memory prune
    projectMemoryPrune: () => {
      try {
        const { pruneProjects } = require('../services/projectMemoryService');
        pruneProjects();
      } catch { /* non-critical */ }
    },

    // 5s: File integrity check
    fileIntegrity: () => {
      try {
        const integrity = require('../services/fileIntegrityService');
        const ok = integrity.verifyOnStartup();
        if (!ok) {
          try {
            const chalk = require('chalk').default || require('chalk');
            emit(chalk.red('  ⚠ 文件完整性校验异常 — 部分核心文件已被修改'));
            emit(chalk.dim('    运行 security 命令查看详情'));
          } catch { /* chalk not available */ }
        }
      } catch { /* non-critical */ }
    },

    // 5s: Version update notice
    versionUpdateNotice: () => {
      try {
        const { getUpdateNotice } = require('../services/versionService');
        const notice = getUpdateNotice();
        if (notice && !busy()) {
          try {
            const chalk = require('chalk').default || require('chalk');
            emit(chalk.yellow(`  🔄 ${notice}`));
          } catch { /* chalk not available */ }
        }
      } catch { /* non-critical */ }
    },

    // 6s: IDE adapter recovery
    ideAdapterRecovery: async () => {
      try {
        const { recoverIdeAdapters, formatRecoveryMessage } = require('../services/versionService');
        const result = await recoverIdeAdapters();
        const msg = formatRecoveryMessage(result);
        if (msg && !busy()) {
          try {
            const chalk = require('chalk').default || require('chalk');
            emit(chalk.dim(`  ℹ IDE 适配器: ${msg}`));
          } catch { /* chalk not available */ }
        }
      } catch { /* non-critical */ }
    },

    // 8s: Skill learning suggestions
    skillLearning: () => {
      try {
        const { getSuggestedLearning } = require('../services/skillLearningService');
        const suggestions = getSuggestedLearning();
        if (suggestions.length > 0 && !busy()) {
          const s = suggestions[0];
          try {
            const chalk = require('chalk').default || require('chalk');
            emit('');
            emit(chalk.yellow(`  💡 学习建议: `) + chalk.white(s.name));
            emit(chalk.dim(`     ${s.reason}`));
            emit(chalk.dim(`     → ${s.action}`));
            emit('');
          } catch { /* chalk not available */ }
        }
      } catch { /* non-critical */ }
    },

    // Immediate: cloud sync + admin telemetry + security monitor
    immediateServices: () => {
      try {
        const cloudSync = require('../services/cloudSync');
        if (cloudSync.isEnabled()) {
          cloudSync.fetchRemoteConfig().catch(() => {});
          cloudSync.flushTelemetry().catch(() => {});
        }
      } catch { /* non-critical */ }

      try {
        const adminSvc = require('../services/adminService');
        adminSvc.syncTelemetry().catch(() => {});
      } catch { /* non-critical */ }

      try {
        const { startSecurityMonitor } = require('../services/securityGuardService');
        startSecurityMonitor();
      } catch { /* non-critical */ }
    },
  };

  // 由策略调度:immediate 条目走 setImmediate(不进 timers,与原语义一致);其余 setTimeout。
  for (const entry of policy.listStartupSchedule(process.env, mode)) {
    const run = RUNNERS[entry.id];
    if (typeof run !== 'function') continue;
    if (entry.immediate) {
      setImmediate(run);
    } else {
      timers.push(setTimeout(run, entry.delayMs));
    }
  }

  // 轻量模式历史上在发出 deferred:scheduled checkpoint 之前就 return;逐字节保留(仅完整模式标记)。
  if (mode !== 'khy') checkpoint('prefetch:deferred:scheduled');
  return timers;
}

module.exports = { parallelPrefetch, deferredPrefetch };
