'use strict';

/**
 * RightPanel — tabbed right-hand panel aligned with preview-home.html #rightbar.
 *
 * Tabs: 计划 (plan) / 任务 (tasks) / 终端 (terminal) / 文件 (files).
 * Each tab renders scrollable content within a bounded viewport. Tab switching
 * is via click (mouse) or arrow keys; content scrolling is via ↑/↓/PageUp/PageDown.
 *
 * The scroll offset per tab is held in a ref (not state) to avoid re-render
 * storms; the nowTick heartbeat repaints. Keyboard handlers live in App and
 * call into the scrollActions leaf via props.
 */

const React = require('react');

const inkRuntime = require('../inkRuntime');

// Tab descriptor single source — label, key, and default height hint.
const TABS = [
  { key: 'plan', label: '计划', badge: false },
  { key: 'tasks', label: '任务', badge: false },
  { key: 'terminal', label: '终端', badge: false },
  { key: 'files', label: '文件', badge: false },
];

// Design-aligned colors.
const COLOR_TAB_ACTIVE = '#6a92d8';
const COLOR_TAB_INACTIVE = '#a8a7a0';
const COLOR_BG = '#20201e';
const COLOR_BORDER = '#34332f';

function RightPanel({
  activeTab = 'plan',
  onTabChange = () => {},
  focused = false,
  // Content props per tab:
  plan = null, // { steps: [{description, status}], progress: 0-100 }
  taskLines = [], // array of { text, status }
  terminalOutput = '', // string
  terminalPrompt = '$',
  files = [], // array of { name, isChildren, depth }
  viewportHeight = 10,
  scrollOffset = 0,
  onScroll = () => {},
}) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;

  // Build the visible content lines based on active tab.
  const allLines = computeContentLines(activeTab, {
    plan,
    taskLines,
    terminalOutput,
    terminalPrompt,
    files,
  });
  const maxScroll = Math.max(0, allLines.length - viewportHeight);
  const off = Math.max(0, Math.min(Number(scrollOffset) || 0, maxScroll));
  const visible = allLines.slice(off, off + viewportHeight);

  return h(
    Box,
    {
      flexDirection: 'column',
      width: 30,
      height: '100%',
      backgroundColor: COLOR_BG,
      borderStyle: 'round',
      borderColor: focused ? COLOR_TAB_ACTIVE : COLOR_BORDER,
      flexShrink: 0,
    },
    // Tab strip
    h(
      Box,
      { flexShrink: 0 },
      ...TABS.map((t) => {
        const active = t.key === activeTab;
        return h(
          Box,
          {
            key: t.key,
            paddingX: 1,
            onClick: () => onTabChange(t.key),
            onMouseUp: () => onTabChange(t.key),
          },
          h(
            Text,
            {
              color: active ? COLOR_TAB_ACTIVE : COLOR_TAB_INACTIVE,
              bold: active,
              underline: active,
            },
            t.label
          )
        );
      })
    ),
    // Content area (scrollable)
    h(
      Box,
      { flexDirection: 'column', flexGrow: 1, paddingX: 1 },
      visible.length === 0
        ? h(Text, { dimColor: true, color: '#85847d' }, '（无内容）')
        : visible.map((ln, i) =>
            h(
              Text,
              {
                key: `ln-${i}`,
                color: ln.color,
                dimColor: ln.dim,
                bold: ln.bold,
              },
              ln.text
            )
          )
    ),
    // Scroll indicator (only when scrollable; shows clamped position).
    maxScroll > 0
      ? h(
          Text,
          { dimColor: true, color: '#85847d' },
          `  ↑↓ ${off + 1}-${off + visible.length}/${allLines.length}`
        )
      : null
  );
}

/**
 * Pure: compute the full (un-windowed) line list for a tab. Never throws.
 */
function computeContentLines(tab, data) {
  const lines = [];
  switch (tab) {
    case 'plan': {
      const plan = data.plan;
      if (plan && Array.isArray(plan.steps)) {
        const pct = plan.progress != null ? plan.progress : 0;
        lines.push({ text: `计划进度`, bold: true, color: '#d9d9d4' });
        lines.push({ text: `${'█'.repeat(Math.round(pct / 10))}${'░'.repeat(10 - Math.round(pct / 10))} ${pct}%`, color: '#6a92d8' });
        plan.steps.forEach((s, i) => {
          const mark = s.status === 'done' ? '✓' : s.status === 'in_progress' ? '⟳' : s.status === 'skipped' ? '⊘' : '○';
          const color = s.status === 'done' ? '#4ea96a' : s.status === 'in_progress' ? '#6a9d28' : '#a8a7a0';
          lines.push({ text: `  ${mark} ${s.description}`, color, dim: s.status === 'skipped' });
        });
      } else {
        lines.push({ text: '暂无计划', dim: true, color: '#85847d' });
      }
      break;
    }
    case 'tasks': {
      if (data.taskLines.length === 0) {
        lines.push({ text: '暂无任务', dim: true, color: '#85847d' });
      } else {
        data.taskLines.forEach((t) => {
          lines.push({ text: t.text, color: t.color || '#d9d9d4', dim: t.dim });
        });
      }
      break;
    }
    case 'terminal': {
      const out = data.terminalOutput || '';
      if (!out) {
        lines.push({ text: '（终端空闲）', dim: true, color: '#85847d' });
      } else {
        out.split('\n').forEach((l) => lines.push({ text: l || ' ', color: '#a8a7a0' }));
      }
      lines.push({ text: `${data.terminalPrompt || '$'} _`, color: '#4ea96a', bold: true });
      break;
    }
    case 'files': {
      if (data.files.length === 0) {
        lines.push({ text: '项目文件', bold: true, color: '#d9d9d4' });
        lines.push({ text: '  （空目录）', dim: true, color: '#85847d' });
      } else {
        data.files.forEach((f) => {
          const icon = f.isDirectory ? '[+]' : ' - ';
          lines.push({ text: `${'  '.repeat(f.depth || 0)}${icon} ${f.name}`, color: '#a8a7a0' });
        });
      }
      break;
    }
    default:
      break;
  }
  return lines;
}

module.exports = RightPanel;
module.exports.TABS = TABS;
module.exports.computeContentLines = computeContentLines;
