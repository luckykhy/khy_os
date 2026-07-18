'use strict';

/**
 * rawPasteChunkClassify — 经典 REPL stdin `data` 监听器里「这块 chunk 是否像一次粘贴」的判定核(纯叶子)。
 *
 * 承 keystroke 流畅性同族(输入热路径每键分配消除):
 * [[project_bottom_decoration_write_dedup_keystroke]] · [[project_bottom_decoration_repaint_memo_keystroke]] ·
 * [[project_input_cursor_metrics_memo_keystroke]] · [[project_display_width_memo_keystroke]]。
 *
 * 根因(每键无谓正则分配):`repl.js` 在 `process.stdin.prependListener('data', …)` 里对**每一块** stdin
 * chunk(即每次按键)都执行:
 *   const newlineCount = (raw.match(/[\r\n]/g) || []).length;
 *   if (raw.length >= RAW_PASTE_THRESHOLD && newlineCount >= 2) { …粘贴… }
 * 但粘贴判定同时要求 `raw.length >= RAW_PASTE_THRESHOLD`(默认 40)**且** `newlineCount >= 2`。普通单字
 * 按键的 chunk 长度远小于 40 —— 换行数根本不可能让它被判为粘贴,然而 `.match(/g)` 仍**每键分配一个
 * 匹配数组**(命中则每换行一个字符串条目),纯属浪费。廉价的 `raw.length >= threshold` 前置守卫应先短路,
 * 只有可能成为粘贴的长 chunk 才去数换行。
 *
 * 修:把判定抽成纯函数 `isPasteChunk(raw, threshold)`,先用长度短路;仅当 `raw.length >= threshold` 时才
 * 手动扫描换行计数(手扫 `\r`/`\n` 到达 2 即提前退出,零正则、零数组分配)。行为与历史**逐字节等价**:
 * 同样的 (length>=threshold && newlineCount>=2) 布尔结果,只是不再为短 chunk 付正则分配代价。
 *
 * 纯叶子纪律:零 IO、确定性、绝不抛;门控关 / 坏输入 / 异常 → 回退历史正则实现(逐字节等价)。
 *
 * 门控 `KHY_RAW_PASTE_CHUNK_FASTPATH` 默认开;关 → 走历史正则路径,逐字节等价。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env = process.env) {
  const raw = env && env.KHY_RAW_PASTE_CHUNK_FASTPATH;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

/**
 * 历史正则实现:数出 raw 中的 \r/\n 总数。作为门控关 / 异常时的逐字节回退基准。
 * @param {string} raw
 * @returns {number}
 */
function _countNewlinesRegex(raw) {
  return (String(raw == null ? '' : raw).match(/[\r\n]/g) || []).length;
}

/**
 * 手扫换行计数,数到 `cap` 即提前退出(默认 2,判定只关心是否 >=2)。零正则、零数组分配。
 * @param {string} raw
 * @param {number} [cap]
 * @returns {number} min(实际换行数, cap)
 */
function _countNewlinesUpTo(raw, cap = 2) {
  let n = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charCodeAt(i);
    if (ch === 10 /* \n */ || ch === 13 /* \r */) {
      n++;
      if (n >= cap) return n;
    }
  }
  return n;
}

/**
 * 判定一块 stdin chunk 是否符合「原始粘贴」形状:长度达阈值 **且** 含 >=2 个换行。
 *
 * 与历史 `raw.length >= threshold && (raw.match(/[\r\n]/g)||[]).length >= 2` **逐字节等价**,
 * 但对普通短按键先用长度短路,免去每键正则/数组分配。
 *
 * @param {string} raw     stdin chunk(已转 utf8 字符串)
 * @param {number} threshold RAW_PASTE_THRESHOLD(触发粘贴的最小长度)
 * @param {object} [env]
 * @returns {boolean}
 */
function isPasteChunk(raw, threshold, env = process.env) {
  try {
    const s = typeof raw === 'string' ? raw : String(raw == null ? '' : raw);
    const th = Number.isFinite(threshold) ? threshold : 40;

    if (!isEnabled(env)) {
      // 门控关 → 历史正则路径,逐字节等价。
      return s.length >= th && _countNewlinesRegex(s) >= 2;
    }

    // 快路径:短于阈值的 chunk 绝不可能是粘贴 → 免正则短路。
    if (s.length < th) return false;
    // 仅长 chunk 才数换行(手扫,数到 2 即停)。
    return _countNewlinesUpTo(s, 2) >= 2;
  } catch {
    // 异常 → 保守回退历史正则实现,绝不抛。
    try {
      const s = typeof raw === 'string' ? raw : String(raw == null ? '' : raw);
      const th = Number.isFinite(threshold) ? threshold : 40;
      return s.length >= th && _countNewlinesRegex(s) >= 2;
    } catch {
      return false;
    }
  }
}

module.exports = {
  isEnabled,
  isPasteChunk,
  _countNewlinesRegex,
  _countNewlinesUpTo,
  OFF_VALUES,
};
