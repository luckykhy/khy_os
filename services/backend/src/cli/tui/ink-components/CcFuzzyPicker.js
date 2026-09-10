'use strict';

/**
 * CcFuzzyPicker.js —— CC 风格模糊搜索选择器
 *
 * 设计：
 * - 顶部搜索输入框
 * - 模糊匹配排序
 * - 选中项高亮（▸ + 反显）
 * - 键盘导航（↑/↓/Enter/Esc）
 * - 实时过滤
 *
 * 参考：[DESIGN-ARCH-081] Phase 5: 补全菜单与覆盖层
 */

const React = require('react');
const { Text, Box, useInput } = require('../inkRuntime').get();
const { CC_COLORS } = require('../theme/ccTheme');

/**
 * 简单模糊匹配评分
 */
function fuzzyScore(query, text) {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  // 完全匹配
  if (t === q) return 100;
  // 前缀匹配
  if (t.startsWith(q)) return 80;
  // 包含匹配
  if (t.includes(q)) return 60;

  // 字符顺序匹配
  let qi = 0;
  let ti = 0;
  let matches = 0;
  while (qi < q.length && ti < t.length) {
    if (q[qi] === t[ti]) {
      matches++;
      qi++;
    }
    ti++;
  }
  if (matches === q.length) return 40;

  return 0; // 不匹配
}

/**
 * CC 风格模糊搜索选择器
 */
function CcFuzzyPicker({
  items = [],           // [{ label, value, description }]
  placeholder = 'Search...',
  onSelect,
  onClose,
  maxHeight = 15,
  maxWidth = 80,
}) {
  const [query, setQuery] = React.useState('');
  const [selectedIndex, setSelectedIndex] = React.useState(0);

  // 过滤 + 排序
  const filtered = React.useMemo(() => {
    if (!query) return items;
    return items
      .map(item => ({
        ...item,
        _score: fuzzyScore(query, item.label + ' ' + (item.description || '')),
      }))
      .filter(item => item._score > 0)
      .sort((a, b) => b._score - a._score);
  }, [query, items]);

  // 确保选中索引有效
  const safeIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1));

  useInput((input, key) => {
    if (key.upArrow) {
      setSelectedIndex(i => (i > 0 ? i - 1 : filtered.length - 1));
    }
    if (key.downArrow) {
      setSelectedIndex(i => (i < filtered.length - 1 ? i + 1 : 0));
    }
    if (key.return) {
      const item = filtered[safeIndex];
      if (item) onSelect?.(item);
    }
    if (key.escape) {
      onClose?.();
    }
    if (key.backspace || key.delete) {
      setQuery(q => q.slice(0, -1));
    }
    if (input && !key.ctrl && !key.meta && !key.return) {
      setQuery(q => q + input);
    }
  });

  // 可见区域计算
  const visibleItems = filtered.slice(0, maxHeight);

  return (
    React.createElement(Box, {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: CC_COLORS.border,
      paddingX: 1,
      width: maxWidth,
    },
      // 搜索输入
      React.createElement(Box, null,
        React.createElement(Text, { color: CC_COLORS.brand }, '> '),
        React.createElement(Text, null, query || placeholder),
        React.createElement(Text, { color: CC_COLORS.dimColor, bold: true }, '│'),
      ),

      // 分隔线
      React.createElement(Text, { color: CC_COLORS.border }, '─'.repeat(maxWidth - 4)),

      // 列表
      React.createElement(Box, { flexDirection: 'column' },
        visibleItems.length === 0
          ? React.createElement(Box, { paddingY: 1 },
              React.createElement(Text, { color: CC_COLORS.dimColor }, '  No matches'),
            )
          : visibleItems.map((item, i) => {
              const isSelected = i === safeIndex;
              return (
                React.createElement(Box, { key: i, marginY: 0 },
                  React.createElement(Text, {
                    color: isSelected ? CC_COLORS.brand : CC_COLORS.textSecondary,
                    dimColor: !isSelected,
                  }, isSelected ? '▸ ' : '  '),
                  React.createElement(Text, {
                    color: isSelected ? undefined : CC_COLORS.textSecondary,
                    bold: isSelected,
                  }, item.label),
                  item.description
                    ? React.createElement(Text, { color: CC_COLORS.dimColor },
                        '  ' + item.description)
                    : null,
                )
              );
            })
      ),

      // 底部提示
      React.createElement(Text, { color: CC_COLORS.border }, '─'.repeat(maxWidth - 4)),
      React.createElement(Text, { color: CC_COLORS.dimColor },
        '  ↑↓ navigate · Enter select · Esc cancel',
      ),
    )
  );
}

module.exports = { CcFuzzyPicker: React.memo(CcFuzzyPicker), fuzzyScore };
