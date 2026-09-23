'use strict';

/**
 * RightPanel — kanban (DESIGN-ARCH-102 §4.7 / P2).
 *
 * Two fixed sections instead of four always-resident tabs:
 *   • 任务 — plan steps + task lines (the default landing section)
 *   • 上下文 — model / context / permission / bridge status
 * The old `终端` / `文件` tabs were "occasional reference" content that occupied
 * 2/4 of the kanban at near-zero usage; they sink to `/terminal` and `/files`
 * overlays (on-demand, they never own the right column). Completed task groups
 * fold to a clickable `✓ N 已完成` count; in-progress items show elapsed time
 * (102 §4.7 / P1 click-to-expand via foldModel).
 *
 * Fixed top anchor + independent scroll (the rail's bottom-anchor + topOffset
 * float is gone — that constraint only existed to dodge the live-region limit,
 * which no longer applies once the rail retired as the default backend).
 */

const React = require('react');

const inkRuntime = require('../inkRuntime');

// 2 段 (was 4 tabs). 终端/文件 → /terminal /files 覆盖层,不再常驻。
const SECTIONS = [
  { key: 'tasks', label: '任务', badge: false },
  { key: 'context', label: '上下文', badge: false },
];

// Back-compat alias: consumers (ThreeColumnLayout) still say "tab".
const TABS = SECTIONS;

// Design-aligned colors.
const COLOR_TAB_ACTIVE = '#6a92d8';
const COLOR_TAB_INACTIVE = '#a8a7a0';
const COLOR_BG = '#20201e';
const COLOR_BORDER = '#34332f';

function RightPanel({
  activeTab = 'tasks',
  onTabChange = () => {},
  focused = false,
  // Content props per section:
  plan = null, // { steps: [{description, status}], progress: 0-100 }
  taskLines = [], // array of { text, status, duration, color, dim }
  context = null, // { model, contextPct, permission, bridgeConnected }
  viewportHeight = 10,
  scrollOffset = 0,
  onScroll = () => {},
  onToggleSection = () => {},
  expanded = {}, // { tasks: boolean, context: boolean }
}) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;
  const active = SECTIONS.some((s) => s.key === activeTab) ? activeTab : 'tasks';

  const allLines = computeContentLines(active, { plan, taskLines, context, expanded });
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
    // 2 段 tab strip (点击切段;段内可点击展开/收起走 onToggleSection)
    h(
      Box,
      { flexShrink: 0 },
      ...SECTIONS.map((s) => {
        const isActive = s.key === active;
        return h(
          Box,
          {
            key: s.key,
            paddingX: 1,
            onClick: () => onTabChange(s.key),
            onMouseUp: () => onTabChange(s.key),
          },
          h(
            Text,
            {
              color: isActive ? COLOR_TAB_ACTIVE : COLOR_TAB_INACTIVE,
              bold: isActive,
              underline: isActive,
            },
            s.label
          )
        );
      })
    ),
    // Content area (independent scroll)
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
                // 可点击展开的折叠行(已完成任务组 / 段标题):
                onClick: ln.foldable ? () => onToggleSection(active, ln.key) : undefined,
                onMouseUp: ln.foldable ? () => onToggleSection(active, ln.key) : undefined,
              },
              ln.text
            )
          )
    ),
    // Scroll indicator (only when scrollable).
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
 * 10 段迷你进度条。pct 来自外部数据（plan.progress / context.contextPct），
 * 可能 <0 或 >100；不钳制会让 repeat() 收到负数抛 RangeError，违反本文件
 * computeContentLines「Never throws」的契约。非有限值一律按 0 处理。
 */
function miniBar(pct) {
  const p = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  const filled = Math.round(p / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

/**
 * Pure: compute the full (un-windowed) line list for a section. Never throws.
 */
function computeContentLines(tab, data) {
  const lines = [];
  const expanded = data.expanded || {};
  switch (tab) {
    case 'tasks':
    case 'plan': {
      // ── 任务段 = 计划步骤 + 任务清单 ──
      const plan = data.plan;
      if (plan && Array.isArray(plan.steps) && plan.steps.length) {
        lines.push({ text: '计划', bold: true, color: '#d9d9d4' });
        const pct = plan.progress != null ? plan.progress : 0;
        lines.push({
          text: `${miniBar(pct)} ${pct}%`,
          color: '#6a92d8',
        });
        plan.steps.forEach((s) => {
          const mark =
            s.status === 'done' ? '✓' : s.status === 'in_progress' ? '⟳' : s.status === 'skipped' ? '⊘' : '○';
          const color = s.status === 'done' ? '#4ea96a' : s.status === 'in_progress' ? '#6a9d28' : '#a8a7a0';
          const dur = s.duration ? `  ${s.duration}` : '';
          lines.push({ text: `  ${mark} ${s.description}${dur}`, color, dim: s.status === 'skipped' });
        });
      }

      // 已完成任务组:默认折叠为 `✓ N 已完成(点击展开)`;展开后逐条列出。
      const completed = (data.taskLines || []).filter((t) => t.status === 'completed' || t.status === 'done');
      const open = expanded.tasks;
      if (completed.length) {
        if (!open) {
          lines.push({
            text: `✓ ${completed.length} 已完成（点击展开）`,
            color: '#4ea96a',
            foldable: true,
            key: 'completed',
          });
        } else {
          completed.forEach((t) => lines.push({ text: `✓ ${t.text}`, color: '#4ea96a', dim: true }));
        }
      }
      // in_progress / error / pending:逐条显示,in_progress 带耗时(102 §4.7)。
      (data.taskLines || []).forEach((t) => {
        if (t.status === 'completed' || t.status === 'done') {
          return; // 已在折叠组内
        }
        const mark =
          t.status === 'in_progress' ? '→' : t.status === 'error' ? '✗' : t.status === 'pending' ? '○' : '·';
        const dur = t.duration ? `  ${t.duration}` : '';
        const reason = t.status === 'error' && t.reason ? ` ${t.reason}` : '';
        lines.push({
          text: `${mark} ${t.text}${dur}${reason}`,
          color: t.color || (t.status === 'error' ? '#EF4444' : t.status === 'in_progress' ? '#6a9d28' : '#d9d9d4'),
          dim: t.dim,
        });
      });
      if (!plan && !(data.taskLines || []).length) {
        lines.push({ text: '暂无任务', dim: true, color: '#85847d' });
      }
      break;
    }
    case 'context':
    case 'terminal':
    case 'files': {
      // 上下文段(102 §4.7 示意):模型 / 上下文 / 权限 / 桥接。
      // 终端/文件 不再是常驻段——若显式传入,保留旧渲染(向后兼容)。
      const c = data.context;
      if (c) {
        lines.push({ text: '模型', color: '#d9d9d4' });
        lines.push({ text: `  ${c.model || '—'}`, color: '#a8a7a0' });
        const pct = c.contextPct != null ? c.contextPct : 0;
        lines.push({
          text: `上下文 ${miniBar(pct)} ${pct}%`,
          color: pct >= 95 ? '#EF4444' : pct >= 80 ? '#F59E0B' : '#a8a7a0',
        });
        if (c.permission) lines.push({ text: `权限  ${c.permission}`, color: '#a8a7a0' });
        if (c.bridgeConnected != null) {
          lines.push({
            text: `桥接  ${c.bridgeConnected ? '● 已连接' : '○ 未连接'}`,
            color: c.bridgeConnected ? '#4ea96a' : '#a8a7a0',
          });
        }
      } else if (tab === 'terminal' || tab === 'files') {
        // 向后兼容:旧调用方仍可能直接渲染 terminal/files(下沉为覆盖层后主路径不传)。
        if (tab === 'terminal') {
          const out = data.terminalOutput || '';
          if (!out) {
            lines.push({ text: '（终端空闲）', dim: true, color: '#85847d' });
          } else {
            out.split('\n').forEach((l) => lines.push({ text: l || ' ', color: '#a8a7a0' }));
          }
          lines.push({ text: `${data.terminalPrompt || '$'} _`, color: '#4ea96a', bold: true });
        } else {
          if ((data.files || []).length === 0) {
            lines.push({ text: '项目文件', bold: true, color: '#d9d9d4' });
            lines.push({ text: '  （空目录）', dim: true, color: '#85847d' });
          } else {
            data.files.forEach((f) => {
              const icon = f.isDirectory ? '[+]' : ' - ';
              lines.push({ text: `${'  '.repeat(f.depth || 0)}${icon} ${f.name}`, color: '#a8a7a0' });
            });
          }
        }
      } else {
        lines.push({ text: '暂无上下文', dim: true, color: '#85847d' });
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
module.exports.SECTIONS = SECTIONS;
module.exports.computeContentLines = computeContentLines;
