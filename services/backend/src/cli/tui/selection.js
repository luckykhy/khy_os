'use strict';

/**
 * selection — 应用内自绘文本选择的单一真源（纯叶子：零 IO、绝不抛、确定性）。
 *
 * 背景（为什么需要它）：
 *   终端原生拖选在鼠标追踪态下不可用 —— `press` 一进 stdin 就被 ink 读走，
 *   `return false` 物理上回不到终端（见 `[DESIGN-ARCH-119]` §二 缺陷 A）。
 *   参考实现（Claude Code 全屏模式）的做法是**不向终端要选择**，而是自己画：
 *   拖选 → 反色 → 松手即复制。本模块是那个「自己画」的模型层。
 *
 * 关键洞察（让本模块成本极低的原因）：
 *   `_mainContentLines`（App.js:5275）是**扁平字符串数组**，且 `Viewport` 的
 *   lines 模式按 `height` 直接 `slice` 渲染 ⇒ **屏幕行 == 数组下标（1:1）**。
 *   因此行列 ↔ 文本位置的换算不需要任何布局反查。
 *
 * 与 `scrollActions.js` 同范式：纯算术/纯变换 + clamp，绝不触 React、绝不读 env
 * （门控在 App 层读，否则测试无法确定性驱动）。
 *
 * 坐标契约：
 *   - `{line, col}` 均为 **0-based**；`line` 是 `lines` 数组下标（=屏幕行，
 *     调用方负责用 `Viewport.resolveViewportOffset` 把屏幕行换算成下标）；
 *   - 选区是 **半开区间 `[start, end)`** —— `head` 所在列**不含**，与鼠标拖动
 *     直觉一致（拖到第 5 列反色到第 4 列），`extractText` 取 `slice(from, to)`。
 *
 * 已知偏差（诚实边界，见 `[DESIGN-ARCH-119]` §六 不做的事 4）：
 *   `_mainContentLines` 里已含 `buildTranscriptLines` 按列宽折好的**软换行**，
 *   所以视觉行 ≠ 逻辑行。跨软换行复制会在折行处带一个硬 `\n`。
 *   彻底修复需要行投影补 `softWrap` 元数据 —— 另立提案，不在本层范围。
 */

/** 布尔解析用的关闭词（与 `ccClipboard._isOn` 同口径，此处仅作常量占位说明）。 */
const OFF_WORDS = Object.freeze(['0', 'false', 'off', 'no']);

/**
 * 词字符集 —— 双击选词的边界依据。
 *
 * **为什么不是朴素 `\b`**：`\b` 把 `/`、`.`、`:`、`-`、`~` 全视为非词字符，
 * 于是双击一条路径只会选中其中一段（`D:/Portable/khy-os/a.js` → `Portable`）。
 * Claude Code 的文档专门规避了这一点（"matching iTerm2's word boundaries so a
 * file path selects as one unit"），而复制路径是本仓最高频的复制场景。
 *
 * 允许 `-` 与 `+`：命令行开关（`--foo`）与 scope 包名（`@khy/os`）也要整体选中。
 * 不含中文：CJK 无空格分词，按本集会把一段连续中文视为一个「词」，与主流编辑器一致。
 */
const WORD_CHARS = '[A-Za-z0-9_./\\\\:~@+\\-]';
const WORD_RE = new RegExp(WORD_CHARS);

/** 有限整数化，非数/NaN/Infinity → 0（fail-soft，绝不抛）。 */
function _int(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.trunc(n);
}

/** 非负整数化（负 → 0）。 */
function _nat(v) {
  const n = _int(v);
  return n > 0 ? n : 0;
}

/** 把任意值安全地当作字符串数组读；非数组 → 空数组。 */
function _asLines(lines) {
  return Array.isArray(lines) ? lines : [];
}

/** 取某行的文本，非字符串（含 null/undefined/洞）→ 空串。 */
function _lineAt(lines, line) {
  const arr = _asLines(lines);
  const i = _nat(line);
  if (i >= arr.length) {
    return '';
  }
  const v = arr[i];
  return typeof v === 'string' ? v : '';
}

/** 是否是合法的「端点」对象。 */
function _isPoint(p) {
  return !!p && typeof p === 'object' && Number.isFinite(Number(p.line)) && Number.isFinite(Number(p.col));
}

/** 把端点规范化成 0-based 非负整数对。 */
function _point(p) {
  return { line: _nat(p && p.line), col: _nat(p && p.col) };
}

// ── 构造 / 状态转移 ─────────────────────────────────────────────────────────

/**
 * 新建空选区。
 * @returns {{anchor: null, head: null, dragging: boolean}}
 */
function createSelection() {
  return { anchor: null, head: null, dragging: false };
}

/** 清空选区（与 `createSelection()` 等价，语义自解释）。 */
function clearSelection() {
  return createSelection();
}

/**
 * 按下：建立锚点，活动端同起点。
 * @param {object} sel 当前选区（被忽略，保持签名一致性）
 * @param {number} line 0-based 屏幕行（= lines 下标）
 * @param {number} col 0-based 列
 * @returns {object} 新选区
 */
function beginSelection(sel, line, col) {
  const p = _point({ line, col });
  return { anchor: p, head: { line: p.line, col: p.col }, dragging: true };
}

/**
 * 拖动：只改活动端，锚点纹丝不动（这是选区的定义）。
 * 未按下过（anchor 为 null）→ 视为从当前位置开始按下（fail-soft）。
 * @returns {object} 新选区
 */
function extendSelection(sel, line, col) {
  const p = _point({ line, col });
  const anchor = _isPoint(sel && sel.anchor) ? _point(sel.anchor) : p;
  return { anchor, head: p, dragging: true };
}

/**
 * 松手：只把 dragging 置假，两端点位不变。
 * @returns {object} 新选区
 */
function endSelection(sel) {
  if (!sel || typeof sel !== 'object') {
    return createSelection();
  }
  return {
    anchor: _isPoint(sel.anchor) ? _point(sel.anchor) : null,
    head: _isPoint(sel.head) ? _point(sel.head) : null,
    dragging: false,
  };
}

/**
 * 是否有**非空**选区（锚点与活动端不同）。
 *
 * 两个容易漏的判据：
 *   - 同行零宽（`(0,3)→(0,3)`）**不算**有选区 —— 否则「点一下」就会复制空串；
 *   - **跨行零宽**（`(0,0)→(1,0)`）**算**有选区 —— 用户拖到了下一行行首，
 *     列相同但确实跨了一行，必须算选中。
 *
 * @returns {boolean}
 */
function hasSelection(sel) {
  if (!sel || typeof sel !== 'object') {
    return false;
  }
  const a = sel.anchor;
  const h = sel.head;
  if (!_isPoint(a) || !_isPoint(h)) {
    return false;
  }
  const al = _nat(a.line);
  const ac = _nat(a.col);
  const hl = _nat(h.line);
  const hc = _nat(h.col);
  return al !== hl || ac !== hc;
}

/**
 * 有序化选区 → `Range`；无可选内容 → `null`。
 *
 * 调用方**不必判断拖动方向**（反向拖选在此交换）。
 *
 * @returns {{startLine:number, startCol:number, endLine:number, endCol:number}|null}
 */
function normalizeSelection(sel) {
  if (!sel || typeof sel !== 'object') {
    return null;
  }
  const a = sel.anchor;
  const h = sel.head;
  if (!_isPoint(a) || !_isPoint(h)) {
    return null;
  }
  let start = _point(a);
  let end = _point(h);
  // 逐位比较：(行,列) 的字典序
  const reversed = start.line > end.line || (start.line === end.line && start.col > end.col);
  if (reversed) {
    const t = start;
    start = end;
    end = t;
  }
  if (start.line === end.line && start.col === end.col) {
    return null; // 零宽 → 无内容
  }
  return {
    startLine: start.line,
    startCol: start.col,
    endLine: end.line,
    endCol: end.col,
  };
}

// ── 词边界 / 行选区 ─────────────────────────────────────────────────────────

/**
 * 给定一行文本与落点列，求该处「词」的 `[from, to)` 区间。
 *
 * 词字符集见 `WORD_CHARS`（路径友好）。落点不在词字符上（如空白处）→ 返回
 * 该处连续**非词字符**段的区间（可能是空串段，即 `from === to`）。
 *
 * 绝不抛：越界列被 clamp 到 `[0, len]`。
 *
 * @param {string} lineText 行文本
 * @param {number} col 0-based 落点列
 * @returns {{from:number, to:number}}
 */
function wordBoundaryAt(lineText, col) {
  const text = typeof lineText === 'string' ? lineText : '';
  const len = text.length;
  if (len === 0) {
    return { from: 0, to: 0 };
  }
  let i = _nat(col);
  if (i >= len) {
    i = len - 1; // 列越界 → 按最后一个字符处理
  }
  const isWord = (ch) => WORD_RE.test(ch);
  const target = isWord(text[i]);

  // 双向扩展：从 i 出发，向左右吞掉与 text[i] 同性（同属词/同属非词）的字符
  let from = i;
  while (from > 0 && isWord(text[from - 1]) === target) {
    from--;
  }
  let to = i + 1;
  while (to < len && isWord(text[to]) === target) {
    to++;
  }
  // 落点在非词字符上 → 该段可能是空格；这是允许的（见验收标准 S-23）
  return { from, to };
}

/**
 * 双击：选中该处的「词」。
 *
 * 行越界 → 返回空选区（无内容可选，但绝不抛）。
 *
 * @param {string[]} lines
 * @param {number} line
 * @param {number} col
 * @returns {object} 新选区（已松手状态）
 */
function expandToWord(lines, line, col) {
  const arr = _asLines(lines);
  const li = _nat(line);
  if (li >= arr.length) {
    return createSelection();
  }
  const text = _lineAt(arr, li);
  if (text.length === 0) {
    return createSelection();
  }
  const b = wordBoundaryAt(text, col);
  // 零宽词（落点在空段边界）→ 仍返回一个零宽选区，由 hasSelection 判为空
  return {
    anchor: { line: li, col: b.from },
    head: { line: li, col: b.to },
    dragging: false,
  };
}

/**
 * 三击：选中整视觉行（**不含**换行符）。
 *
 * 行越界 → 空选区。
 *
 * @param {string[]} lines
 * @param {number} line
 * @returns {object} 新选区（已松手状态）
 */
function expandToLine(lines, line) {
  const arr = _asLines(lines);
  const li = _nat(line);
  if (li >= arr.length) {
    return createSelection();
  }
  const text = _lineAt(arr, li);
  if (text.length === 0) {
    return createSelection();
  }
  return {
    anchor: { line: li, col: 0 },
    head: { line: li, col: text.length },
    dragging: false,
  };
}

// ── 抽取（选区 → 文本）──────────────────────────────────────────────────────

/**
 * 按选区抽文本。空选区 / 异常输入 → `''`（**绝不**返回 null/undefined）。
 *
 * 半开区间 `[start, end)`：
 *   - 单行 → `line.slice(startCol, endCol)`；
 *   - 跨行 → 首行 `slice(startCol)`，末行 `slice(0, endCol)`，中间行整行，
 *     行间以 `'\n'` 连接；
 *   - **空行必须产出一个 `'\n'`**（不得被 `filter(Boolean)` 跳过）。
 *
 * @param {string[]} lines
 * @param {object} sel
 * @returns {string}
 */
function extractText(lines, sel) {
  const r = normalizeSelection(sel);
  if (!r) {
    return '';
  }
  const arr = _asLines(lines);
  if (arr.length === 0) {
    return '';
  }

  if (r.startLine === r.endLine) {
    const text = _lineAt(arr, r.startLine);
    return text.slice(r.startCol, r.endCol);
  }

  const parts = [];
  // 末行下标可能超出数组（投影变短）→ 按最后一行处理
  const lastIdx = Math.min(r.endLine, arr.length - 1);
  for (let i = r.startLine; i <= lastIdx; i++) {
    const text = _lineAt(arr, i);
    if (i === r.startLine) {
      parts.push(text.slice(r.startCol));
    } else if (i === r.endLine) {
      parts.push(text.slice(0, r.endCol));
    } else {
      parts.push(text);
    }
  }
  return parts.join('\n');
}

/**
 * 供渲染层：该行在选区内需要反色的 `[from, to)` 列区间；不在选区内 → `null`。
 *
 * 零宽（`from === to`）也返回 `null` —— 没有内容可反色，渲染层走原路径。
 *
 * **端点一律是具体列号**（非 `Infinity`）：渲染层可直接 `slice(from, to)`，
 * 不需要自己知道行长度。因此本函数需要 `lines` 来解析「到行尾」这一端。
 *
 * @param {string[]} lines
 * @param {object} sel
 * @param {number} line 0-based 屏幕行（= lines 下标）
 * @returns {{from:number, to:number}|null}
 */
function selectionRangeFor(lines, sel, line) {
  const r = normalizeSelection(sel);
  if (!r) {
    return null;
  }
  const li = _nat(line);
  if (li < r.startLine || li > r.endLine) {
    return null;
  }
  if (li === r.startLine && li === r.endLine) {
    return r.endCol > r.startCol ? { from: r.startCol, to: r.endCol } : null;
  }
  // 区间端点一律**解析成具体列号**（不用 Infinity）：
  // 渲染层直接 `slice(from, to)`，让它自己去查行长度是把契约漏给了调用方，
  // 而且 `slice(3, Infinity)` 虽合法却难断言、难调试。这里一次算清。
  if (li === r.startLine) {
    return { from: r.startCol, to: _lineAt(lines, li).length };
  }
  if (li === r.endLine) {
    return r.endCol > 0 ? { from: 0, to: r.endCol } : null; // 末行 endCol=0 → 无内容
  }
  return { from: 0, to: _lineAt(lines, li).length }; // 中间行整行
}

module.exports = {
  OFF_WORDS,
  WORD_CHARS,
  createSelection,
  clearSelection,
  beginSelection,
  extendSelection,
  endSelection,
  hasSelection,
  normalizeSelection,
  wordBoundaryAt,
  expandToWord,
  expandToLine,
  extractText,
  selectionRangeFor,
};
