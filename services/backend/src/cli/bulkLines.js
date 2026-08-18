'use strict';

/**
 * bulkLines.js — CLI stdout 合并写工具：低调用次数、失败回退、绝不抛、可单测。
 *
 * 修「CLI 大面积刷屏卡顿」的根因之一:多处把 AI 回复/大段动态输出按
 * `text.split('\n').forEach(l => console.log(...))` 逐行打印 —— 千行输出 = 千次同步写
 * syscall,Windows ConHost 逐次阻塞,终端呈「一行一行往外挤」的刷屏卡顿。
 *
 * 开门(KHY_BULK_LINE_WRITE 默认开)→ 把各行(带 indent 前缀)join('\n') 后**一次性**
 * `process.stdout.write(joined + '\n')`,与逐行 console.log 的输出逐字节等价
 * (console.log 每行输出 `indent + line + '\n'`,合并写完全一致);合并写后惰性通知
 * spinner 有外部 stdout 写入(noteExternalStdoutWrite),失败静默。
 * 关门(0/false/off/no)或任何异常 → 逐行 console.log 回退历史行为,绝不抛。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env = process.env) {
  const raw = env && env.KHY_BULK_LINE_WRITE;
  const v = String(raw == null ? '' : raw)
    .trim()
    .toLowerCase();
  return !OFF_VALUES.includes(v);
}

// 历史行为(逐字节回退基准):逐行 console.log(indent + line)。
function _legacy(lines, indent) {
  for (const line of lines) {
    console.log(indent + line);
  }
}

/**
 * 把多行文本一次性写到 stdout(每行加 indent 前缀),输出与逐行 console.log 逐字节等价。
 * @param {*} text  多行文本;非字符串按 String(text) 转换(与 console.log 的行为同族)。
 * @param {string} [indent]  每行前缀(历史 call-site 多为两个空格)。
 * @param {Record<string,string>} [env]
 */
function printLines(text, indent = '', env = process.env) {
  let lines;
  try {
    // String(null)='null'、String(undefined)='undefined' — 与 console.log(String(x)) 等价。
    lines = String(text).split('\n');
  } catch {
    lines = [''];
  }
  const prefix = typeof indent === 'string' ? indent : String(indent == null ? '' : indent);
  try {
    if (!isEnabled(env)) {
      _legacy(lines, prefix);
      return;
    }
    const joined = lines.map((l) => prefix + l).join('\n');
    process.stdout.write(joined + '\n');
    // Coalesced write bypasses console.log; nudge the spinner so its frame-dedup
    // cache repaints after someone else touched the terminal. Fail silently.
    try {
      const spinner = require('./spinner');
      if (spinner && typeof spinner.noteExternalStdoutWrite === 'function') {
        spinner.noteExternalStdoutWrite();
      }
    } catch {
      /* spinner optional — never let notification break output */
    }
  } catch {
    // 兜底:任何异常回退历史逐行打印,绝不抛。
    try {
      _legacy(lines, prefix);
    } catch {
      /* stdout gone — nothing left to do */
    }
  }
}

module.exports = { isEnabled, printLines };
