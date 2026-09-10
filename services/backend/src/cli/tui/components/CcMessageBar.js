'use strict';

/**
 * CcMessageBar.js —— 错误/警告/信息横幅
 *
 * 设计：
 * - 错误：红色背景 + ✗ + 消息 + 修复建议
 * - 警告：黄色背景 + ⚠ + 消息
 * - 信息：蓝色背景 + ℹ + 消息
 * - 可关闭（× 按钮）
 *
 * 参考：[DESIGN-ARCH-087] 微交互与反馈设计
 */

const React = require('react');
const { Text, Box, useInput } = require('../inkRuntime').get();
const { CC_COLORS } = require('../theme/ccTheme');

const ICONS = Object.freeze({
  error: '✗',
  warning: '⚠',
  info: 'ℹ',
  success: '✓',
});

const COLORS = Object.freeze({
  error: CC_COLORS.error,
  warning: CC_COLORS.warning,
  info: CC_COLORS.info,
  success: CC_COLORS.success,
});

/**
 * 消息横幅
 */
function CcMessageBar({
  type = 'info',
  message,
  suggestion, // 修复建议
  onClose,
  dismissible = true,
}) {
  useInput((input, key) => {
    if (dismissible && (key.escape || input === 'q' || input === 'x')) {
      onClose?.();
    }
  });

  if (!message) return null;

  const icon = ICONS[type] || ICONS.info;
  const color = COLORS[type] || COLORS.info;

  return (
    React.createElement(Box, {
      borderStyle: 'round',
      borderColor: color,
      paddingX: 1,
      marginY: 0,
    },
      React.createElement(Text, { color }, icon),
      React.createElement(Text, null, ' ' + message),
      suggestion
        ? React.createElement(Text, { color: CC_COLORS.dimColor }, ' — ' + suggestion)
        : null,
      dismissible
        ? React.createElement(Text, { color: CC_COLORS.dimColor }, ' [×]')
        : null,
    )
  );
}

/**
 * 错误横幅（带修复建议的快捷方式）
 */
function CcErrorBar({ error, suggestion, onClose }) {
  return React.createElement(CcMessageBar, {
    type: 'error',
    message: error,
    suggestion,
    onClose,
  });
}

module.exports = {
  CcMessageBar: React.memo(CcMessageBar),
  CcErrorBar: React.memo(CcErrorBar),
  ICONS,
  COLORS,
};
