'use strict';

/**
 * performanceSampler.js — 进程内「系统负载快照」采样器(纯叶子、无第三方依赖)
 *
 * 背景(为什么有这个文件):
 *   当用户抱怨「卡 / 卡顿 / 慢 / 死机 / 转圈 / 发热」时,「慢的是电脑还是当前项目/程序」本
 *   身是歧义的(见 referenceDisambiguation 的 device 分支)。给模型一份**确定性的系统负载
 *   佐证**(CPU / 内存占用),能让它据实澄清而非空谈。
 *
 * 设计要点:
 *   - **规避 Windows 上 os.loadavg() 恒为 0 的问题**:不用 loadavg,改为用 os.cpus() 相隔约
 *     100ms **两次采样**,对 CPU times(user/nice/sys/idle/irq)求差算占用率——跨平台可用。
 *   - 内存占用直接由 os.freemem()/os.totalmem() 计算(瞬时值,无需两次采样)。
 *   - **约 5s TTL 缓存**:同进程内重复调用直接命中缓存,零额外采样开销(避免每轮 100ms 阻塞)。
 *   - **采样超时兜底**:采样竞速一个超时,超时/任何异常一律返回 `null`,调用方优雅降级。
 *
 * 纯叶子契约:仅依赖标准内置 os / 计时器;无网络、无磁盘、无第三方依赖;**绝不抛**(异常 →
 * 返回 null)。'use strict' + CommonJS。
 */

const os = require('os');

// 两次 CPU 采样的间隔(ms)。约 100ms 足以拿到有区分度的占用率,又不至于明显卡顿。
const SAMPLE_INTERVAL_MS = 100;
// 单次采样的超时兜底(ms):正常仅需 ~100ms,超过此值判定异常并返回 null。
const SAMPLE_TIMEOUT_MS = 1000;
// 缓存有效期(ms):同进程内 5s 内的重复调用命中缓存,零额外采样开销。
const CACHE_TTL_MS = 5000;

// 进程内单例缓存:{ ts:number, value:object }。
let _cache = null;

/**
 * 汇总当前所有逻辑核心的 CPU times,返回累计 idle 与 total(tick 数)。
 * @returns {{ idle:number, total:number, cpuCount:number }|null} os.cpus() 不可用时返回 null
 */
function _readCpuTimes() {
  const cpus = os.cpus();
  if (!Array.isArray(cpus) || cpus.length === 0) {
    return null;
  }
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    const t = (c && c.times) || {};
    const user = Number(t.user) || 0;
    const nice = Number(t.nice) || 0;
    const sys = Number(t.sys) || 0;
    const idl = Number(t.idle) || 0;
    const irq = Number(t.irq) || 0;
    idle += idl;
    total += user + nice + sys + idl + irq;
  }
  return { idle, total, cpuCount: cpus.length };
}

function _delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function _clamp01to100(n) {
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * 真正执行两次采样并计算负载(内部,不含缓存/超时)。
 * @param {number} intervalMs 两次采样间隔
 * @returns {Promise<object|null>}
 */
async function _doSample(intervalMs) {
  const first = _readCpuTimes();
  if (!first) {
    return null;
  }
  await _delay(intervalMs);
  const second = _readCpuTimes();
  if (!second) {
    return null;
  }

  const idleDiff = second.idle - first.idle;
  const totalDiff = second.total - first.total;
  // totalDiff<=0(时钟异常/无变化)→ CPU 占用按 0 处理,避免除零/负值。
  const cpuPercent = totalDiff > 0 ? _clamp01to100((1 - idleDiff / totalDiff) * 100) : 0;

  const totalMem = Number(os.totalmem()) || 0;
  const freeMem = Number(os.freemem()) || 0;
  const memPercent = totalMem > 0 ? _clamp01to100((1 - freeMem / totalMem) * 100) : 0;

  return {
    cpuPercent,
    memPercent,
    freeMemMB: Math.round(freeMem / (1024 * 1024)),
    totalMemMB: Math.round(totalMem / (1024 * 1024)),
    cpuCount: second.cpuCount,
    sampledAt: Date.now(),
  };
}

/**
 * 采样一份系统负载快照(带 5s TTL 缓存 + 超时兜底 + 全程 fail-soft)。
 *
 * @param {object} [options]
 * @param {number} [options.intervalMs]  两次采样间隔(默认 100ms;主要供测试提速)
 * @param {number} [options.timeoutMs]   采样超时(默认 1000ms)
 * @param {boolean} [options.force]      跳过缓存强制重采(默认 false)
 * @returns {Promise<{ cpuPercent:number, memPercent:number, freeMemMB:number,
 *            totalMemMB:number, cpuCount:number, sampledAt:number }|null>}
 *          任何异常/超时/不可用 → null(调用方据此优雅降级)。
 */
async function sampleSystemLoad(options = {}) {
  try {
    const opts = options || {};
    const now = Date.now();
    if (!opts.force && _cache && now - _cache.ts < CACHE_TTL_MS) {
      return _cache.value;
    }

    const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : SAMPLE_INTERVAL_MS;
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : SAMPLE_TIMEOUT_MS;

    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const value = await Promise.race([_doSample(intervalMs), timeout]);
    if (timer) {
      clearTimeout(timer);
    }

    if (value) {
      _cache = { ts: Date.now(), value };
    }
    return value || null;
  } catch {
    return null;
  }
}

/**
 * 清空缓存(供测试隔离用;生产路径无需调用)。
 */
function _clearCache() {
  _cache = null;
}

module.exports = {
  SAMPLE_INTERVAL_MS,
  SAMPLE_TIMEOUT_MS,
  CACHE_TTL_MS,
  sampleSystemLoad,
  _clearCache,
};
