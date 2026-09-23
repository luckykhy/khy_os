'use strict';

/**
 * oscSafeText.js — 终端 OSC 字符串载荷的唯一清洗出口（窗口标题写入点共用）。
 *
 * 病根（BUG-33 / `.khy/feedback/tui-ux-audit-20260919/Y/`）：两个标题写点都是
 *   `write(`\x1b]0;${title}\x07`)`（`cli/tui/runtime/topicBar._paint`、
 *   `cli/repl/terminalTitle.setTerminalTitle`），而 title 来自会话主题：
 *   模型回包（useTopic → `generateTitleAI`）**或用户输入原文**
 *   （`generateTitle` 只 strip `\n`）。载荷里只要含 BEL / ESC —— OSC 串的**定界符** ——
 *   终端就把它解析成第二条独立 OSC 命令。实测（`repro-before.txt` A/B 段）
 *   可注入 `OSC 52` 剪贴板写入。发送方有义务保证载荷无定界符，与终端实现无关。
 *
 * 两步，顺序有意义：
 *  1. **整段**删掉完整的转义序列（CSI / OSC / 两字节 ESC 派发）。只删 ESC 会把
 *     `\x1b[31m` 变成可见残片 `[31m` —— 正是用户用「乱码」纠正过的那类缺陷，
 *     所以先按序列吞掉，再谈控制字符。
 *  2. 剩下的 C0 控制字符 / DEL / C1（`\u009b`、`\u009d` 是 8-bit 形式的 CSI/OSC，
 *     部分终端照收）一律清除；C0 里的空白族（`\t\n\v\f\r`）换成空格，
 *     免得把两个词粘成一个。
 *
 * **刻意保留** U+2800 braille blank 装饰（非 C1/C0）：见
 * `cli/tui/runtime/topicBarWorkingIndicator` 的 anti-trim 纪律，它不是乱码。
 *
 * 契约：纯函数、确定性、nullish 安全、绝不抛。
 */

// 一条完整的转义序列：CSI、OSC（BEL 或 ST 结尾）、ESC-中间字节派发（如 `ESC ( B`）、
// 两字节 ESC 派发。与 wrapCell 的 ESC_SEQ_RE **同一形状**（那里 sticky 逐 token，这里
// 全局一次扫）—— BUG-115 把两处一起放宽：CSI 参数字节是完整 ECMA-48 区段
// `[0-9:;<=>?]`（不是旧的 `[0-9;?]`），否则冒号 truecolor SGR（`ESC [ 38:2:R:G:B m`）
// 与私有参数（`ESC [ > c`）不被整段吞掉，落单的 ESC 虽被第 2 步清掉，却把
// `[38:2:...m` 留在标题里当可见残片 —— 正是本模块上面注释立誓要防的「乱码」。
// eslint-disable-next-line no-control-regex
const _ESC_SEQ_RE = /\x1b(?:\[[0-9:;<=>?]*[ -/]*[@-~]|\][\s\S]*?(?:\x07|\x1b\\)|[ -/]+[@-~]|[@-Z\\-_])/g;
// C0 空白族 → 空格（标题必须单行，但不该因此粘连）。
const _C0_SPACE_RE = /[\t\n\v\f\r]/g;
// 其余 C0（含 BEL \x07、ESC 落单字节）+ DEL + C1 控制字符 → 删除。
const _C0_DEL_C1_RE = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g;
// 清洗后可能留下连续空白（原序列两侧各一个空格），收成一个。
const _SPACE_RUN_RE = /  +/g;

/**
 * 把任意（可能不可信的）文本变成可安全嵌入 OSC 字符串的单行纯文本。
 * @param {unknown} value
 * @returns {string} 不含 ESC / BEL / 任何 C0 / DEL / C1 控制字符的字符串
 */
function toOscSafeText(value) {
  return String(value == null ? '' : value)
    .replace(_ESC_SEQ_RE, '')
    .replace(_C0_SPACE_RE, ' ')
    .replace(_C0_DEL_C1_RE, '')
    .replace(_SPACE_RUN_RE, ' ')
    .trim();
}

module.exports = { toOscSafeText };
