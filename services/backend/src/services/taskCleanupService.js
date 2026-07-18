'use strict';

/**
 * taskCleanupService — 启动时清理陈旧持久化任务的薄壳(执行 IO)。
 *
 * 背景(真缺口):持久库里 AI 建过、从未跑完的任务会「反复重启都不消失」(TUI 启动屏
 * pull-style 读回全部任务渲染,无人在启动时清理)。用户定案「加启动自动清理选项」。
 *
 * 职责划分:本模块**执行 IO**(读 `_taskStore.list()` / `_taskStore.remove(id)`),
 *   因此**不是**自声明纯叶子,不受 leaf-contract 扫描。「该清哪些 id」的确定性判定
 *   全部收敛在纯叶子 `taskCleanupPolicy.js`;本模块只删除被它批准的任务、并取当前时钟。
 *
 * 不变量:fail-soft——store 不可用 / list 抛 / remove 抛 / 门控关,都不得抛出、不得阻塞
 *   会话;最差只是「这次没清」。now 在此壳内取(叶子零时钟)。
 */

const policy = require('./taskCleanupPolicy');

/** 清理提示行(removed>0 时打印)。color 可选。 */
function _noticeLine(removed, days, color) {
  const paint = typeof color === 'function' ? color : (t) => t;
  return paint(
    `🧹 已清理 ${removed} 条陈旧任务(超过 ${days} 天未更新)。用 /tasks 查看当前清单。`,
    'notice',
  );
}

/**
 * 清理陈旧持久化任务。
 *
 * @param {object} [opts]
 * @param {number}   [opts.now]  当前时间戳(ms);缺省用 Date.now()。
 * @param {object}   [opts.env]  环境(默认 process.env)。
 * @param {Function} [opts.log]  日志行输出(如 console.log);removed>0 时调用一次。
 * @param {object}   [opts.store] 注入 _taskStore(测试用);缺省 require 真实 store。
 * @returns {{ran:boolean, removed:number, ids:string[]}}
 *          门控关 → {ran:false, removed:0, ids:[]};fail-soft:任何异常 → 如实少删。
 */
function cleanupStaleTasks(opts = {}) {
  const env = opts.env || (typeof process !== 'undefined' ? process.env : {});
  try {
    if (!policy.isEnabled(env)) {
      return { ran: false, removed: 0, ids: [] };
    }

    const store = opts.store || require('../tools/_taskStore');

    let tasks;
    try {
      tasks = store.list();
    } catch {
      return { ran: true, removed: 0, ids: [] }; // store 读失败 → 不阻塞
    }
    if (!Array.isArray(tasks)) return { ran: true, removed: 0, ids: [] };

    const now = Number.isFinite(opts.now)
      ? opts.now
      : (typeof Date !== 'undefined' ? Date.now() : 0);

    const staleIds = policy.selectStaleTaskIds({ tasks, now, env });

    const removedIds = [];
    for (const id of staleIds) {
      try {
        if (store.remove(id)) removedIds.push(id);
      } catch {
        // 单条删除失败:吞掉、少删而已,继续下一条
      }
    }

    if (removedIds.length > 0 && typeof opts.log === 'function') {
      try {
        opts.log(_noticeLine(removedIds.length, policy.resolveRetentionDays(env), opts.color));
      } catch {
        // 日志失败不影响清理结果
      }
    }

    return { ran: true, removed: removedIds.length, ids: removedIds };
  } catch {
    return { ran: false, removed: 0, ids: [] };
  }
}

module.exports = {
  cleanupStaleTasks,
  _noticeLine,
};
