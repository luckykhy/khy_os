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
      } catch {
        /* non-critical */
      }
    })()
  );

  if (mode === 'khyquant') {
    // Network detector (full mode only)
    tasks.push(
      (async () => {
        try {
          const networkDetector = require('../services/networkDetector');
          await networkDetector.init();
        } catch {
          /* non-critical */
        }
      })()
    );

    // Cache service warmup (full mode only)
    tasks.push(
      (async () => {
        try {
          const cache = require('../services/cacheService');
          await cache.getStats();
        } catch {
          /* non-critical */
        }
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
  } catch {
    /* non-critical */
  }
}

/**
 * Schedule deferred background tasks after REPL is ready.
 *
 * Returns an array of timer IDs that can be cleared on shutdown:
 *   const timers = deferredPrefetch({ ... });
 *   // on exit: timers.forEach(clearTimeout);
 *
 * @param {{ mode?: string, onOutput?: (msg: string|object) => void, isBusy?: () => boolean }} options
 * @returns {Array<NodeJS.Timeout>}
 */
function deferredPrefetch(options = {}) {
  const { mode = 'khyquant', onOutput, isBusy } = options;
  const timers = [];
  const busy = () => (typeof isBusy === 'function' ? isBusy() : false);
  const pendingOutput = [];
  let flushTimer = null;
  const deliver = (value) => {
    if (typeof onOutput !== 'function') return;
    try {
      const handled = onOutput(value);
      if (handled && typeof handled.catch === 'function') handled.catch(() => {});
    } catch {
      /* non-critical output consumer */
    }
  };
  const flush = () => {
    flushTimer = null;
    if (busy() || pendingOutput.length === 0) {
      if (pendingOutput.length > 0) {
        flushTimer = setTimeout(flush, 500);
        timers.push(flushTimer);
      }
      return;
    }
    while (!busy() && pendingOutput.length > 0) deliver(pendingOutput.shift());
    if (pendingOutput.length > 0) {
      flushTimer = setTimeout(flush, 500);
      timers.push(flushTimer);
    }
  };
  const emit = (value) => {
    if (typeof onOutput !== 'function') return;
    if (busy()) {
      pendingOutput.push(value);
      if (!flushTimer) {
        flushTimer = setTimeout(flush, 500);
        timers.push(flushTimer);
      }
      return;
    }
    deliver(value);
  };

  // Apply hardware-derived runtime limits SYNCHRONOUSLY up front (idempotent;
  // honors user/env overrides). This must precede the deferred cleanup/agent
  // timers and the first request so concurrency, timeout and background-cadence
  // consumers read already-adapted env. detectProfile() is cached, so the later
  // deferred call that emits the lightweight notice is effectively free.
  try {
    require('../services/hardwareProfileService').applyLimits();
  } catch {
    /* non-critical — falls back to fixed defaults */
  }

  // 生命周期策略驱动(操作化):策略决定「跑什么 / 何时 / 是否启用」,本模块只持有「怎么跑」。
  // RUNNERS 每个 body 与改造前的 setTimeout/setImmediate 回调逐字节一致;id 必须与
  // serviceLifecyclePolicy 的 cli-startup 条目一一对应,scripts/check-lifecycle-policy.js 守卫防漂移。
  const policy = require('../services/serviceLifecyclePolicy');

  // 体积自检的提示发射:完整模式与轻量模式共用一份,免得两处文案漂移。
  // 只报不删 —— .khy 下躺着会话存档与工作区快照,自动清理判错是不可逆的。
  const emitFootprintNotice = (cleanup) => {
    try {
      const footprint = cleanup.assessRuntimeFootprint();
      if (footprint.notice) {
        const chalk = require('chalk').default || require('chalk');
        emit(chalk.dim(`  存储  ${footprint.notice}`));
      }
    } catch {
      /* 自检失败不该拦住启动 */
    }
  };

  const RUNNERS = {
    // ── Lightweight mode (khy):+300ms 预热 gateway(门判定保留在 body 内)──────
    gatewayWarmup: () => {
      try {
        const shouldWarmGateway =
          String(process.env.KHY_GATEWAY_WARMUP_ON_BOOT || 'true').toLowerCase() !== 'false';
        if (!shouldWarmGateway) {
          return;
        }
        const gw = require('../services/gateway/aiGateway');
        gw.init().catch(() => {});
      } catch {
        /* non-critical */
      }
    },

    // 轻量模式 +3.5s:滚动 + 体积自检。
    //
    // 为什么轻量模式要单独有这一条:cleanupService 那条策略条目是 mode 'khyquant',
    // 而 bin/khy.js 以 `khy` 名调用时把 KHY_RUNTIME_MODE 设成 'khy',走的是本段。
    // 于是日志/审计的滚动在最主要的分发入口上从来没跑过,.khy 只增不减。这里补的是
    // 那条缺口,但刻意只做两件有界的事(滚动 logs 与 audit、报一次体积),不起周期
    // timer、不做完整 runCleanup,轻量模式该轻的地方仍然轻。
    runtimeFootprintNotice: () => {
      try {
        const cleanup = require('../services/cleanupService');
        try {
          cleanup.cleanRuntimeLogs();
        } catch {
          /* 滚动失败不影响自检 */
        }
        try {
          cleanup.cleanTraceAudit();
        } catch {
          /* 同上 */
        }
        emitFootprintNotice(cleanup);
      } catch {
        /* non-critical */
      }
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
            emit(
              chalk.dim(
                `  模式  轻量 ${profile.profile} (${profile.memory.totalGB}GB RAM, ${profile.cpu.cores} cores)`
              )
            );
          } catch {
            /* chalk not available */
          }
        }
      } catch {
        /* non-critical */
      }
    },

    // 3s: Data cleanup + periodic cleanup
    cleanupService: () => {
      try {
        const cleanup = require('../services/cleanupService');
        const result = cleanup.runCleanup({ trigger: 'startup' });
        cleanup.startPeriodicCleanup({ skipInitial: true });
        // 体积自检:只报不删。清理跑完之后才测,报的才是清理之后的真实占用。
        emitFootprintNotice(cleanup);
        if (result.summary && result.summary.actions && result.summary.actions.length > 0) {
          try {
            const chalk = require('chalk').default || require('chalk');
            emit(
              chalk.dim(
                `  清理  ${result.summary.actions.join(', ')} (释放 ${result.summary.freedHuman})`
              )
            );
          } catch {
            /* chalk not available */
          }
        }
      } catch {
        /* non-critical */
      }
    },

    // 4s: Resource guard memory monitor
    resourceGuard: () => {
      try {
        const { startMemoryMonitor } = require('../services/resourceGuard');
        startMemoryMonitor();
      } catch {
        /* non-critical */
      }
    },

    // 4s: Project memory prune
    projectMemoryPrune: () => {
      try {
        const { pruneProjects } = require('../services/projectMemoryService');
        pruneProjects();
      } catch {
        /* non-critical */
      }
    },

    // 5s: File integrity check
    fileIntegrity: () => {
      try {
        const integrity = require('../services/fileIntegrityService');
        const ok = integrity.verifyOnStartup();
        if (!ok) {
          try {
            const chalk = require('chalk').default || require('chalk');
            emit(chalk.red('  校验  文件完整性异常：部分核心文件已被修改'));
            emit(chalk.dim('  操作  运行 security 命令查看详情'));
          } catch {
            /* chalk not available */
          }
        }
      } catch {
        /* non-critical */
      }
    },

    // 5s: Unified background update detection. Detection may fetch and stage a
    // verified artifact, but installation remains behind an explicit choice.
    versionUpdateNotice: async () => {
      try {
        const coordinator = require('../services/updateCoordinator');
        const state = await coordinator.checkUpdate({
          mode,
          cwd: process.cwd(),
          channel: process.env.KHY_UPDATE_CHANNEL,
        });
        if (state && state.state === 'available') {
          const staged = await coordinator.stageUpdate({ state });
          emit({ type: 'update-available', state: staged });
        } else if (state && state.state === 'blocked') {
          emit({ type: 'update-blocked', state });
        }
      } catch {
        /* non-critical */
      }
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
            emit(chalk.dim(`  适配  ${msg}`));
          } catch {
            /* chalk not available */
          }
        }
      } catch {
        /* non-critical */
      }
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
            emit(chalk.yellow('  建议  ') + chalk.white(s.name));
            emit(chalk.dim(`  原因  ${s.reason}`));
            emit(chalk.dim(`  操作  ${s.action}`));
            emit('');
          } catch {
            /* chalk not available */
          }
        }
      } catch {
        /* non-critical */
      }
    },

    // Immediate: cloud sync + admin telemetry + security monitor
    immediateServices: () => {
      try {
        const cloudSync = require('../services/cloudSync');
        if (cloudSync.isEnabled()) {
          cloudSync.fetchRemoteConfig().catch(() => {});
          cloudSync.flushTelemetry().catch(() => {});
        }
      } catch {
        /* non-critical */
      }

      try {
        const adminSvc = require('../services/adminService');
        adminSvc.syncTelemetry().catch(() => {});
      } catch {
        /* non-critical */
      }

      try {
        const { startSecurityMonitor } = require('../services/securityGuardService');
        startSecurityMonitor();
      } catch {
        /* non-critical */
      }
    },
  };

  // 由策略调度:immediate 条目走 setImmediate(不进 timers,与原语义一致);其余 setTimeout。
  for (const entry of policy.listStartupSchedule(process.env, mode)) {
    const run = RUNNERS[entry.id];
    if (typeof run !== 'function') {
      continue;
    }
    if (entry.immediate) {
      setImmediate(run);
    } else {
      timers.push(setTimeout(run, entry.delayMs));
    }
  }

  // 轻量模式历史上在发出 deferred:scheduled checkpoint 之前就 return;逐字节保留(仅完整模式标记)。
  if (mode !== 'khy') {
    checkpoint('prefetch:deferred:scheduled');
  }
  return timers;
}

module.exports = { parallelPrefetch, deferredPrefetch };
