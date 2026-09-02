'use strict';

/**
 * outputWidthGuard — TUI 输出行宽守卫(单一真源)。
 *
 * 用户契约:「每行输出文字宽度不得超过输入框当前显示的最大宽度」。输入框横跨
 * `stdout.columns` 列;ink 自己的帧都按这个宽度排版,但**直写 stdout 的内容不经过
 * ink 排版** —— 启动期的登录/版本行、异步落点的更新检查、后端日志(winston 走
 * console._stdout)、各种 best-effort 通知 —— 超宽时由终端硬折行,版面被冲乱。
 *
 * 做法:包一层 `stdout.write`,对**纯文本 + SGR 颜色码**的行按显示宽度(CJK=2、
 * ANSI 零宽)折行到 ≤ columns;折行处闭合已开的 SGR 并在续行首重新打开,颜色不串行。
 *
 * 绝不碰的内容(逐字节放行):
 *   - 含任何**非 SGR** 转义(CUP/EL/ED/OSC/DECRST…)或 `\r` 的写入 —— 那是 ink 帧、
 *     进度行、鼠标层、标题栏等瞬时 UI,折行会毁掉寻址语义;
 *   - 显示宽度本就 ≤ columns 的行(热路径零改动,ink 帧因此不受影响);
 *   - 非 TTY(管道/重定向,机器可读输出绝不能被折)。
 *
 * 门控 KHY_OUTPUT_WIDTH_GUARD(默认开;0/false/off/no 关 → install 返回 noop 句柄)。
 * 纯叶子契约:零 IO(不主动写终端)、确定性、绝不抛;measure 可注入(测试)。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// SGR 序列(颜色/字重等,零显示宽度,可安全携带/重放)。
const SGR_RE = /\x1b\[[0-9;]*m/g;
// 非 SGR 的转义或回车:出现即整块放行(瞬时 UI / 寻址写入,绝不可折)。
const CURSOR_OP_RE = /\x1b(?!\[[0-9;]*m)|\r/;

function guardEnabled(env) {
  try {
    const raw = (env || process.env).KHY_OUTPUT_WIDTH_GUARD;
    if (raw === undefined || raw === null) {
      return true;
    }
    return !OFF_VALUES.includes(String(raw).trim().toLowerCase());
  } catch {
    return true;
  }
}

/**
 * 把一行(可含 SGR)折成若干段,每段显示宽度 ≤ cols。
 * 折行点:闭合已开 SGR(`\x1b[0m`),续行首重放全部已开 SGR;折点处的尾随空白丢弃。
 * 无 ANSI 且不超宽 → 返回原串(零拷贝热路径)。
 * @param {string} line
 * @param {number} cols
 * @param {(s: string) => number} measure - 显示宽度度量(ANSI 感知)
 * @returns {string[]}
 */
function wrapAnsiLine(line, cols, measure) {
  const widthOf = typeof measure === 'function' ? measure : require('../../formatters').displayWidth;
  if (!line) {
    return [line];
  }
  if (cols < 2) {
    return [line];
  }
  if (line.indexOf('\x1b') === -1 && widthOf(line) <= cols) {
    return [line];
  }

  // 逐 token 扫描:SGR 记入活跃栈(零宽),普通字符按码点计宽。
  const out = [];
  let cur = '';
  let curW = 0;
  let active = ''; // 已开且未关的 SGR 序列拼接(续行首重放)
  let i = 0;
  const src = String(line);
  SGR_RE.lastIndex = 0;
  while (i < src.length) {
    SGR_RE.lastIndex = i;
    const sgr = SGR_RE.exec(src);
    if (sgr && sgr.index === i) {
      const seq = sgr[0];
      cur += seq;
      // `\x1b[0m`(含空参变体 `\x1b[m`)清空活跃栈;其余入栈。
      if (/^\x1b\[(0?|0;*)m$/.test(seq)) {
        active = '';
      } else {
        active += seq;
      }
      i += seq.length;
      continue;
    }
    const cp = src.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const w = widthOf(ch);
    if (curW + w > cols) {
      // 折行:本行收口(已开 SGR 需闭合),续行首重放。当前字符**不跳过** ——
      // 下一轮把它作为续行首字符加入,绝不丢字。
      out.push(cur.replace(/\s+$/, '') + (active ? '\x1b[0m' : ''));
      cur = active;
      curW = 0;
      // 续行首的行首空白不保留(避免悬挂缩进)。
      while (i < src.length && src[i] === ' ') {
        i++;
      }
      continue;
    }
    cur += ch;
    curW += w;
    i += cp > 0xffff ? 2 : 1;
  }
  out.push(cur);
  return out.length ? out : [line];
}

/**
 * 把一段(可多行)写入内容按行折到 ≤ cols;不超宽或含寻址序列 → 原样返回。
 * @param {string} text
 * @param {number} cols
 * @param {(s: string) => number} measure
 * @returns {string} 原串(未折)或折行后的串
 */
function clampChunkToWidth(text, cols, measure) {
  const s = String(text == null ? '' : text);
  if (cols < 2 || s === '') {
    return s;
  }
  // 热路径:整体都不可能超宽(总长 ≤ cols,必然单行且每行 ≤ cols)。
  if (s.length <= cols) {
    return s;
  }
  if (CURSOR_OP_RE.test(s)) {
    return s; // 瞬时 UI / 寻址写入,逐字节放行
  }
  const widthOf = typeof measure === 'function' ? measure : require('../../formatters').displayWidth;
  const lines = s.split('\n');
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln === '' || ln.length <= cols) {
      continue; // 长度即上界的快速判断:纯 ASCII 不会超;CJK 由下方精确量
    }
    if (widthOf(ln) <= cols) {
      continue;
    }
    lines[i] = wrapAnsiLine(ln, cols, widthOf).join('\n');
    changed = true;
  }
  return changed ? lines.join('\n') : s;
}

/** 已安装句柄(模块级幂等:同一 stdout 只装一层)。 */
let _installed = null;

/**
 * 在 stdout 上安装行宽守卫。
 * @param {object} [options]
 * @param {object} [options.stdout] - 被包的流(默认 process.stdout)
 * @param {object} [options.env] - 门控环境(测试注入)
 * @param {(s: string) => number} [options.measure] - 显示宽度度量(测试注入)
 * @returns {{ uninstall: function(): void }} install 幂等;未启用/非 TTY → noop 句柄
 */
function install(options = {}) {
  const out = options.stdout || process.stdout;
  if (_installed && _installed.stdout === out) {
    return { uninstall() {} }; // 已装,不叠加
  }
  if (!guardEnabled(options.env || process.env)) {
    return { uninstall() {} };
  }
  if (!out || !out.isTTY || typeof out.write !== 'function') {
    return { uninstall() {} }; // 管道/重定向:机器可读输出,绝不折
  }

  const original = out.write;
  const measure = typeof options.measure === 'function'
    ? options.measure
    : require('../../formatters').displayWidth;

  const guarded = function (chunk, ...rest) {
    try {
      const cols = Number(out.columns) > 0 ? Math.floor(Number(out.columns)) : 0;
      if (cols >= 2) {
        const s = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk == null ? '' : chunk);
        const clamped = clampChunkToWidth(s, cols, measure);
        if (clamped !== s) {
          return original.call(out, clamped, ...rest);
        }
        // 原样(未折)也统一走 original,保持调用语义一致
        return original.call(out, chunk, ...rest);
      }
    } catch {
      /* 守卫自身绝不能阻断输出 */
    }
    return original.apply(out, [chunk, ...rest]);
  };

  try {
    out.write = guarded;
  } catch {
    return { uninstall() {} }; // 只读流等异常情况:放弃但不抛
  }

  _installed = { stdout: out, original };
  return {
    uninstall() {
      if (!_installed || _installed.stdout !== out) {
        return;
      }
      try {
        if (out.write === guarded) {
          out.write = original;
        }
      } catch {
        /* 流可能已被别的层换过 —— 尽力而为 */
      }
      _installed = null;
    },
  };
}

/** 测试辅助:清模块级安装状态(生产代码不应调用)。 */
function _resetForTests() {
  _installed = null;
}

module.exports = {
  install,
  uninstall: () => {
    if (_installed) {
      const { stdout, original } = _installed;
      try {
        if (stdout.write !== original) {
          stdout.write = original;
        }
      } catch {
        /* 尽力而为 */
      }
      _installed = null;
    }
  },
  wrapAnsiLine,
  clampChunkToWidth,
  guardEnabled,
  _resetForTests,
};
