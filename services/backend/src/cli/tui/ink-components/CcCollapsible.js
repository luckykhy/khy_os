'use strict';

/**
 * CcCollapsible.js — CC 模式折叠组件
 * 
 * 设计：
 * - 折叠时显示 ▸ + 标题 + 摘要
 * - 展开时显示 ▾ + 标题 + 内容（缩进 2 空格）
 * - 支持键盘交互（Enter/Space/o/x/z）
 * 
 * 参考：[DESIGN-ARCH-083] CC 模式表格与折叠设计
 */

const React = require('react');
const { Text, Box, useInput } = require('../inkRuntime').get();

/**
 * 折叠组件
 */
function CcCollapsible({
  title,
  summary,
  children,
  defaultFolded = true,
  indent = 2,
  onToggle,
}) {
  const [folded, setFolded] = React.useState(defaultFolded);

  const toggle = React.useCallback(() => {
    setFolded(f => {
      const next = !f;
      onToggle?.(next);
      return next;
    });
  }, [onToggle]);

  useInput((input, key) => {
    if (key.return || input === ' ') {
      toggle();
    }
    if (input === 'o') setFolded(false);
    if (input === 'x') setFolded(true);
    if (input === 'z') toggle();
  });

  if (folded) {
    return (
      React.createElement(Box, null,
        React.createElement(Text, { color: '#A0A0A0' }, '▸'),
        React.createElement(Text, null, ' ' + title),
        summary ? React.createElement(Text, { color: '#6B7280' }, ' (' + summary + ')') : null,
      )
    );
  }

  return (
    React.createElement(Box, { flexDirection: 'column' },
      React.createElement(Box, null,
        React.createElement(Text, { color: '#A0A0A0' }, '▾'),
        React.createElement(Text, { bold: true }, ' ' + title),
      ),
      React.createElement(Box, { flexDirection: 'column', paddingLeft: indent },
        children
      ),
    )
  );
}

/**
 * 工具调用结果折叠卡片
 */
function CcToolCard({ name, params, status, result, defaultFolded = true }) {
  const statusIcon = {
    pending: '◆',
    success: '✓',
    error: '✗',
    waiting: '◦',
  }[status] || '◦';

  const statusColor = {
    pending: '#FBBF24',
    success: '#4ADE80',
    error: '#F87171',
    waiting: '#6B7280',
  }[status] || '#6B7280';

  const paramSummary = summarizeToolParams(name, params);
  const resultSummary = result ? `${result.split('\n').length} lines` : '';

  return (
    React.createElement(CcCollapsible, {
      title: name + (paramSummary ? '(' + paramSummary + ')' : ''),
      summary: resultSummary,
      defaultFolded,
    },
      React.createElement(Box, { flexDirection: 'column' },
        React.createElement(Text, { color: statusColor }, '  ' + statusIcon + ' ' + status),
        result ? React.createElement(Text, { color: '#A0A0A0' }, '  ' + result.split('\n').slice(0, 5).join('\n  ')) : null,
      )
    )
  );
}

/**
 * 思考块折叠
 */
function CcThinkingBlock({ steps, defaultFolded = true }) {
  return (
    React.createElement(CcCollapsible, {
      title: 'Thinking...',
      summary: steps.length + ' steps',
      defaultFolded,
    },
      steps.map((step, i) =>
        React.createElement(Text, { key: i, color: '#6B7280' }, '  │ ' + step)
      )
    )
  );
}

// ── 工具函数 ────────────────────────────────────────────────────────────────

function summarizeToolParams(name, input) {
  if (!input) return '';
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return truncatePath(input.file_path, 40);
    case 'Bash':
      return truncateCommand(input.command, 40);
    case 'Grep':
      return truncateString(input.pattern, 30);
    case 'Glob':
      return input.pattern || '*';
    default:
      return JSON.stringify(input).slice(0, 40);
  }
}

function truncatePath(p, max) {
  if (!p) return '';
  if (p.length <= max) return p;
  const parts = p.split(/[\\/]/);
  if (parts.length > 2) return parts[0] + '/…/' + parts[parts.length - 1];
  return p.slice(0, max - 1) + '…';
}

function truncateCommand(c, max) {
  if (!c) return '';
  if (c.length <= max) return c;
  return c.slice(0, max - 3) + '…';
}

function truncateString(s, max) {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '…';
}

module.exports = {
  CcCollapsible: React.memo(CcCollapsible),
  CcToolCard: React.memo(CcToolCard),
  CcThinkingBlock: React.memo(CcThinkingBlock),
};
