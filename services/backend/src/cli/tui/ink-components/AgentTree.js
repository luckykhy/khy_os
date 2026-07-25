'use strict';

/**
 * AgentTree — ink renderer for a parallel sub-agent fan-out, Claude-Code style:
 *
 *   ● Running 2 agents…  (Ctrl+O 展开)
 *     ├ 基本面分析师 · 5 tool uses · 2.1s
 *     │ └ Reading server.js
 *     └ 风控经理 · Done
 *
 * It owns NO layout logic of its own: the branch glyphs (├│└), the header
 * wording and the stats are all derived from cli/agentTreeView — the SINGLE
 * source shared with the classic REPL renderer (cli/agentRenderer) — so a
 * fan-out reads identically in both front-ends. This module only maps the
 * semantic rows onto ink Box/Text + colours.
 *
 * Folding mirrors ToolLines' Ctrl+O contract: a committed (non-live) tree shows
 * ONLY the header with a truthful "(Ctrl+O 展开)" hint; `live` (still running)
 * or `expanded` (Ctrl+O pressed) reveals the full tree.
 */
const React = require('react');
const inkRuntime = require('../inkRuntime');
const { buildAgentHeader, buildAgentTreeRows, STATUS } = require('../../agentTreeView');

// Agent status → ink colour props for the name cell. Mirrors agentRenderer's
// nameColorFor (green done / red error / bold-white running / dim pending) so
// the two front-ends colour a branch the same way.
function nameProps(status) {
  switch (status) {
    case STATUS.COMPLETED: return { color: 'green' };
    case STATUS.ERROR: return { color: 'red' };
    case STATUS.RUNNING: return { bold: true };
    default: return { dimColor: true };
  }
}

function AgentTree({ agents = [], expanded = false, live = false }) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;
  const list = Array.isArray(agents) ? agents : [];
  if (list.length === 0) return null;

  const header = buildAgentHeader(list);
  const headIcon = header.allDone ? '✓' : header.dot;
  const headColor = header.allDone ? 'green' : 'yellow';

  const children = [
    h(Box, { key: 'head' },
      h(Text, { color: headColor }, headIcon + ' '),
      h(Text, { bold: true, color: header.allDone ? 'green' : undefined }, header.label),
      // Honest fold hint: only when the full tree is hidden (committed + collapsed).
      (!live && !expanded) ? h(Text, { dimColor: true }, '  (Ctrl+O 展开)') : null),
  ];

  if (live || expanded) {
    const rows = buildAgentTreeRows(list);
    rows.forEach((row, idx) => {
      if (row.kind === 'agent') {
        const statsStr = row.stats.length > 0 ? ` · ${row.stats.join(' · ')}` : '';
        children.push(
          h(Box, { key: `row-${idx}`, marginLeft: 2 },
            h(Text, { dimColor: true }, row.branch + ' '),
            h(Text, nameProps(row.status), row.name),
            statsStr ? h(Text, { dimColor: true }, statsStr) : null));
      } else if (row.kind === 'preview') { // 目录树 sub-line ("│   ├ src/")
        children.push(
          h(Box, { key: `row-${idx}`, marginLeft: 2 },
            h(Text, { dimColor: true }, `${row.cont}   ${row.text}`)));
      } else { // detail sub-line under the branch ("│ └ Reading server.js" / "└ Done")
        children.push(
          h(Box, { key: `row-${idx}`, marginLeft: 2 },
            h(Text, { dimColor: true }, `${row.cont} └ ${row.text}`)));
      }
    });
  }

  return h(Box, { flexDirection: 'column' }, ...children.filter(Boolean));
}

module.exports = AgentTree;
