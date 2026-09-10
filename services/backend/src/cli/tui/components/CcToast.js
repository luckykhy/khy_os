'use strict';

/**
 * CcToast.js —— 瞬态消息组件
 *
 * 设计：
 * - 成功：✓ Message（绿色，3s）
 * - 错误：✗ Message（红色，5s）
 * - 警告：⚠ Message（黄色，4s）
 * - 信息：ℹ Message（蓝色，3s）
 * - 自动消失
 *
 * 参考：[DESIGN-ARCH-087] 微交互与反馈设计
 */

const React = require('react');
const { Text, Box } = require('../inkRuntime').get();
const { CC_COLORS } = require('../theme/ccTheme');
const { TIMING } = require('../utils/ccTimers');

const ICONS = Object.freeze({
  success: '✓',
  error: '✗',
  warning: '⚠',
  info: 'ℹ',
});

const COLORS = Object.freeze({
  success: CC_COLORS.success,
  error: CC_COLORS.error,
  warning: CC_COLORS.warning,
  info: CC_COLORS.info,
});

const DURATIONS = Object.freeze({
  success: TIMING.toast.success,
  error: TIMING.toast.error,
  warning: TIMING.toast.warning,
  info: TIMING.toast.info,
});

/**
 * Toast 瞬态消息
 */
function CcToast({ message, type = 'info', onDismiss }) {
  const duration = DURATIONS[type] || DURATIONS.info;
  const [visible, setVisible] = React.useState(true);

  React.useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false);
      onDismiss?.();
    }, duration);
    return () => clearTimeout(timer);
  }, [duration, onDismiss]);

  if (!visible || !message) return null;

  const icon = ICONS[type] || ICONS.info;
  const color = COLORS[type] || COLORS.info;

  return (
    React.createElement(Box, { marginY: 0 },
      React.createElement(Text, { color }, icon),
      React.createElement(Text, null, ' ' + message),
    )
  );
}

/**
 * Toast 容器（管理多个 Toast）
 */
function CcToastContainer({ toasts = [], onDismiss }) {
  if (!toasts || toasts.length === 0) return null;

  return (
    React.createElement(Box, { flexDirection: 'column' },
      toasts.map((toast, i) => (
        React.createElement(CcToast, {
          key: toast.id || i,
          message: toast.message,
          type: toast.type,
          onDismiss: () => onDismiss?.(toast.id || i),
        })
      ))
    )
  );
}

module.exports = {
  CcToast: React.memo(CcToast),
  CcToastContainer: React.memo(CcToastContainer),
  ICONS,
  COLORS,
  DURATIONS,
};
