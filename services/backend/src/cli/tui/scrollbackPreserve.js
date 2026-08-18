'use strict';

// scrollbackPreserve.js — pure leaf (zero IO, deterministic, never throws).
//
// 纯叶子:零 IO、确定性、env 门控、绝不抛、可单测。
//
// 目的:让 ink TUI 在 fullscreen 重绘时**不擦终端原生回滚缓冲(scrollback)**,使用户能向上
// 滚动查看中间历史(本次修复的 bug:「滚动查看历史要么在最上面,要么在最下面,无法滚到中间」)。
//
// 背景(诊断):khy 默认走 ink TUI,已提交历史走 ink `<Static>` + 终端原生 scrollback,本 TUI
// **不自管 transcript 滚动**。ink 在 live 区渲染高度 `lastOutputHeight >= stdout.rows` 时进入
// fullscreen 分支,执行 `stdout.write(ansiEscapes.clearTerminal + fullStaticOutput + output)`
// (node_modules/ink/build/ink.js:327、instance.js:132)。非 win32 的 clearTerminal =
// `\x1b[2J\x1b[3J\x1b[H`(node_modules/ansi-escapes/index.js:85-91),其中 **`\x1b[3J` 清空回滚
// 缓冲**。长输出时此分支反复触发 → scrollback 被持续擦除、视图弹回顶部 → 用户只剩当前帧。
//
// 修复(本叶子是「噪声定义」单一真源):在写给 ink 的 stdout 边界把 `\x1b[3J`(且仅它)剥掉,
// 保留 `\x1b[2J`(清屏)/`\x1b[H`(光标归位)→ fullscreen 重绘外观不变,但 scrollback 存活。
// 这一处统一覆盖 ink 的所有 clearTerminal 来源(稳态 fullscreen / 瞬时 spike / 缩放重绘)。
// 与 `liveRegionBudget`(尽量不触发 fullscreen)正交叠加:那是第一层「少触发」,本叶子是第二层
// 「即便触发也不擦回滚」。
//
// 平台对称：两类终端都只剥离 clearTerminal 中的 `3J`。Windows 的 `2J` 行为
// 依终端实现而异，但主动注入 `3J` 会直接清空用户正在查看的原生 scrollback，
// 因此不能用它修复重复帧；保留终端原生滚动缓冲比去重更重要。
// 分发函数 `normalizeClearTerminal` 在两平台统一执行剥离，且不会主动生成任何新字节。
//
// 门控 KHY_PRESERVE_SCROLLBACK 默认开;关 → `normalizeClearTerminal`/`stripScrollbackClear`
// 原样返回 → ink 写出原字节 → 两平台行为与今日逐字节一致(Windows 重复症状保留 = 诚实回退)。

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 待剥离的「清回滚缓冲」子序列 `\x1b[3J`。ESC 用显式 `` 构造(绝不在源码里嵌入不可见的
// 字面 ESC 字节,避免编辑/镜像时被吞)。注:仅此一序列被剥,`\x1b[2J`(清屏)/`\x1b[H`(归位)保留。
const SCROLLBACK_CLEAR = '[3J';

/**
 * ESC(0x1b)从本叶子自有的 SCROLLBACK_CLEAR 首字节派生,避免在源码里再嵌入不可见字面 ESC
 * 字节(编辑/四树镜像时易被吞)。下面是 win32 的 ink clearTerminal 与其「注入 3J」修正形式。
 */
const ESC = SCROLLBACK_CLEAR.charAt(0); // '\x1b'
const WIN_CLEAR = `${ESC}[2J${ESC}[0f`; // win32 ink clearTerminal(无 3J)
// 兼容旧调用方的导出名；修复后它等于原始 Windows 清屏序列，不再注入 3J。
const WIN_CLEAR_FIXED = WIN_CLEAR;

/**
 * scrollback 保全默认开;仅显式 falsy 关闭。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  const raw = env && env.KHY_PRESERVE_SCROLLBACK;
  const v = String(raw === null || raw === undefined ? '' : raw)
    .trim()
    .toLowerCase();
  return !OFF_VALUES.includes(v);
}

/**
 * 从单次 stdout 写入块中剥离「清回滚缓冲」子序列 `\x1b[3J`,保留其余转义(`2J`/`H` 等)。
 *
 * 门控关 → 原样返回(逐字节回退)。非字符串(Buffer/undefined/…)→ 原样返回(ink 的
 * clearTerminal 帧恒为字符串;Buffer 不动,保守)。整体 try/catch 兜底:任何异常 → 返回原
 * 入参(失败软化,绝不破坏输出)。
 *
 * @param {*} chunk - stdout.write 的首参
 * @param {object} [env]
 * @returns {*} 过滤后的 chunk(或原样)
 */
function stripScrollbackClear(chunk, env = process.env) {
  try {
    if (!isEnabled(env)) {
      return chunk;
    }
    if (typeof chunk !== 'string') {
      return chunk;
    }
    if (chunk.indexOf(SCROLLBACK_CLEAR) === -1) {
      return chunk;
    }
    return chunk.split(SCROLLBACK_CLEAR).join('');
  } catch {
    return chunk;
  }
}

/**
 * 规范化 ink 写出的 clearTerminal 序列：所有平台都剥离 `\x1b[3J`，因此
 * fullscreen 重绘仍可清理当前可视区，但不会清空终端原生 scrollback。
 * Windows 的 ink 序列本身不含 3J，保持逐字节不变。
 *
 * @param {*} chunk - stdout.write 的首参
 * @param {object} [env]
 * @param {string} [platform] - 默认 process.platform;测试可显式传 'win32'/'linux'
 * @returns {*} 规范化后的 chunk(或原样)
 */
function normalizeClearTerminal(chunk, env = process.env, platform = process.platform) {
  try {
    if (!isEnabled(env)) {
      return chunk;
    }
    if (typeof chunk !== 'string') {
      return chunk;
    }
    return stripScrollbackClear(chunk, env);
  } catch {
    return chunk;
  }
}

/**
 * 为 stdout.write() 创建有状态规范化器。Ink 通常一次写出完整全屏帧，但流包装器
 * 允许把清屏序列拆到多次 write()，也允许传 Buffer。这里只保留「可能是目标序列
 * 开头」的最长尾缀，序列完整后再规范化；最多暂存 WIN_CLEAR.length - 1 个字节。
 *
 * 门控关闭时每次写入逐字节直通。flush() 返回尚未闭合的尾缀，供退出清理和测试使用。
 * @param {object} [env]
 * @param {string} [platform]
 * @returns {{write:function(*):*,flush:function():string}}
 */
function createClearTerminalNormalizer(env = process.env, platform = process.platform) {
  let pending = '';

  function write(chunk) {
    try {
      if (!isEnabled(env)) {
        return chunk;
      }
      const isBuffer = Buffer.isBuffer(chunk);
      if (typeof chunk !== 'string' && !isBuffer) {
        return chunk;
      }
      const token = SCROLLBACK_CLEAR;
      const text = pending + (isBuffer ? chunk.toString('utf8') : chunk);
      pending = '';

      let keep = 0;
      const max = Math.min(token.length - 1, text.length);
      for (let n = max; n > 0; n -= 1) {
        if (text.endsWith(token.slice(0, n))) {
          keep = n;
          break;
        }
      }

      const ready = keep > 0 ? text.slice(0, -keep) : text;
      pending = keep > 0 ? text.slice(-keep) : '';
      const normalized = normalizeClearTerminal(ready, env, platform);
      return isBuffer ? Buffer.from(normalized, 'utf8') : normalized;
    } catch {
      pending = '';
      return chunk;
    }
  }

  function flush() {
    const rest = pending;
    pending = '';
    return rest;
  }

  return { write, flush };
}

module.exports = {
  isEnabled,
  stripScrollbackClear,
  normalizeClearTerminal,
  createClearTerminalNormalizer,
  OFF_VALUES,
  SCROLLBACK_CLEAR,
  WIN_CLEAR,
  WIN_CLEAR_FIXED,
};
