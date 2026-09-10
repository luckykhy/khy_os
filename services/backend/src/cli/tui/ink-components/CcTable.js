'use strict';

/**
 * CcTable.js — CC 模式表格组件
 * 
 * 设计：
 * - 表头粗体 + 下划线分隔
 * - 列对齐：文本左对齐，数字右对齐，状态居中
 * - 超长内容截断用 …
 * - 空状态显示友好提示
 * - 响应式列隐藏
 * 
 * 参考：[DESIGN-ARCH-083] CC 模式表格与折叠设计
 */

const React = require('react');
const { Text, Box } = require('../inkRuntime').get();

// ── 工具函数 ────────────────────────────────────────────────────────────────

let _dwidth = null;
function dwidth(s) {
  if (_dwidth === null) {
    try {
      _dwidth = require('../../formatters').displayWidth || false;
    } catch {
      _dwidth = false;
    }
  }
  if (_dwidth) {
    try { return _dwidth(s); } catch { /* fall through */ }
  }
  return String(s == null ? '' : s).length;
}

function padRight(str, width) {
  const w = dwidth(str);
  if (w >= width) return str;
  return str + ' '.repeat(width - w);
}

function padLeft(str, width) {
  const w = dwidth(str);
  if (w >= width) return str;
  return ' '.repeat(width - w) + str;
}

function padCenter(str, width) {
  const w = dwidth(str);
  if (w >= width) return str;
  const left = Math.floor((width - w) / 2);
  const right = width - w - left;
  return ' '.repeat(left) + str + ' '.repeat(right);
}

function truncate(str, max) {
  if (dwidth(str) <= max) return str;
  let s = str;
  while (dwidth(s) + 1 > max && s.length > 0) s = s.slice(0, -1);
  return s + '…';
}

// ── 列宽计算 ────────────────────────────────────────────────────────────────

function calculateColumnWidths(columns, rows, availWidth) {
  // 最小宽度：表头 vs 数据
  const minWidths = columns.map((col, i) => {
    const headerW = dwidth(col.header);
    const dataW = Math.max(0, ...rows.map(row => dwidth(String(row[i] ?? ''))));
    return Math.max(headerW, dataW, col.minWidth || 0);
  });

  const totalW = minWidths.reduce((a, b) => a + b, 0);
  if (totalW <= availWidth) return minWidths;

  // 压缩弹性列
  const flexCols = columns.map((c, i) => c.flex ? i : -1).filter(i => i >= 0);
  const fixedW = minWidths.reduce((sum, w, i) => sum + (columns[i].flex ? 0 : w), 0);
  const flexAvail = availWidth - fixedW;
  const flexTotal = minWidths.reduce((sum, w, i) => sum + (columns[i].flex ? w : 0), 0);

  return minWidths.map((w, i) => {
    if (!columns[i].flex) return w;
    return Math.max(columns[i].minWidth || 3, Math.floor(w * flexAvail / flexTotal));
  });
}

// ── 表格组件 ────────────────────────────────────────────────────────────────

function CcTable({
  columns,           // [{ key, header, align, flex, minWidth, priority }]
  rows,              // [[cell, cell, ...], ...]
  cols = 80,         // 可用宽度
  minCols = 60,      // 最小宽度
  emptyMessage = 'No data',
  emptyAction,
}) {
  // 响应式：根据宽度过滤列
  const visibleCols = cols >= minCols
    ? columns
    : columns.filter(c => c.priority !== 'low');

  const widths = calculateColumnWidths(visibleCols, rows, cols - 4); // 减去边框

  // 空状态
  if (rows.length === 0) {
    return (
      React.createElement(Box, { flexDirection: 'column', borderStyle: 'single', borderColor: '#374151', padding: 1 },
        React.createElement(Text, { color: '#6B7280' }, emptyMessage),
        emptyAction ? React.createElement(Text, { color: '#5769F7' }, emptyAction) : null,
      )
    );
  }

  // 表头
  const headerRow = (
    React.createElement(Box, { key: 'header' },
      visibleCols.map((col, i) => {
        const align = col.align || 'left';
        const cell = align === 'right' ? padLeft(visibleCols[i].header, widths[i])
          : align === 'center' ? padCenter(visibleCols[i].header, widths[i])
          : padRight(visibleCols[i].header, widths[i]);
        return React.createElement(Text, { key: i, bold: true, color: '#A0A0A0' }, cell);
      })
    )
  );

  // 分隔线
  const separator = (
    React.createElement(Box, { key: 'sep' },
      React.createElement(Text, { color: '#374151' }, '─'.repeat(Math.max(2, cols - 4)))
    )
  );

  // 数据行
  const dataRows = rows.map((row, ri) => (
    React.createElement(Box, { key: ri },
      visibleCols.map((col, ci) => {
        const align = col.align || 'left';
        const cell = align === 'right' ? padLeft(String(row[ci] ?? ''), widths[ci])
          : align === 'center' ? padCenter(String(row[ci] ?? ''), widths[ci])
          : padRight(String(row[ci] ?? ''), widths[ci]);
        return React.createElement(Text, { key: ci, color: col.color || '#E0E0E0' }, cell);
      })
    )
  ));

  return (
    React.createElement(Box, { flexDirection: 'column', borderStyle: 'single', borderColor: '#374151' },
      React.createElement(Box, { paddingX: 1 }, headerRow),
      React.createElement(Box, { paddingX: 1 }, separator),
      ...dataRows.map(r => React.createElement(Box, { paddingX: 1 }, r)),
    )
  );
}

// ── 预设表格 ────────────────────────────────────────────────────────────────

/**
 * MCP 服务器列表表格
 */
function CcMcpTable({ servers, cols = 80 }) {
  const columns = [
    { key: 'name', header: '名称', flex: true, minWidth: 12, priority: 'high' },
    { key: 'status', header: '状态', align: 'center', minWidth: 10, priority: 'high' },
    { key: 'type', header: '类型', minWidth: 6, priority: 'medium' },
    { key: 'tools', header: '工具', align: 'right', minWidth: 4, priority: 'low' },
  ];

  const statusIcon = {
    connected: '•',
    connecting: '◦',
    failed: '✗',
    disabled: '○',
    reconnecting: '◐',
  };

  const statusColor = {
    connected: '#4ADE80',
    connecting: '#FBBF24',
    failed: '#F87171',
    disabled: '#6B7280',
    reconnecting: '#FBBF24',
  };

  const rows = servers.map(s => [
    s.name,
    (statusIcon[s.state] || '?') + ' ' + s.state,
    s.type || '—',
    s.tools != null ? String(s.tools) : '—',
  ]);

  // 为每行的状态列添加颜色
  const coloredRows = servers.map((s, i) => {
    const row = rows[i];
    row.color = statusColor[s.state] || '#E0E0E0';
    return row;
  });

  return React.createElement(CcTable, {
    columns,
    rows: coloredRows,
    cols,
    emptyMessage: '没有配置 MCP 服务器',
    emptyAction: '按 /mcp 添加服务器',
  });
}

/**
 * 命令列表表格
 */
function CcCommandsTable({ commands, cols = 80 }) {
  const columns = [
    { key: 'cmd', header: '命令', flex: true, minWidth: 14, priority: 'high' },
    { key: 'alias', header: '别名', minWidth: 6, priority: 'medium' },
    { key: 'desc', header: '功能', flex: true, minWidth: 20, priority: 'high' },
  ];

  const rows = commands.map(c => [
    c.command,
    c.alias || '—',
    c.description,
  ]);

  return React.createElement(CcTable, {
    columns,
    rows,
    cols,
    emptyMessage: '没有可用命令',
  });
}

module.exports = {
  CcTable: React.memo(CcTable),
  CcMcpTable: React.memo(CcMcpTable),
  CcCommandsTable: React.memo(CcCommandsTable),
};
