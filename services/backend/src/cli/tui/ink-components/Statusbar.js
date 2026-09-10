'use strict';

/**
 * Statusbar — bottom status line aligned with preview-home.html #statusbar.
 *
 * Mirrors FooterBar's data sources (model, context, workspace, connection) in a
 * single slim row with the design's dark styling. Replaces FooterBar when the
 * three-column layout is active.
 */

const React = require('react');

const inkRuntime = require('../inkRuntime');

function Statusbar({
  model = '',
  effort = '',
  contextPct = 0,
  contextTokens = 0,
  contextLimit = 0,
  workspace = '',
  connected = false,
  tokenPct = 0,
  generating = false,
}) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;

  const dot = h(
    Text,
    { color: connected ? '#4ea96a' : '#d9635b' },
    '● '
  );

  const modelStr = [model, effort].filter(Boolean).join(' · ') || '未配置';
  const ctxStr = contextLimit
    ? `${contextPct}% ctx`
    : '';
  const wsStr = workspace || process.cwd();
  const tokenStr = `Token ${tokenPct}%`;

  return h(
    Box,
    {
      height: 1,
      backgroundColor: '#20201e',
      paddingX: 1,
      alignItems: 'center',
      flexShrink: 0,
    },
    dot,
    h(Text, { color: '#a8a7a0' }, '后端已连接'),
    h(Text, { dimColor: true }, '  '),
    h(Text, { color: '#d9d9d4' }, modelStr),
    h(Text, { dimColor: true }, '  '),
    h(Text, { color: '#a8a7a0' }, wsStr),
    h(Box, { flexGrow: 1 }),
    h(Text, { color: tokenPct > 80 ? '#d9635b' : '#a8a7a0' }, tokenStr),
    generating ? h(Text, { color: '#c9a24a' }, '  生成中…') : null
  );
}

module.exports = Statusbar;
