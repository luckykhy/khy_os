'use strict';

/**
 * ShellView — a peek panel (块4 SUBVIEW) over the CURRENT or most-recent tool
 * call's command and output, opened with ↓ while a turn is executing.
 *
 * It reads from the live streaming state (timeline/tools) — the same data the
 * StreamingBlock tails — so it needs no backend change. As the tool result fills
 * in, the panel reflects it; if the backend later streams incremental tool
 * output, this panel lights up automatically. Bounded height + a scroll offset
 * keep it within the viewport (anti-staircase, consistent with StreamingBlock).
 */
const React = require('react');
const inkRuntime = require('../inkRuntime');

function _toolName(t) {
  return (t && (t.name || t.toolName || t.tool)) || 'tool';
}

// Most-descriptive common arg keys, in preference order. Hoisted to a module
// constant so _argSummary() iterates one shared array instead of rebuilding
// the literal each peek-panel render. Read-only iterand; never mutated.
const _ARG_SUMMARY_KEYS = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description'];

function _argSummary(t) {
  const raw = t && (t.input ?? t.args ?? t.parameters ?? t.arguments);
  if (raw == null) return '';
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return raw; }
  }
  if (typeof obj !== 'object') return String(obj);
  for (const key of _ARG_SUMMARY_KEYS) {
    if (obj[key]) return String(obj[key]);
  }
  return Object.keys(obj).map((k) => `${k}=${typeof obj[k] === 'string' ? obj[k] : JSON.stringify(obj[k])}`).join(', ');
}

function _resultText(t) {
  const r = t && t.result;
  if (!r) return '';
  const text = r.text || r.content || r.output || '';
  return typeof text === 'string' ? text : JSON.stringify(text, null, 2);
}

// Pick the most recent tool from the live state: prefer the last tool entry in
// the ordered timeline, else the last item in the flat tools array.
function _latestTool(streaming) {
  if (!streaming) return null;
  const tl = Array.isArray(streaming.timeline) ? streaming.timeline : null;
  if (tl) {
    for (let i = tl.length - 1; i >= 0; i--) {
      if (tl[i] && tl[i].type === 'tool' && tl[i].tool) return tl[i].tool;
    }
  }
  const tools = Array.isArray(streaming.tools) ? streaming.tools : null;
  if (tools && tools.length) return tools[tools.length - 1];
  return null;
}

function ShellView({ streaming, scroll = 0 }) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;

  const tool = _latestTool(streaming);
  if (!tool) {
    return h(Box, { flexDirection: 'column', marginTop: 1, borderStyle: 'round', borderColor: 'cyan', paddingX: 1 },
      h(Text, { color: 'cyan', bold: true }, '⊟ 实时输出'),
      h(Text, { dimColor: true }, '（暂无正在执行的工具）· ← 返回')
    );
  }

  const done = !!tool.result;
  const isErr = done && (tool.result.isError || tool.result.is_error || tool.result.error);
  const statusIcon = !done ? '◆' : isErr ? '✗' : '✓';
  const statusColor = !done ? 'yellow' : isErr ? 'red' : 'green';

  const out = _resultText(tool);
  const allLines = out ? out.split('\n') : [];

  // Bounded viewport for the body. Leave room for the prompt frame + footer.
  const rows = (process.stdout.rows && process.stdout.rows > 0) ? process.stdout.rows : 24;
  const maxBody = Math.max(4, Math.min(allLines.length, rows - 12));

  // Clamp the scroll offset to the scrollable range.
  const maxScroll = Math.max(0, allLines.length - maxBody);
  const off = Math.max(0, Math.min(scroll, maxScroll));
  const body = allLines.slice(off, off + maxBody);

  const children = [
    h(Box, { key: 'title' },
      h(Text, { color: 'cyan', bold: true }, '⊟ 实时输出  '),
      h(Text, { color: statusColor }, statusIcon + ' '),
      h(Text, { bold: true }, _toolName(tool))
    ),
    h(Text, { key: 'arg', dimColor: true }, '$ ' + _argSummary(tool)),
  ];

  if (allLines.length === 0) {
    children.push(h(Text, { key: 'pending', dimColor: true }, done ? '（无输出）' : '执行中…'));
  } else {
    children.push(h(Box, { key: 'body', flexDirection: 'column', marginTop: 1 },
      ...body.map((ln, i) => h(Text, { key: i }, ln))
    ));
  }

  // Scroll/return affordance.
  const scrollInfo = maxScroll > 0 ? `  ·  ${off + 1}-${off + body.length}/${allLines.length}  (↑↓ 滚动)` : '';
  children.push(h(Text, { key: 'hint', dimColor: true }, `← 返回${scrollInfo}`));

  return h(Box, { flexDirection: 'column', marginTop: 1, borderStyle: 'round', borderColor: 'cyan', paddingX: 1 },
    ...children
  );
}

module.exports = ShellView;
