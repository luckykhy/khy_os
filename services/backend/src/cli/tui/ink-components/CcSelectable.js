'use strict';

/**
 * CcSelectable.js — CC 模式可选择列表组件
 * 
 * 设计：
 * - 单选：▸ 前缀 + 反显背景
 * - 多选：[x] / [ ] 标记
 * - 键盘导航：↑/↓/Enter/Esc
 * - 鼠标点击支持
 * 
 * 参考：[DESIGN-ARCH-084] CC 模式注意力与选择设计
 */

const React = require('react');
const { Text, Box, useInput } = require('../inkRuntime').get();

// ── 单选列表 ────────────────────────────────────────────────────────────────

function CcSelectableList({
  items,               // [{ key, label, description }]
  selectedIndex = 0,
  onSelect,
  onCancel,
  filterable = false,
  emptyMessage = 'No items',
  indent = 2,
}) {
  const [filter, setFilter] = React.useState('');
  const [cursor, setCursor] = React.useState(selectedIndex);

  const filtered = React.useMemo(() => {
    if (!filter) return items;
    const f = filter.toLowerCase();
    return items.filter(i =>
      i.label.toLowerCase().includes(f) ||
      (i.description && i.description.toLowerCase().includes(f))
    );
  }, [items, filter]);

  // 确保 cursor 在有效范围内
  const safeCursor = Math.min(Math.max(0, cursor), Math.max(0, filtered.length - 1));

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor(c => Math.max(0, c - 1));
    }
    if (key.downArrow) {
      setCursor(c => Math.min(filtered.length - 1, c + 1));
    }
    if (key.return && filtered.length > 0) {
      onSelect?.(filtered[safeCursor], safeCursor);
    }
    if (key.escape) {
      onCancel?.();
    }
    if (filterable) {
      if (input && !key.ctrl && !key.meta) {
        setFilter(f => f + input);
      }
      if (key.backspace) {
        setFilter(f => f.slice(0, -1));
      }
    }
  });

  if (filtered.length === 0) {
    return (
      React.createElement(Box, { flexDirection: 'column', borderStyle: 'single', borderColor: '#374151', padding: 1 },
        React.createElement(Text, { color: '#6B7280' }, emptyMessage),
      )
    );
  }

  return (
    React.createElement(Box, { flexDirection: 'column', borderStyle: 'single', borderColor: '#00D4D4', padding: 1 },
      filterable && filter ? React.createElement(Text, { color: '#6B7280' }, 'Filter: ' + filter) : null,
      filterable && filter ? React.createElement(Box, { height: 1 }) : null,
      ...filtered.map((item, i) => {
        const isSelected = i === safeCursor;
        return React.createElement(Box, { key: item.key || i, marginY: 0 },
          isSelected
            ? React.createElement(Text, { backgroundColor: '#00D4D4', color: '#000000', bold: true },
                '▸ ' + item.label)
            : React.createElement(Text, null, '  ' + item.label),
          item.description && !isSelected
            ? React.createElement(Text, { color: '#6B7280', dimColor: true }, '   ' + item.description)
            : null,
          item.description && isSelected
            ? React.createElement(Text, { color: '#1A1A1A', dimColor: true }, '   ' + item.description)
            : null,
        );
      }),
      React.createElement(Box, { height: 1 }),
      React.createElement(Text, { color: '#6B7280', dimColor: true },
        '↑/↓ navigate  Enter select  Esc cancel'),
    )
  );
}

// ── 多选列表 ────────────────────────────────────────────────────────────────

function CcMultiSelectList({
  items,
  selected = new Set(),
  onToggle,
  onConfirm,
  onCancel,
}) {
  const [cursor, setCursor] = React.useState(0);

  const isSelected = (key) => selected.has(key);

  useInput((input, key) => {
    if (key.upArrow) setCursor(c => Math.max(0, c - 1));
    if (key.downArrow) setCursor(c => Math.min(items.length - 1, c + 1));
    if (input === ' ' && items[cursor]) {
      onToggle?.(items[cursor].key);
    }
    if (key.return) onConfirm?.();
    if (key.escape) onCancel?.();
  });

  return (
    React.createElement(Box, { flexDirection: 'column', borderStyle: 'single', borderColor: '#00D4D4', padding: 1 },
      ...items.map((item, i) => {
        const checked = isSelected(item.key);
        const isCursor = i === cursor;
        return React.createElement(Box, { key: item.key || i },
          isCursor
            ? React.createElement(Text, { backgroundColor: '#00D4D4', color: '#000000' },
                (checked ? '[x] ' : '[ ] ') + item.label)
            : React.createElement(Text, null,
                (checked ? '[x] ' : '[ ] ') + item.label),
        );
      }),
      React.createElement(Box, { height: 1 }),
      React.createElement(Text, { color: '#6B7280', dimColor: true },
        'Space toggle  Enter confirm  Esc cancel'),
    )
  );
}

// ── 权限提示 ────────────────────────────────────────────────────────────────

function CcPermissionPrompt({
  title = 'Do you want to proceed?',
  options = [
    { key: 'yes', label: 'Yes, proceed', safe: true },
    { key: 'no', label: 'No, reject', safe: true },
    { key: 'always', label: 'Always allow', safe: false },
  ],
  onSelect,
  onCancel,
  danger = false,
}) {
  const [cursor, setCursor] = React.useState(options.findIndex(o => o.safe));

  useInput((input, key) => {
    if (key.upArrow) setCursor(c => Math.max(0, c - 1));
    if (key.downArrow) setCursor(c => Math.min(options.length - 1, c + 1));
    if (key.return) onSelect?.(options[cursor].key);
    if (key.escape) onCancel?.();
  });

  const borderColor = danger ? '#F87171' : '#00D4D4';

  return (
    React.createElement(Box, {
      flexDirection: 'column',
      borderStyle: 'single',
      borderColor,
      paddingX: 2,
      paddingY: 1,
    },
      React.createElement(Text, { bold: true, color: danger ? '#F87171' : '#E0E0E0' }, title),
      React.createElement(Box, { height: 1 }),
      ...options.map((opt, i) => {
        const isCursor = i === cursor;
        const isDanger = !opt.safe;
        return React.createElement(Box, { key: opt.key, marginY: 0 },
          isCursor
            ? React.createElement(Text, {
                backgroundColor: isDanger ? '#F87171' : '#00D4D4',
                color: '#000000',
                bold: true,
              }, '❯ ' + opt.label)
            : React.createElement(Text, { color: isDanger ? '#F87171' : '#E0E0E0' }, '  ' + opt.label),
        );
      }),
      React.createElement(Box, { height: 1 }),
      React.createElement(Text, { color: '#6B7280', dimColor: true },
        'Esc to cancel' + (danger ? ' · Tab to amend' : '')),
    )
  );
}

// ── 消息提示 ────────────────────────────────────────────────────────────────

function CcMessageBar({ type = 'info', message, action }) {
  const config = {
    error:   { icon: '❌', borderColor: '#F87171', bgColor: '#3D0F0F', textColor: '#F87171' },
    warning: { icon: '⚠️', borderColor: '#FBBF24', bgColor: '#3D300F', textColor: '#FBBF24' },
    info:    { icon: 'ℹ️', borderColor: '#58A6FF', bgColor: '#0F1A3D', textColor: '#58A6FF' },
    success: { icon: '✅', borderColor: '#4ADE80', bgColor: '#0F3D1A', textColor: '#4ADE80' },
  }[type] || { icon: 'ℹ️', borderColor: '#58A6FF', bgColor: '#0F1A3D', textColor: '#58A6FF' };

  return (
    React.createElement(Box, {
      flexDirection: 'column',
      borderStyle: 'single',
      borderColor: config.borderColor,
      backgroundColor: config.bgColor,
      paddingX: 1,
    },
      React.createElement(Text, { color: config.textColor, bold: true },
        config.icon + ' ' + message),
      action ? React.createElement(Text, { color: '#6B7280', dimColor: true }, action) : null,
    )
  );
}

module.exports = {
  CcSelectableList: React.memo(CcSelectableList),
  CcMultiSelectList: React.memo(CcMultiSelectList),
  CcPermissionPrompt: React.memo(CcPermissionPrompt),
  CcMessageBar: React.memo(CcMessageBar),
};
