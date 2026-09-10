'use strict';

/**
 * CcSidebarPanel.js —— 右侧看板容器
 *
 * 设计：
 * - 终端宽度 >= 120 列时自动显示
 * - 宽度：30 列
 * - 标签页导航：📋 Context / 📁 Files / 🔧 Tools / 📊 Stats / 🔌 MCP
 * - 当前面板高亮
 * - Ctrl+B 切换显示/隐藏
 *
 * 参考：[DESIGN-ARCH-081] Phase 1: 右侧看板设计规范
 */

const React = require('react');
const { Text, Box, useInput } = require('../inkRuntime').get();
const { CC_COLORS } = require('../theme/ccTheme');

const PANELS = [
  { id: 'context', icon: '📋', label: 'Context' },
  { id: 'files', icon: '📁', label: 'Files' },
  { id: 'tools', icon: '🔧', label: 'Tools' },
  { id: 'stats', icon: '📊', label: 'Stats' },
  { id: 'mcp', icon: '🔌', label: 'MCP' },
];

/**
 * 右侧看板容器
 */
function CcSidebarPanel({
  width = 30,
  activePanel = 'context',
  onPanelChange,
  stats = null,
  mcpServers = [],
  files = [],
}) {
  const [currentPanel, setCurrentPanel] = React.useState(activePanel);

  const handlePanelChange = React.useCallback((id) => {
    setCurrentPanel(id);
    onPanelChange?.(id);
  }, [onPanelChange]);

  // 标签页切换
  useInput((input, key) => {
    const currentIdx = PANELS.findIndex(p => p.id === currentPanel);
    if (key.rightArrow || (key.tab && !key.shift)) {
      const next = (currentIdx + 1) % PANELS.length;
      handlePanelChange(PANELS[next].id);
    }
    if (key.leftArrow || (key.tab && key.shift)) {
      const prev = (currentIdx - 1 + PANELS.length) % PANELS.length;
      handlePanelChange(PANELS[prev].id);
    }
  });

  const panel = PANELS.find(p => p.id === currentPanel) || PANELS[0];

  return (
    React.createElement(Box, {
      flexDirection: 'column',
      width,
      borderStyle: 'single',
      borderColor: CC_COLORS.secondary,
      paddingX: 1,
    },
      // 标签页导航
      React.createElement(Box, { marginBottom: 1 },
        PANELS.map((p, i) => {
          const isActive = p.id === currentPanel;
          return React.createElement(Text, {
            key: p.id,
            color: isActive ? CC_COLORS.brand : CC_COLORS.dimColor,
            bold: isActive,
            marginRight: 1,
          }, p.icon);
        })
      ),

      // 分割线
      React.createElement(Text, { color: CC_COLORS.border }, '─'.repeat(width - 4)),

      // 面板内容
      React.createElement(Box, { flexDirection: 'column', marginTop: 1 },
        currentPanel === 'context' && renderContextPanel(stats),
        currentPanel === 'files' && renderFilesPanel(files),
        currentPanel === 'tools' && renderToolsPanel(),
        currentPanel === 'stats' && renderStatsPanel(stats),
        currentPanel === 'mcp' && renderMcpPanel(mcpServers),
      ),
    )
  );
}

function renderContextPanel(stats) {
  return React.createElement(Box, { flexDirection: 'column' },
    React.createElement(Text, { bold: true }, 'Context'),
    React.createElement(Text, { color: CC_COLORS.dimColor }, 'No context yet'),
  );
}

function renderFilesPanel(files) {
  if (!files || files.length === 0) {
    return React.createElement(Box, { flexDirection: 'column' },
      React.createElement(Text, { bold: true }, 'Files'),
      React.createElement(Text, { color: CC_COLORS.dimColor }, 'No files tracked'),
    );
  }
  return React.createElement(Box, { flexDirection: 'column' },
    React.createElement(Text, { bold: true }, 'Files'),
    files.slice(0, 10).map((f, i) => (
      React.createElement(Text, { key: i, color: CC_COLORS.textSecondary }, '├─ ' + f)
    )),
  );
}

function renderToolsPanel() {
  return React.createElement(Box, { flexDirection: 'column' },
    React.createElement(Text, { bold: true }, 'Tools'),
    React.createElement(Text, { color: CC_COLORS.dimColor }, 'Read ✓'),
    React.createElement(Text, { color: CC_COLORS.dimColor }, 'Write'),
    React.createElement(Text, { color: CC_COLORS.dimColor }, 'Bash'),
    React.createElement(Text, { color: CC_COLORS.dimColor }, 'Grep'),
  );
}

function renderStatsPanel(stats) {
  return React.createElement(Box, { flexDirection: 'column' },
    React.createElement(Text, { bold: true }, 'Stats'),
    React.createElement(Text, { color: CC_COLORS.dimColor },
      'Tokens: ' + (stats?.tokensUsed || '0'),
    ),
    React.createElement(Text, { color: CC_COLORS.dimColor },
      'Cost: ' + (stats?.cost || '$0.00'),
    ),
  );
}

function renderMcpPanel(servers) {
  if (!servers || servers.length === 0) {
    return React.createElement(Box, { flexDirection: 'column' },
      React.createElement(Text, { bold: true }, 'MCP'),
      React.createElement(Text, { color: CC_COLORS.dimColor }, 'No servers'),
    );
  }
  return React.createElement(Box, { flexDirection: 'column' },
    React.createElement(Text, { bold: true }, 'MCP'),
    servers.map((s, i) => {
      const color = s.state === 'connected' ? CC_COLORS.success
        : s.state === 'failed' ? CC_COLORS.error
        : CC_COLORS.dimColor;
      const icon = s.state === 'connected' ? '•'
        : s.state === 'failed' ? '✗'
        : '○';
      return React.createElement(Text, { key: i, color }, icon + ' ' + s.name);
    }),
  );
}

module.exports = { CcSidebarPanel: React.memo(CcSidebarPanel), PANELS };
