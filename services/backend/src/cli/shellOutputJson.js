'use strict';

/**
 * shellOutputJson — 命令输出里的 JSON 行美化(纯叶子,零 IO、确定性、绝不抛、门控)。
 *
 * 背景(对齐 CC 后端逻辑):Claude Code 渲染 shell 命令输出时,会对**每一行**尝试
 * JSON 美化——见 `src/components/shell/OutputLine.tsx` 的 `tryJsonFormatContent` /
 * `tryFormatJson`:一行若是合法 JSON 且 round-trip 不丢精度,就 `JSON.stringify(_, null, 2)`
 * 缩进展开,让 `{"a":1,"b":[2,3]}` 这种压扁成一坨的输出变得可读;否则原样保留。
 * 整体内容超过 `MAX_JSON_FORMAT_LENGTH` 时整段跳过(避免大输出上做昂贵的逐行解析)。
 *
 * Khy 旧逻辑:两个命令输出体渲染器(TUI `renderLiteralOutput`、classic
 * `_printToolCallResultInner`)都把原始输出体直接 `split('\n')` 逐行渲染,**从不做
 * JSON 美化**——一行压扁的 JSON 就一直是难读的一长行。本叶子补齐这个真缺口,且**忠实
 * 移植 CC 的精度守卫**(大整数超过 `Number.MAX_SAFE_INTEGER` 时 round-trip 会丢精度,
 * 此时原样保留,绝不给出一个被悄悄改写过的「美化」版本)。
 *
 * 关键不变量:本变换**只动**「本身就是合法 JSON 且无精度损失」的行;任何普通文本
 * (如「命令输出 5 行」「Read 50 lines」)JSON.parse 即抛 → 原样返回。故对非 JSON
 * 输出**逐字节无害**,可安全套在任意输出体上。
 *
 * 门控:`KHY_SHELL_OUTPUT_JSON`(默认开)。=0/false/off/no → 关 → 原样返回输入,
 * 调用方逐字节回退到改前行为。
 */

const MAX_JSON_FORMAT_LENGTH = 10000; // CC MAX_JSON_FORMAT_LENGTH

function _gateOff(env) {
  const v = String((env && env.KHY_SHELL_OUTPUT_JSON) || '').trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'off' || v === 'no';
}

/**
 * 对单行尝试 JSON 美化。忠实移植 CC `tryFormatJson`:
 *  - 解析失败(非 JSON)→ 原样返回。
 *  - round-trip 后(去除 `\/` 转义与全部空白)与原行不等 → 判定有精度/信息损失 → 原样返回。
 *  - 否则返回 `JSON.stringify(parsed, null, 2)`(2 空格缩进美化)。
 * @param {string} line
 * @returns {string}
 */
function tryFormatJsonLine(line) {
  try {
    const parsed = JSON.parse(line);
    const stringified = JSON.stringify(parsed);
    // 检测 round-trip 精度损失:大整数超过 Number.MAX_SAFE_INTEGER 时会被改写。
    // 归一化两侧(原行剥掉可选的 `\/` 转义 + 去全部空白;序列化串去全部空白)再比较。
    const normalizedOriginal = String(line).replace(/\\\//g, '/').replace(/\s+/g, '');
    const normalizedStringified = String(stringified).replace(/\s+/g, '');
    if (normalizedOriginal !== normalizedStringified) {
      return line; // 有精度/信息损失 → 原样保留
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return line; // 非 JSON → 原样保留
  }
}

/**
 * 对整段命令输出逐行尝试 JSON 美化。忠实移植 CC `tryJsonFormatContent`。
 * 门控关 / 非字符串 / 整段超长 / 异常 → 原样返回(逐字节回退)。
 * @param {string} content
 * @param {object} [env]
 * @returns {string}
 */
function formatShellOutputJson(content, env) {
  try {
    if (typeof content !== 'string' || content === '') return content;
    const e = env || (typeof process !== 'undefined' ? process.env : undefined);
    if (_gateOff(e)) return content;
    if (content.length > MAX_JSON_FORMAT_LENGTH) return content;
    return content.split('\n').map(tryFormatJsonLine).join('\n');
  } catch {
    return content;
  }
}

module.exports = {
  formatShellOutputJson,
  tryFormatJsonLine,
  MAX_JSON_FORMAT_LENGTH,
};
