'use strict';

/**
 * CompletionMenu — inline dropdown for slash-command and @file completion.
 * Visual model follows Claude Code: a bordered list under the prompt, the
 * selected row highlighted, command/description in two columns.
 */
const React = require('react');
const inkRuntime = require('../inkRuntime');

const MAX_VISIBLE = 10;

function CompletionMenu({ completion, selectedIndex, marginLeft = 0 }) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;
  if (!completion || !completion.active || completion.items.length === 0) return null;

  const items = completion.items;
  const total = items.length;

  // Scroll window so the selected row stays visible.
  let start = 0;
  if (total > MAX_VISIBLE) {
    start = Math.min(Math.max(0, selectedIndex - Math.floor(MAX_VISIBLE / 2)), total - MAX_VISIBLE);
  }
  const visible = items.slice(start, start + MAX_VISIBLE);

  const labelWidth = Math.min(
    28,
    visible.reduce((w, it) => Math.max(w, (it.label || '').length), 0)
  );

  const rows = visible.map((it, i) => {
    const idx = start + i;
    const selected = idx === selectedIndex;
    const label = (it.label || '').padEnd(labelWidth);
    return h(Box, { key: it.value || idx },
      h(Text, { color: selected ? 'black' : 'cyan', backgroundColor: selected ? 'cyan' : undefined },
        (selected ? '› ' : '  ') + label),
      it.desc ? h(Text, { dimColor: true }, '  ' + it.desc) : null
    );
  });

  const moreAbove = start > 0;
  const moreBelow = start + MAX_VISIBLE < total;

  // marginLeft(默认 0)让下拉横向对齐输入光标列(Fix 1b,门控 KHY_COMPLETION_FOLLOW_CURSOR
  // 在 App.js 侧判定;关时传 0 → 贴左=逐字节 legacy)。Math.max 防负值兜底。
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1,
                  marginLeft: Math.max(0, Number(marginLeft) || 0) },
    moreAbove ? h(Text, { dimColor: true }, `  ↑ 还有 ${start} 项`) : null,
    ...rows,
    moreBelow ? h(Text, { dimColor: true }, `  ↓ 还有 ${total - start - MAX_VISIBLE} 项`) : null,
    h(Text, { dimColor: true }, `  ${completion.kind === 'slash' ? '斜杠命令' : '文件'} · Tab/Enter 选择 · Esc 取消`)
  );
}

module.exports = CompletionMenu;
