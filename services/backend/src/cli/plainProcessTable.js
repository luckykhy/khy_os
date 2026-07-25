'use strict';

/**
 * plainProcessTable — 纯叶子:把 markdown 表格渲染成**无边框、按列对齐的纯文本**。
 *
 * 背景(用户报告「输出过程表格线条太多,复制生成的过程文案太混乱」):模型 narration 里的
 * markdown 表格被 markdownRenderer._formatTableFromData 画成 `╭┬╮ │ ├┼┤ ╰┴╯` 盒线表格,
 * 复制过程文案时这些边框字符与内容混在一起,粘出来一团乱。本叶子提供一个**复制友好**的替代:
 * 列按内容宽度左对齐、以两空格分隔、表头下一行用 `---` 分隔(markdown 源风格)——没有竖线、
 * 没有盒角,且**每行去掉尾随空白**(尾随空格正是复制噪声的一大来源)。
 *
 * 契约(leaf-contract):零 IO、确定性、绝不抛。量宽/格式化/配色等**渲染器相关**能力全部由
 * 调用方注入(displayWidth、inline 格式化、表头着色、dim),故本叶子不依赖 renderTheme/formatters,
 * 保持零依赖可纯测。门控 KHY_PLAIN_PROCESS_TABLE(默认开)由渲染器读取:关 → 渲染器走旧盒线分支
 * 逐字节回退。异常输入 → 返回 null(让调用方回退),绝不抛。
 *
 * @module cli/plainProcessTable
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 门控。优先 flagRegistry(集中优先级),不可用时回退本地 CANON 词表。默认开。
 * @param {object} [env]
 * @returns {boolean}
 */
function plainProcessTableEnabled(env) {
  const e = env || process.env || {};
  try {
    const reg = require('../services/flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_PLAIN_PROCESS_TABLE', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_PLAIN_PROCESS_TABLE;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 把解析好的表格数据渲染成无边框、按列对齐的纯文本行数组。
 *
 * @param {{rows:string[][], colCount:number}} data  _parseTableData 的输出
 * @param {object} [helpers]  渲染器注入的能力(全部可选,缺省退化为恒等/length)
 * @param {(s:string)=>number} [helpers.measure]  显示宽度(CJK 安全);默认 .length
 * @param {(s:string)=>string} [helpers.stripMd]  剥 markdown 标记用于量宽;默认恒等
 * @param {(s:string)=>string} [helpers.format]   对可见文本套 inline 格式;默认恒等
 * @param {(s:string)=>string} [helpers.header]   表头文本着色;默认恒等
 * @param {(s:string)=>string} [helpers.dim]      分隔线着色;默认恒等
 * @param {string} [helpers.indent]  行首缩进;默认 '  '(与盒线表格一致)
 * @returns {string[]|null}  渲染行;数据非法 → null
 */
function renderPlainTable(data, helpers = {}) {
  try {
    if (!data || typeof data !== 'object') return null;
    const rows = Array.isArray(data.rows) ? data.rows : null;
    if (!rows || rows.length === 0) return null;
    const colCount = Number.isInteger(data.colCount) && data.colCount > 0
      ? data.colCount
      : Math.max(...rows.map((r) => (Array.isArray(r) ? r.length : 0)), 0);
    if (colCount <= 0) return null;

    const h = helpers || {};
    const measure = typeof h.measure === 'function' ? h.measure : (s) => String(s == null ? '' : s).length;
    const stripMd = typeof h.stripMd === 'function' ? h.stripMd : (s) => String(s == null ? '' : s);
    const format = typeof h.format === 'function' ? h.format : (s) => String(s == null ? '' : s);
    const header = typeof h.header === 'function' ? h.header : (s) => s;
    const dim = typeof h.dim === 'function' ? h.dim : (s) => s;
    const indent = typeof h.indent === 'string' ? h.indent : '  ';

    const cellText = (row, col) => String((row && row[col] != null) ? row[col] : '');

    // Column widths from stripped (plain) content — left-align, no truncation.
    const widths = new Array(colCount).fill(0);
    for (const row of rows) {
      for (let col = 0; col < colCount; col++) {
        const w = measure(stripMd(cellText(row, col)));
        if (w > widths[col]) widths[col] = w;
      }
    }

    const hasHeader = rows.length > 1;

    // Build one output line: pad each cell to its column width (trailing spaces),
    // join with two spaces, then trim trailing whitespace so copied text is clean.
    const buildLine = (row, isHeader) => {
      const parts = [];
      for (let col = 0; col < colCount; col++) {
        const raw = cellText(row, col);
        const plainW = measure(stripMd(raw));
        const gap = Math.max(0, widths[col] - plainW);
        const visible = isHeader ? header(format(raw)) : format(raw);
        // Last column: no trailing pad (avoids dangling spaces mid-line too — we
        // right-pad all but rely on the final trimEnd to strip the last column's).
        parts.push(visible + ' '.repeat(gap));
      }
      return (indent + parts.join('  ')).replace(/\s+$/, '');
    };

    const out = [];
    out.push(buildLine(rows[0], hasHeader));
    if (hasHeader) {
      // Header underline: dashes sized to each column, joined by two spaces.
      const dashes = widths.map((w) => '-'.repeat(Math.max(3, w)));
      out.push((indent + dim(dashes.join('  '))).replace(/\s+$/, ''));
      for (let r = 1; r < rows.length; r++) out.push(buildLine(rows[r], false));
    }
    return out;
  } catch {
    return null;
  }
}

module.exports = {
  plainProcessTableEnabled,
  renderPlainTable,
};
