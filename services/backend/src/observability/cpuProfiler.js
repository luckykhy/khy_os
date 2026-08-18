'use strict';

/**
 * cpuProfiler.js — 薄壳(副作用):按需 CPU 采样(profiling 方案 A)。
 *
 * 用 Node 内置的 `node:inspector` Session 驱动 V8 的 Profiler:
 *   Profiler.enable → setSamplingInterval → start → (采样窗口) → stop
 * 产出标准 `.cpuprofile`,可直接拖进 Chrome DevTools → Performance、VS Code
 * 或 speedscope 看火焰图。**零新依赖** —— 不引入 0x / clinic / pprof,
 * 因而不触碰 packaging/npm/scripts/audit-purity.js 与 pip 纯度审计。
 *
 * 与 cli/heapDump.js 互补:heapDump 落 V8 堆快照(内存侧),这里落 CPU 采样。
 * 两者同一版式(纯叶子 profilerCore.js + 薄壳 + `.khy/` 下并排两个文件:
 * 主产物 + 元数据 JSON)。
 *
 * 产物落 `.khy/monitor/profiles/`:
 *   cpu-<ISO-slug>.cpuprofile   采样数据(调用树 + 样本序列)
 *   cpu-<ISO-slug>.json         元数据(触发源/实采时长/采样率/内存/CPU 时间)
 * `cpu-` 前缀刻意避开 MonitorTool 的 `mon-*` 前缀。
 *
 * 隐私(F3):只写本地文件,不发起任何网络请求,不做任何上报。
 *
 * 开销(F2):默认关闭(KHY_PROFILING_ENABLED)。开启后也**只在采样窗口内**
 * 有开销 —— 窗口外 inspector session 已 disconnect,进程回到零开销状态。
 *
 * 超时说明(规则 3):采样窗口是用户指定的**固定观测时长**,窗口到期是采样
 * 自然结束,不 kill 任何进行中的任务 —— 不属于「硬 kill 长任务」的范畴。
 */

const fs = require('fs');
const path = require('path');

const core = require('./profilerCore');

const _state = {
  active: false,
  session: null,
  profileId: '',
  startedAt: 0,
};

/** 是否有采样正在进行(供 /metrics 的 khy_profiling_active 读取)。 */
function isActive() {
  return _state.active === true;
}

function activeProfileId() {
  return _state.profileId || '';
}

/** 解析(并创建)profiles 目录 `.khy/monitor/profiles/`。失败返回 null。 */
function getProfilesDir() {
  try {
    const { getDataDir } = require('../utils/dataHome');
    return getDataDir('monitor', 'profiles');
  } catch {
    return null;
  }
}

function _post(session, method, params) {
  return new Promise((resolve, reject) => {
    session.post(method, params || {}, (err, result) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(result);
    });
  });
}

/**
 * 采一次 CPU profile 并落盘。
 *
 * @param {object} [opts]
 * @param {number} [opts.durationMs] 采样时长(会夹到 [100ms, PROFILING_MAX_DURATION_MS])
 * @param {string} [opts.trigger='manual'] 触发源,写进元数据
 * @param {object} [opts.env]
 * @param {function} [opts.onProgress] 进度回调(收到「动作+目标+进度」文本)
 * @returns {Promise<{ok:boolean,profilePath?:string,metaPath?:string,meta?:object,error?:string,reason?:string}>}
 *          永不抛异常 —— 失败以 {ok:false} 返回。
 */
async function captureProfile(opts = {}) {
  const cfg = core.resolveConfig(opts.env || process.env);
  if (!cfg.enabled) {
    return { ok: false, reason: 'disabled', error: core.formatDisabled() };
  }
  if (_state.active) {
    return {
      ok: false,
      reason: 'busy',
      error: `已有一个 CPU 采样在进行中(${_state.profileId}),请等待其结束后再试。`,
    };
  }

  const durationMs = core.clampDuration(opts.durationMs, cfg);
  const trigger = String(opts.trigger || 'manual');
  const dir = getProfilesDir();
  if (!dir) {
    return { ok: false, reason: 'no-dir', error: core.formatError('无法解析 .khy/monitor/profiles 目录') };
  }

  let session = null;
  const startedAt = Date.now();
  const profileId = core.buildProfileId(startedAt);
  const cpuBefore = process.cpuUsage();

  try {
    const inspector = require('node:inspector');
    session = new inspector.Session();
    session.connect();

    _state.active = true;
    _state.session = session;
    _state.profileId = profileId;
    _state.startedAt = startedAt;

    await _post(session, 'Profiler.enable');
    await _post(session, 'Profiler.setSamplingInterval', { interval: cfg.sampleIntervalUs });
    await _post(session, 'Profiler.start');

    if (typeof opts.onProgress === 'function') {
      try {
        opts.onProgress(
          `CPU 采样 ${profileId} 进行中,窗口 ${(durationMs / 1000).toFixed(1)}s @ ${cfg.sampleIntervalUs}μs`
        );
      } catch {
        /* progress callback must not break profiling */
      }
    }

    // 固定观测窗口:到期即采样自然结束(不 kill 任何任务),unref 以免拖住退出。
    await new Promise((resolve) => {
      const t = setTimeout(resolve, durationMs);
      if (typeof t.unref === 'function') {
        t.unref();
      }
    });

    const { profile } = await _post(session, 'Profiler.stop');
    const elapsedMs = Date.now() - startedAt;
    const counts = core.summarizeProfile(profile);

    const meta = core.buildProfileMeta({
      now: startedAt,
      profileId,
      trigger,
      requestedDurationMs: durationMs,
      elapsedMs,
      sampleIntervalUs: cfg.sampleIntervalUs,
      sampleCount: counts.sampleCount,
      nodeCount: counts.nodeCount,
      pid: process.pid,
      nodeVersion: process.version,
      uptimeSeconds: process.uptime(),
      memoryUsage: process.memoryUsage(),
      cpuUsage: process.cpuUsage(cpuBefore),
    });

    const profilePath = path.join(dir, `${profileId}.cpuprofile`);
    const metaPath = path.join(dir, `${profileId}.json`);
    fs.writeFileSync(profilePath, JSON.stringify(profile), 'utf-8');
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

    try {
      require('./eventLog').append({
        type: 'perf.profile_captured',
        source: 'observability/cpuProfiler',
        payload: {
          profileId,
          trigger,
          elapsedMs,
          sampleCount: counts.sampleCount,
          nodeCount: counts.nodeCount,
          sampleIntervalUs: cfg.sampleIntervalUs,
          file: profilePath,
        },
      });
    } catch {
      /* event log unavailable — the profile itself already landed */
    }

    return { ok: true, profileId, profilePath, metaPath, meta };
  } catch (err) {
    return {
      ok: false,
      reason: 'error',
      error: core.formatError(err && err.message ? err.message : String(err)),
    };
  } finally {
    try {
      if (session) {
        session.disconnect();
      }
    } catch {
      /* ignore */
    }
    _state.active = false;
    _state.session = null;
    _state.profileId = '';
    _state.startedAt = 0;
  }
}

/** 列出已落盘的 profile(新→旧)。永不抛。 */
function listProfiles(limit = 20) {
  const dir = getProfilesDir();
  if (!dir) {
    return [];
  }
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.cpuprofile'))
      .sort()
      .reverse()
      .slice(0, Math.max(1, Number(limit) || 20))
      .map((name) => {
        const full = path.join(dir, name);
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          /* ignore */
        }
        return { name, path: full, sizeBytes: size };
      });
  } catch {
    return [];
  }
}

module.exports = {
  captureProfile,
  listProfiles,
  getProfilesDir,
  isActive,
  activeProfileId,
  _state,
};
