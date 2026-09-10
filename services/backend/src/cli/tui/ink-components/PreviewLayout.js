'use strict';

/**
 * PreviewLayout — 对齐 layout-preview.html 的终端主体布局。
 *
 * 结构（严格对齐预览图）:
 *   <column height:100%>
 *     <Topbar />                          ← 标题栏
 *     <banner />                          ← 横幅 (固定)
 *     <row flex:1>                        ← 主分割区
 *       <column flex:1>                   ← 左侧 MAIN (对话+工具+任务)
 *         <Static />                      ← 对话历史 (scrollback)
 *         <live tools />                  ← 流式工具调用
 *         <task panel />                  ← 任务清单
 *       </column>
 *       <Sidebar />                       ← 右侧 SIDEBAR (看板)
 *     </row>
 *     <bottom-fixed>                      ← 底部固定层
 *       <streaming spinner />
 *       <prompt />
 *       <footer />
 *     </bottom-fixed>
 *   </column>
 *
 * 复用所有现有叶组件，零业务逻辑重写。
 */

const React = require('react');

const inkRuntime = require('../inkRuntime');
const { Static } = inkRuntime.get();

const Topbar = require('./Topbar');
const Transcript = require('./Transcript');
const ToolLines = require('./ToolLines');
const TaskListPanel = require('./TaskListPanel');
const Spinner = require('./Spinner');
const PromptFrame = require('./PromptFrame');
const FooterBar = require('./FooterBar');
const Viewport = require('./Viewport');
const MemoMessageBlock = Transcript.MessageBlock;

function PreviewLayout(props) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;

  const {
    titleBar = {},
    banner = null,
    staticItems = [],
    bannerElement = null,
    expanded = false,
    streaming = null,
    status = 'idle',
    onToolErrorClick,
    taskProps = {},
    tasksHidden = false,
    nowTick = 0,
    value = '',
    offset = 0,
    placeholder = '',
    accent = null,
    vimEnabled = false,
    vimMode = 'INSERT',
    mic = null,
    completion = { active: false, items: [] },
    selectedIndex = 0,
    completionPage = 0,
    completionMarginLeft = 0,
    hint = '',
    footer = {},
    sidebar = {},
    overlays = null,
    width = 80,
    viewportHeight = 10,
    viewportScroll = 0,
    onViewportScroll,
    sidebarScroll = 0,
    onSidebarScroll,
  } = props;

  const busy = status !== 'idle' && status !== 'done';

  // 自适应分隔线生成器(避免硬编码长度导致折行)
  const sep = (color, len) => h(Text, { color }, '─'.repeat(Math.max(1, len)));

  return h(
    Box,
    { flexDirection: 'column' },
    // ── 标题栏 ──
    h(Topbar, titleBar),
    // ── 主分割区 ──
    // 横幅作为 Static 第一个元素(scrollback 顶部固定),对话历史紧随其后 ——
    // 这样横幅始终在内容上方,且不会每帧重绘产生多个 spinner。
    h(
      Box,
      { flexDirection: 'row', flexGrow: 1, minHeight: 0, overflow: 'hidden' },
      // 左侧 MAIN
      h(
        Box,
        { flexDirection: 'column', flexGrow: 1, minWidth: 0 },
        // 对话历史 + 横幅 (Static → scrollback,横幅为首项)
        h(Static, { items: staticItems }, (item) =>
          item.kind === 'banner'
            ? bannerElement
            : h(MemoMessageBlock, { key: item.key, msg: item.msg, expanded })
        ),
            // 流式工具调用 + 任务面板 (包裹在 Viewport 内,页面内滚动,不带动输入框)
        h(Viewport, {
          height: viewportHeight,
          scroll: viewportScroll,
          onScroll: onViewportScroll,
          showIndicator: true,
        },
          // 子元素:工具调用
          streaming
            ? h(ToolLines, {
                key: 'live-tools',
                tools: streaming.tools,
                expanded,
                live: true,
                onErrorClick: onToolErrorClick,
              })
            : null,
          // 任务面板
          h(TaskListPanel, {
            key: 'task-panel',
            tick: nowTick,
            ...taskProps,
            ...(tasksHidden ? { lines: [], hidden: 0, hiddenLines: [] } : {}),
          })
        )
      ),
      // 右侧 SIDEBAR (可滚动)
      h(Sidebar, {
        data: sidebar,
        height: viewportHeight,
        scroll: sidebarScroll,
        onScroll: onSidebarScroll,
      })
    ),
    // ── 底部固定层 ──
    h(
      Box,
      { flexDirection: 'column', flexShrink: 0 },
      // 顶部分隔线(自适应宽度,避免折行)
      sep('#58a6ff', width),
      busy
        ? h(Box, { paddingX: 2, paddingY: 1 }, h(Spinner, { label: '执行计划中…' }))
        : null,
      h(PromptFrame, {
        value,
        offset,
        busy,
        placeholder,
        accent,
        vimMode: vimEnabled ? vimMode : null,
        mic,
      }),
      h(FooterBar, footer)
    ),
    // 覆盖层
    overlays || null
  );
}

/**
 * Sidebar — 右侧看板，对齐预览图 .right-col 内容。
 * 工作目录 / 待办 / MCP / LSP / 工具 / 队列 / 通知 / 输入回显。
 */
function Sidebar({ data = {}, height = 10, scroll = 0, onScroll }) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;

  const lines = buildSidebarLines(data);
  const width = data.width || 45;

  // 渲染带左侧边框的行:每行前面加 │ 字符模拟 border-left(避免 ink borderStyle
  // 在 height:100% 无宽度约束时报错)。
  // 内容包裹在 Viewport 内,支持页面内滚动。
  const borderedLines = lines.map((ln) =>
    h(
      Text,
      {
        color: ln.color,
        dimColor: ln.dim,
        bold: ln.bold,
      },
      '│ ' + ln.text
    )
  );

  return h(
    Box,
    {
      flexDirection: 'column',
      width,
      flexShrink: 0,
      paddingX: 1,
    },
    h(Viewport, {
      height,
      scroll,
      onScroll,
      showIndicator: true,
    }, ...borderedLines)
  );
}

/**
 * 构建右栏行列表（纯函数，对齐预览图内容顺序）。
 */
function buildSidebarLines(data = {}) {
  const lines = [];
  const t = (s) => String(s == null ? '' : s);
  // 自适应分隔线长度 = 栏宽 - 左右padding(2),避免折行
  const sepLen = Math.max(1, (data.width || 45) - 4);
  const sep = () => ({ text: '─'.repeat(sepLen), color: '#21262d', dim: true });

  // 工作目录
  if (data.workDir) {
    lines.push({ text: '工作目录', color: '#58a6ff', bold: true });
    lines.push({ text: t(data.workDir), color: '#8b949e' });
    lines.push(sep());
  }

  // 待办
  const todos = Array.isArray(data.todos) ? data.todos : [];
  if (todos.length > 0 || data.todos !== undefined) {
    lines.push({ text: `待办 (${todos.length})`, color: '#58a6ff', bold: true });
    for (const todo of todos.slice(0, 8)) {
      const mark = todo.done ? '✓' : todo.running ? '→' : '○';
      const color = todo.done ? '#3fb950' : todo.running ? '#58a6ff' : '#484f58';
      lines.push({ text: `  ${mark} ${todo.text || todo}`, color });
    }
    lines.push(sep());
  }

  // MCP
  const mcp = Array.isArray(data.mcp) ? data.mcp : [];
  if (mcp.length > 0) {
    lines.push({ text: `MCP (${mcp.length})`, color: '#58a6ff', bold: true });
    for (const s of mcp) {
      lines.push({ text: `  ● ${s.name || s}`, color: '#3fb950' });
    }
    lines.push(sep());
  }

  // LSP
  const lsp = Array.isArray(data.lsp) ? data.lsp : [];
  if (lsp.length > 0) {
    lines.push({ text: `LSP (${lsp.length})`, color: '#58a6ff', bold: true });
    for (const s of lsp) {
      lines.push({ text: `  ● ${s.name || s}`, color: '#3fb950' });
    }
    lines.push(sep());
  }

  // 工具列表
  const tools = Array.isArray(data.tools) ? data.tools : [];
  if (tools.length > 0) {
    tools.forEach((tool, i) => {
      lines.push({ text: `工具 ${i + 1}/${tools.length}`, color: '#d29922' });
      const icon = tool.error ? '✗' : tool.running ? '●' : '✓';
      const color = tool.error ? '#f85149' : tool.running ? '#58a6ff' : '#3fb950';
      lines.push({ text: `  ${icon} ${tool.name || 'tool'}`, color });
      if (tool.summary) {
        lines.push({ text: `    ${tool.summary}`, color: '#8b949e' });
      }
    });
    lines.push(sep());
  }

  // 队列
  const queueLen = data.queueLen || 0;
  lines.push({ text: `队列 ${queueLen} 条`, color: '#8b949e' });
  lines.push(sep());

  // 通知
  const notifications = Array.isArray(data.notifications) ? data.notifications : [];
  if (notifications.length > 0) {
    lines.push({ text: `通知 ${notifications.length} 条`, color: '#8b949e' });
    for (const n of notifications.slice(0, 3)) {
      lines.push({ text: t(String(n.title || n)), color: '#8b949e' });
    }
    lines.push(sep());
  }

  // 输入回显
  if (data.inputEcho) {
    lines.push({ text: `▸ ${data.inputEcho}`, color: '#484f58' });
  }

  return lines;
}

module.exports = PreviewLayout;
module.exports.Sidebar = Sidebar;
module.exports.buildSidebarLines = buildSidebarLines;
