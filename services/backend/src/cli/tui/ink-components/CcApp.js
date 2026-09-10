'use strict';

/**
 * CcApp.js —— CC 模式根组件
 *
 * 当 KHY_CC_TUI=1 时，app.js 渲染此组件替代 Legacy App。
 * 使用 CC 风格组件：CcStatusLine, CcPromptInput, CcLogo 等。
 *
 * 零破坏原则：本组件独立于 Legacy App.js，不影响 Legacy 模式。
 *
 * 参考：[DESIGN-ARCH-086] 总计划
 */

const React = require('react');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
// App.js 使用 inkRuntime.get() 获取 ink 组件（第 431 行），
// 因为 ink 是 ESM 模块，不能直接 require。CcApp.js 必须保持一致。
const { Box, Text, useInput, useApp } = require('../inkRuntime').get();
const { isCcMode } = require('../utils/ccMode');
const { CcLogo } = require('./CcLogo');
const { CcStatusLine } = require('./CcStatusLine');
const { CcPromptInput } = require('./CcPromptInput');
const { CcAssistantMessage, CcStreamingMessage } = require('./CcAssistantMessage');
const { CcCollapsible, CcToolCard } = require('./CcCollapsible');
const { CcViewStack } = require('./CcViewStack');
const { CcHelpMenu } = require('./CcHelpMenu');
const { CcFuzzyPicker } = require('./CcFuzzyPicker');
const { CcToastContainer } = require('../components/CcToast');
const { CcScrollIndicators } = require('../components/CcScrollIndicators');
const { CcMessageBar } = require('../components/CcMessageBar');
const { CcPermissionPrompt } = require('./CcPermissionPrompt');
const AgentTree = require('./AgentTree');
const { CcTranscriptView } = require('./CcTranscriptView');
const { formatDuration, estimateAllAgents } = require('../utils/ccTaskEstimate');
const { getLayout } = require('../utils/ccLayout');
const { CC_COLORS } = require('../theme/ccTheme');

/**
 * CC 模式根组件
 */
function CcApp({ options = {} }) {
  const { exit } = useApp();
  const [messages, setMessages] = React.useState([]);
  const [inputValue, setInputValue] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [showHelp, setShowHelp] = React.useState(false);
  const [showCommandPalette, setShowCommandPalette] = React.useState(false);
  const [toasts, setToasts] = React.useState([]);
  const [messageBar, setMessageBar] = React.useState(null);
  const [permissionPrompt, setPermissionPrompt] = React.useState(null);
  const [modelId, setModelId] = React.useState(options.model || 'claude-sonnet-4');
  const [contextUsed, setContextUsed] = React.useState(0);
  const [cost, setCost] = React.useState(0);
  const [cols, setCols] = React.useState(process.stdout.columns || 80);
  const [rows, setRows] = React.useState(process.stdout.rows || 24);
  const [permissionProfile, setPermissionProfile] = React.useState('normal');
  const [cacheHitRate, setCacheHitRate] = React.useState(null);
  const [subAgents, setSubAgents] = React.useState([]); // 父子 Agent 工具树（ZCode 对齐）
  const [agentTreeExpanded, setAgentTreeExpanded] = React.useState(false);
  const [showTranscript, setShowTranscript] = React.useState(false); // 转录视图（Claude Code Ctrl+O 对齐）
  const [editorOpen, setEditorOpen] = React.useState(false); // 外部编辑器（Ctrl+E）
  const [editorContent, setEditorContent] = React.useState(''); // 编辑器内容
  const [vimMode, setVimMode] = React.useState(null); // Vim 模式（null=禁用）
  const [vimEnabled, setVimEnabled] = React.useState(true); // Vim 模式开关（默认启用）

  // 初始化权限 profile（从 permissionStore 读取）
  React.useEffect(() => {
    try {
      const permStore = require('../../../services/permissionStore');
      if (permStore && typeof permStore.getProfile === 'function') {
        setPermissionProfile(permStore.getProfile());
      }
    } catch {
      /* permissionStore unavailable — keep default */
    }
  }, []);

  // 父子 Agent 工具树演示数据（ZCode 对齐：可视化多智能体层级 + 时间预估）
  // 在实际运行中，这些数据来自后端 sub-agent 编排引擎
  React.useEffect(() => {
    // 演示：展示一个父子 Agent 工具树（含步骤，用于时间预估）
    const agents = [
      {
        id: 'agent-1',
        name: '基本面分析师',
        status: 'running',
        stats: ['5 tool uses', '2.1s'],
        currentTool: 'Reading server.js',
        steps: [
          { tool: 'Read', args: { file_path: '/src/server.js' } },
          { tool: 'Grep', args: { pattern: 'TODO' } },
          { tool: 'Bash', args: { command: 'npm test' } },
          { tool: 'Edit', args: { file_path: '/src/index.js' } },
          { tool: 'Read', args: { file_path: '/README.md' } },
        ],
      },
      {
        id: 'agent-2',
        name: '风控经理',
        status: 'completed',
        stats: ['3 tool uses', '1.5s'],
        steps: [
          { tool: 'Read', args: { file_path: '/src/auth.js' } },
          { tool: 'Grep', args: { pattern: 'password' } },
          { tool: 'Bash', args: { command: 'npm audit' } },
        ],
      },
    ];

    // 为每个 Agent 添加时间预估
    const estimates = estimateAllAgents(agents);
    const agentsWithEstimate = agents.map((agent, i) => ({
      ...agent,
      estimate: estimates[i]?.label || '',
    }));

    setSubAgents(agentsWithEstimate);
  }, []);

  const layout = getLayout(cols, rows);

  // ── 全局快捷键 ──────────────────────────────────────────────────────────

  useInput((input, key) => {
    // 退出
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }
    if (key.ctrl && input === 'd') {
      exit();
      return;
    }

    // 帮助菜单
    if (input === '?' && !showHelp && !showCommandPalette) {
      setShowHelp(true);
      return;
    }

    // 命令面板
    if (key.ctrl && input === 'p' && !showHelp && !showCommandPalette) {
      setShowCommandPalette(true);
      return;
    }

    // 清除对话
    if (key.ctrl && input === 'l') {
      setMessages([]);
      return;
    }

    // 转录视图（Ctrl+O，Claude Code 对齐：时间戳+模型+可展开工具调用）
    if (key.ctrl && input === 'o') {
      setShowTranscript((prev) => !prev);
      return;
    }

    // Agent 工具树折叠/展开（Ctrl+T，对齐任务列表快捷键）
    if (key.ctrl && input === 't') {
      setAgentTreeExpanded((prev) => !prev);
      return;
    }

    // 外部编辑器（Ctrl+E，OpenCode / Claude Code 对齐：打开 $EDITOR 编辑长文本）
    if (key.ctrl && input === 'e' && !editorOpen) {
      openExternalEditor();
      return;
    }

    // 切换 Vim 模式（Ctrl+V，状态栏显示当前模式）
    if (key.ctrl && input === 'v' && !showTranscript && !editorOpen) {
      setVimEnabled((prev) => !prev);
      return;
    }
  });

  // ── 消息处理 ────────────────────────────────────────────────────────────

  const handleSubmit = React.useCallback((text) => {
    if (!text.trim()) return;

    // 添加用户消息（带时间戳，用于转录视图）
    setMessages(prev => [...prev, {
      id: Date.now(),
      timestamp: Date.now(),
      role: 'user',
      text,
    }]);

    // 模拟 AI 响应（实际应连接 AI 网关）
    setBusy(true);
    setTimeout(() => {
      setMessages(prev => [...prev, {
        id: Date.now() + 1,
        timestamp: Date.now(),
        role: 'assistant',
        model: modelId,
        text: `收到: ${text}`,
        steps: [],
      }]);
      setBusy(false);
    }, 500);

    setInputValue('');
  }, []);

  // ── Toast 管理（必须在 openExternalEditor 之前定义，避免 TDZ 错误） ──────

  const addToast = React.useCallback((message, type = 'info') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
  }, []);

  const dismissToast = React.useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  // ── 外部编辑器（Ctrl+E，OpenCode / Claude Code 对齐） ────────────────────

  /**
   * 打开外部编辑器编辑长文本。
   * 创建临时文件 → 启动 $EDITOR → 等待关闭 → 读取内容回填输入框。
   * 对标 OpenCode Ctrl+E 打开 $EDITOR（默认 nvim）的行为。
   */
  const openExternalEditor = React.useCallback(() => {
    const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vim');
    const tmpFile = path.join(os.tmpdir(), `khy-tui-edit-${Date.now()}.txt`);

    // 写入当前输入内容到临时文件
    try {
      fs.writeFileSync(tmpFile, inputValue || '', 'utf-8');
    } catch {
      addToast('无法创建临时文件', 'error');
      return;
    }

    setEditorOpen(true);
    setEditorContent(inputValue || '');

    // 启动编辑器（挂起 TUI，等待编辑器关闭）
    const child = spawn(editor, [tmpFile], {
      stdio: 'inherit',
    });

    child.on('close', (code) => {
      setEditorOpen(false);
      if (code !== 0) {
        // 用户取消（如 vim :q!）→ 不修改输入
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        return;
      }
      try {
        const content = fs.readFileSync(tmpFile, 'utf-8').trim();
        fs.unlinkSync(tmpFile);
        if (content) {
          setInputValue(content);
          addToast(`已加载 ${content.length} 字符`, 'success');
        }
      } catch {
        addToast('读取编辑器内容失败', 'error');
      }
    });

    child.on('error', () => {
      setEditorOpen(false);
      addToast(`无法启动编辑器: ${editor}`, 'error');
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    });
  }, [inputValue, addToast]);

  // ── 渲染 ────────────────────────────────────────────────────────────────

  // 帮助菜单覆盖层
  if (showHelp) {
    return React.createElement(CcHelpMenu, {
      version: options.version || '1.0.0',
      onClose: () => setShowHelp(false),
      width: layout.helpMenuWidth,
    });
  }

  // 命令面板覆盖层
  if (showCommandPalette) {
    return React.createElement(CcFuzzyPicker, {
      items: [
        { label: '/clear', value: 'clear', description: '清除对话历史' },
        { label: '/compact', value: 'compact', description: '压缩对话历史' },
        { label: '/cost', value: 'cost', description: '查看 token 用量' },
        { label: '/model', value: 'model', description: '切换 AI 模型' },
        { label: '/mcp', value: 'mcp', description: 'MCP 服务器管理' },
        { label: '/permissions', value: 'permissions', description: '权限设置' },
      ],
      onSelect: (item) => {
        setShowCommandPalette(false);
        addToast(`执行: ${item.label}`, 'info');
      },
      onClose: () => setShowCommandPalette(false),
      maxWidth: layout.helpMenuWidth,
    });
  }

  // 权限提示覆盖层
  if (permissionPrompt) {
    return React.createElement(CcPermissionPrompt, {
      question: permissionPrompt.question,
      options: permissionPrompt.options,
      onSelect: (value) => {
        permissionPrompt.onSelect?.(value);
        setPermissionPrompt(null);
      },
      onCancel: () => setPermissionPrompt(null),
    });
  }

  // 转录视图覆盖层（Ctrl+O，Claude Code 对齐）
  if (showTranscript) {
    return React.createElement(CcTranscriptView, {
      messages: messages.map((m) => ({
        ...m,
        timestamp: m.timestamp || (typeof m.id === 'number' ? m.id : Date.now()),
      })),
      onClose: () => setShowTranscript(false),
    });
  }

  // 外部编辑器覆盖层（Ctrl+E，OpenCode / Claude Code 对齐）
  if (editorOpen) {
    return React.createElement(Box, { flexDirection: 'column', flexGrow: 1 },
      React.createElement(Box, { paddingX: 1, paddingY: 1 },
        React.createElement(Text, { bold: true, color: CC_COLORS.brand }, '外部编辑器'),
        React.createElement(Text, { color: CC_COLORS.dimColor }, '  '),
        React.createElement(Text, { color: CC_COLORS.textSecondary }, `正在 ${process.env.VISUAL || process.env.EDITOR || 'vim'} 中编辑...`),
      ),
      React.createElement(Box, { paddingX: 1 },
        React.createElement(Text, { color: CC_COLORS.dimColor }, '保存并关闭编辑器以继续'),
      ),
    );
  }

  // 主布局
  return (
    React.createElement(Box, { flexDirection: 'column' },
      // Logo / 欢迎区
      React.createElement(CcLogo, { subtitle: true }),

      // 消息区域
      React.createElement(Box, { flexDirection: 'column', flexGrow: 1 },
        // 父子 Agent 工具树（ZCode 对齐：可视化多智能体层级）
        subAgents.length > 0
          ? React.createElement(AgentTree, {
              agents: subAgents,
              expanded: agentTreeExpanded,
              live: busy,
            })
          : null,
        messages.map(msg =>
          msg.role === 'user'
            ? React.createElement(Box, { key: msg.id, marginTop: 1 },
                React.createElement(Text, null, msg.text),
              )
            : React.createElement(CcAssistantMessage, {
                key: msg.id,
                text: msg.text,
              })
        ),
        busy
          ? React.createElement(CcStreamingMessage, { text: '思考中...' })
          : null,
      ),

      // 消息横幅
      messageBar
        ? React.createElement(CcMessageBar, {
            type: messageBar.type,
            message: messageBar.message,
            suggestion: messageBar.suggestion,
            onClose: () => setMessageBar(null),
          })
        : null,

      // Toast 容器
      React.createElement(CcToastContainer, {
        toasts,
        onDismiss: dismissToast,
      }),

      // 状态栏
      React.createElement(CcStatusLine, {
        modelId,
        contextUsed,
        cost,
        cols,
        permissionProfile,
        cacheHitRate,
        vimMode,
        taskEstimate: subAgents.length > 0
          ? formatDuration(
              subAgents.reduce((sum, a) => {
                const est = a.steps ? estimateAllAgents([a])[0]?.seconds || 0 : 0;
                return sum + est;
              }, 0),
            )
          : null,
      }),

      // 输入框
      React.createElement(CcPromptInput, {
        value: inputValue,
        onChange: setInputValue,
        onSubmit: handleSubmit,
        busy,
        cols,
        maxRows: layout.inputMaxHeight,
        vimEnabled,
        onVimModeChange: setVimMode,
      }),
    )
  );
}

// 直接导出组件（不是对象），与 App.js 的 module.exports = App 保持一致
// 注意：不能在这里包 React.memo，否则 module.exports 是对象而非函数
module.exports = CcApp;
