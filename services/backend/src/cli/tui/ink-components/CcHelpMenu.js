'use strict';

/**
 * CcHelpMenu.js —— CC 风格帮助菜单覆盖层
 *
 * 设计：
 * - 标签页导航：Help / General / Commands / Custom commands
 * - 当前标签高亮（橙色下划线）
 * - 快捷键网格：2-3 列布局
 * - 底部状态栏：版本 + MCP 状态 + 操作提示
 * - Esc / q / ? 关闭
 *
 * 参考：[DESIGN-ARCH-081] Phase 5: 补全菜单与覆盖层
 */

const React = require('react');
const { Text, Box, useInput } = require('../inkRuntime').get();
const { CC_COLORS } = require('../theme/ccTheme');
const { BRAND } = require('../utils/ccBrand');

const TABS = ['Help', 'General', 'Commands', 'Custom commands'];

const GENERAL_SHORTCUTS = [
  { keys: 'Ctrl+C', desc: 'Cancel/Exit' },
  { keys: 'Ctrl+D', desc: 'Exit REPL' },
  { keys: 'Ctrl+O', desc: 'Transcript mode' },
  { keys: 'Ctrl+L', desc: 'Clear' },
  { keys: 'Ctrl+R', desc: 'History search' },
  { keys: 'Ctrl+T', desc: 'Tasks' },
  { keys: '↑/↓', desc: 'History nav' },
  { keys: 'Tab', desc: 'Complete' },
  { keys: 'Shift+Tab', desc: 'Cycle mode' },
  { keys: '?', desc: 'Help' },
];

const COMMANDS_LIST = [
  { cmd: '/clear', desc: '清除对话历史' },
  { cmd: '/compact', desc: '压缩对话历史' },
  { cmd: '/cost', desc: '查看 token 用量' },
  { cmd: '/status', desc: '查看会话状态' },
  { cmd: '/init', desc: '初始化 CLAUDE.md' },
  { cmd: '/memory', desc: '管理记忆文件' },
  { cmd: '/model', desc: '切换 AI 模型' },
  { cmd: '/permissions', desc: '权限设置' },
  { cmd: '/vim', desc: '切换 Vim 模式' },
  { cmd: '/mcp', desc: 'MCP 服务器管理' },
  { cmd: '/agents', desc: 'Agent 管理' },
  { cmd: '/hooks', desc: 'Hooks 管理' },
];

/**
 * CC 风格帮助菜单覆盖层
 */
function CcHelpMenu({ version = '1.0.0', mcpStatus, onClose, width = 80 }) {
  const [activeTab, setActiveTab] = React.useState(0);

  useInput((input, key) => {
    if (key.escape || input === 'q' || input === '?') {
      onClose?.();
    }
    if (key.leftArrow) {
      setActiveTab(i => (i > 0 ? i - 1 : TABS.length - 1));
    }
    if (key.rightArrow) {
      setActiveTab(i => (i < TABS.length - 1 ? i + 1 : 0));
    }
    if (key.tab) {
      setActiveTab(i => (i + 1) % TABS.length);
    }
  });

  return (
    React.createElement(Box, {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: CC_COLORS.border,
      paddingX: 1,
      width,
    },
      // 标签页导航
      React.createElement(Box, { marginBottom: 1 },
        TABS.map((tab, i) => {
          const isActive = i === activeTab;
          return React.createElement(Text, {
            key: i,
            color: isActive ? CC_COLORS.brand : CC_COLORS.dimColor,
            bold: isActive,
            underline: isActive,
            marginRight: 2,
          }, tab);
        })
      ),

      // 分割线
      React.createElement(Text, { color: CC_COLORS.secondary }, '─'.repeat(width - 4)),

      // 内容区
      React.createElement(Box, { flexDirection: 'column', marginTop: 1 },
        activeTab === 0 && renderHelpTab(),
        activeTab === 1 && renderGeneralTab(),
        activeTab === 2 && renderCommandsTab(),
        activeTab === 3 && renderCustomCommandsTab(),
      ),

      // 底部状态栏
      React.createElement(Text, { color: CC_COLORS.secondary }, '─'.repeat(width - 4)),
      React.createElement(Box, { marginTop: 1, justifyContent: 'space-between' },
        React.createElement(Text, { color: CC_COLORS.dimColor },
          BRAND.versionTemplate(version),
        ),
        React.createElement(Text, { color: CC_COLORS.dimColor },
          'Esc close · ←→ tabs · Enter select',
        )
      ),
    )
  );
}

function renderHelpTab() {
  return React.createElement(Box, { flexDirection: 'column' },
    React.createElement(Text, { bold: true }, 'Welcome to Khy'),
    React.createElement(Text, { color: CC_COLORS.dimColor }, 'AI-powered coding assistant'),
    React.createElement(Text, null, ' '),
    React.createElement(Text, null, 'Type a message to get started.'),
    React.createElement(Text, null, 'Type / to see available commands.'),
    React.createElement(Text, null, 'Type ? to open this help menu.'),
  );
}

function renderGeneralTab() {
  // 2 列网格
  const left = [];
  const right = [];
  GENERAL_SHORTCUTS.forEach((s, i) => {
    if (i % 2 === 0) left.push(s);
    else right.push(s);
  });

  return (
    React.createElement(Box, { flexDirection: 'column' },
      left.map((s, i) => (
        React.createElement(Box, { key: i },
          React.createElement(Box, { width: 20 },
            React.createElement(Text, { color: CC_COLORS.brand }, s.keys),
          ),
          React.createElement(Text, { color: CC_COLORS.textSecondary }, s.desc),
          right[i]
            ? React.createElement(React.Fragment, null,
                React.createElement(Text, { color: CC_COLORS.dimColor }, '  '),
                React.createElement(Box, { width: 20 },
                  React.createElement(Text, { color: CC_COLORS.brand }, right[i].keys),
                ),
                React.createElement(Text, { color: CC_COLORS.textSecondary }, right[i].desc),
              )
            : null,
        )
      ))
    )
  );
}

function renderCommandsTab() {
  return (
    React.createElement(Box, { flexDirection: 'column' },
      COMMANDS_LIST.map((c, i) => (
        React.createElement(Box, { key: i },
          React.createElement(Box, { width: 18 },
            React.createElement(Text, { color: CC_COLORS.brand }, c.cmd),
          ),
          React.createElement(Text, { color: CC_COLORS.textSecondary }, c.desc),
        )
      ))
    )
  );
}

function renderCustomCommandsTab() {
  return React.createElement(Box, { flexDirection: 'column' },
    React.createElement(Text, { color: CC_COLORS.dimColor }, 'No custom commands configured.'),
    React.createElement(Text, { color: CC_COLORS.dimColor }, 'Create .khy/commands/ to add your own.'),
  );
}

module.exports = { CcHelpMenu: React.memo(CcHelpMenu) };
