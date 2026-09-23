'use strict';

/**
 * Topbar — status-line title (DESIGN-ARCH-102 §10 / P2).
 *
 * The macOS-style traffic-light dots (`● ● ●`) were removed: a terminal has no
 * window chrome to close, so the dots were pure noise. The title now merges
 * into the status line as `Khy · <title>` — the single, calm row the doc wants.
 */

const React = require('react');

const inkRuntime = require('../inkRuntime');

function Topbar({ title = 'khy-os TUI' }) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;

  return h(
    Box,
    {
      height: 1,
      backgroundColor: '#161b22',
      paddingX: 2,
      alignItems: 'center',
      flexShrink: 0,
    },
    h(Text, { bold: true, color: '#58a6ff' }, 'Khy'),
    h(Text, { color: '#8b949e' }, ' · ' + title)
  );
}

module.exports = Topbar;
