// 抓取自 https://raw.githubusercontent.com/aaif-goose/goose/main/ui/desktop/src/main.ts
// 仅保留 khy-os 桌面端调研相关的 3 段范式：
//   A. Native menu 中英文翻译 (menuT + translateMenuLabels)
//   B. Quick Launcher 独立透明窗口
//   C. IPC 体系（renderer → main 的所有 invoke/on 频道清单）
//
// 主文件是 1300+ 行，此处精剪到 ~200 行核心模式。

import type { IpcMainInvokeEvent, OpenDialogOptions, OpenDialogReturnValue } from 'electron';
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, MenuItem,
         net, Notification, powerMonitor, powerSaveBlocker, screen, session, shell, Tray } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn, execFile } from 'child_process';
import fsSync from 'node:fs';

// =======================================================================
// A. Native menu 中英文翻译
// -----------------------------------------------------------------------
// Electron 的主进程用不了 react-intl（那是 renderer 的），native menu 只能
// 手工维护一份字典。仅简体中文化，其他 locale 走英文。
// =======================================================================

const MENU_TRANSLATIONS_ZH_CN: Record<string, string> = {
  File: '文件', Edit: '编辑', View: '视图', Window: '窗口', Help: '帮助',
  'Add to dictionary': '添加到词典', Cut: '剪切', Copy: '复制', Paste: '粘贴',
  'New Window': '新建窗口', Settings: '设置',
  'Find…': '查找…', 'Find Next': '查找下一个', 'Find Previous': '查找上一个',
  'Use Selection for Find': '用所选内容查找', Find: '查找',
  'New Chat': '新建聊天', 'New Chat Window': '新建聊天窗口',
  'Open Directory...': '打开目录…', 'Recent Directories': '最近的目录',
  'Focus Goose Window': '聚焦 Goose 窗口',
  'Quick Launcher': '快速启动器',
  'Always on Top': '窗口置顶', 'Toggle Navigation': '切换导航',
  'About Goose': '关于 Goose',
  Undo: '撤销', Redo: '重做', 'Select All': '全选', Delete: '删除',
  Speech: '语音', Reload: '重新加载', 'Force Reload': '强制重新加载',
  'Toggle Developer Tools': '切换开发者工具',
  'Actual Size': '实际大小', 'Reset Zoom': '重置缩放',
  'Zoom In': '放大', 'Zoom Out': '缩小',
  'Toggle Full Screen': '切换全屏', 'Toggle Fullscreen': '切换全屏',
  Minimize: '最小化', Close: '关闭', 'Close Window': '关闭窗口',
  Quit: '退出', Exit: '退出', 'Bring All to Front': '全部置于最前',
  'Emoji & Symbols': '表情符号', 'Start Dictation…': '开始听写…',
  'Hide Goose': '隐藏 Goose', 'Hide Others': '隐藏其他', 'Show All': '全部显示',
  Services: '服务',
};

function detectMenuLocale(): string {
  // 从 settings.json 读 GOOSE_LOCALE 配置
  return getConfiguredGooseLocale() ?? 'en';
}

function menuT(label: string): string {
  const lower = detectMenuLocale().replace(/_/g, '-').toLowerCase();
  const isTraditional = /^zh-(hant|tw|hk|mo)\b/.test(lower);
  const isSimplifiedChinese = !isTraditional && (lower === 'zh' || lower.startsWith('zh-'));
  if (isSimplifiedChinese) {
    return MENU_TRANSLATIONS_ZH_CN[label] ?? label;
  }
  return label;
}

function translateMenuLabels(items: MenuItem[]): void {
  for (const item of items) {
    if (item.label) {
      const translated = menuT(item.label);
      if (translated !== item.label) {
        // MenuItem.label 在主进程是 writable，但 TS 类型有时不对，cast 一次
        (item as unknown as { label: string }).label = translated;
      }
    }
    if (item.submenu?.items) {
      translateMenuLabels(item.submenu.items);
    }
  }
}


// =======================================================================
// B. Quick Launcher 独立透明窗口
// -----------------------------------------------------------------------
// 这正是 ZCode 截图里 Ctrl+K 搜索覆盖层的桌面端实现。Goose 用的是"独立
// BrowserWindow + transparent + alwaysOnTop + 失焦自销"，对标 macOS Spotlight。
// =======================================================================

let activeLauncherWindow: BrowserWindow | null = null;

const createLauncher = () => {
  if (activeLauncherWindow && !activeLauncherWindow.isDestroyed()) {
    activeLauncherWindow.focus();
    return activeLauncherWindow;
  }

  const launcherWindow = new BrowserWindow({
    width: 600, height: 80,
    frame: false,
    transparent: process.platform === 'darwin',
    backgroundColor: process.platform === 'darwin' ? '#00000000' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      partition: 'persist:goose',
    },
    skipTaskbar: true,
    alwaysOnTop: true,
    resizable: false, movable: true,
    minimizable: false, maximizable: false, fullscreenable: false,
    hasShadow: true,
    vibrancy: process.platform === 'darwin' ? 'window' : undefined,
  });

  // 居中放在屏幕 1/3 位置（Spotlight 风格）
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  const windowBounds = launcherWindow.getBounds();
  launcherWindow.setPosition(
    Math.round(width / 2 - windowBounds.width / 2),
    Math.round(height / 3 - windowBounds.height / 2),
  );

  // 加载 Quick Launcher 路由
  const url = getAppUrl();
  url.hash = '/launcher';
  launcherWindow.loadURL(formatUrl(url));
  activeLauncherWindow = launcherWindow;

  // 失焦自动销毁
  launcherWindow.on('blur', () => launcherWindow.destroy());
  launcherWindow.on('closed', () => {
    reactReadyWindows.delete(launcherWindow.id);
    activeLauncherWindow = null;
  });
  // ESC 关闭
  launcherWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'Escape') { launcherWindow.destroy(); event.preventDefault(); }
  });

  return launcherWindow;
};


// =======================================================================
// C. IPC 体系（renderer → main 的所有 invoke/on 频道清单）
// -----------------------------------------------------------------------
// 这一份几乎是 khy-os 桌面端 v1 的 todo list
// =======================================================================

// --- 单向通知（renderer → main，fire-and-forget） ---
ipcMain.on('react-ready', (event) => { /* 渲染端报告"我准备好了" */ });
ipcMain.on('close-window', (event) => { /* 关窗 */ });
ipcMain.on('notify', (event, data) => { /* 系统通知 */ });
ipcMain.on('logInfo', (_event, info) => { /* log 转发 */ });
ipcMain.on('broadcast-theme-change', (event, themeData) => { /* 跨窗口广播主题 */ });
ipcMain.on('reload-app', (event) => { /* 重载窗口 */ });
ipcMain.on('open-in-chrome', (_event, url) => { /* 外部 Chrome 打开 URL */ });
ipcMain.on('restart-app', () => { /* 重启应用 */ });
ipcMain.on('get-app-version', (event) => { /* 获取版本号 */ });
ipcMain.on('get-app-locale', (event) => { /* 获取 locale */ });
ipcMain.on('create-chat-window', (event, options) => { /* 新建聊天窗口 */ });

// --- 调用-返回（renderer → main，Promise） ---
ipcMain.handle('open-external', async (event, url) => { /* 打开外部 URL */ });
ipcMain.handle('directory-chooser', async () => { /* 选目录 */ });
ipcMain.handle('add-recent-dir', (_event, dir) => { /* 记录最近目录 */ });
ipcMain.handle('list-recent-dirs', () => { /* 列最近目录 */ });
ipcMain.handle('list-git-worktree-dirs', async (_event, dir) => { /* 列 git worktree */ });
ipcMain.handle('get-setting', (_event, key) => { /* 读设置 */ });
ipcMain.handle('set-setting', (_event, key, value) => { /* 写设置 */ });
ipcMain.handle('get-secret-key', (event) => { /* 后端 secret key */ });
ipcMain.handle('get-acp-url', async (event) => { /* ACP WebSocket URL */ });
ipcMain.handle('set-menu-bar-icon', async (_event, show) => { /* 托盘 */ });
ipcMain.handle('get-menu-bar-icon-state', () => { /* 托盘状态 */ });
ipcMain.handle('set-dock-icon', async (_event, show) => { /* macOS dock */ });
ipcMain.handle('get-dock-icon-state', () => { /* macOS dock 状态 */ });
ipcMain.handle('open-notifications-settings', async () => { /* 通知设置 */ });
ipcMain.handle('set-wakelock', async (_event, enable) => { /* 电源锁 */ });
ipcMain.handle('get-wakelock-state', () => { /* 电源锁状态 */ });
ipcMain.handle('set-spellcheck', async (_event, enable) => { /* 拼写检查 */ });
ipcMain.handle('get-spellcheck-state', () => { /* 拼写检查状态 */ });
ipcMain.handle('is-any-window-focused', () => { /* 是否有窗口聚焦 */ });
ipcMain.handle('get-is-fullscreen', (event) => { /* 是否全屏 */ });
ipcMain.handle('select-file-or-directory', async (_event, defaultPath) => { /* 选文件或目录 */ });
ipcMain.handle('select-recipe-file', async (event) => { /* 选 recipe YAML */ });
ipcMain.handle('read-goosehints', async (event) => { /* 读 per-project hints */ });
ipcMain.handle('write-goosehints', async (event, content) => { /* 写 per-project hints */ });
ipcMain.handle('select-import-session-file', async () => { /* 选导入的会话文件 */ });
ipcMain.handle('check-ollama', async () => { /* 检查 ollama 是否在跑 */ });
ipcMain.handle('write-file', async (_event, filePath, content) => { /* 写文件 */ });
ipcMain.handle('ensure-directory', async (_event, dirPath) => { /* 确保目录存在 */ });
ipcMain.handle('list-files', async (_event, dirPath, extension) => { /* 列文件 */ });
ipcMain.handle('show-message-box', async (_event, options) => { /* 系统消息框 */ });
ipcMain.handle('show-save-dialog', async (_event, options) => { /* 系统保存对话框 */ });
ipcMain.handle('get-allowed-extensions', async () => { /* 远端拉白名单 */ });
ipcMain.handle('open-directory-in-explorer', async (_event, path) => { /* 文件管理器打开 */ });
ipcMain.handle('launch-app', async (event, gooseApp) => { /* 启动 MCP 子应用 */ });
ipcMain.handle('refresh-app', async (_event, gooseApp) => { /* 刷新 MCP 子应用 */ });
ipcMain.handle('close-app', async (_event, appName) => { /* 关闭 MCP 子应用 */ });