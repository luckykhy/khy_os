'use strict';

/**
 * CcPermissionPrompt.js —— CC 风格权限提示
 *
 * 设计：
 * - "Do you want to proceed?" 标题
 * - 选项列表（▸ 选中指示器 + 反显背景）
 * - 默认聚焦安全选项
 * - 危险操作红色标记
 * - 底部操作提示：Esc to cancel · Tab to amend
 *
 * 参考：[DESIGN-ARCH-081] Phase 4: 输入框与交互
 */

const React = require('react');
const { Text, Box, useInput } = require('../inkRuntime').get();
const { CC_COLORS } = require('../theme/ccTheme');

/**
 * CC 风格权限提示
 */
function CcPermissionPrompt({
  question = 'Do you want to proceed?',
  options = [
    { label: 'Yes, proceed', value: 'yes', safe: true },
    { label: 'No, reject', value: 'no', safe: true },
  ],
  defaultIndex = 0,
  onSelect,
  onCancel,
  dangerIndex = -1, // 危险选项的索引（红色标记）
}) {
  const [selectedIndex, setSelectedIndex] = React.useState(defaultIndex);

  useInput((input, key) => {
    if (key.upArrow) {
      setSelectedIndex(i => (i > 0 ? i - 1 : options.length - 1));
    }
    if (key.downArrow) {
      setSelectedIndex(i => (i < options.length - 1 ? i + 1 : 0));
    }
    if (key.return) {
      const opt = options[selectedIndex];
      onSelect?.(opt.value, opt);
    }
    if (key.escape) {
      onCancel?.();
    }
  });

  return (
    React.createElement(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: CC_COLORS.border, paddingX: 1 },
      // 标题
      React.createElement(Text, { bold: true, color: CC_COLORS.brand }, question),

      // 选项列表
      React.createElement(Box, { flexDirection: 'column', marginTop: 1 },
        options.map((opt, i) => {
          const isSelected = i === selectedIndex;
          const isDanger = i === dangerIndex;
          const color = isDanger
            ? CC_COLORS.error
            : isSelected
              ? undefined
              : CC_COLORS.textSecondary;

          return (
            React.createElement(Box, { key: i, marginY: 0 },
              React.createElement(Text, {
                color: isSelected ? CC_COLORS.brand : CC_COLORS.textSecondary,
                dimColor: !isSelected,
              }, isSelected ? '▸ ' : '  '),
              React.createElement(Text, { color, bold: isSelected }, opt.label),
            )
          );
        })
      ),

      // 底部操作提示
      React.createElement(Box, { marginTop: 1 },
        React.createElement(Text, { color: CC_COLORS.dimColor },
          'Esc to cancel · Tab to amend',
        )
      ),
    )
  );
}

module.exports = { CcPermissionPrompt: React.memo(CcPermissionPrompt) };
