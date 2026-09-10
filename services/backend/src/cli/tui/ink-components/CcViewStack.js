'use strict';

/**
 * CcViewStack.js — CC 模式视图栈管理
 * 
 * 设计：
 * - 视图栈模型，Esc 返回上一层
 * - 每视图状态缓存，返回时恢复
 * - 全局快捷键优先于视图本地快捷键
 * 
 * 参考：[DESIGN-ARCH-085] CC 模式子视图、子菜单、卡片与滚动设计
 */

const React = require('react');
const { Box } = require('../inkRuntime').get();

// ── 视图上下文 ──────────────────────────────────────────────────────────────

const ViewContext = React.createContext({
  currentView: 'main',
  viewStack: ['main'],
  viewState: {},
  pushView: () => {},
  popView: () => {},
  replaceView: () => {},
});

function ViewProvider({ children }) {
  const [viewStack, setViewStack] = React.useState(['main']);
  const [viewState, setViewState] = React.useState({});

  const currentView = viewStack[viewStack.length - 1];

  const pushView = React.useCallback((viewId, initialState = {}) => {
    setViewStack(s => [...s, viewId]);
    setViewState(s => ({
      ...s,
      [viewId]: { ...(s[viewId] || {}), ...initialState },
    }));
  }, []);

  const popView = React.useCallback(() => {
    setViewStack(s => s.length > 1 ? s.slice(0, -1) : s);
  }, []);

  const replaceView = React.useCallback((viewId) => {
    setViewStack(s => [...s.slice(0, -1), viewId]);
  }, []);

  const updateViewState = React.useCallback((patch) => {
    setViewState(s => ({
      ...s,
      [currentView]: { ...(s[currentView] || {}), ...patch },
    }));
  }, [currentView]);

  return React.createElement(ViewContext.Provider, {
    value: {
      currentView,
      viewStack,
      viewState: viewState[currentView] || {},
      pushView,
      popView,
      replaceView,
      updateViewState,
    },
  }, children);
}

// ── 命令面板 ────────────────────────────────────────────────────────────────

function CcCommandPalette({ onClose, onExecute }) {
  const [filter, setFilter] = React.useState('');
  const [cursor, setCursor] = React.useState(0);

  const commands = [
    { group: 'Model & Provider', cmd: '/model', desc: 'Switch AI model' },
    { group: 'Model & Provider', cmd: '/login', desc: 'Configure provider' },
    { group: 'Model & Provider', cmd: '/status', desc: 'Gateway status' },
    { group: 'Session', cmd: '/clear', desc: 'Clear conversation' },
    { group: 'Session', cmd: '/compact', desc: 'Compress context' },
    { group: 'Session', cmd: '/cost', desc: 'Token usage' },
    { group: 'Tools', cmd: '/mcp', desc: 'MCP server management' },
    { group: 'Tools', cmd: '/agents', desc: 'Agent management' },
    { group: 'Tools', cmd: '/goal', desc: 'Set goal' },
    { group: 'Help', cmd: '/help', desc: 'Show help' },
    { group: 'Help', cmd: '/doctor', desc: 'System health' },
  ];

  const filtered = React.useMemo(() => {
    if (!filter) return commands;
    const f = filter.toLowerCase().replace(/^\//, '');
    return commands.filter(c =>
      c.cmd.toLowerCase().includes(f) ||
      c.desc.toLowerCase().includes(f)
    );
  }, [filter, commands]);

  const safeCursor = Math.min(Math.max(0, cursor), Math.max(0, filtered.length - 1));

  // 按分组
  const grouped = React.useMemo(() => {
    const groups = {};
    filtered.forEach(c => {
      if (!groups[c.group]) groups[c.group] = [];
      groups[c.group].push(c);
    });
    return groups;
  }, [filtered]);

  useInput((input, key) => {
    if (key.escape) onClose();
    if (key.upArrow) setCursor(c => Math.max(0, c - 1));
    if (key.downArrow) setCursor(c => Math.min(filtered.length - 1, c + 1));
    if (key.return && filtered[safeCursor]) {
      onExecute(filtered[safeCursor].cmd);
      onClose();
    }
    if (input && !key.ctrl && !key.meta) {
      setFilter(f => f + input);
    }
    if (key.backspace) {
      setFilter(f => f.slice(0, -1));
    }
  });

  let flatIndex = -1;
  return (
    React.createElement(Box, {
      flexDirection: 'column',
      borderStyle: 'single',
      borderColor: '#00D4D4',
      paddingX: 1,
    },
      React.createElement(Box, null,
        React.createElement(Text, { color: '#00D4D4', bold: true }, '> '),
        React.createElement(Text, null, filter),
      ),
      React.createElement(Box, { borderStyle: 'single', borderColor: '#374151', borderTop: false, borderBottom: true, borderLeft: false, borderRight: false }),
      ...Object.entries(grouped).map(([group, cmds]) =>
        React.createElement(Box, { key: group, flexDirection: 'column', marginTop: 1 },
          React.createElement(Text, { color: '#6B7280', bold: true }, group),
          ...cmds.map(c => {
            flatIndex++;
            const isCursor = flatIndex === safeCursor;
            return React.createElement(Box, { key: c.cmd },
              isCursor
                ? React.createElement(Text, { backgroundColor: '#00D4D4', color: '#000000' },
                    '▸ ' + c.cmd + '  ' + c.desc)
                : React.createElement(Text, null, '  ' + c.cmd + '  ' + c.desc),
            );
          }),
        )
      ),
      React.createElement(Box, { height: 1 }),
      React.createElement(Text, { color: '#6B7280', dimColor: true },
        '↑/↓ navigate  Enter run  Esc close'),
    )
  );
}

// ── 历史搜索 ────────────────────────────────────────────────────────────────

function CcHistorySearch({ onSelect, onClose }) {
  const [query, setQuery] = React.useState('');
  const [cursor, setCursor] = React.useState(0);

  const allHistory = React.useMemo(() => {
    try {
      const { loadHistory } = require('../utils/ccHistory');
      return loadHistory();
    } catch {
      return [];
    }
  }, []);

  const filtered = React.useMemo(() => {
    if (!query) return allHistory.slice().reverse();
    const q = query.toLowerCase();
    return allHistory.filter(h => h.toLowerCase().includes(q)).reverse();
  }, [query, allHistory]);

  const safeCursor = Math.min(Math.max(0, cursor), Math.max(0, filtered.length - 1));

  useInput((input, key) => {
    if (key.escape) onClose();
    if (key.upArrow) setCursor(c => Math.max(0, c - 1));
    if (key.downArrow) setCursor(c => Math.min(filtered.length - 1, c + 1));
    if (key.return && filtered[safeCursor]) {
      onSelect(filtered[safeCursor]);
      onClose();
    }
    if (input && !key.ctrl && !key.meta) {
      setQuery(q => q + input);
      setCursor(0);
    }
    if (key.backspace) {
      setQuery(q => q.slice(0, -1));
      setCursor(0);
    }
  });

  return (
    React.createElement(Box, {
      flexDirection: 'column',
      borderStyle: 'single',
      borderColor: '#00D4D4',
      paddingX: 1,
    },
      React.createElement(Box, null,
        React.createElement(Text, { color: '#00D4D4', bold: true }, '🔍 '),
        React.createElement(Text, null, query),
      ),
      React.createElement(Box, { borderStyle: 'single', borderColor: '#374151', borderTop: false, borderBottom: true, borderLeft: false, borderRight: false }),
      ...filtered.slice(0, 10).map((h, i) =>
        React.createElement(Box, { key: i },
          i === safeCursor
            ? React.createElement(Text, { backgroundColor: '#00D4D4', color: '#000000' }, '▸ ' + h)
            : React.createElement(Text, null, '  ' + h),
        )
      ),
      React.createElement(Box, { height: 1 }),
      React.createElement(Text, { color: '#6B7280', dimColor: true },
        filtered.length + ' entries  ↑/↓ navigate  Enter select  Esc close'),
    )
  );
}

// ── 任务完成卡片 ────────────────────────────────────────────────────────────

function CcTaskCompleteCard({ summary, onContinue, onReview, onNewTask }) {
  return (
    React.createElement(Box, {
      flexDirection: 'column',
      borderStyle: 'single',
      borderColor: '#4ADE80',
      paddingX: 2,
      paddingY: 1,
    },
      React.createElement(Text, { color: '#4ADE80', bold: true }, '✓ Task Complete'),
      React.createElement(Box, { height: 1 }),
      ...(summary || []).map((line, i) =>
        React.createElement(Text, { key: i, color: '#E0E0E0' }, '  ' + line)
      ),
      React.createElement(Box, { height: 1 }),
      React.createElement(Box, null,
        React.createElement(Text, { color: '#00D4D4' }, '[Enter]'),
        React.createElement(Text, { color: '#6B7280' }, ' Continue  '),
        React.createElement(Text, { color: '#5769F7' }, '[r]'),
        React.createElement(Text, { color: '#6B7280' }, ' Review  '),
        React.createElement(Text, { color: '#FBBF24' }, '[n]'),
        React.createElement(Text, { color: '#6B7280' }, ' New Task'),
      ),
    )
  );
}

module.exports = {
  ViewProvider,
  ViewContext,
  CcCommandPalette: React.memo(CcCommandPalette),
  CcHistorySearch: React.memo(CcHistorySearch),
  CcTaskCompleteCard: React.memo(CcTaskCompleteCard),
};
