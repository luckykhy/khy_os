'use strict';

/**
 * taskCleanupPolicy.js — 纯叶子:启动时「该清理哪些持久化任务」的确定性判定单一真源。
 *
 * 背景(真缺口):AI 用 TaskCreate 建的任务落进持久库 largeTaskRuntimeStore 后,
 * TUI 启动屏 `_taskStore.snapshot()` pull-style 读回全部非删除任务并渲染。没有任何
 * 东西在启动时清理它们,故一批很久以前建、从未跑完的任务会「反复重启都不消失」。
 * 用户定案「加启动自动清理选项」:超过保留期(默认 7 天未更新)的任务应被清掉。
 *
 * 契约(CONTRACT):零 IO、零时钟(now 由壳注入)、确定性、绝不抛(fail-soft)、
 *   env 门控 `KHY_TASK_CLEANUP` 默认开。门控关 / 坏输入 → 返回空数组,让薄壳字节
 *   回退到今日「永不清理」行为。
 *
 * 诚实边界:
 *   · 只**判定 task id**,绝不碰 IO(读任务 / 删除由薄壳 taskCleanupService 执行)。
 *   · 时间戳缺失 / 不可解析 → **保守不删**(宁可漏清一次,不误杀正在跑的活任务)。
 *   · 非终态(pending/in_progress)也会在超期后清理——因为陈旧遗留任务正是本刀要治的
 *     病;但只在「年龄 ≥ 保留期」时,年轻任务一律保留。
 */

const _OFF = new Set(['0', 'false', 'off', 'no']);

/** 默认保留期(天):未更新超过它的任务视为陈旧,可清理。 */
const RETENTION_DAYS = 7;

const _MS_PER_DAY = 86400000;

/** 门控:KHY_TASK_CLEANUP 默认开,仅 {0,false,off,no} 关。 */
function isEnabled(env = (typeof process !== 'undefined' ? process.env : {})) {
  try {
    const raw = env && env.KHY_TASK_CLEANUP;
    const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
    return !_OFF.has(v);
  } catch {
    return true;
  }
}

/**
 * 解析保留期天数。KHY_TASK_CLEANUP_DAYS 为正整数时采用,非法 / 缺失 → 回退默认。
 * @param {object} [env]
 * @returns {number} 正整数天数
 */
function resolveRetentionDays(env = (typeof process !== 'undefined' ? process.env : {})) {
  try {
    const raw = env && env.KHY_TASK_CLEANUP_DAYS;
    if (raw === undefined || raw === null || String(raw).trim() === '') return RETENTION_DAYS;
    const n = Number(String(raw).trim());
    if (Number.isInteger(n) && n > 0) return n;
    return RETENTION_DAYS;
  } catch {
    return RETENTION_DAYS;
  }
}

/** 单条任务的年龄(毫秒);时间戳缺失 / 不可解析 → null(调用方据此保守保留)。 */
function _ageMs(task, now) {
  const stamp = (task && (task.updatedAt || task.createdAt)) || null;
  if (!stamp) return null;
  const t = Date.parse(stamp);
  if (!Number.isFinite(t)) return null;
  const age = now - t;
  return Number.isFinite(age) ? age : null;
}

/**
 * 从任务列表里挑出应清理的 task id。
 *
 * @param {object} args
 * @param {Array<{id:string,status:string,createdAt?:string,updatedAt?:string}>} args.tasks
 * @param {number} args.now   当前时间戳(ms),由壳注入(叶子零时钟)。
 * @param {object} [args.env]
 * @returns {string[]} 应清理的 id 数组(fail-soft:门控关 / 坏输入 → [])。
 */
function selectStaleTaskIds(args = {}) {
  try {
    const env = args.env || (typeof process !== 'undefined' ? process.env : {});
    if (!isEnabled(env)) return [];

    const tasks = args.tasks;
    const now = args.now;
    if (!Array.isArray(tasks) || !Number.isFinite(now)) return [];

    const retentionDays = resolveRetentionDays(env);
    const thresholdMs = retentionDays * _MS_PER_DAY;

    const stale = [];
    for (const task of tasks) {
      if (!task || typeof task.id !== 'string' || !task.id) continue;
      const age = _ageMs(task, now);
      if (age === null) continue;          // 时间戳缺失 → 保守保留
      if (age >= thresholdMs) stale.push(task.id);
    }
    return stale;
  } catch {
    return [];
  }
}

module.exports = {
  isEnabled,
  RETENTION_DAYS,
  resolveRetentionDays,
  selectStaleTaskIds,
};
