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
// 平台对称(win32 反向注入,修复 Windows「同一对话窗口重复显示多份」):
//   • 非 win32 的 clearTerminal `\x1b[2J\x1b[3J\x1b[H` 里的 `\x1b[2J`(erase display)在
//     xterm 系是**原地擦除**,`\x1b[3J` 才擦回滚 → 剥掉 `3J` 即保全 scrollback(见上)。
//   • win32 的 clearTerminal 是 `\x1b[2J\x1b[0f`(**无 `3J`**)。但 Windows conhost /
//     Windows Terminal 上 `\x1b[2J` 的历史行为是把当前可视帧**向上滚进 scrollback**(而非原地
//     擦除)→ ink 每次 fullscreen 重绘都把整段 `fullStaticOutput` 连同旧帧堆进 scrollback,
//     用户看到同一段对话被重复显示 2–3 份。修法:在 win32 的 clearTerminal 里**注入 `\x1b[3J`**
//     (`\x1b[2J\x1b[0f` → `\x1b[2J\x1b[3J\x1b[0f`),让每次重绘先清掉刚滚进去的重复副本 →
//     随后写出的 `fullStaticOutput` 成为唯一一份干净 transcript。
//   • 分发函数 `normalizeClearTerminal(chunk, env, platform)` 按平台选择「剥离(非 win32)/
//     注入(win32)」;注入**幂等**(WIN_CLEAR_FIXED 不含完整 WIN_CLEAR token,重复跑不二次注入)。
//   • `\x1b[3J` 在 ink TUI 表面唯一语义就是「擦回滚」,本仓自有源码从不发它(仅
//     liveRegionBudget.js 注释提及)→ 统一剥离/注入不破坏任何既有功能。
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
const WIN_CLEAR_FIXED = `${ESC}[2J${ESC}[3J${ESC}[0f`; // 注入 3J → 擦回滚,消除重复副本

/**
 * scrollback 保全默认开;仅显式 falsy 关闭。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  const raw = env && env.KHY_PRESERVE_SCROLLBACK;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
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
    if (!isEnabled(env)) return chunk;
    if (typeof chunk !== 'string') return chunk;
    if (chunk.indexOf(SCROLLBACK_CLEAR) === -1) return chunk;
    return chunk.split(SCROLLBACK_CLEAR).join('');
  } catch {
    return chunk;
  }
}

/**
 * 按平台规范化 ink 写出的 clearTerminal 序列(fullscreen 重绘的单一处理点):
 *   • 非 win32 → 委托 `stripScrollbackClear`(剥 `\x1b[3J`,保全 scrollback,行为不变)。
 *   • win32   → 把 ink 的 `\x1b[2J\x1b[0f` 注入为 `\x1b[2J\x1b[3J\x1b[0f`,清掉被 `\x1b[2J`
 *     滚进 scrollback 的重复副本 → 每次重绘只留一份干净 transcript。
 *
 * 门控关 → 原样返回(逐字节回退)。非字符串 → 原样返回。win32 注入**幂等**:WIN_CLEAR_FIXED
 * 不含完整 WIN_CLEAR token,重复处理不会二次注入。整体 try/catch 兜底,绝不抛。
 *
 * @param {*} chunk - stdout.write 的首参
 * @param {object} [env]
 * @param {string} [platform] - 默认 process.platform;测试可显式传 'win32'/'linux'
 * @returns {*} 规范化后的 chunk(或原样)
 */
function normalizeClearTerminal(chunk, env = process.env, platform = process.platform) {
  try {
    if (!isEnabled(env)) return chunk;
    if (typeof chunk !== 'string') return chunk;
    if (platform === 'win32') {
      if (chunk.indexOf(WIN_CLEAR) === -1) return chunk;
      return chunk.split(WIN_CLEAR).join(WIN_CLEAR_FIXED);
    }
    return stripScrollbackClear(chunk, env);
  } catch {
    return chunk;
  }
}

module.exports = {
  isEnabled,
  stripScrollbackClear,
  normalizeClearTerminal,
  OFF_VALUES,
  SCROLLBACK_CLEAR,
  WIN_CLEAR,
  WIN_CLEAR_FIXED,
};
