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
// inkRuntime 是 ESM 桥接：顶层 .get() 会在 loadInk() 之前 require 本模块时抛错。
// 与 CcToast / CcScrollIndicators 同一惰性模式 —— 组件渲染时（loadInk 之后）才取。
const inkRuntime = require('../inkRuntime');
// 行预算与窗口起点：与 ./CompletionMenu.js(perPageFor/frameFits) 同一判据族，见该叶子注释。
const ccLayout = require('./ccOverlayLayout');

/**
 * 终端尺寸真源在 ./ccOverlayLayout.termSize（宿主 props 优先，其次 ../effectiveDims）。
 * 本地只留一个别名，避免三个浮层各抄一份 NaN 兜底（BUG-73）。
 */
const _dim = ccLayout.termSize;

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

/**
 * 两个浮层的装饰账本（BUG-88b/89b）——与 `CcHelpMenu` 的 `CHROME_ROWS/CHROME_SHED`
 * 同一台机器，件名各按本浮层实际渲染的东西列。
 *
 * 病灶：chrome 写死 6、**没有让位梯**。`listRows()` 的地板是 1 行，于是帧高恒 7 行：
 * rows ≥ 8 才装得下，rows ≤ 7 撞进 ink 的全屏分支（条件是 `>=`），每次重画写一次
 * \x1b[2J —— win32 conpty 下旧帧被滚进回滚缓冲（按一键留一份整屏副本），
 * 且框的顶边被推下屏幕。实测（`AU/repro-before-bug89b.txt`）：
 * 面板/历史在 7 行档 2J 1 次、6 行档 3 次；选择器 7 行档帧高 7 = 终端 7、2J 3 次。
 *
 * 让位顺序按「最没用在前」：列表后那个纯空行 → 输入行下的分隔线 → 底栏。
 * 底栏最后才砍（它写着 `Esc close`，是唯一告诉用户怎么退出这一层的东西），
 * 但砍它的代价（少一行提示）仍小于不砍的代价（整屏擦除），判据同 BUG-88。
 * 砍无可砍（chrome 3 = 上下边框 2 + 输入行 1）仍装不下时，留给
 * `LIST_FLOOR` 兜 1 行 —— 实测边界停在 rows 4，与 `CcHelpMenu` 同一档。
 */
const PALETTE_CHROME = {
  full: 6, // 上下边框 2 + 输入行 1 + 分隔线 1 + 空行 1 + 提示行 1
  shed: [
    { name: 'spacer', rows: 1 },
    { name: 'rule', rows: 1 },
    { name: 'footer', rows: 1 },
  ],
};

const HISTORY_CHROME = {
  full: 6, // 同上：边框 2 + 查询行 1 + 分隔线 1 + 空行 1 + 提示行 1
  shed: [
    { name: 'spacer', rows: 1 },
    { name: 'rule', rows: 1 },
    { name: 'footer', rows: 1 },
  ],
};

/** 导出给探针与守卫：账本与 paint 必须同源，探针另抄一份算式测到的绿是假的。 */
function paletteChromePlan(rows, total) {
  return ccLayout.chromeLadder({ ...PALETTE_CHROME, rows, total });
}

function historyChromePlan(rows, total) {
  return ccLayout.chromeLadder({ ...HISTORY_CHROME, rows, total });
}

function CcCommandPalette({ onClose, onExecute, cols, rows }) {
  // 惰性取 ink 组件（loadInk 之后才安全）：原文漏导 Text/useInput，挂载即 ReferenceError。
  const { Box, Text, useInput } = inkRuntime.get();
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

  // 行模型：组标题 / 空行 / 条目都各占**恰好一行**，窗口按行切，光标所在行必在窗内。
  // 旧写法用 marginTop 造组间空行 + 全量渲染 → 帧高恒 25 行，80×24 也超，
  // 于是每次重画都触发 ink 全屏分支（\x1b[2J 把旧帧滚进回滚缓冲 = 整屏残影）。
  const rowModel = React.useMemo(() => {
    const out = [];
    const posByItem = [];
    let idx = -1;
    Object.entries(grouped).forEach(([group, cmds], gi) => {
      if (gi > 0) out.push({ type: 'blank' });
      out.push({ type: 'group', label: group });
      cmds.forEach(c => {
        idx += 1;
        posByItem[idx] = out.length;
        out.push({ type: 'item', index: idx, cmd: c.cmd, desc: c.desc });
      });
    });
    return { rows: out, posByItem };
  }, [grouped]);

  // chrome = 上下边框 2 + 输入行 1 + 分隔线 1 + 空行 1 + 提示行 1，
  // 但**装不下时装饰要让位**（BUG-88b/89b，见 PALETTE_CHROME 的注释）。
  const termRows = _dim('rows', rows);
  const plan = paletteChromePlan(termRows, rowModel.rows.length);
  const keep = (name) => !plan.shed.includes(name);
  const visible = ccLayout.listRows({
    rows: termRows, chrome: plan.chrome, total: rowModel.rows.length, legacyCap: Infinity,
  });
  const anchorRow = rowModel.posByItem[safeCursor] != null ? rowModel.posByItem[safeCursor] : 0;
  const start = ccLayout.pageStart(anchorRow, visible, rowModel.rows.length);
  const shown = rowModel.rows.slice(start, start + visible);
  const hint = ccLayout.moreHint(anchorRow, visible, rowModel.rows.length);
  const inner = Math.max(12, _dim('cols', cols) - 8);

  return (
    React.createElement(Box, {
      flexDirection: 'column',
      borderStyle: 'single',
      borderColor: '#00D4D4',
      paddingX: 1,
    },
      React.createElement(Box, null,
        React.createElement(Text, { color: '#00D4D4', bold: true }, '> '),
        React.createElement(Text, { wrap: 'truncate' }, ccLayout.clipLine(filter, inner)),
      ),
      keep('rule')
        ? React.createElement(Box, { borderStyle: 'single', borderColor: '#374151', borderTop: false, borderBottom: true, borderLeft: false, borderRight: false })
        : null,
      ...shown.map((r, i) => {
        if (r.type === 'blank') return React.createElement(Box, { key: `b${start + i}` });
        if (r.type === 'group') {
          return React.createElement(Box, { key: `g${start + i}` },
            React.createElement(Text, { color: '#6B7280', bold: true, wrap: 'truncate' }, ccLayout.clipLine(r.label, inner)));
        }
        const isCursor = r.index === safeCursor;
        const line = (isCursor ? '▸ ' : '  ') + r.cmd + '  ' + r.desc;
        return React.createElement(Box, { key: r.cmd },
          isCursor
            ? React.createElement(Text, { backgroundColor: '#00D4D4', color: '#000000', wrap: 'truncate' }, ccLayout.clipLine(line, inner))
            : React.createElement(Text, { wrap: 'truncate' }, ccLayout.clipLine(line, inner)),
        );
      }),
      keep('spacer') ? React.createElement(Box, { height: 1 }) : null,
      keep('footer')
        ? React.createElement(Text, { color: '#6B7280', dimColor: true, wrap: 'truncate' },
          ccLayout.clipLine(hint
            ? `${filtered.length} commands  ${hint}  ↑/↓ navigate  Enter run  Esc close`
            : `${filtered.length} commands  ↑/↓ navigate  Enter run  Esc close`, inner + 4))
        : null,
    )
  );
}

// ── 历史搜索 ────────────────────────────────────────────────────────────────

function CcHistorySearch({ onSelect, onClose, cols, rows }) {
  // 惰性取 ink 组件（同 CcCommandPalette）。
  const { Box, Text, useInput } = inkRuntime.get();
  const [query, setQuery] = React.useState('');
  const [cursor, setCursor] = React.useState(0);

  const allHistory = React.useMemo(() => {
    try {
      // Single source: every submit in the TUI is persisted through
      // cli/repl/history (portable installs keep it under the project data home).
      // The old `utils/ccHistory` read ~/.khyquant/.khy_history, a file nothing in
      // this repo ever writes → the panel was structurally empty (BUG-67).
      const { loadHistory } = require('../../repl/history');
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

  // 每条历史裁成**一行**再按行开窗：旧写法 `slice(0, 10)` 既不管终端还剩几行
  // （长条目折行 → 60 列时一帧 27 行），窗口也不跟随光标（↓ 过第 10 条后「▸」
  // 直接不在屏上，Enter 选中的是看不见的那条）。
  const inner = Math.max(12, _dim('cols', cols) - 8);
  const termRows = _dim('rows', rows);
  // 装饰让位梯（BUG-88b/89b）：与命令面板同一台机器，件名见 HISTORY_CHROME。
  const plan = historyChromePlan(termRows, filtered.length);
  const keep = (name) => !plan.shed.includes(name);
  const visible = ccLayout.listRows({
    rows: termRows, chrome: plan.chrome, total: filtered.length, legacyCap: 10,
  });
  const start = ccLayout.pageStart(safeCursor, visible, filtered.length);
  const shown = filtered.slice(start, start + visible);
  const hint = ccLayout.moreHint(safeCursor, visible, filtered.length);

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
        React.createElement(Text, { wrap: 'truncate' }, ccLayout.clipLine(query, inner)),
      ),
      keep('rule')
        ? React.createElement(Box, { borderStyle: 'single', borderColor: '#374151', borderTop: false, borderBottom: true, borderLeft: false, borderRight: false })
        : null,
      ...shown.map((h, i) =>
        React.createElement(Box, { key: start + i },
          i + start === safeCursor
            ? React.createElement(Text, { backgroundColor: '#00D4D4', color: '#000000', wrap: 'truncate' }, '▸ ' + ccLayout.clipLine(h, inner - 2))
            : React.createElement(Text, { wrap: 'truncate' }, '  ' + ccLayout.clipLine(h, inner - 2)),
        )
      ),
      keep('spacer') ? React.createElement(Box, { height: 1 }) : null,
      keep('footer')
        ? React.createElement(Text, { color: '#6B7280', dimColor: true, wrap: 'truncate' },
          ccLayout.clipLine(hint
            ? `${filtered.length} entries  ${safeCursor + 1}/${filtered.length}  ${hint}  ↑/↓ navigate  Enter select  Esc close`
            : `${filtered.length} entries  ↑/↓ navigate  Enter select  Esc close`, inner + 4))
        : null,
    )
  );
}

// ── 任务完成卡片 ────────────────────────────────────────────────────────────

function CcTaskCompleteCard({ summary, onContinue, onReview, onNewTask }) {
  // Same lazy inkRuntime pattern as the sibling components above: Box/Text are
  // only available after loadInk(), and a top-level .get() would throw.
  const { Box, Text } = inkRuntime.get();
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
  // 装饰账本（件名 + 让位梯）导出给守卫与探针：探针另抄一份算式，测到的「同源」是假的。
  paletteChromePlan,
  historyChromePlan,
  PALETTE_CHROME,
  HISTORY_CHROME,
};
