'use strict';

/**
 * ansiSanitizer.js — 剥离「CSI / OSC / 裸 ESC」控制序列的**单一真源**（纯叶子）。
 *
 * ## 为什么需要它（谁要的 / 为什么这么做）
 *
 * 病灶：模型偶尔把 ANSI 转义序列当正文吐出来（最典型是 `ESC[1m` 粗体）。
 * 旧路径 `modelTextNormalizer._stripInvisible` 用
 * `CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g` 做「剥不可见字符」，
 * 它**只吃掉 `0x1B`(ESC) 这一个字节**，紧跟其后的 CSI 参数（`[1m`）无人接管，
 * 于是残留成可见 ASCII，屏幕显示 `1m_标题_`。
 *
 * **剥一半比不剥更糟**：完整保留时，渲染器（marked/CommonMark）会把整段
 * `ESC[1m` 当不可见控制序列连同参数一起忽略；剥掉 ESC 后留下的 `[1m` 是
 * **可见字符**，且 `[`/`1`/`m` 都不是空白也不是单词字符，恰好破坏了紧随的
 * `_` 的「左侧接（left-flanking）」条件 → `_标题_` 强调不成立 → 下划线裸上屏。
 * 这解释了用户截图里 `_…_` 与 `1m` **同时**出现的现象：它们是同一个病的两个症状。
 *
 * ## 为什么不选另一条路
 *
 * - **不选「只扩展 CONTROL_CHARS 的正则」**：控制字符类无法表达「CSI 参数 + 终止符」
 *   这种**多字符结构**。任何在字符类里加 `[0-9;\[` 的做法都会误伤正文里合法的
 *   方括号与数字。
 * - **不选「只依赖 strip-ansi 包」**：该包在 `utils/stripAnsi.js` 里是 lazy-load 且
 *   **加载失败即静默回退**到本地弱正则（只认纯数字 SGR，实测漏剥 5/6，见
 *   `.khy/feedback/structured-output-20260922/repro-before.txt`）。依赖包=依赖运行时环境，
 *   而输出卫生是**每次对话都走**的关键路径，不能有不生效的兜底分叉。
 * - **本模块 = 自带完整覆盖、零依赖、永不抛**，让所有消费方收敛到同一口径。
 *
 * ## 契约（纯叶子）
 *
 * - 零 IO、零业务 require、确定性、**绝不抛**（非字符串输入原样返回）。
 * - 只删除控制序列，**不动任何可见字符**，不改写正文语义。
 * - 代码块内容由调用方自行保护（本模块不感知 fence 语义）。
 *
 * ## 覆盖范围（对齐 ANSI X3.64 / ECMA-48）
 *
 * - **CSI** `ESC [ 参数 中间符 终止符`：SGR 颜色/样式、光标移动、擦除、
 *   私有模式（`?25l`/`?25h`）、冒号分隔真彩（`38:2::r:g:b`）等 —— 参数含 `0-9 ; : < = > ?`
 * - **OSC** `ESC ] … (BEL | ESC \)`：超链接、窗口标题、剪贴板
 * - **DCS/SOS/PM/APC** `ESC (P|X|^|_) … (ESC \ | BEL)`：设备控制串
 * - **ESC 短序列** `ESC [中间符] 终态`：两/三字节转义（`ESC # 6` 双宽、
 *   `ESC ( B` 字符集选择、`ESC 7` 存光标…）
 * - **裸控制字符** `0x00-0x08`、`0x0B`、`0x0C`、`0x0E-0x1F`、`0x7F`
 *   （保留 `\n` 0x0A 与 `\t` 0x09）—— 放最后兜底，清掉**不属于任何序列**的零散控制字符
 *
 * 顺序不可颠倒：**先删完整序列，再删裸控制字符**。颠倒会先把 ESC 吃掉，
 * 使 `[1m` 变成没有 ESC 前缀的孤儿参数而幸存——正是本模块要消灭的那个 bug。
 */

// ── CSI: ESC [ <参数> <中间符> <终止符> ───────────────────────────────────────
// 参数/中间符 允许 0x30-0x3F (0-9 : ; < = > ?) 与 0x20-0x2F (! " # $ % & ' ( ) * + , - . /)
// 终止符 0x40-0x7E (@ A-Z [ \ ] ^ _ ` a-z { | } ~)。
// 宽松量化：任何以 ESC[ 开头、以合法终止符结尾的串都算控制序列——宁可多删，
// 因为「模型正文里合法出现 ESC[」的概率极低，而残留参数的可读性伤害是确定的。
// eslint-disable-next-line no-control-regex
const RE_CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

// ── OSC: ESC ] … (BEL 或 ST=ESC\) ────────────────────────────────────────────
// 惰性主体 + 两种终止符。必须先于 RE_ESC_TWO_CHAR 执行，否则 ST 的 ESC\ 会被
// 两字节规则先吃掉，留下 OSC 主体成为可见垃圾。
// eslint-disable-next-line no-control-regex
const RE_OSC = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;

// ── DCS / SOS / PM / APC: ESC (P|X|^|_) … (ST 或 BEL) ───────────────────────
// eslint-disable-next-line no-control-regex
const RE_DCS = /\u001b[PX^_][\s\S]*?(?:\u001b\\|\u0007)/g;

// ── 转义序列：ESC [中间符可选] 终态 ─────────────────────────────────────────
// ECMA-48 的「nF / Fs」形：ESC 后可跟若干个**中间符** 0x20-0x2F（`!`–`/`），
// 再跟一个**终态** 0x30-0x7E。真实例：
//   - `ESC # 6`（DEC 双宽）      → 中间符 `#`(0x23) + 终态 `6`(0x36)
//   - `ESC ( B`（选 ASCII 字符集）→ 中间符 `(`(0x28) + 终态 `B`(0x42)
//   - `ESC 7` / `ESC 8`（存/取光标）→ 无中间符
//   - `ESC c`（硬复位）           → 无中间符
// 必须放在 CSI/OSC/DCS 之后：那些多字节序列的引导字符（[/]/P/X/^/_）也是
// ESC 后第一个字节，先跑这一条会把序列腰斩成「只剩主体」。放最后则它们的
// 引导+主体已被前面几条整段吃掉，此处只兜住真正的两/三字节短序列。
// eslint-disable-next-line no-control-regex
const RE_ESC_SHORT = /\u001b[ -/]*[0-~]/g;

// ── 裸控制字符兜底（保留 \n=0x0A、\t=0x09）─────────────────────────────────
// eslint-disable-next-line no-control-regex
const RE_BARE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

// ── 零宽 / BOM 类字符（小模型偶发，会撑坏列宽计算）──────────────────────────
const RE_ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/g;

/**
 * 剥离所有 ANSI/CSI/OSC 控制序列与裸控制字符。纯函数、绝不抛。
 *
 * @param {string} text 输入文本
 * @returns {string} 剥离后的可见文本（非字符串输入原样返回）
 */
function stripAnsiSequences(text) {
  if (typeof text !== 'string' || text === '') {
    return text;
  }
  // 顺序敏感：多字节序列 → 短序列/两字节 → 裸控制字符 → 零宽。
  let out = text;
  if (out.indexOf('\u001b') !== -1) {
    out = out
      .replace(RE_OSC, '')
      .replace(RE_CSI, '')
      .replace(RE_DCS, '')
      .replace(RE_ESC_SHORT, '');
  }
  out = out.replace(RE_BARE_CONTROL, '').replace(RE_ZERO_WIDTH, '');
  return out;
}

/**
 * 判定文本是否**含**控制序列（不修改）。用于「按需触发」与观测埋点。
 * @param {string} text
 * @returns {boolean}
 */
function hasAnsiSequences(text) {
  if (typeof text !== 'string' || text === '') {
    return false;
  }
  return /\u001b/.test(text) || RE_BARE_CONTROL.test(text) || RE_ZERO_WIDTH.test(text);
}

module.exports = {
  stripAnsiSequences,
  hasAnsiSequences,
  RE_CSI,
  RE_OSC,
  RE_DCS,
  RE_ESC_SHORT,
  RE_BARE_CONTROL,
  RE_ZERO_WIDTH,
};
