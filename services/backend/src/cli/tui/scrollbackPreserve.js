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
// 平台差异(本叶子的第二处职责):两类终端都先剥离 clearTerminal 中的 `3J`,此外 win32 再
// 多做一步「清屏形式改写」。原因:conhost / Windows Terminal 的 **ED2(`[2J`)不是就地擦除**,
// 而是把当前视口整屏**向上滚进** scrollback 再填白 —— 于是 ink 每触发一次 fullscreen 分支,
// 回滚缓冲里就永久多出一份完整的 banner+输入框副本(用户报「UI 显示混乱 / 同一输入框重复两遍」)。
//
// 历史上试过反向**注入** `3J` 来压制,已刻意废弃:那会直接清空用户正在查看的原生 scrollback,
// 代价高于它修的症状。正解是第三条路 —— 把 `[2J[0f` 改写成等价的 `[H[J`:
//   `[H` 光标归位 + `[J`(ED0,从光标擦到屏幕末尾)。视觉终态与 ED2 完全一致(可视区清空、
//   光标在左上角),但 ED0 是**就地擦除**,既不滚屏 → 不留重复副本,也不碰 scrollback → 历史仍可上翻。
// 两个目标(去重复 / 保回滚)由此同时满足,不再二选一。
// 非 win32 的 `[2J` 本就是就地擦除,保持原样,逐字节不变。
//
// 门控 KHY_PRESERVE_SCROLLBACK 默认开;关 → `normalizeClearTerminal`/`stripScrollbackClear`
// 原样返回 → ink 写出原字节 → 两平台都回退到 ink 的原始行为(win32 重复帧症状随之回归)。

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 待剥离的「清回滚缓冲」子序列 `\x1b[3J`。ESC 用显式 `` 构造(绝不在源码里嵌入不可见的
// 字面 ESC 字节,避免编辑/镜像时被吞)。注:仅此一序列被剥,`\x1b[2J`(清屏)/`\x1b[H`(归位)保留。
const SCROLLBACK_CLEAR = '[3J';

/**
 * ESC(0x1b)从本叶子自有的 SCROLLBACK_CLEAR 首字节派生,避免在源码里再嵌入不可见字面 ESC
 * 字节(编辑/四树镜像时易被吞)。下面是 win32 的 ink clearTerminal 与其「注入 3J」修正形式。
 */
const ESC = SCROLLBACK_CLEAR.charAt(0); // '\x1b'
// ink 6.x 依赖 ansi-escapes@7,其 clearTerminal 按 **isOldWindows()** 分支,而不是 platform:
//   老 conhost → `2J + 0f`;其余(含 Windows 10/11 + Windows Terminal)→ `2J + 3J + H`。
// 实测 Win11 走的是后者 —— 所以「win32 本就无 3J 可剥」是只对老 conhost 成立的旧结论,
// 两种形式都要能识别,否则改写会静默漏掉现代 Windows 这条主路径。
const WIN_CLEAR = `${ESC}[2J${ESC}[0f`; // 老 conhost 形式
const NIX_CLEAR = `${ESC}[2J${ESC}[3J${ESC}[H`; // 现代形式(Win11 亦然)
const CLEAR_VIEWPORT = `${ESC}[2J${ESC}[H`; // 现代形式剥掉 3J 之后的样子
// win32 的等价「就地清屏」形式,是上面三者在 win32 上的统一改写目标(理由见头注)。
// 注意顺序:必须先 `[H` 归位再 `[J` 擦到末尾 —— ED0 只擦光标之后,不归位就擦不干净整屏。
const WIN_CLEAR_INPLACE = `${ESC}[H${ESC}[J`;
// 兼容旧调用方的导出名:它即 win32 归一化后的目标序列。
const WIN_CLEAR_FIXED = WIN_CLEAR_INPLACE;

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
    // 第一步(两平台一致):剥 `3J`,保全原生 scrollback。
    const stripped = stripScrollbackClear(chunk, env);
    if (platform !== 'win32' || typeof stripped !== 'string') {
      return stripped;
    }
    // 第二步(仅 win32):把两种 ED2 清屏形式都换成就地擦除,避免旧视口被滚进 scrollback。
    // 此时 3J 已被剥掉,现代形式已塌缩为 CLEAR_VIEWPORT(`2J + H`)。
    let out = stripped;
    if (out.indexOf(WIN_CLEAR) !== -1) {
      out = out.split(WIN_CLEAR).join(WIN_CLEAR_INPLACE);
    }
    if (out.indexOf(CLEAR_VIEWPORT) !== -1) {
      out = out.split(CLEAR_VIEWPORT).join(WIN_CLEAR_INPLACE);
    }
    return out;
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
      // win32 还要识别被拆开的 `[2J[0f`(8 字节),否则半截序列会漏过改写。
      const tokens = platform === 'win32'
        ? [SCROLLBACK_CLEAR, WIN_CLEAR, CLEAR_VIEWPORT, NIX_CLEAR]
        : [SCROLLBACK_CLEAR];
      const longest = tokens.reduce((a, t) => (t.length > a ? t.length : a), 0);
      const text = pending + (isBuffer ? chunk.toString('utf8') : chunk);
      pending = '';

      // 只暂存「可能是某个 token 的真前缀」的最长尾缀;已完整的 token 不留,立即归一化。
      let keep = 0;
      const max = Math.min(longest - 1, text.length);
      for (let n = max; n > 0; n -= 1) {
        if (tokens.some((t) => t.length > n && text.endsWith(t.slice(0, n)))) {
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
  NIX_CLEAR,
  CLEAR_VIEWPORT,
  WIN_CLEAR_INPLACE,
  WIN_CLEAR_FIXED,
};
