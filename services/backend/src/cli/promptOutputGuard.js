'use strict';

/**
 * promptOutputGuard.js — 交互式提问期间的「控制台输出暂存闸」。
 *
 * 修的问题:启动路径上有若干**延迟异步通知**,它们的落地时刻不可预测 ——
 *   - bin/khy.js `_scheduleStartupUpdateCheck`:await 三个发布源(GitHub/PyPI/npm)的网络往返,
 *     超时可达数秒,落点完全取决于网络;
 *   - replSession.js 的 `git init` 提示、过期任务清理提示:setImmediate + console.log。
 * 而同一段启动路径上还有两个 **inquirer 提问**(工作区信任门、onboarding 向导)。inquirer 靠
 * 「记住自己渲染了几行 → 回退同样行数重绘」维持画面;任何第三方在它渲染期间往 stdout 插一行,
 * 行计数当场错位 → 提问框被从中间劈开、答完后又擦掉不该擦的行。实测捕获(版本通知插进选项行):
 *   `否,退出 <ESC>[10D<ESC>[10C  ℹ 当前版本 v1.1.11 领先于已发布版本 v1.1.7（…）`
 * 这正是用户截图里信任提示下方几行「该出现的通知不见了」的成因。
 *
 * 做法:提问期间把 console.log/info/warn/error 暂时改成入队,提问返回后原样按序补发。
 * 只拦 console.*,**不碰 process.stdout.write** —— inquirer 自己走 readline/stdout,必须畅通。
 * 补发发生在提问结束、TUI 挂载之前,所以这些通知仍然出现在它们本该在的位置(banner 之前),
 * 只是不再插进提问框中间。
 *
 * 为什么是「暂存」而不是「丢弃」或「延后到 TUI 里」:通知本身有价值(版本落后、仓库已初始化),
 * 丢弃是信息损失;而 ink 挂载后 <Static> 已接管屏幕,再补发会挤进 transcript 顶部,位置更乱。
 *
 * 门控 KHY_PROMPT_OUTPUT_GUARD(默认开;仅 0/false/off/no 关)。关 → runExclusive 直接透传
 * 回调,不碰 console → 逐字节回退到今日行为(提问被插行的老症状随之回归)。
 * 失败软化:安装/还原/补发任一步抛出都不会传播给调用方,提问本身永远优先。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 暂存上限。提问通常只挡住个位数通知;设上限纯粹是防某个后台循环狂打日志时把内存吃穿。
// 超限后只计数不入队,补发时如实说明省略了多少条(状态透明:动作 + 目标 + 进度)。
const MAX_QUEUED = 200;

const METHODS = ['log', 'info', 'warn', 'error'];

let _depth = 0; // 支持嵌套提问:只有最外层负责安装/还原/补发
let _queue = [];
let _dropped = 0;
let _original = null;

/**
 * 闸门是否启用。默认开;仅显式 0/false/off/no 关。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  try {
    const raw = env && env.KHY_PROMPT_OUTPUT_GUARD;
    if (raw === undefined || raw === null) {
      return true;
    }
    return !OFF_VALUES.includes(String(raw).trim().toLowerCase());
  } catch {
    return true;
  }
}

/**
 * 当前是否有提问正占用屏幕。供后台通知方自行判断(可选;走 runExclusive 的无需关心)。
 * @returns {boolean}
 */
function isPromptActive() {
  return _depth > 0;
}

function _install() {
  if (_original) {
    return;
  }
  _original = {};
  for (const m of METHODS) {
    _original[m] = console[m];
    console[m] = (...args) => {
      if (_queue.length >= MAX_QUEUED) {
        _dropped += 1;
        return;
      }
      _queue.push([m, args]);
    };
  }
}

function _restore() {
  if (!_original) {
    return;
  }
  for (const m of METHODS) {
    console[m] = _original[m];
  }
  _original = null;
}

function _flush() {
  const pending = _queue;
  const dropped = _dropped;
  _queue = [];
  _dropped = 0;
  for (const [m, args] of pending) {
    try {
      console[m](...args);
    } catch {
      /* 终端可能已关闭 —— 补发是尽力而为 */
    }
  }
  if (dropped > 0) {
    try {
      console.log(`  ℹ 提问期间省略 ${dropped} 条通知：暂存队列已达上限 ${MAX_QUEUED} 条。`);
    } catch {
      /* 同上 */
    }
  }
}

/**
 * 在「控制台输出暂存」保护下执行一段交互式提问。
 *
 * @param {function(): (Promise<*>|*)} fn - 提问过程(通常是 await inquirer.prompt 的那段)
 * @param {object} [env]
 * @returns {Promise<*>} fn 的返回值(原样透传;fn 抛出的异常也原样抛出)
 */
async function runExclusive(fn, env = process.env) {
  if (typeof fn !== 'function') {
    return undefined;
  }
  if (!isEnabled(env)) {
    return fn();
  }
  _depth += 1;
  if (_depth === 1) {
    try {
      _install();
    } catch {
      /* 装不上就等于没开闸,提问照常进行 */
    }
  }
  try {
    return await fn();
  } finally {
    _depth -= 1;
    if (_depth <= 0) {
      _depth = 0;
      // 顺序是关键:先还原真 console,再补发 —— 否则补发会重新入队,永远吐不出来。
      try {
        _restore();
      } catch {
        /* ignore */
      }
      try {
        _flush();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 测试用:强制清空内部状态(还原 console、丢弃队列)。生产路径不应调用。
 */
function _resetForTests() {
  _depth = 0;
  try {
    _restore();
  } catch {
    /* ignore */
  }
  _queue = [];
  _dropped = 0;
}

module.exports = {
  runExclusive,
  isPromptActive,
  isEnabled,
  _resetForTests,
  OFF_VALUES,
  MAX_QUEUED,
  METHODS,
};
