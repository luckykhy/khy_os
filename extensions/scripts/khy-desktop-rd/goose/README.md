# goose — 桌面 + CLI + API 三端 AI Agent（Electron）

> 调研日期: 2026-08-31
> 仓库: <https://github.com/aaif-goose/goose>（注：项目刚迁移到 Linux Foundation Agentic AI Foundation，组织从 block → aaif-goose）
> 官网: <https://goose-docs.ai>
> License: Apache-2.0
> Stars: 53.7k · Forks: 6.2k · 5,548 commits
> 调研目录: `ui/desktop/`

## 一、为什么列为第二位

goose 是 **当下 GitHub 上最成熟、企业级使用规模最大** 的桌面 AI Agent 客户端（Block 公司出品，迁移到 Linux Foundation AAIF）。和 OpenFlux 的"AI Gateway"路线不同，goose 走的是"**进程化后端（goose serve）+ TLS 加密回环**"的更工程化路线。技术栈用 Electron 43（不是 Tauri），但其工程化深度远超 OpenFlux。

## 二、技术栈

```
┌─────────────────────────────────────────┐
│ Electron 43 桌面壳（macOS/Win/Linux）│
├─────────────────────────────────────────┤
│ React 19 + Tailwind 4 + Radix UI │
│ Zustand 状态 + SWR 数据 │
├─────────────────────────────────────────┤
│ Express 5（goose serve，TLS + WS）│ ← 与 khy-os backend 形态几乎一致
├─────────────────────────────────────────┤
│ Claude Agent SDK / 多 LLM │
└─────────────────────────────────────────┘
```

## 三、关键技术点（节选自 `ui/desktop/package.json` 与 `src/main.ts`）

### 3.1 goose serve 作为外部可独立运行后端

goose 的核心创新：**后端不只是 Electron 内嵌的，还能跑成独立进程**（"goose serve"命令）。Electron 主进程通过 TLS + shared secret 跟它通信。

源码模式（`ui/desktop/src/main.ts` 中反复出现）：

```typescript
// 外部 backend 配置
const getExternalBackendUrlFromEnv = (): string | null => {
  if (!process.env.GOOSE_EXTERNAL_BACKEND) return null;
  return `http://127.0.0.1:${process.env.GOOSE_PORT || '3000'}`;
};

const getServerSecret = (settings: Settings): string => {
  if (settings.externalGoosed?.enabled && settings.externalGoosed.secret) {
    return settings.externalGoosed.secret;
  }
  return GENERATED_SECRET;
};
```

**给 khy-os 的启示**：
- khy-os 已经有 `services/backend/server.js`（Express + ws 同进程），**结构形态一致**
- goose 的 `_external_` 模式更灵活：可以桌面壳，也可以独立进程
- khy-os 的 `bin/khy.js:1100-1194` 路径（"启动后端 spawn + 探测端口 + 浏览器打开"）和 goose 的 `startGooseServe` + `getLoginShellPath` 模式几乎可以 1:1 对照

### 3.2 TLS + 证书指纹（可信启动）

goose 把 backend 起成 HTTPS（自签证书），启动时通过 readiness probe 把证书指纹暴露给 Electron，Electron 端 pin 指纹做 TOFU（Trust On First Use）：

```typescript
// 指纹注册
const trustBackendCertificate = (hostname, fingerprint): BackendCertificateTrustRegistration => {
  const trust = { hostname: normalizeHostname(hostname), fingerprint: fingerprint ? normalizeFingerprint(fingerprint) : null };
  trustedBackendCertificates.add(trust);
  return { trust, release: () => trustedBackendCertificates.delete(trust) };
};

const verifyBackendCertificate = (hostname, fingerprint) => {
  // TOFU：首次握手后 pin 证书
  const tofuTrust = trusts.find(t => t.fingerprint === null);
  if (tofuTrust) {
    tofuTrust.fingerprint = normalizedFingerprint;
    return true;
  }
  return trusts.some(t => t.fingerprint === normalizedFingerprint);
};
```

**给 khy-os 的启示**：
- 这是**对 WebView2/AppContainer loopback 限制的一个工程解**（OpenFlux 用 `apply_loopback_exemption`，goose 用 TLS pin）
- khy-os 当前是 ws://127.0.0.1:3000——WebView2 直连 ws 没问题（HTTP 路径），**不需要上 TLS**；但 Electron 主进程接管 + Renderer 走 IPC 是更稳的方案（khy-os 可以借鉴）

### 3.3 Electron 主进程 IPC 体系

源码：`ui/desktop/src/main.ts` 是 1300+ 行的大文件，覆盖了：

| IPC 频道 | 用途 | khy-os 对应 |
|----------|------|------------|
| `open-external` | 打开外部 URL（白名单协议过滤） | 暂缺 |
| `directory-chooser` | 选目录 | 移动端 Shizuku 桥可对接 |
| `add-recent-dir` / `list-recent-dirs` | 最近目录持久化 | `khy-Trajectory/` 已有 |
| `read-goosehints` / `write-goosehints` | 读/写 per-project `.goosehints` | 可对照 `.khyos-hints` |
| `select-file-or-directory` / `select-recipe-file` | 文件选择 | 缺 |
| `select-import-session-file` | 导入会话文件 | khy-mobile 已有 |
| `check-ollama` | 检查 ollama 是否在跑（ps aux \| grep ollama） | 有适配器，可对照 |
| `write-file` / `ensure-directory` / `list-files` | 文件操作 | 缺 |
| `show-message-box` / `show-save-dialog` | 系统对话框 | 缺 |
| `get-allowed-extensions` | 远端拉白名单（HTTP fetch YAML） | 已有 |
| `set-wakelock` / `get-wakelock-state` | 电源锁（防止休眠） | 缺 |
| `set-spellcheck` / `get-spellcheck-state` | 拼写检查 | 缺 |
| `set-menu-bar-icon` / `get-menu-bar-icon-state` | 托盘图标 | 缺 |
| `set-dock-icon` / `get-dock-icon-state` | macOS dock 图标 | 不适用 |
| `launch-app` / `refresh-app` / `close-app` | 启动 MCP 子应用 | 缺 |
| `create-chat-window` / `close-window` | 多窗口 | 缺 |
| `react-ready` | 渲染端"我准备好了"信号 | 缺 |
| `restart-app` | 重启应用 | 缺 |
| `open-url` | 协议 deeplink 处理 | 缺 |

**给 khy-os 的启示**：这份 IPC 清单几乎是 khy-os **桌面端 v1 的 todo list**。

### 3.4 协议 deeplink（`goose://`）

goose 注册 `goose://` 协议，支持 `goose://bot/...`、`goose://recipe/...`、`goose://sessions/...`、`goose://extension/...`、`goose://new-session?prompt=...`、`goose://resume/<id>` 等子域名。

```typescript
app.on('open-url', async (_event, url) => {
  // macOS: 通过 open-url 事件接收
  // Windows: 通过 second-instance + argv
  // 单实例锁确保只有一个窗口
});
```

**给 khy-os 的启示**：桌面端的"分享会话链接"功能可以照搬这个模式（如 `khy://session/<id>`）。

### 3.5 多窗口隔离 + 进程级 lease

goose 设计了一个"goose serve lease"系统：

```typescript
const gooseServeLeases = new GooseServeLeaseRegistry(log);

// 每个 BrowserWindow 独立绑定一个 backend lease
gooseServeLeases.attachWindow(mainWindow.id, gooseServeLease);
mainWindow.on('closed', () => gooseServeLeases.releaseWindow(mainWindow.id));
```

**给 khy-os 的启示**：khy-os 当前是"一个 backend 进程服务所有 BrowserWindow"，未来如果要做"每个 session 一个后端"，lease 模式是个清晰的范式。

### 3.6 内置菜单中英文翻译（**特别有借鉴价值**）

goose 主进程不能跑 `react-intl`（那是渲染端的），于是维护了一份手工中英文映射表：

```typescript
const MENU_TRANSLATIONS_ZH_CN: Record<string, string> = {
  File: '文件', Edit: '编辑', View: '视图', Window: '窗口', Help: '帮助',
  'Add to dictionary': '添加到词典', Cut: '剪切', Copy: '复制', Paste: '粘贴',
  'New Window': '新建窗口', Settings: '设置',
  'Find…': '查找…', 'Find Next': '查找下一个', 'Find Previous': '查找上一个',
  // ...
  Undo: '撤销', Redo: '重写', 'Select All': '全选', Delete: '删除',
  Speech: '语音', Reload: '重新加载', 'Force Reload': '强制重新加载',
  'Toggle Developer Tools': '切换开发者工具',
  'Actual Size': '实际大小', 'Reset Zoom': '重置缩放',
  'Zoom In': '放大', 'Zoom Out': '缩小',
  'Toggle Full Screen': '切换全屏', Close: '关闭', 'Close Window': '关闭窗口',
  Quit: '退出', Exit: '退出',
  Minimize: '最小化',
  'Hide Goose': '隐藏 Goose', 'Hide Others': '隐藏其他', 'Show All': '全部显示',
  Services: '服务',
};

function detectMenuLocale(): string {
  return getConfiguredGooseLocale() ?? 'en';
}

function menuT(label: string): string {
  const lower = detectMenuLocale().replace(/_/g, '-').toLowerCase();
  const isSimplified = !/^zh-(hant|tw|hk|mo)\b/.test(lower) && (lower === 'zh' || lower.startsWith('zh-'));
  if (isSimplified) return MENU_TRANSLATIONS_ZH_CN[label] ?? label;
  return label;
}

function translateMenuLabels(items: MenuItem[]): void {
  for (const item of items) {
    if (item.label) {
      const translated = menuT(item.label);
      if (translated !== item.label) {
        (item as unknown as { label: string }).label = translated;
      }
    }
    if (item.submenu?.items) translateMenuLabels(item.submenu.items);
  }
}
```

**给 khy-os 的启示**：khy-os AGENTS.md 已经明确"中文界面"，如果未来上 Tauri/Electron，主进程的 native menu（macOS 应用菜单、Windows 系统菜单）必须做这个翻译。goose 的 `menuT()` + `translateMenuLabels()` 是直接可抄的范式。

### 3.7 快捷键 + Quick Launcher

goose 有一个独立的"快速启动器"窗口（`createLauncher()`）：

```typescript
const createLauncher = () => {
  const launcherWindow = new BrowserWindow({
    width: 600, height: 80,
    frame: false, transparent: process.platform === 'darwin',
    alwaysOnTop: true, resizable: false,
    hasShadow: true, vibrancy: process.platform === 'darwin' ? 'window' : undefined,
    skipTaskbar: true,
  });
  // 居中放在屏幕 1/3 位置
  const { width, height } = primaryDisplay.workAreaSize;
  launcherWindow.setPosition(
    Math.round(width / 2 - windowBounds.width / 2),
    Math.round(height / 3 - windowBounds.height / 2),
  );
  launcherWindow.loadURL(formatUrl({ ...url, hash: '/launcher' }));
  // 失焦或 ESC 自动销毁
  launcherWindow.on('blur', () => launcherWindow.destroy());
  // ESC 关闭
  launcherWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'Escape') { launcherWindow.destroy(); event.preventDefault(); }
  });
};
```

**给 khy-os 的启示**：这正好对标 ZCode 截图里的 **Ctrl+K 搜索覆盖层**。khy-os 可以借鉴 goose 的"独立透明小窗口 + 失焦自销"实现路径。

### 3.8 React 19 + Tailwind 4 + Radix UI + Lucide 图标

依赖清单关键项（节选）：

```json
{
  "@radix-ui/themes": "^3.3.0",
  "@tanstack/react-form": "1.33.5",
  "framer-motion": "^12.34.3",
  "lucide-react": "^0.575.0",
  "react": "^19.2.8",
  "react-dom": "^19.2.8",
  "react-router": "^8.3.0",
  "react-markdown": "^10.1.0",
  "react-intl": "^10.1.0",
  "tailwindcss": "^4.3.3",
  "zod": "^4.4.3",
  "date-fns": "^4.4.0"
}
```

**给 khy-os 的启示**：
- khy-os 现有 Vue + Element Plus 是另一条路线（不冲突）
- goose 走 React + Tailwind 4 + Radix Themes 是一套**非常适合深色 IDE 风的现代栈**
- 未来如果 khy-os 桌面端想用 Tailwind 直接对齐 ZCode 风，可以参考

### 3.9 Power Save Blocker（防休眠）

```typescript
const windowPowerSaveBlockers = new Map<number, number>(); // windowId -> blockerId
// 长任务跑时不休眠
const blockerId = powerSaveBlocker.start('prevent-app-suspension');
windowPowerSaveBlockers.set(windowId, blockerId);
mainWindow.on('closed', () => powerSaveBlocker.stop(blockerId));
```

**给 khy-os 的启示**：khy-os 的 AI 长对话 / 回测 / 训练跑时也可借鉴，防止 Windows 进入休眠中断任务。

### 3.10 Auto-Updater

```json
"electron-updater": "^6.8.9"
```

`UPDATES_ENABLED` 环境变量门控。goose 还做了**远端拉 allowlist**（`get-allowed-extensions`）：从 HTTP URL 拉 YAML 配置，限制允许安装的扩展命令，避免 supply-chain 攻击。

## 四、给 khy-os 的关键启示

1. **Tauri vs Electron 路线权衡更新**：goose 是当前最成熟的桌面 AI Agent 客户端，**它选 Electron 不是因为不想技术，而是因为**：
   - Electron 的 DevTools / 调试链路最成熟
   - electron-updater / electron-builder 的打包工程化最久
   - 跟 React/Next.js 生态完全对齐（很多 SaaS 团队熟悉）
2. **但 OpenFlux 走 Tauri 路线**也能跑通——给"小体积"诉求提供了选项
3. **khy-os 桌面端选 Electron 的强理由**：
   - 已经有 Vue 3 + Element Plus（团队熟）
   - 已经有 Express + ws 后端（结构同构）
   - Capacitor mobile 经验可迁移
4. **khy-os 桌面端选 Tauri 的强理由**：
   - 包体积（~10MB vs ~150MB）
   - 内存（~50MB vs ~300MB）
   - 跟 OpenFlux 一样内嵌 Node/Python

## 五、本地文件

| 文件 | 来源 |
|------|------|
| `package.json` | `ui/desktop/package.json` |
| `main.ts` | `ui/desktop/src/main.ts`（精剪版） |

抓取自 <https://raw.githubusercontent.com/aaif-goose/goose/main/>