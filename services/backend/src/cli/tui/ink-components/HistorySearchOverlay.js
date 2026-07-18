'use strict';

/**
 * HistorySearchOverlay — thin read-only render of the Ctrl+R reverse-incremental
 * history search prompt line. Mirrors bash / Claude Code's
 * `(reverse-i-search)'query': match`.
 *
 * This component holds NO logic: it renders whatever `state` the pure leaf
 * services/keybindings/historyReverseSearch produced (see App.js for the
 * key→leaf dispatch). Fail-soft: a missing / empty state renders nothing.
 */
const React = require('react');
const inkRuntime = require('../inkRuntime');

function HistorySearchOverlay({ state }) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;
  if (!state) return null;

  const query = String(state.query == null ? '' : state.query);
  const current = String(state.current == null ? '' : state.current);
  const noMatch = !current && query !== '';

  // `(reverse-i-search)'query': match` — dim the fixed label, keep the query and
  // matched command legible. A non-empty query with no match shows a hint.
  return h(Box, { flexDirection: 'column' },
    h(Box, null,
      h(Text, { color: noMatch ? 'red' : 'cyan' }, '(reverse-i-search)'),
      h(Text, { dimColor: true }, `'${query}': `),
      h(Text, null, current)
    ),
    h(Text, { dimColor: true },
      noMatch
        ? '  无匹配 · Backspace 改词 · Esc 取消'
        : '  Ctrl+R 上一条 · Enter/Tab 采用 · Esc 取消')
  );
}

module.exports = HistorySearchOverlay;
