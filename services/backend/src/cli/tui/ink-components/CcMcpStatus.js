'use strict';

/**
 * CcMcpStatus.js —— MCP 状态栏指示器
 *
 * 设计：
 * - 状态图标：• Connected / ◦ Connecting / ✗ Failed / ○ Disabled / ◐ Reconnecting
 * - 颜色：绿色=已连接 / 黄色=连接中 / 红色=失败 / 灰色=禁用
 * - 服务器名称显示
 * - 多服务器紧凑显示
 *
 * 参考：[DESIGN-ARCH-081] MCP 状态显示规范
 */

const React = require('react');
const { Text, Box } = require('../inkRuntime').get();
const { CC_COLORS } = require('../theme/ccTheme');

const STATE_ICONS = Object.freeze({
  connected: '•',
  connecting: '◦',
  failed: '✗',
  disabled: '○',
  reconnecting: '◐',
});

const STATE_COLORS = Object.freeze({
  connected: CC_COLORS.success,
  connecting: CC_COLORS.warning,
  failed: CC_COLORS.error,
  disabled: CC_COLORS.dimColor,
  reconnecting: CC_COLORS.warning,
});

const STATE_LABELS = Object.freeze({
  connected: 'Connected',
  connecting: 'Connecting...',
  failed: 'Failed',
  disabled: 'Disabled',
  reconnecting: 'Reconnecting',
});

/**
 * 单服务器 MCP 状态指示器
 */
function CcMcpServerIndicator({ name, state, compact = false }) {
  const icon = STATE_ICONS[state] || '?';
  const color = STATE_COLORS[state] || CC_COLORS.dimColor;

  if (compact) {
    return React.createElement(Text, { color }, icon + name);
  }

  const label = STATE_LABELS[state] || state;
  return (
    React.createElement(Box, null,
      React.createElement(Text, { color }, icon),
      React.createElement(Text, null, name + ' '),
      React.createElement(Text, { color: CC_COLORS.dimColor }, label),
    )
  );
}

/**
 * MCP 状态栏指示器（多服务器）
 */
function CcMcpStatus({ servers = [], compact = true }) {
  if (!servers || servers.length === 0) return null;

  const connected = servers.filter(s => s.state === 'connected').length;
  const total = servers.length;

  // 紧凑模式：单行显示
  if (compact) {
    return (
      React.createElement(Box, null,
        React.createElement(Text, { color: CC_COLORS.dimColor }, 'MCP '),
        servers.map((s, i) => (
          React.createElement(Text, { key: i },
            i > 0 ? React.createElement(Text, { color: CC_COLORS.dimColor }, ' ') : null,
            React.createElement(CcMcpServerIndicator, { name: s.name, state: s.state, compact: true }),
          )
        )),
      )
    );
  }

  // 展开模式：列表显示
  return (
    React.createElement(Box, { flexDirection: 'column' },
      React.createElement(Box, null,
        React.createElement(Text, { bold: true }, 'MCP Servers'),
        React.createElement(Text, { color: CC_COLORS.dimColor },
          ` (${connected}/${total})`,
        ),
      ),
      React.createElement(Box, { flexDirection: 'column', marginTop: 1 },
        servers.map((s, i) => (
          React.createElement(CcMcpServerIndicator, {
            key: i,
            name: s.name,
            state: s.state,
            compact: false,
          })
        ))
      ),
    )
  );
}

module.exports = {
  CcMcpStatus: React.memo(CcMcpStatus),
  CcMcpServerIndicator: React.memo(CcMcpServerIndicator),
  STATE_ICONS,
  STATE_COLORS,
  STATE_LABELS,
};
