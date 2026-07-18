'use strict';

/**
 * displayWidthMemo — 字符串显示宽度(CJK/emoji 感知)的 LRU 记忆(纯叶子)。
 *
 * 承 keystroke 流畅性同族(渲染热路径每键 O(n) 全串重算)。
 *
 * 根因:`formatters.js::displayWidth(str)` 是全渲染层的显示宽度 SSOT(aiRenderer/diffRenderer/
 * 两个 picker/主输入刷新都调)。它每次:① `stripAnsi(str)`(整串正则替换)② ASCII 快路径正则
 * `/^[\x20-\x7E]*$/.test`(整串扫描)③ 非 ASCII 时走 `string-width` 的整串 grapheme 分段。主输入刷新
 * `_getInputCursorMetrics`(repl.js:2231-2232)**每按键**对整行调两次;用户逐字符键入长行 → 每键
 * 重测整行 = 一行内 O(n²)。CJK 密集输入(本项目中文为主)更每键命中昂贵的 string-width 路径。
 *
 * 修:`displayWidth` 是**其字符串实参的纯函数**——按字符串本身 LRU 记忆宽度。相同/增长中的行的重复
 * 测量直接命中缓存。计算逻辑不变(经注入的 `computeFn` 承担),仅在其外包一层缓存。
 *
 * 纯叶子纪律:零 IO、确定性(缓存进程内)、绝不抛;门控关 / 异常 → `computeFn(str)`(逐字节回退)。
 * 有界封顶(默认 2048 条)防长会话累积;超长串(> MAX_KEY_LEN)不缓存(直接算,避免缓存巨串)。
 *
 * 门控 `KHY_DISPLAY_WIDTH_MEMO` 默认开;关 → 每次现算,逐字节等价历史。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env = process.env) {
  const raw = env && env.KHY_DISPLAY_WIDTH_MEMO;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

const MAX_ENTRIES = 2048;
const MAX_KEY_LEN = 4096; // 超长串不入缓存(避免缓存巨串占内存;这类串也很少重复测量)

// str -> width。Map 保序 → LRU:命中/写入时 delete+set 移到最新,超界淘汰最旧。
const _cache = new Map();

/**
 * 取(或首算)字符串的显示宽度(LRU 记忆)。
 * @param {string} str 待测字符串
 * @param {(s:string)=>number} computeFn 现算宽度的函数(承担 stripAnsi + string-width 等)
 * @param {object} [env]
 * @returns {number} 显示宽度
 */
function getDisplayWidth(str, computeFn, env = process.env) {
  try {
    if (!isEnabled(env) || typeof str !== 'string') {
      return computeFn(str);
    }
    // 空串 / 超长串:直接算,不入缓存。
    if (str.length === 0) return computeFn(str);
    if (str.length > MAX_KEY_LEN) return computeFn(str);

    const hit = _cache.get(str);
    if (hit !== undefined) {
      // LRU：移到最新
      _cache.delete(str);
      _cache.set(str, hit);
      return hit;
    }
    const w = computeFn(str);
    // 只缓存有限数值(防把 NaN/非数污染缓存)。
    if (typeof w === 'number' && Number.isFinite(w)) {
      _cache.set(str, w);
      if (_cache.size > MAX_ENTRIES) {
        const oldest = _cache.keys().next().value;
        _cache.delete(oldest);
      }
    }
    return w;
  } catch {
    try { return computeFn(str); } catch { return 0; }
  }
}

// 测试/生命周期钩子:清空缓存(进程内)。
function _clearCache() { _cache.clear(); }
function _size() { return _cache.size; }

module.exports = {
  isEnabled,
  getDisplayWidth,
  _clearCache,
  _size,
  OFF_VALUES,
  MAX_ENTRIES,
  MAX_KEY_LEN,
};
