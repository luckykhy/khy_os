# khy-os 桌面端调研档案（desktop-rd）

> 调研日期: 2026-08-31
> 调研者: Claude Code
> 触发: 用户希望给 khy-os 加独立桌面端，参考 D:\Portable\4-output\ZCode-UI\running\ 截图风格
> 目标: 把"桌面端路线选型"需要的参考项目材料归档到此，等用户/团队评审后再进入实施

## 一、为什么存在这个目录

khy-os 当前形态：

| 用户面 | 入口 | 形态 |
|--------|------|------|
| **CLI 终端** | `khy` / `khyquant` 命令 | Ink (React) TUI + `bin/khy.js:1192 startRepl()` |
| **Web UI** | 浏览器访问 `http://localhost:3000` | Vue 3 SPA + Element Plus + `apps/ai-frontend/` |
| **移动端** | `apps/khy-mobile/release/*.apk` | Capacitor + Android WebView |
| **桌面端** | ❌ 无 | 全仓零 `electron`/`tauri`/`wails`/`neutralino`/`nwjs` |

**唯一移动壳是 Capacitor**，桌面壳**完全空缺**。这是用户希望填补的空白。

后端已经是 **Express + ws 同进程**形态（`services/backend/server.js`），已经托管前端 dist、已经有 `IDLE_SHUTDOWN_MS=60000` 自动关停、已经有 `bin/khy.js:1100-1194` 的"spawn 后端 + 探测端口 + 拉前端"路径——**桌面壳嵌入后端的工程阻力非常低**。

## 二、调研结论：4 个核心参考项目

| 排序 | 项目 | Stars | 技术栈 | 与 khy-os 的关系 | 价值 |
|------|------|------:|--------|------------------|------|
| ① | [OpenFlux](openflux/) | 225 | **Tauri v2** + Rust + 内嵌 Node.js Sidecar | **架构同构**（Tauri v2 壳 + Node.js AI Gateway） | 最直接、最可抄 |
| ② | [goose](goose/) | 53.7k | **Electron 43** + React 19 + Express + 多 LLM | 后端结构同构（Express + ws） | 工程化最成熟、企业级 |
| ③ | [ChatML](chatml/) | 48 | **Tauri 2** + Go Backend + Claude Agent SDK | 多层架构清晰、Provider 两层抽象 | 架构哲学参考 |
| ④ | [one-api](one-api/) | 36.7k | Go + React + 多 LLM 网关 | khy-os 前端视觉风格的源头 | 设计 token 追溯 |
| 附 | [kbar](cmdk/) | — | React  Cmd+K 覆盖层 | ZCode 风格的关键组件 | UI 组件参考 |

> 完整 README + 关键源码 + 架构对比都在各子目录下。

## 三、目标视觉风格：ZCode 3.10.1

源: `D:\Portable\4-output\ZCode-UI\running\` 14 张截图

| 维度 | 描述 |
|------|------|
| 主题 | **强制深色**（黑底贯穿） |
| 整体调性 | IDE 风 + 极简控制台（Cursor/VSCode 骨架） |
| 侧栏 | 4 主功能图标 + 任务分组 + 项目树 + 用户头像 |
| 顶栏 | 单行面包屑 + ⚙/🗗 |
| 中央 | 巨幅时段问候 + 渐变 logo 水印 + 居中圆角输入框 + 快捷入口胶囊 |
| 主色 | **暖橙 #f76b1c**（发送按钮 / Ctrl+K 选中条 / 限额警示 / 链接） |
| Ctrl+K | 屏幕正中毛玻璃弹窗（4 标签 + 最近任务 + 建议 + 面板） |
| 对话页 | 用户消息 + AI 长响应（含"测试/验证"章节 + 命令徽章）+ 限额提示 |
| 自动化页 | "还没有定时任务"卡片 + 模板卡 |
| 字体 | 正文系统中文；代码 **JetBrains Mono** 等宽 |
| 密度 | 比 EP 默认稍紧凑；圆角 10-12px；hairline `#2a1a1a` |

## 四、技术路线推荐（待用户决策）

### 路线 A：Electron + 内嵌现有 Vue + 内嵌 Node 子进程（**复用度 95%**）

- **优点**：零改动现有前端 dist 和 Express server.js；xterm/剪贴板/通知/tray 都能补
- **代价**：包大 ~150-200MB，内存 200-400MB
- **关键参考**：goose（IPC 体系）+ kbar（Ctrl+K）

### 路线 B：Tauri 2 + 现有 Vue + Rust 命令层（**复用度 85%**）

- **优点**：包小 ~10MB，内存低；与 OpenFlux 路径同构
- **代价**：需新建 Rust 工程、首次编译慢
- **关键参考**：OpenFlux（架构完全同构）+ ChatML（多层架构）

### 路线 C：先出原型（MVP），路线后面再定

- 先用 Electron 跑通"启动后端 + 打开窗口 + Ctrl+K 搜索"
- 一周后决定是否切 Tauri

## 五、khy-os 桌面端 v1 候选 IPC 清单

> 直接借自 goose `ui/desktop/src/main.ts:130-1100` 的 IPC 体系
> 这是 v1 必须有的最小集合

| IPC | 用途 | 优先级 |
|-----|------|--------|
| `open-external` | 打开外部 URL（白名单过滤） | |
| `directory-chooser` / `select-file-or-directory` | 选目录/文件 | |
| `read-goosehints` / `write-goosehints` | per-project hints | |
| `check-ollama` | 检 ollama 是否在跑 | |
| `set-menu-bar-icon` / `set-dock-icon` | 托盘/macOS dock | |
| `set-wakelock` | 电源锁（防休眠中断长任务） | |
| `set-spellcheck` | 拼写检查 | |
| `show-message-box` / `show-save-dialog` | 系统对话框 | |
| `restart-app` / `reload-app` | 重启/重载 | |
| `create-chat-window` / `close-window` | 多窗口 | |
| `react-ready` | 渲染端"准备好了" | |
| `broadcast-theme-change` | 跨窗口广播主题 | |
| `select-import-session-file` | 导入会话 | |
| `open-url` (khy://) | 协议 deeplink | |
| `get-setting` / `set-setting` | 设置持久化 | |
| `get-allowed-extensions` | 远端拉白名单（供应链安全） | |

## 六、给 khy-os 的"零硬编码"对接点

桌面壳要从 `services/backend/server.js` 拿到 **真实端口**——绝对不能硬编码 9090/3000：

```typescript
// 桌面壳启动时
const runtime = JSON.parse(await fs.readFile(join(userData, 'ai_manage_runtime.json'), 'utf8'));
const backendPort = runtime.port;  // ← 真实端口
window.loadURL(`http://127.0.0.1:${backendPort}`);
```

这条路径 khy-os 已经有 `apps/ai-frontend/backendDiscovery.mjs:29-38` 的 mirror pattern。

## 七、桌面端 vs 现有能力对照

| 能力 | 现状 | 桌面端增量 |
|------|------|------------|
| 多 LLM | ✅ | 0 |
| 长记忆 / 轨迹 | ✅ `khy-Trajectory/` | 0 |
| MCP 协议 | ✅ | 0 |
| 浏览器自动化 | ✅（部分） | Tauri/Electron 内嵌浏览器 |
| 鼠标键盘控制 | ❌（DESIGN-ARCH-056 留接口） | 增量补 |
| 语音 | ❌ | Tauri/Electron 麦克风 |
| Office 插件 | ❌ | 远期 |
| 多窗口 | ❌ | IPC 体系增量 |
| 系统托盘 | ❌ | tray icon |
| 全局快捷键 | ❌ | `globalShortcut` |
| 协议 deeplink | ❌ | `khy://` 注册 |
| Auto-update | ❌ | electron-updater / Tauri updater |

## 八、待用户/团队决策

1. **技术路线**：A (Electron) / B (Tauri 2) / C (MVP 先出) — 已初步倾向 A（推荐路线），但用户暂未决定
2. **主题风格**：保留 khy 蓝 / 切 ZCode 暖橙 / 双主题可切 — **用户已选"先不急"**
3. **下一步**：用户希望**先把参考项目保存到本地**（当前文档所在目录），然后再决定方案

## 九、文件清单

```
extensions/scripts/khy-desktop-rd/
├── README.md                          # 本文件
├── openflux/                          # ① OpenFlux（Tauri v2 + Node Sidecar）
│   ├── README.md                      #   详细对比 + 关键启示
│   ├── tauri.conf.json                #   完整配置（含 bundle.resources 内嵌 node.exe）
│   ├── Cargo.toml                     #   Rust 依赖（axum + tungstenite + rcgen 自签）
│   ├── lib.rs                         #   主入口（Sidecar spawn 模式）
│   └── package.json
├── goose/                             # ② goose（Electron 43 + 多 LLM）
│   ├── README.md                      #   详细对比 + 关键启示
│   ├── package.json                   #   完整依赖（React 19 + Radix UI）
│   └── main-pattern-extract.ts        #   menuT + Quick Launcher + IPC 体系三段
├── chatml/                            # ③ ChatML（Tauri 2 + Go + Agent SDK）
│   ├── README.md                      #   详细对比 + 关键启示
│   └── ARCHITECTURE.md                #   官方架构文档
├── one-api/                           # ④ one-api（khy-os 视觉风格源头）
│   ├── README.md                      #   详细对比 + 关键启示
│   └── App.js                         #   路由清单（参考）
└── cmdk/                              # 附 kbar（Cmd+K 覆盖层）
    └── README.md                      #   ZCode 风格组件范式
```

## 十、抓取来源（所有素材均为 2026-08-31 抓取自 GitHub）

- OpenFlux: <https://github.com/EDEAI/OpenFlux>
- goose: <https://github.com/aaif-goose/goose>
- ChatML: <https://github.com/chatml/chatml>
- one-api: <https://github.com/songquanpeng/one-api>
- kbar: <https://github.com/timc1/kbar>