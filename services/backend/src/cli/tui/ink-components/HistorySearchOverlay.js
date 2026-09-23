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
  if (!state) {
    return null;
  }

  const query = String(state.query == null ? '' : state.query);
  const current = String(state.current == null ? '' : state.current);
  const noMatch = !current && query !== '';

  // `反向搜索'query': 匹配` —— 2026-09-19 BUG-20: 标签原为英文 bash 惯例
  // `(reverse-i-search)`,与本仓「用户可见文案默认中文」策略(对齐 FooterBar
  // 同款 KHY_UI_LANG 语言感知)不一致;配套提示行本就是中文,故标签一并中文化。
  // 查询词与命中结果的可见性不变:标签 dim? 否——保持彩色锚点,查询/结果可读。
  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Box,
      null,
      h(Text, { color: noMatch ? 'red' : 'cyan' }, '反向搜索'),
      h(Text, { dimColor: true }, `'${query}': `),
      h(Text, null, current)
    ),
    h(
      Text,
      { dimColor: true },
      noMatch
        ? '  无匹配 · Backspace 改词 · Esc 取消'
        : '  Ctrl+R 上一条 · Enter/Tab 采用 · Esc 取消'
    )
  );
}

module.exports = HistorySearchOverlay;
