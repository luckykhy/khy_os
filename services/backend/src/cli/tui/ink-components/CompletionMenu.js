'use strict';

/**
 * CompletionMenu — inline dropdown for slash-command and @file completion.
 * Visual model follows Claude Code: a bordered list under the prompt, the
 * selected row highlighted, command/description in two columns.
 *
 * Features:
 * - ESC exits cleanly (no residual traces via React unmount)
 * - Standardized format with border, two-column layout
 * - Page navigation with PageUp/PageDown or [/] keys
 */
const React = require('react');

const inkRuntime = require('../inkRuntime');

const MAX_VISIBLE = 10;
const ITEMS_PER_PAGE = MAX_VISIBLE;

function CompletionMenu({ completion, selectedIndex, marginLeft = 0, page = 0 }) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;
  if (!completion || !completion.active || completion.items.length === 0) {
    return null;
  }

  const items = completion.items;
  const total = items.length;
  const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

  // Clamp page to valid range
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));

  // Get items for current page
  const pageStart = currentPage * ITEMS_PER_PAGE;
  const pageEnd = Math.min(total, pageStart + ITEMS_PER_PAGE);
  const visible = items.slice(pageStart, pageEnd);

  const labelWidth = Math.min(
    28,
    visible.reduce((w, it) => Math.max(w, (it.label || '').length), 0)
  );

  const rows = visible.map((it, i) => {
    const idx = pageStart + i;
    const selected = idx === selectedIndex;
    const label = (it.label || '').padEnd(labelWidth);
    return h(
      Box,
      { key: it.value || idx },
      h(
        Text,
        { color: selected ? 'black' : 'cyan', backgroundColor: selected ? 'cyan' : undefined },
        (selected ? '› ' : '  ') + label
      ),
      it.desc ? h(Text, { dimColor: true }, '  ' + it.desc) : null
    );
  });

  // marginLeft(默认 0)让下拉横向对齐输入光标列(Fix 1b,门控 KHY_COMPLETION_FOLLOW_CURSOR
  // 在 App.js 侧判定;关时传 0 → 贴左=逐字节 legacy)。Math.max 防负值兜底。
  return h(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: 'gray',
      paddingX: 1,
      marginLeft: Math.max(0, Number(marginLeft) || 0),
    },
    ...rows,
    h(
      Text,
      { dimColor: true },
      `  ${completion.kind === 'slash' ? '斜杠命令' : '文件'} · ` +
        `${currentPage + 1}/${totalPages} · ` +
        `Tab/Enter 选择 · Esc 取消`
    )
  );
}

module.exports = CompletionMenu;
