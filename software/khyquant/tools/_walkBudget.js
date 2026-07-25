'use strict';

/**
 * _walkBudget.js — 给同步递归目录遍历(GlobTool / ListDirTool 的 walkDir)加一道
 * **墙钟时间预算**,防止在超大目录树(如 Windows 上 `site-packages\khy_os\bundled`)或存在
 * junction 回环时,同步 walk 把整个 Node 事件循环阻塞十几分钟、ESC 都打不断的「假死」。
 *
 * 为什么要这个:两个 walkDir 都是**同步** `readdirSync`/`statSync` 递归,只有 depth 和
 * results 数量上限,**没有时间上限**。当匹配稀疏而树极大(Glob 深度 15 会走遍整棵树)、
 * 或 Windows 单次 readdir/stat 远慢于 Linux(还叠加 Defender 扫描)、或存在 junction 回环
 * (Windows junction 被 readdirSync 当普通目录、depth 15 上限下呈组合式膨胀)时,walk 会跑到
 * 分钟级甚至更久。同步阻塞 ⇒ 事件循环冻结 ⇒「等待响应」永不推进、ESC 无法中断。加墙钟预算后,
 * walk 在预算耗尽时**优雅提前返回**并标记 truncated,最坏被时间上限兜住,与树规模 / I-O 速度 /
 * 环的具体成因无关——这正是本助手兜住的核心不变量。
 *
 * 注:符号链接/junction 的「防环」不在此处理——POSIX symlink 经 Dirent.isDirectory() 已判为
 * 非目录、原 walk 本就不下钻;Windows junction 则被当普通目录(isSymbolicLink 为假),靠 Dirent
 * 无法可靠识别。与其加一层既冗余(POSIX)又无效(Windows junction)的链接判定,不如用墙钟预算
 * 统一兜底所有成因的回环/巨树。
 *
 * 契约:除读取 env 与注入的时钟外零副作用、绝不抛。时钟经参数注入(默认 Date.now)以便测试
 * 用确定性时钟。**门控关 ⇒ 返回 null 哨兵 ⇒ 调用方 walk 逐字节回退今日无预算行为。**
 *
 * 门控(dogfood flagRegistry):
 *   KHY_FS_WALK_BUDGET      默认 on —— 总开关;关 → createWalkDeadline 返 null(无预算,今日行为)。
 *   KHY_FS_WALK_BUDGET_MS   默认 8000 —— 墙钟预算毫秒(numeric,clamp[250, 600000])。
 */


const _isEnabled = require('../utils/isEnabledDefaultOn');

/** 总开关:墙钟预算是否启用。默认 on。 */
function isWalkBudgetEnabled(env) {
  return _isEnabled('KHY_FS_WALK_BUDGET', env);
}

/**
 * 异步 walk 总开关。默认 on。
 *
 * 为什么:同步 `readdirSync`/`statSync` 递归在单个系统调用上阻塞时(Windows OneDrive 占位
 * 文件 / reparse point / 网络盘),会**冻结整个 Node 事件循环**——此时不仅本模块的
 * `deadline.exceeded()`(只在系统调用**之间**被检查)无从触发,连工具漏斗的 120s 墙钟竞赛
 * (toolCalling `_withToolTimeout`)、abort 信号、ESC 都无法被派发,呈现为「列目录卡十几分钟、
 * 不超时、不换方法」。改用 `fs.promises.readdir/stat`(走 libuv 线程池)后事件循环不再被占,
 * 上述所有既有超时/中断机制**立即恢复生效**,并让 walk 在每次 `await` 之间真正让出。
 *
 * 门控关 → 调用方逐字节回退到今日的同步 walk(此开关只切换 walk 的同步/异步实现,不改结果形状)。
 *
 * 门控(dogfood flagRegistry):
 *   KHY_FS_WALK_ASYNC   默认 on —— 关 → 回退同步 walk(今日行为)。
 */
function isWalkAsyncEnabled(env) {
  return _isEnabled('KHY_FS_WALK_ASYNC', env);
}


/** 解析墙钟预算(毫秒)。经 flagRegistry.resolveNumeric;不可用则本地 clamp。默认 8000。 */
function resolveWalkBudgetMs(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : {});
  try {
    const flagRegistry = require('../services/flagRegistry');
    const v = flagRegistry.resolveNumeric('KHY_FS_WALK_BUDGET_MS', e);
    if (Number.isFinite(v) && v > 0) return v;
  } catch { /* fall through */ }
  const raw = Number.parseInt((e && e.KHY_FS_WALK_BUDGET_MS) || '', 10);
  if (Number.isFinite(raw) && raw > 0) return Math.min(600000, Math.max(250, raw));
  return 8000;
}

/**
 * 创建一个墙钟截止判定器。门控关 → 返回 null(调用方据此走无预算的今日路径)。
 *
 * @param {object} [env]
 * @param {() => number} [nowFn] 时钟注入(默认 Date.now),测试用确定性时钟。
 * @returns {{ exceeded: () => boolean, budgetMs: number, startedAt: number } | null}
 */
function createWalkDeadline(env, nowFn) {
  try {
    const e = env || (typeof process !== 'undefined' ? process.env : {});
    if (!isWalkBudgetEnabled(e)) return null;
    const clock = typeof nowFn === 'function' ? nowFn : Date.now;
    const budgetMs = resolveWalkBudgetMs(e);
    const startedAt = clock();
    const deadline = startedAt + budgetMs;
    return {
      budgetMs,
      startedAt,
      exceeded() {
        try { return clock() >= deadline; } catch { return false; }
      },
    };
  } catch {
    return null; // fail-soft:预算构造失败 ⇒ 无预算(今日行为),绝不拖垮 walk
  }
}

module.exports = {
  isWalkBudgetEnabled,
  isWalkAsyncEnabled,
  resolveWalkBudgetMs,
  createWalkDeadline,
};
