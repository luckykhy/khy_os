'use strict';

/**
 * Topbar — title bar aligned with layout-preview.html .title-bar.
 *
 * Traffic-light dots (red/yellow/green) + title text. No buttons — matches the
 * preview exactly. Background #161b22, border-bottom #30363d.
 */

const React = require('react');

const inkRuntime = require('../inkRuntime');

function Topbar({ title = 'khy-os TUI' }) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;

  const dot = (color) =>
    h(Box, { width: 2, height: 1, marginRight: 1, backgroundColor: color });

  return h(
    Box,
    {
      height: 1,
      backgroundColor: '#161b22',
      paddingX: 2,
      alignItems: 'center',
      flexShrink: 0,
    },
    h(Text, { color: '#ff5f57' }, '●'),
    h(Text, { color: '#febc2e' }, ' ●'),
    h(Text, { color: '#28c840' }, ' ●'),
    h(Text, { color: '#8b949e' }, '  ' + title)
  );
}

module.exports = Topbar;
