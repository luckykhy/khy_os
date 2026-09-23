'use strict';

/**
 * vtScreen — 最小 VT 屏幕模型（从 tests/tui/liveFrameGeometry.test.js 抽出，
 * 那条守卫与 BUG-91 的真帧断言共用同一份行语义；抄两份就会漂移）。
 *
 * 用途：ink 的字节流是**增量帧序列**，累积流上的 `\n` 相邻不代表屏幕相邻
 * （一次重画可能只写变化的尾行）。要判「某两行此刻在屏幕上隔几行」，
 * 必须把字节流喂给一个会滚动、会解析 CSI 的屏幕模型再读行。
 */

/**
 * @param {number} rows @param {number} cols
 * @returns {{feed:(s:string)=>void, lineAt:(i:number)=>string, findLast:(needle:string)=>number}}
 */
function createScreen(rows, cols) {
  const grid = Array.from({ length: rows }, () => []);
  let r = 0;
  let c = 0;
  let saved = { r: 0, c: 0 };
  const newline = () => {
    c = 0;
    if (r === rows - 1) {
      grid.shift();
      grid.push([]);
    } else {
      r += 1;
    }
  };
  const put = (ch) => {
    const row = grid[r];
    while (row.length < c) row.push(' ');
    row[c] = ch;
    c += 1;
    if (c >= cols) newline();
  };
  const csi = (params, final) => {
    const n = (i, dflt) => {
      const v = params[i];
      return v === undefined || v === '' ? dflt : Number(v);
    };
    switch (final) {
      case 'A': r = Math.max(0, r - (n(0, 1) || 1)); break;
      case 'B': r = Math.min(rows - 1, r + (n(0, 1) || 1)); break;
      case 'C': c += n(0, 1) || 1; break;
      case 'D': c = Math.max(0, c - (n(0, 1) || 1)); break;
      case 'G': c = Math.max(0, n(0, 1) - 1); break;
      case 'H': case 'f':
        r = Math.max(0, Math.min(rows - 1, n(0, 1) - 1));
        c = Math.max(0, n(1, 1) - 1);
        break;
      case 'J':
        if (n(0, 0) === 2 || n(0, 0) === 3) {
          for (let i = 0; i < rows; i++) grid[i] = [];
        }
        break;
      case 'K': {
        const mode = n(0, 0);
        if (mode === 2) grid[r] = [];
        else if (mode === 0) grid[r].length = Math.min(grid[r].length, c);
        else grid[r] = [];
        break;
      }
      case 's': saved = { r, c }; break;
      case 'u': r = saved.r; c = saved.c; break;
      default: break;
    }
  };
  const feed = (s) => {
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\x1b' || s[i] === '\u009b') {
        // 参数组可缺省：ink 的差量写会发**无参** CSI（`\x1b[G` = 列归 1、`\x1b[K`
        // 缺省参 0）。旧写法把数字组设成必选，这类序列解析失败后 ESC 与 `[G`
        // 被当正文塞进网格，行精确匹配就永远落空（BUG-91 守卫实测）。
        const m = /^[[(#;?]*(([0-9]{1,4}(?:;[0-9]{0,4})*)?)([0-9A-ORZcf-nqry=><])/.exec(s.slice(i + 1));
        if (m) {
          csi(m[1] === '' ? [] : m[1].split(';'), m[3]);
          i += m[0].length;
          continue;
        }
      }
      if (s[i] === '\n') { newline(); continue; }
      if (s[i] === '\r') { c = 0; continue; }
      if (s[i] === '\x07' || s[i] === '\b') continue;
      put(s[i]);
    }
  };
  const lineAt = (i) => (grid[i] || []).join('').replace(/\s+$/, '');
  const findLast = (needle) => {
    for (let i = rows - 1; i >= 0; i--) if (lineAt(i).includes(needle)) return i;
    return -1;
  };
  return { feed, lineAt, findLast };
}

module.exports = { createScreen };
