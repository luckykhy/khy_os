# [DESIGN-ARCH-092] ZCode 1:1 复刻设计文档（完整版 v3）

> **目标**：以 KhyOS 桌面端壳（`apps/khyos-desktop/`）为交付物，对外呈现与 **ZCode Desktop v3.11.2** 完全一致的界面、交互、文案与数据契约。
> **方法**：解包 `C:\Program Files\ZCode\resources\app.asar`（307 MB，27 281 个文件）提取一手真源 + 官方站/更新日志交叉验证 + 竞品技术栈取证。
> **状态**：设计定稿，全部待实现（本仓库当前视为零基础）。
> **日期**：2026-09-08
> **取代**：v1～v17 合并版（其中第 一～十六 章像素级规格与 checklist 已丢失，本版全部重建）

---

## §0 执行指令（交给 AI 模型的第一条消息）

> **本节是整个文档的入口。** 如果你是 AI 编码助手，从这里开始执行。

### 0.1 你是谁

你是 khyos-desktop 项目的开发者。项目路径：`D:\Portable\khy-os\apps\khyos-desktop\`。
你的任务是按本文档的 Phase 顺序，逐步实现 ZCode 1:1 复刻。

### 0.2 执行规则

1. **严格按 Phase 顺序执行**，不要跳步。每个 Phase 完成后再进下一个。
2. **每完成一个 Phase**，运行该 Phase 末尾的「验收命令」。全部通过才提交。
3. **每完成一个 Phase**，运行 `node scripts/ci/check-agent-rules.js --changed` 确保零违规。
4. **提交格式**：`phase-N: <简述>`，例如 `phase-0a: scaffold 2-process skeleton`。
5. **遇到阻塞**：不要猜测，不要绕过。记录阻塞点，跳到下一个不依赖它的 Phase，最后回来处理。
6. **不要修改 `zcode-analysis/` 下的任何文件**——它们是只读真源。

### 0.3 Phase 顺序与依赖

```
Phase 0a  清场与两进程骨架 ──→ Phase 0b  加 preload ──→ Phase 0c  加 host 进程 ──→ Phase 0d  加 scheduler
    │                              │                         │                        │
    ▼                              ▼                         ▼                        ▼
Phase 1   设计令牌与主题          Phase 2   布局骨架      Phase 3   i18n 与组件库
    │                              │                         │
    ▼                              ▼                         ▼
Phase 4   任务侧栏与会话 ──→ Phase 5  Composer ──→ Phase 6  消息流
    │                              │                         │
    ▼                              ▼                         ▼
Phase 7   文件改动与终端 ──→ Phase 8  文件树/Diff/Git ──→ Phase 9  设置页
    │                              │                         │
    ▼                              ▼                         ▼
Phase 10  扩展能力 ──→ Phase 11  更新与进程管理 ──→ Phase 12  1:1 验收
```

### 0.4 验收命令清单（每个 Phase 结束时必跑）

```bash
# Phase 0a-0d: 骨架
npm run dev                              # renderer 能启动
npx electron .                           # 主进程能启动（或 npm run electron:dev）
node scripts/ci/check-agent-rules.js --changed

# Phase 1: 令牌
node scripts/ci/check-tokens.js          # 抽检 20 个令牌与 tokens.txt 一致

# Phase 3: i18n
node scripts/ci/check-i18n-fidelity.js   # 文案零 diff

# Phase 12: 最终验收
node scripts/ci/check-brand-replacement.js  # 品牌替换完整
node scripts/ci/check-agent-rules.js --changed
node scripts/ci/check-version-sync.js
```

### 0.5 关键文件速查

| 你需要的 | 在哪里 |
|---------|--------|
| CSS 令牌真源 | `zcode-analysis/tokens.txt` |
| 文案真源 | `zcode-analysis/i18n-zh.json`（5070 键） |
| RPC 方法真源 | `zcode-analysis/rpc-surface.json`（127 方法） |
| ZCode 解包产物 | `zcode-analysis/unpacked/`（只读参考） |
| 品牌替换规则 | §13.2 验收清单最后一项 |
| AGENTS.md 工程红线 | `../../AGENTS.md` |
| 本设计文档 | `docs/[DESIGN-ARCH-092] ZCode 1：1 复刻设计文档.md` |

---

## 证据强度标记约定

本文每一个可校验数值都带标记，读者据此判断可信度：

| 标记 | 含义 | 复现方式 |
|------|------|---------|
| `[asar]` | 从 ZCode 3.11.2 `app.asar` 内实际字节提取 | `zcode-analysis/asar-inspect.cjs` |
| `[i18n]` | 从 `IntlProvider-Db46X9QF.js` 的 5070 条键值对提取 | `zcode-analysis/extract-i18n.cjs` |
| `[css]` | 从 `styles-t2tKjMWX.css`（383 112 字节，572 条规则）提取 | `zcode-analysis/css-tokens.cjs` |
| `[setting]` | 从本机 `C:\Users\<user>\.zcode\v2\setting.json` 实读 | 直接 Read |
| `[官方]` | `zcode.z.ai` / `zcode.z.ai/changelog` 页面 | WebFetch |
| `[竞品]` | GitHub API + npm registry 实抓 | WebFetch |
| `[推断]` | 由上述证据合理推导，未直接观测 | 本文显式标注 |

**真源资产已落盘**（后续所有 Phase 都以这些文件为唯一依据，禁止凭记忆改数值）：

```
apps/khyos-desktop/zcode-analysis/
├── asar-inspect.cjs          # asar 只读检视（list/tree/sub/cat）
├── asar-extract.cjs          # asar 定向解包
├── css-tokens.cjs            # CSS 自定义属性按选择器分组提取
├── extract-i18n.cjs          # i18n 键值对提取（json/jsonl/tsv 三格式）
├── extract-rpc.cjs           # preload RPC 方法面提取
├── show-group.cjs            # i18n 命名空间过滤
├── count-namespaces.cjs      # 命名空间实测计数
├── verify-doc-claims.cjs     # 文档数值自检
├── tokens.txt                # 456 个 CSS 自定义属性，按选择器分组
├── i18n-zh.json              # 5070 条文案（嵌套对象）
├── i18n-zh.jsonl             # 5070 条文案（机器安全，单行一对象）
├── i18n-zh.tsv               # 5070 条文案（人工可读）
├── rpc-surface.json          # 127 个 RPC 方法标识符
├── rpc-surface.tsv           # 同上，含 invoke/on/send 计数
└── unpacked/                 # 定向解包产物
    ├── package.json          # ZCode 清单（1 442 字节）
    └── out/
        ├── main/index.js     # 主进程（1 493 013 字节）
        ├── host/index.js     # 宿主进程（2 308 292 字节）
        ├── scheduler/index.js# 调度进程（1 336 206 字节）
        ├── preload/index.cjs # Preload（507 670 字节）
        └── renderer/assets/
            ├── styles-t2tKjMWX.css          # 383 112 字节
            └── IntlProvider-Db46X9QF.js     # 660 390 字节
```

> **重要更正**：旧版文档假设 ZCode 是 Vue 栈并据此设计，**这是错的**。`package.json` 明确 `react: ^19.2.4` `[asar]`。本仓库现有 `src/**/*.vue` 实现应整体废弃重写，理由见 §3.8。

---

## 一、产品定位与复刻边界

### 1.1 ZCode 是什么

ZCode 是智谱（Zhipu AI / Z AI）围绕 GLM 系列模型构建的 **Agentic Development Environment（ADE）**。官方自我定位原文：「不是 IDE 插件，也不是命令行工具，而是智谱围绕 GLM-5.2 深度调优的 Agentic Development Environment」`[官方]`。

关键事实：

- 官网 `https://zcode.z.ai`，作者邮箱 `dev@zcode.z.ai`，包名 `@zcode/desktop`，`productName: "ZCode"`，`zcodeProductFlavor: "production"` `[asar]`。
- 当前版本 **3.11.2**，发布于 2026-09-04 `[官方]`。
- 界面主品牌为「ZAI」：主题类名 `.theme-zai-light` / `.theme-zai-dark` `[css]`。
- **它不是一个应用，而是一个进程家族 + 服务家族**。`package.json` 依赖里全是内部 workspace 包：`@zcode/client`、`@zcode/server`、`@zcode/services`、`@zcode/shared`、`@zcode/ui`、`@zcode/rpc`、`@zcode/zcode-cua`、`@zcode/e2e-report`，全部 `workspace:*` `[asar]`。

### 1.2 复刻范围：三圈模型

「1:1」在不同圈层有不同的含义与可行性，必须分开声明，否则计划不可验收。

**第一圈 — 必须 1:1（本计划的硬指标）**

| 维度 | 判定标准 | 证据真源 |
|------|---------|---------|
| 视觉 | 颜色/圆角/间距/字体/动效逐值一致 | `tokens.txt` |
| 几何 | 窗口、标题栏、侧栏、控件尺寸一致 | §5 |
| 文案 | 用户可见字符串逐字一致，含标点与空格 | `i18n-zh.json` |
| 信息架构 | 页面/面板/菜单/设置分组结构一致 | §7 |
| 交互 | 快捷键、模式切换、确认流、进度语义一致 | §7.3/7.6/7.31 |
| 数据契约 | 本地配置目录与字段名一致 | §9 |

**第二圈 — 必须等价但允许替换实现（架构对齐）**

进程模型（4 进程）、RPC 通道命名、SQLite 存储、checkpoint 撤销模型、hooks 事件名、MCP 协议协商、终端/高亮/diff 组件选型。见 §2、§3、§7.5、§7.8。

**第三圈 — 明确不复刻（能力边界）**

| 不复刻 | 原因 | 替代方案 |
|--------|------|---------|
| GLM 模型与推理能力 | 第三方服务，无本地复刻可能 | 接入 khy-os `aiGateway.js` 多供应商网关 |
| 智谱账号 / GLM Coding Plan 计费 | 商业服务 | khy-os 本地 Token 用量统计（`tokenUsageService.js`） |
| `@zcode/server` / `@zcode/zcode-cua` 实现 | 闭源后端 | khy-os 后端 + ZCode Computer Use 已在本仓库可用的会话内 |
| 品牌标识（ZCode 名称、Logo、GLM 图标素材） | 商标与美术作品著作权 | 全套自研资产，命名空间与布局等价 |
| ARMS RUM / OpenTelemetry 上报到智谱 | 第三方遥测 | khy-os 自有可观测性，默认关 |
| 飞书反馈表单、Discord/飞书社群链接 | 第三方资源 | 指向 khy-os 自有反馈渠道 |

> **合规提示**：第三圈中的品牌资产不可复用。本计划中所有涉及 `ZCode` / `GLM` 名称的字符串（如菜单「关于 ZCode」、`welcome.title: "Welcome to ZCode"`、图标文件名 `icon-glm-for-dark-*.png`）在实现时必须替换为 KhyOS 自有名称；替换清单见 §13.2 的 CI 校验项。UI 的**布局、结构、尺寸、交互、信息层级**不属于商标，可以等价实现。

### 1.3 与 KhyOS 的集成关系

KhyOS 是 AI 平台操作系统，桌面端壳是它的第 5 类前端入口。壳**不承载 Agent 逻辑**，只承载界面；Agent 能力全部委托给 KhyOS 后端。这与 ZCode 自身「shell 与 server 分离」的架构同构，因此 1:1 复刻在架构上是顺的。

调用路径按 AGENTS.md 五通道决策矩阵落地，见 §2.5。

---

## 二、进程与工程架构

### 2.1 四进程模型 `[asar]`

ZCode 不是 Electron 常见的「main + renderer」两进程，而是**四进程 + 五 preload**：

| 产物 | 体积 | 角色 |
|------|------|------|
| `out/main/index.js` | 1 493 013 B | 主进程：窗口、菜单、托盘、更新、系统能力、IPC 注册 |
| `out/host/index.js` | 2 308 292 B | 宿主进程：承载 `@zcode/server` / `@zcode/client`，与 renderer 走 RPC 而非 IPC |
| `out/scheduler/index.js` | 1 336 206 B | 调度进程：自动化、闲时任务、定时唤醒（对应 §7.19） |
| `out/preload/index.cjs` | 507 670 B | 主 preload，暴露 127 个 RPC 方法 |
| `out/preload/codingPlanWebview.cjs` | 489 055 B | 套餐/计费 WebView 专用 preload |
| `out/preload/processMonitor.cjs` | 487 526 B | 进程监视器窗口 preload |
| `out/preload/cuaPermissionPanel.cjs` | 487 266 B | 电脑控制权限面板 preload |
| `out/preload/embeddedBrowserJavaScriptDialog.cjs` | 489 815 B | 内置浏览器 JS 对话框 preload |
| `out/preload/browserVideoRecorder.cjs` | 140 B | 浏览器录制桥（极简，仅转发） |

另有独立 worker 与元数据：

- `out/main/browserWebmRecorder.js`（153 B）
- `out/main/zcodeDataSizeWorker.js`（303 B）
- `out/metadata/build-meta.json`（141 B）
- `out/.main-build-ready` / `.host-build-ready` / `.preload-build-ready` / `.scheduler-build-ready`（各 25 B）——**构建就绪标记文件**，运行时据此判断是否需要重建。

**设计含义**：`host` 进程的存在意味着 ZCode 把 Agent 运行时从 UI 进程里彻底剥离，UI 崩溃不丢 Agent 状态，Agent 高负载不卡 UI。这是复刻的关键架构决策，不是可选优化。

### 2.2 monorepo 包结构 `[asar]`

```
@zcode/desktop        ← 本壳（apps/khyos-desktop 对应物）
├── @zcode/client      UI ↔ server 客户端
├── @zcode/server      Agent 运行时服务
├── @zcode/services    领域服务层
├── @zcode/shared      跨进程共享类型
├── @zcode/rpc         RPC 传输定义（通道名、schema）
├── @zcode/ui          组件库（shadcn 之上的业务组件）
├── @zcode/zcode-cua   电脑控制（Computer Use）
├── @zcode/e2e-report  E2E 报告产物
```

注意 `@zcode/rpc` 单独成包 —— **通道名与 schema 是独立于两端的真源**。我们的复刻必须同样抽出一个 `khyos-desktop/shared/rpc/`，否则 main/host/renderer 三端会漂移。

### 2.3 从零建立的目录布局

```
apps/khyos-desktop/
├── package.json
├── electron.vite.config.ts
├── electron-builder.yml
├── tsconfig.json
├── src/
│   ├── main/                     # 主进程（对应 out/main）
│   │   ├── index.ts
│   │   ├── windows/              # BrowserWindow 工厂、多窗口管理
│   │   ├── menu/                 # File/View/Window/Help（§7.27）
│   │   ├── tray/                 # 托盘 + closeToTrayOnWindows
│   │   ├── updater/              # electron-updater 封装
│   │   ├── terminal/             # node-pty 宿主
│   │   ├── pty/                  # pty 平台分发
│   │   ├── filesystem/           # 文件读写、tree、目录选择器
│   │   ├── git/                  # git 命令封装 + gitGraph
│   │   ├── mcp/                  # MCP client（stdio/HTTP/SSE）
│   │   ├── browser/              # 内置浏览器控制 + 录制
│   │   ├── telemetry/            # 默认关的遥测开关
│   │   ├── checkpoints/          # checkpoint 快照与 rewind（§7.5）
│   │   ├── hooks/                # 7 事件钩子执行器（§7.8）
│   │   ├── bot/                  # 微信/飞书/Telegram 通道（§7.20）
│   │   ├── remote/               # 远程 Web 控制 relay（§7.21）
│   │   └── workers/
│   │       ├── dataSize.worker.ts
│   │       └── browserRecorder.ts
│   ├── host/                     # 宿主进程（对应 out/host）
│   │   ├── index.ts              # Agent 运行时适配（§2.5）
│   │   ├── bridge/               # khy-os 五通道适配器
│   │   └── session/
│   ├── scheduler/                # 调度进程（对应 out/scheduler）
│   │   ├── index.ts
│   │   ├── cron.ts               # 定时任务
│   │   └── offPeak.ts            # 闲时算力（§7.19）
│   ├── preload/
│   │   ├── index.ts              # 主 preload，127 RPC 方法
│   │   ├── codingPlanWebview.ts
│   │   ├── processMonitor.ts
│   │   ├── cuaPermissionPanel.ts
│   │   ├── embeddedBrowserDialog.ts
│   │   └── browserVideoRecorder.ts
│   ├── renderer/                 # UI
│   │   ├── index.html
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── i18n/                 # 82 命名空间，5070 键（§6）
│   │   ├── theme/                # 3 主题 + 令牌（§4）
│   │   ├── state/                # Redux Toolkit + RTK Query
│   │   ├── components/
│   │   │   ├── ui/               # shadcn/Radix 原子组件
│   │   │   ├── layout/           # TitleBar、Sidebar、SidePane
│   │   │   ├── composer/         # 输入框（§7.2）
│   │   │   ├── message/          # 消息与模型轨迹（§7.4）
│   │   │   ├── terminal/         # xterm 封装（§7.9）
│   │   │   ├── diff/             # 改动与 diff（§7.5）
│   │   │   ├── git/              # Git 面板 + graph
│   │   │   ├── settings/         # 设置页（§7.13）
│   │   │   ├── marketplace/      # 插件市场
│   │   │   ├── skills/  subagents/  mcp/
│   │   │   ├── browser/          # 浏览器控制（§7.16）
│   │   │   ├── automation/       # 自动化 + 闲时（§7.19）
│   │   │   ├── bot/              # Bot 通道（§7.20）
│   │   │   ├── remote/           # 远程控制（§7.21）
│   │   │   ├── wiki/             # Wiki/Memory（§7.22）
│   │   │   └── whiteboard/       # 白板（§7.23）
│   │   └── features/             # 按 feature 切片的 slices/components
│   ├── shared/                   # 对应 @zcode/shared + @zcode/rpc
│   │   ├── rpc/                  # 通道名 + zod schema（单一真源）
│   │   ├── types/
│   │   └── settings/             # setting.json schema
│   └── web/                      # 同源 Web 端（远程控制用，可选）
├── resources/
│   ├── icon/                     # 自研图标（禁用 ZCode 素材）
│   ├── tray/
│   └── config/
│       └── default.json          # 反馈/社区链接（指向 KhyOS）
└── zcode-analysis/               # 本计划的一手证据资产（保留）
```

### 2.4 与现有实现的差异

| 现有（废弃） | 目标 |
|-------------|------|
| `src/**/*.vue`（68 个 .vue 文件） | `src/renderer/**/*.tsx` |
| `src/stores/app.js`（Pinia 风格） | Redux Toolkit + RTK Query |
| `src/assets/zcode-precise.css`（凭截图取色） | `src/renderer/theme/` 基于 `tokens.txt` 逐值落地 |
| `src/assets/ycode-theme.css`（33 KB，名称有误） | 删除 |
| `electron/main.js`（24 KB，单进程） | 4 进程拆分 |
| `electron/preload.js`（5.5 KB） | 6 个 preload，127 RPC 方法 |
| `package.json` 无 electron-vite | `electron-vite 5.0.0` |

现有 `preview*.html`、`BUILD_README.md`、`build.log` 属于历史试验产物，与复刻无关，Phase 0 归档删除。

### 2.5 host 进程与 KhyOS 五通道桥接

ZCode 的 `host` 进程直连智谱后端；我们的 `host` 进程必须按 AGENTS.md 五通道决策矩阵把同类调用分流到 KhyOS：

| host 里的调用类别 | 走哪条通道 | 依据 |
|------------------|-----------|------|
| 需要改变状态的（发消息、建会话、写文件、撤销） | **CH-2 服务层直调** 或 **CH-3 CLI**（不同进程时） | 「写必走正门」，校验/审计/FSM 在门内 |
| 只读且 schema 稳定的（任务列表索引、会话元数据） | **CH-1 直接读状态文件** | 仅只读豁免 |
| 前端/流式/并发（AI 回复流、token 统计查询） | **CH-4 Web API**，不可达降级 CLI | 端点经 `serviceDefaults.js` / env |
| 人/脚本/CI 一次性操作 | **CH-3 CLI** | 走 `services/backend/bin/khy.js` |
| 需视觉验证的桌面操作 | **CH-5 desktopControl**（总闸 + safetyGate 审批） | 最后手段 |

硬约束继承自 AGENTS.md，实现时不得违反：

1. **零硬编码**：端点一律从 `services/backend/src/constants/serviceDefaults.js` 导入或 env 覆盖。KhyOS 生产域名字面量只允许存在于 `serviceDefaults.js`。
2. **状态透明**：所有 spinner / 进度 / 错误文案遵守「动作 + 目标 + 进度」，且**必须从 `i18n-zh.json` 取真值**——ZCode 自身的文案已经符合此规范（例：`正在重试压缩上下文（{attempt}/{maxAttempts}）`、`已运行 {minutes} 分 {seconds} 秒`、`重新连接中... {attempt}/{maxRetries}` `[i18n]`），照抄即天然合规。
3. **基于活动的超时**：Agent 循环、自动化任务禁止硬 kill，用空闲/滑动超时。
4. **终端渲染**：不用 ANSI 滚动区 `\x1B[n;mr`（除备用缓冲区全屏 UI）。这条对 xterm 组件是免费的（xterm 自带实现）。

---

## 三、技术栈与版本锁定

### 3.1 运行时与打包 `[asar]` `[竞品]`

| 组件 | 版本 | 证据 |
|------|------|------|
| React | `^19.2.4` | `package.json` `[asar]` |
| react-dom | `^19.2.4` | 同上 |
| Electron | 44.2.0 | 竞品调研当前稳定版；ZCode 未在本清单声明 |
| electron-vite | 5.0.0 | 竞品（Cherry/AionUi 同用） |
| electron-builder | **锁定 26.15.3** | v27 已发布但 latest 仍是 26.15.3，v27 有 ESM 破坏性变更 |
| electron-updater | 6.8.9 | ZCode 用 `^6.8.3` `[asar]` |
| TypeScript | 5.x | 由 @zcode/* 类型包推断 `[推断]` |

### 3.2 前端框架与 UI 库 `[asar]`（renderer 产物 + node_modules 文件名取证）

| 类别 | 库 | 证据 |
|------|-----|------|
| 样式 | **Tailwind CSS 4.2.2**（OKLCH，`@layer theme`） | CSS 首行注释 `[css]` |
| 状态 | @reduxjs/toolkit + RTK Query | `node_modules/@reduxjs/toolkit` |
| 原子组件 | shadcn/ui + Radix | `var(--radix-select-trigger-width)` 出现在产物中 `[css]` |
| 图标 | lucide-react（含 `dynamicIconImports`，按需动态导入） | node_modules |
| 动效 | framer-motion / motion（motion-dom 同源） | node_modules |
| 弹层定位 | @floating-ui/react | node_modules |
| 拖拽 | @dnd-kit/core | node_modules |
| 富文本 | @lexical/* + lexical-yjs（协同编辑） | node_modules |
| 图形画布 | @xyflow/react（React Flow）、@rive-app/webgl2（Rive）、regl | node_modules |

### 3.3 终端 `[asar]` `[竞品]`

| 组件 | 版本 | 说明 |
|------|------|------|
| @xterm/xterm | 6.0.0 | 已迁 `@xterm` scope；ZCode 产物为 `@xterm/xterm/lib/xterm.js` |
| addon-fit | 0.11.0 | 必装 |
| addon-web-links | 0.12.0 | |
| addon-search | 0.16.0 | 配合 `Ctrl+F` 对话内检索 |
| addon-webgl | 0.19.0 | 渲染性能 |
| node-pty | `^1.0.0`（ZCode）→ 建议 1.1.0 | ZCode 清单 `[asar]` |
| @lydell/node-pty-linux-* | 1.2.0-beta.10（ZCode）→ 1.2.0-beta.15 | **Linux 预编译包，ZCode 明确声明** `[asar]` |

**Windows 硬约束**：node-pty 已移除 `winpty`，改用 ConPTY，**要求 Windows 10 1809 (build 18309) 或更高**。编译需 Windows SDK「Desktop C++ Apps」+ Spectre-mitigated CRT。

### 3.4 Markdown / 高亮 / Diff `[asar]` `[竞品]`

ZCode 的 renderer 里**同时存在 shiki 和 highlight.js 两套语法文件**（产物中 `shiki` 语言包与 `highlight.js/es/languages/*` 并存，且每个语言都产出两份 chunk），说明双引擎并存是真实设计而非冗余。

| 组件 | 版本 | 用途 |
|------|------|------|
| shiki | 4.4.3 | 主引擎，TextMate 语法，与 VS Code 一致 |
| @shikijs/engine-oniguruma | 4.4.3 | wasm 解析器（产物 `wasm-BtdWojWb.js` 622 325 B） |
| highlight.js | 11.12.0 | 兜底引擎 |
| streamdown | 2.6.0 | **流式 Markdown**（peerDeps `react ^18\|\|^19`，ZCode 是 React 栈，可用） |
| @pierre/diffs | 1.4.1 | 语义 diff，产物 `wasm-BaDzIkIn.js` 622 581 B + `diffs.worker-CAavpt0L.js` 827 865 B |
| diff2html | 3.4.56 | 批量静态报告 |
| katex | 4.x | 数学公式（含 `katex` 中文变量） |
| mermaid | 11.x | 图表（架构/时序/流程图/C4/Gantt，产物含 `architectureDiagram-*`、`sequenceDiagram-*`、`cose-bilkent`） |

### 3.5 数据可视化 `[asar]`

ZCode 同时打进 **echarts（8 个 dist 变体）+ recharts + chart.js + zrender + d3-geo + world-atlas + us-atlas**，并有专用 chunk `treemapping`、`src-CdedQslh.js`、`chart-ChlBTCNY.js`。对应 i18n 命名空间 `treemapping`、`codeViewer`。

选型建议：echarts 为主（ZCode 同款），chart.js/recharts 仅在轻量场景按需引入，地图数据 `world-atlas`/`us-atlas` 改为按需拉取而非全量打包。

### 3.6 文档与媒体预览 `[asar]`

产物里有完整的 Office/PDF 预览栈，必须复刻（i18n 命名空间 `codeViewer`、`markdownImage`、`markdownTable` 对应）：

| 文件类型 | 库 | 证据（产物 chunk） |
|---------|-----|------|
| PDF | pdfjs-dist | `pdf-viewer-DQwxHgh0.js`、`pdf.worker.min-*.mjs` |
| XLSX | @extend-ai/react-xlsx + @dukelib/sheets-wasm | `previewPaneOfficeXlsxContent-*.js` 2 154 743 B |
| DOCX | @extend-ai/react-docx + docx-preview | `previewPaneOfficeLegacyDocContent-*.js` |
| PPTX | @aiden0z/pptx-renderer | `pptxRendererPreviewEngine-*.js` 1 042 714 B |

### 3.7 会话录制 `[asar]`

`rrweb` + `rrweb-snapshot` + `rrdom` 三件套全部打进产物。对应菜单项「开始性能录制 / 停止性能录制」`[i18n]`。

- rrweb 2.1.1，**分片写 userData 目录 + 后台合并 + 上限轮转**（高频小块 JSON 直写 SQLite 会锁库）。

### 3.8 可观测性 `[asar]`

| 库 | 版本 | 用途 |
|----|------|------|
| @arms/rum-electron | ^0.0.3 | 前端 RUM（阿里云 ARMS） |
| @arms/rum-browser | — | 浏览器端 RUM |
| @opentelemetry/api | 1.9.1 | 追踪 API |
| @opentelemetry/exporter-trace-otlp-proto | 0.214.0 | OTLP 导出 |
| @opentelemetry/resources / sdk-trace-base | 2.6.1 | 资源与 SDK |
| msw | 2.x | 开发期网络 mock（产物含 `msw/lib/iife/index.js` 999 322 B） |

**我们的策略**：保留 OpenTelemetry 的本地 span 采集能力，导出端默认关闭，改为可插拔 exporter；ARMS 不接入。`setting.json` 里没有遥测开关字段，但 `v2/telemetry-state.json`（96 B）存在，说明遥测状态持久化。我们应显式提供开关。

### 3.9 其他工具链 `[asar]`

`sharp 0.34.5`（图片处理）、`ssh2 ^1.16.0`（§7 的 SSH/远程）、`node-forge ^1.4.0`（TLS/证书，配合 `v2/certs/`）、`ws ^8.20.0`、`undici ^6.23.0`、`yaml ^2.9.0`、`yazl ^3.3.1`（zip 流式写入，用于导出）、`semver ^7.7.4`、`@fiahfy/icns ^0.0.7`（macOS 图标）、`@larksuiteoapi/node-sdk 1.61.1`（**飞书 Bot SDK，对应 §7.20**）、`playwright-core 1.59.1`（内置浏览器控制）、`tldts`、`zod`、`recast`、`@babel/parser`、`esprima`、`acorn`、`parse5`、`js-yaml`、`jszip`、`pako`、`fflate`。

另有 `@chenglou/pretext`（含 `pages/demos/masonry/shower-thoughts.json`）——一个文本排版库，用于长文本流式布局。

### 3.10 关键决策：为什么必须从 Vue 切到 React

这不是风格偏好，是复刻的硬约束：

1. **ZCode 真实栈是 React 19.2.4** `[asar]`，旧文档的 Vue 假设错误。
2. `streamdown`（流式 Markdown）peerDeps 仅 `react ^18\|\|^19`，Vue 侧不可用；ZCode 的流式渲染体验（`messageStreamShowReasoning`、分块思考轨迹）依赖它。
3. `@lexical/*`、`@xyflow/react`、`@aiden0z/pptx-renderer`、`@extend-ai/react-*`、`react-diff-viewer` 全部 React 原生。
4. i18n 产物是 `IntlProvider`（React Provider 模式），组件树假设为 React。
5. 用户已明确「默认 khy 现在什么都没有实现」，现有 68 个 .vue 文件无保留价值。

**结论**：Phase 0 删除 `src/**/*.vue` 与 `src/stores/`、`src/themes/`（TS 但与 ZCode 令牌体系冲突），重建为 React + Redux Toolkit。

### 3.11 依赖体积预算

ZCode 的 asar 达 307 MB，主要被以下吃满：

| 大户 | 体积 | 处置 |
|------|------|------|
| @shikijs/langs 全量语言 | ~20 MB | 改为按需 + 首屏 12 语言白名单 |
| mermaid 多 dist 变体 | 14 MB | 只留 `mermaid.core` + 按需 chunk |
| echarts 8 变体 | 22 MB | 只留 `echarts.min.js` |
| pdfjs-dist legacy + wasm | 12 MB | 保留（PDF 预览必需） |
| @extend-ai react-xlsx/docx/pptx | 9 MB | 保留但全部 dynamic import |
| msw iife | 1 MB | 从生产包剔除 |
| playwright-core | 7 MB | 仅「浏览器控制」功能开启时懒加载 |
| world-atlas / us-atlas | 15 MB | 改为按需 |
| highlight.js + shiki 双份语言包 | 重复 | 只保留 shiki，hljs 仅留兜底核心 |

**目标**：主 asar ≤ 120 MB（不含 playwright 与图表引擎），功能相关重依赖一律 dynamic import 成独立 chunk。

---

## 四、设计令牌规范

> 真源：`zcode-analysis/tokens.txt`（572 条规则，456 个自定义属性）。
> 本节所有数值为 `[css]` 证据，实现时必须逐字落地，不得"近似"。

### 4.1 主题机制

三个主题类，共存于同一无 `html.dark` 的体系（ZCode 不用 Tailwind 的 `dark:` 变体做主题切换，而是用自定义类覆盖语义令牌）：

```css
/* 默认浅色（:root） */
:root, :host {
  --color-header: var(--color-neutral-100);
  --color-panel:  var(--color-neutral-100);
  --color-sidebar: var(--color-neutral-100);
  --color-surface: #0a0a0a08;
  @supports (color: color-mix(in lab, red, red)) {
    --color-surface: color-mix(in oklab, var(--color-neutral-950) 3%, transparent);
  }
  --color-surface-hover: #0a0a0a0d;
}
.dark              /* 通用暗色（18 个规则块） */
.theme-zai-light   /* 品牌浅色（4+ 规则块） */
.theme-zai-dark    /* 品牌暗色（4+ 规则块） */
```

**实现要点**：
- 品牌浅色 = `.theme-zai-light`，品牌暗色 = `.theme-zai-dark`；`.dark` 是兜底通用暗色。
- 半透明一律用 8 位 hex（`#0a0a0a08`）+ `@supports color-mix(in oklab)` 渐进增强。**必须两个都写**，否则不支持 color-mix 的浏览器会退化为完全不透明。
- 主题切换只改 class，不换 CSS 文件，不发请求。
- `setting.json` 无 `theme` 字段，主题偏好应存在 `config.json`（19 KB，含 `reasoning.variants`）`[推断]`；实现时在我们自己的 `setting.json` 中显式加 `themeMode: "light" | "dark" | "system"`。

### 4.2 间距与圆角

```css
--spacing: .25rem;                 /* 4px 基单位，所有尺寸走 calc(var(--spacing) * N) */
--radius-xs: .125rem;              /* 2px */
--radius-sm: .25rem;               /* 4px */
--radius-md: .375rem;              /* 6px */
--radius-lg: .5rem;                /* 8px */
--radius-xl: .75rem;               /* 12px */
--radius-2xl: 1rem;                /* 16px */
--radius-3xl: 1.5rem;              /* 24px */
```

**与旧文档的差异**：旧文档写「列表项 6px、卡片 8px」是对的，但基单位是 `--spacing: .25rem` 且 Tailwind 间距全部走 `calc(var(--spacing) * N)`，不是写死 px。例如产物里有 `.platform-mac-desktop\:top-12 { top: calc(var(--spacing) * 12) }`、`translate-x: calc(var(--spacing) * -42)`。

### 4.3 字体

```css
--font-sans: ui-sans-serif, system-ui, sans-serif,
  "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";

--font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
  "Liberation Mono", "Courier New",
  "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC",
  monospace;
```

**关键细节**：等宽字体栈里显式塞了 4 个 CJK 字体（微软雅黑 UI / 微软雅黑 / 苹方 / Noto Sans CJK SC）。这是为了在代码块里出现中文时不出现字体跳变。必须原样保留——这是「1:1」里最容易被忽略但肉眼可辨的一项。

### 4.4 暗色语义令牌全表（`.theme-zai-dark` + `.dark`）

```css
/* 结构层 */
--color-background:          #161616;
--color-background-win-alt:  #2b2b2b;    /* Windows 标题栏备用背景 */
--color-header:              #202020;
--color-panel:               #202020;
--color-sidebar:             #161616;
--color-surface:             #ffffff0d;
--color-surface-hover:       #ffffff1a;
--color-card:                #2b2b2b;
--color-card-selected:       var(--color-input);
--color-card-border:         var(--color-border);
--color-popover:             #2b2b2b;
--color-popover-foreground:  var(--color-foreground);
--color-popover-header:      var(--color-neutral-700);
--color-popover-border:      var(--color-border);
--color-input:               var(--color-neutral-800);
--color-input-focused:       var(--color-neutral-950);
--color-input-border:        var(--color-border);
--color-input-border-hover:  var(--color-border-hover);
--color-input-border-focused: var(--color-brand);
--color-tab:                 #202020;
--color-tab-active:          #161616;
--color-tab-border:          var(--color-border);
--color-menu:                #2b2b2b;
--color-menu-hover:          #363636;

/* 前景与强调 */
--color-brand:               #fff;
--color-primary:             #fff;
--color-primary-foreground:  #000;
--color-secondary:           #363636;
--color-foreground:          var(--color-neutral-300);
--color-foreground-inverse:  #000;
--color-accent:              #001d3d;
--color-hover:               #ffffff0d;
--color-selected:            #ffffff1a;

/* 边框 */
--color-border:              #ffffff1a;
--color-border-hover:        #ffffff26;

/* 状态色 */
--color-success:             #46bf72;
--color-success-foreground:  #000;
--color-warning:             #ff8a30;
--color-warning-foreground:  #000;
--color-destructive:         #ff5c5c;
--color-destructive-foreground: #fff;
--color-idle-task:           #7b5ce5;
--color-idle-task-surface:   #160d38;

/* 查找高亮 */
--color-find-highlight:      #542500;
--color-find-highlight-active: #ff8a30;

/* 动效文字 */
--animated-gradient-text-strong: #fff;
--animated-gradient-text-soft:   #ffffff38;

/* Toast */
--color-toast:               #2b2b2b;
```

`.dark` 额外定义（通用暗色，与品牌暗色互补）：

```css
--color-background:   var(--color-neutral-900);
--color-header:       var(--color-neutral-900);
--color-panel:        var(--color-neutral-900);
--color-sidebar:      var(--color-neutral-950);
--color-card:         var(--color-neutral-800);
--color-card-selected: var(--color-neutral-700);
--color-input:        var(--color-neutral-800);
--color-input-focused: var(--color-neutral-950);
```

### 4.5 浅色语义令牌全表（`.theme-zai-light`）

```css
--color-background:          #f8f8f8;
--color-background-win-alt:  #ececee;
--color-header:              #fff;
--color-panel:               #fff;
--color-sidebar:             #f0f0f0;
--color-surface:             #0d0d0d08;
--color-surface-hover:       #0d0d0d0d;
--color-card:                #fff;
--color-card-selected:       var(--color-input);
--color-popover:             #fff;
--color-tab:                 #f0f0f0;
--color-tab-active:          #fff;
--color-menu:                #fff;
--color-menu-hover:          #f0f0f0;
--color-brand:               #000;
--color-primary:             #000;
--color-primary-foreground:  #fff;
--color-secondary:           #e6e6e6;
--color-foreground:          var(--color-neutral-800);
--color-foreground-inverse:  #fff;
--color-accent:              #ebf4ff;
--color-hover:               #0d0d0d0d;
--color-selected:            #0d0d0d0d;
--color-border:              #0d0d0d1a;
--color-border-hover:        #0d0d0d26;
--color-success:             #1e8a3e;
--color-warning:             #e07b00;
--color-destructive:         #e03131;
--color-idle-task:           #9e77ed;
--color-idle-task-surface:   #f5f3ff;
--color-find-highlight:      #fff4eb;
--color-find-highlight-active: #ffb26b;
--color-toast:               #fff;
--animated-gradient-text-strong: #0d0d0d;
--animated-gradient-text-soft:   #0d0d0d38;
```

### 4.6 轨迹 / 工具 / Git / 交互专用色

**模型轨迹（trajectory）** —— 对应 i18n 命名空间 `modelTrajectory`，用于渲染 Agent 的思考/动作时间线：

| 令牌 | 暗色 | 浅色 |
|------|------|------|
| `--color-trajectory-user` | `#60a5fa` | `#2563eb` |
| `--color-trajectory-assistant` | `#2dd4bf` | `#0f766e` |
| `--color-trajectory-reasoning` | `#a78bfa` | `#7c3aed` |
| `--color-trajectory-tool-call` | `#f59e0b` | `#d97706` |
| `--color-trajectory-tool-result` | `#38bdf8` | `#0284c7` |

**Diff**：

| 令牌 | 暗色 | 浅色 |
|------|------|------|
| `--color-diff-added` | `#46bf72` | `#1e8a3e` |
| `--color-diff-added-foreground` | `#000` | `#fff` |
| `--color-diff-removed` | `#ff5c5c` | `#e03131` |
| `--color-diff-removed-foreground` | `#000` | `#fff` |

**Git 状态**（8 态，对应 `git` / `gitGraph` 命名空间）：

| 令牌 | 暗色 | 浅色 |
|------|------|------|
| `--color-git-none` | `var(--color-foreground)` | 同 |
| `--color-git-modified` | `#ff8a30` | `#e07b00` |
| `--color-git-added` | `#46bf72` | `#1e8a3e` |
| `--color-git-deleted` | `#ff5c5c` | `#e03131` |
| `--color-git-renamed` | `#4099ff` | `#0b7fff` |
| `--color-git-untracked` | `#46bf72` | `#1e8a3e` |
| `--color-git-ignored` | `var(--color-foreground-subtlest)` | 同 |
| `--color-git-descendant` | `#ff8a30` | `#e07b00` |

**交互式提问（elicitation）两种语气** —— 这是 ZCode 的精细设计，「问」和「确认」用不同色温：

| 令牌 | 暗色 | 浅色 |
|------|------|------|
| `--color-interaction-ask-surface` | `#001d3d` | `#ebf4ff` |
| `--color-interaction-ask-foreground` | `#80beff` | `#06d` |
| `--color-interaction-ask-fill` | `#46bf723d` | `#46bf7233` |
| `--color-interaction-confirmation-surface` | `#46bf7229` | `#eaf7ee` |
| `--color-interaction-confirmation-foreground` | `#87d9a4` | `#166b32` |

### 4.7 终端 16 色（`.dark`）

```css
--color-terminal-bg:              var(--color-neutral-950);
--color-terminal-fg:              var(--color-neutral-50);
--color-terminal-cursor:          var(--color-neutral-50);
--color-terminal-cursor-accent:   var(--color-neutral-950);
--color-terminal-black:           var(--color-neutral-800);
--color-terminal-red:             var(--color-red-600);
--color-terminal-green:           var(--color-green-600);
--color-terminal-yellow:          var(--color-yellow-600);
--color-terminal-blue:            var(--color-sky-600);
--color-terminal-magenta:         var(--color-fuchsia-600);
--color-terminal-cyan:            var(--color-cyan-600);
--color-terminal-white:           var(--color-neutral-200);
--color-terminal-bright-black:    var(--color-neutral-500);
--color-terminal-bright-red:      var(--color-red-600);
--color-terminal-bright-green:    var(--color-green-600);
--color-terminal-bright-yellow:   var(--color-yellow-600);
--color-terminal-bright-blue:     var(--color-sky-600);
--color-terminal-bright-magenta:  var(--color-fuchsia-600);
--color-terminal-bright-cyan:     var(--color-cyan-600);
--color-terminal-bright-white:    var(--color-neutral-50);
```

注意「亮色 = 常规色」（除 black 外），这是刻意选择——终端输出在深底上不需要再提亮。

### 4.8 色板基元（OKLCH）

Tailwind 4.2.2 内建调色板被 ZCode 收窄使用。中性色与天蓝（品牌色 `sky`）的完整取值：

```css
--color-neutral-50:  oklch(98.5% 0 0);
--color-neutral-100: oklch(97% 0 0);
--color-neutral-200: oklch(92.2% 0 0);
--color-neutral-300: oklch(87% 0 0);
--color-neutral-400: oklch(70.8% 0 0);
--color-neutral-500: oklch(55.6% 0 0);
--color-neutral-700: oklch(37.1% 0 0);
--color-neutral-800: oklch(26.9% 0 0);
--color-neutral-900: oklch(20.5% 0 0);
--color-neutral-950: oklch(14.5% 0 0);

--color-sky-50:  oklch(97.7% .013 236.62);
--color-sky-100: oklch(95.1% .026 236.824);
--color-sky-200: oklch(90.1% .058 230.902);
--color-sky-300: oklch(82.8% .111 230.318);
--color-sky-400: oklch(74.6% .16 232.661);
--color-sky-500: oklch(68.5% .169 237.323);   /* 通用暗色主题的品牌色 */
--color-sky-600: oklch(58.8% .158 241.966);
--color-sky-700: oklch(50% .134 242.749);
--color-sky-900: oklch(39.1% .09 240.876);
--color-sky-950: oklch(29.3% .066 243.157);
```

其余色板（red/orange/amber/yellow/green/emerald/...）按 Tailwind 4.2.2 默认 OKLCH 定义，不逐值修改。

### 4.9 动效缓动

```css
--ease-out:    cubic-bezier(0, 0, .2, 1);    /* Material 标准 out */
--ease-in-out: cubic-bezier(.4, 0, .2, 1);
```

Tailwind 的 `--tw-ease` 在产物中只在 `var(--ease-in-out)` 与 `var(--ease-out)` 之间取值，没有第三个自定义曲线。**禁止引入其他缓动函数**——这是视觉一致性的隐性依赖。

### 4.10 Prose（Markdown 正文）令牌

ZCode 重写了 `@tailwindcss/typography` 的全部 prose 令牌（暗色为默认，`invert` 为反色）：

```css
/* 暗色（默认） */
--tw-prose-body:              oklch(37.3% .034 259.733);
--tw-prose-headings:          oklch(21% .034 264.665);
--tw-prose-lead:              oklch(44.6% .03 256.802);
--tw-prose-links:             oklch(21% .034 264.665);
--tw-prose-bold:              oklch(21% .034 264.665);
--tw-prose-counters:          oklch(55.1% .027 264.364);
--tw-prose-bullets:           oklch(87.2% .01 258.338);
--tw-prose-hr:                oklch(92.8% .006 264.531);
--tw-prose-quotes:            oklch(21% .034 264.665);
--tw-prose-quote-borders:     oklch(92.8% .006 264.531);
--tw-prose-captions:          oklch(55.1% .027 264.364);
--tw-prose-kbd:               oklch(21% .034 264.665);
--tw-prose-kbd-shadows:       oklab(21% -.00316127 -.0338527/.1);
--tw-prose-code:              oklch(21% .034 264.665);
--tw-prose-pre-code:          oklch(92.8% .006 264.531);
--tw-prose-pre-bg:            oklch(27.8% .033 256.848);
--tw-prose-th-borders:        oklch(87.2% .01 258.338);
--tw-prose-td-borders:        oklch(92.8% .006 264.531);

/* 反色（invert） */
--tw-prose-invert-body:              oklch(87.2% .01 258.338);
--tw-prose-invert-headings:          #fff;
--tw-prose-invert-lead:              oklch(70.7% .022 261.325);
--tw-prose-invert-links:             #fff;
--tw-prose-invert-bold:              #fff;
--tw-prose-invert-counters:          oklch(70.7% .022 261.325);
--tw-prose-invert-bullets:           oklch(44.6% .03 256.802);
--tw-prose-invert-hr:                oklch(37.3% .034 259.733);
--tw-prose-invert-quotes:            oklch(96.7% .003 264.542);
--tw-prose-invert-quote-borders:     oklch(37.3% .034 259.733);
--tw-prose-invert-captions:          oklch(70.7% .022 261.325);
--tw-prose-invert-kbd:               #fff;
--tw-prose-invert-kbd-shadows:       #ffffff1a;
--tw-prose-invert-code:              #fff;
--tw-prose-invert-pre-code:          oklch(87.2% .01 258.338);
--tw-prose-invert-pre-bg:            #00000080;
--tw-prose-invert-th-borders:        oklch(44.6% .03 256.802);
--tw-prose-invert-td-borders:        oklch(37.3% .034 259.733);
```

**注意**：prose 是唯一的蓝灰色调区域（hue 256~265），与全局中性灰分离。这是为了在长 Markdown 正文里提供微弱的冷暖区分。必须原样落地。

### 4.11 语义工具类

产物中存在成体系的语义 utility，不是 Tailwind 默认，必须自己生成：

```
.bg-sidebar  .bg-panel  .bg-card  .bg-input  .bg-menu  .bg-tab  .bg-tab-active
.bg-popover  .bg-terminal-bg  .bg-toast  .bg-accent  .bg-success  .bg-warning
.bg-destructive  .bg-idle-task-surface  .bg-diff-added  .bg-diff-removed
.bg-interaction-ask-surface  .bg-interaction-confirmation-surface
.border-sidebar  .border-border  .border-input-border
.text-foreground  .text-foreground-inverse  .text-trajectory-*
.text-git-modified  .text-git-added  .text-git-deleted  .text-git-renamed
.w-[var(--windows-caption-control-width,46px)]
.w-[var(--workspace-sidebar-panel-width)]
.w-[var(--radix-select-trigger-width)]
```

Tailwind 4 里这些通过 `@theme` 注册生成，不是手写 utility。

---

## 五、布局与几何常量

### 5.1 窗口

```jsonc
// setting.json 实测值 [setting]
"desktopWindowSize": { "width": 1216, "height": 808, "maximized": true },
"desktopChromiumHardwareAccelerationEnabled": true,
"closeToTrayOnWindows": false,
"keepAwakeWhileRunning": true
```

实现要求：
- 首次启动窗口 **1216 × 808**，`maximized: false`（实测值为 true 是因为用户已最大化；默认应为 false）。
- 窗口尺寸**必须持久化**到 `setting.json.desktopWindowSize`，下次启动还原。
- Windows 关闭按钮行为受 `closeToTrayOnWindows` 控制：false = 直接退出；true = 最小化到托盘。注意存在 `closeToTrayOnWindowsMigrationInitialized: true` 迁移标记——**必须实现设置迁移标记机制**（见 §7.13 通用迁移模式）。
- `keepAwakeWhileRunning` 用系统级「保持唤醒」API（macOS `Electron.PowerSaveBlocker`，Windows 需 PowerRequest）。

### 5.2 标题栏与平台差异 `[css]`

CSS 里能直接提取的平台几何：

```css
/* Windows 标题栏高度 */
.top-[calc(env(titlebar-area-height,48px)+0.5rem)] {
  top: calc(env(titlebar-area-height, 48px) + .5rem);
}
/* Windows 窗口控制按钮宽度 */
.w-[var(--windows-caption-control-width,46px)] {
  width: var(--windows-caption-control-width, 46px);
}
```

| 常量 | 值 | 说明 |
|------|-----|------|
| Windows titlebar 高度 | **48px**（`env(titlebar-area-height, 48px)`） | 通过 CSS `env()` 注入，可被系统覆盖 |
| Windows caption 控件宽度 | **46px**（`var(--windows-caption-control-width, 46px)`） | 最小化/最大化/关闭各一个 |
| macOS 顶部内边距 | `calc(var(--spacing) * 12)` = **48px** | `.platform-mac-desktop\:top-12` |

**平台类机制**：ZCode 用 `platform-mac-desktop` / `platform-windows-desktop` 这类 **class** 做平台分支（配合 Tailwind 的 arbitrary variant），而不是 CSS media query。根节点根据 `process.platform` 挂对应 class。

三平台标题栏形态：

| 平台 | 形态 | 内容 |
|------|------|------|
| macOS | 隐藏原生标题栏，traffic lights 保留在左上 | 内容顶部留 48px 避让 |
| Windows | 无边框窗口 + 自绘标题栏 48px | 右侧 3 个 46px caption 按钮 |
| Linux | 无边框 + 自绘 | 同 Windows |

自绘按钮文案（`[i18n]` `titleBar.*`）：

```
titleBar.window.minimize       最小化窗口
titleBar.window.toggleMaximize 最大化或还原窗口
titleBar.windowMenu            窗口菜单
```

**关闭按钮缺失**：`titleBar.*` 里**没有** `window.close` 键。说明 Windows 关闭按钮用无文案的图标（aria-label 走通用 `common.*`）。实现时保持此形态。

### 5.3 侧栏几何 `[css]`

```css
.w-[var(--workspace-sidebar-panel-width)] {
  width: var(--workspace-sidebar-panel-width);
}
```

侧栏宽度是 **CSS 变量驱动、可拖拽**的，不是固定值。`workspaceSidebar` 命名空间 44 个键描述了完整行为（见 §7.1）。

侧栏结构（从 i18n 键反推 `[i18n]`）：

```
workspaceSidebar
├── workspaces            任务
├── archivedTasks         归档任务
├── conversationsSection  任务
├── projectsSection       项目
├── newConversation       新建任务
├── addProject            添加项目
├── noConversations       还没有任务
├── noProjects            尚未打开项目
├── taskViewOptions       筛选和排序
├── organize              视图
├── organizeGrouped       分组
├── organizeByProject     项目
├── viewByWorkspace       按项目
├── organizeChronologicalList  时间线
├── sortBy                排序方式
├── sortByCreated         创建时间
├── sortByUpdated         更新时间
├── expandAllGroups       展开全部
├── collapseAllGroups     收起全部
├── searchTasks           搜索任务
├── searchTasksPlaceholder  搜索任务...
└── reorderSection        移动{section}分区
```

**关键洞察**：侧栏有**两种视图**——「项目分组」与「时间线」，且有排序、归档、搜索、拖拽重排。这是 44 个键才能描述清楚的复杂度。

### 5.4 主区域三段式

ZCode 不是「侧栏 + 内容」两段，而是**三段**：

```
┌────────────────────────────────────────────────────────────┐
│ TitleBar (48px Windows / traffic lights macOS)              │
├─────┬──────────────────────────────┬───────────────────────┤
│     │                              │                       │
│ 左  │        主内容区               │      右面板           │
│ 侧  │  (chat / task timeline)      │  (Ctrl+Alt+B 切换)     │
│ 栏  │                              │  - 文件树              │
│ 任  │                              │  - 终端 (Ctrl+J)       │
│ 务/ │                              │  - Git                 │
│ 目  │                              │  - 浏览器              │
│ 目  │                              │  - 进程监视器            │
│     │                              │                       │
├─────┴──────────────────────────────┴───────────────────────┤
│ StatusBar: 上下文用量 / 模型 / 模式 / Thought Level         │
└────────────────────────────────────────────────────────────┘
```

对应 i18n 命名空间：`sidebar`（左窄图标栏）、`workspaceSidebar`（左宽任务面板）、`sidePane`（右面板）、`appHeader`（主区头部）、`v4Pane`（四面板区，3.11 新增）。

### 5.5 移动视口与嵌入式浏览器

```jsonc
// setting.json [setting]
"embeddedBrowserViewportPreference": {
  "mode": "normal",
  "viewport": { "width": 393, "height": 852 },
  "zoom": "fit"
}
```

- `mode` 取值至少含 `normal`（另有设备预设，推断 `mobile`/`desktop`）。
- 默认移动视口 **393 × 852**（iPhone 15 Pro Max 尺寸）。
- `zoom: "fit"` = 按比例缩放填充面板。
- 对应「记住窗口尺寸」的 changelog 特性 `[官方]` 3.10.1。

---

## 六、界面文案真源

### 6.1 规模与真源文件

- **5070 条中文文案**，**82 个命名空间**（已由 `count-namespaces.cjs` 复核，无解析噪声）。
- 真源：`zcode-analysis/i18n-zh.json`（345 343 B，嵌套对象）、`.jsonl`（375 761 B）、`.tsv`（304 761 B）。
- 提取脚本：`extract-i18n.cjs`（正则 `key:\`值\`` 匹配反引号模板串）。

**实现时必须直接把 `i18n-zh.json` 复制为 renderer 的 zh-CN locale 文件**，不要重打。这是「标点级 1:1」的唯一可行路径——手抄必然出错。

### 6.2 82 个命名空间全清单

按功能域归组，括号内为**实测键数**（`count-namespaces.cjs` 输出，总计 5070）。
括号内数字最大的五个：`settings` 1724、`chat` 870、`feedback` 290、`bots` 252、`automations` 167。

**设置与账号**：`settings`（**1724 键，最大命名空间**）、`settingsSync`（59）、`login`（32）、`logout`（5）、`onboarding`（62）、`welcome`（6）

**任务与会话**：`chat`（**870**）、`workspaceSidebar`（44）、`sidebar`（55）、`sidePane`（34）、`taskList`（57）、`taskGroup`（24）、`taskNav`（4）、`taskSearch`（9）、`taskTimeline`（8）、`projectSelector`（2）、`workspace`（13）、`workspaceHeader`（6）、`workspaceFileTree`（16）、`todo`（4）

**Agent 与模型**：`mode`（**47**，5 个 provider 的模式矩阵）、`model`（1）、`modelTrajectory`（51）、`planTool`（15）、`subagentDirectory`（13）、`tokenDebug`（15）、`usage`（6）

**反馈与商业化**：`feedback`（**290**）、`codingPlan`（30）、`manualClaimPlan`（55）、`offPeak`（80）

**文件与代码**：`codeViewer`（71）、`codeBlock`（18）、`fileTree`（2）、`fileActions`（2）、`diff`（10）、`directoryBrowser`（9）、`markdownImage`（8）、`markdownTable`（10）、`treemapping`（16）

**版本控制**：`git`（**154**）、`gitGraph`（27）

**自动化与远程**：`automations`（**167**）、`bots`（**252**）、`webRemoteControl`（104）、`remote`（51）、`remoteConnection`（1）、`ssh`（34）、`scheduledPreview`（5）

**智能能力**：`repoWiki`（47）、`wikiReference`（20）、`whiteboard`（15）、`browser`（41）、`cuaPermission`（28）、`docker`（9）、`wsl`（11）

**应用骨架**：`titleBar`（23）、`desktopMenu`（5）、`app`（5）、`appError`（11）、`appHeader`（22）、`common`（15）、`locale`（1）、`forms`（17）、`confirmDialog`（8）、`notification`（11）、`zcode`（24）

**扩展生态与运行环境**：`commandCenter`（20）、`quickPick`（57）、`terminal`（10）、`developerTools`（18）、`debugInfo`（5）、`processMonitor`（6）、`server`（12）、`v4Pane`（10）、`carousel`（2）

**更新**：`update`（7）、`updateAvailable`（1）、`updateDialog`（14）、`updateReady`（8）、`forceUpdate`（7）、`postUpdateReleaseNotes`（2）

### 6.3 插值与复数规则 `[i18n]`

ZCode 的插值语法是 **`{placeholder}` 直插**，无 ICU MessageFormat 的 `select/plural` 语法，但有**手工复数键**：

```
chat.changeSummary.filesChanged.one   {count} 个文件已更改
chat.changeSummary.filesChanged.other {count} 个文件已更改

chat.codeComments.one   1 条评论
chat.codeComments.many  {count} 条评论
```

规则：
- 单数用 `.one`，复数用 `.other` 或 `.many`。
- 部分键带**上下文前缀**分段（`afterWorkspace` / `beforeWorkspace`），用于把变量夹在中间：

```
chat.empty.description.beforeWorkspace  开始在
chat.empty.description.workspace        {workspace} 项目新建任务
chat.empty.description.afterWorkspace   项目新建任务
```

- 空格是刻意且必须保留的：`开始在 {workspace} 项目新建任务` 中，`{workspace}` 前后都有空格。中文标点用**全角**（，。：「」（）），变量外文本用半角空格分隔。**CI 必须逐字节比对**。

### 6.4 标点级 1:1 的执行机制

手抄必然漂移，所以设三道闸门：

**闸门 1 — 构建期**：`i18n-zh.json` 是唯一真源，任何组件里的字符串字面量都会被 lint 拦截。

```ts
// eslint.config.ts
{
  rules: {
    'no-literal-i18n': 'error',   // 禁止中文字面量出现在 .tsx 里
  },
}
```

**闸门 2 — CI 校验脚本** `scripts/ci/check-i18n-fidelity.js`：

```js
// 对比 i18n-zh.json 与构建产物中的文案，逐键逐字符比对
// 差异以 difflib 输出到 stdout，任一 diff 非空即 fail
const golden = require('../zcode-analysis/i18n-zh.json');
const built  = require('./dist/renderer/i18n/zh-CN.json');
diff(JSON.stringify(golden), JSON.stringify(built));
```

**闸门 3 — 运行时**：渲染路径上，`useTranslation()` 缺失键时**报错而非静默回退**（开发模式），生产模式回退到 key 本身便于发现。

### 6.5 文案语体特征（照抄时必须保持的风格）

ZCode 的中文文案有几个可辨识的风格特征，重打会丢失：

1. **欢迎问候用口语化「呀」收尾**，分 6 个时段：

```
chat.empty.greeting.morningEarly  早上好呀，新的一天开始啦
chat.empty.greeting.morning       上午好呀，有什么想让我帮忙的吗
chat.empty.greeting.noon          中午好呀，要不要先休息一下
chat.empty.greeting.afternoon     下午好呀，接下来交给我吧
chat.empty.greeting.evening       晚上好呀，今天辛苦啦
chat.empty.greeting.lateNight     夜深啦，别忘了照顾好自己呀
```

**注意**：`lateNight` 没有「呀」在「夜深」后，而是「夜深啦」。这不是笔误，是刻意断句。

2. **错误文案给具体动作**（符合 AGENTS.md 规则 2.2）：

```
chat.error.connectionLost  与代理的连接已断开
chat.error.processExited   代理进程意外退出
chat.error.noAvailableModel 当前没有可用模型。请开通编程套餐或配置自定义模型。
chat.error.sendFailed      发送失败，请稍后重试。
chat.captcha.verifyFailed  验证码校验失败，请重试。
```

3. **进度文案带可量化进度**（符合规则 2）：

```
chat.apiRetryStatus                     重新连接中... {attempt}/{maxRetries}
chat.contextCompaction.retrying         正在重试压缩上下文（{attempt}/{maxAttempts}）
chat.attachments.upload.uploading       正在上传 {progress}%
chat.longRunning.elapsedMinutesSeconds  已运行 {minutes} 分 {seconds} 秒
chat.history.workedFor                  已工作 {duration}
chat.history.workingFor                 工作中 {duration}
desktopMenu.help.downloadingUpdateVersion  正在下载更新 {version}...
desktopMenu.help.restartToUpdate         重启以更新（{version}）
```

**注意**：中文括号 `（）` 与英文括号 `()` 混用是有规律的——**含变量的括号用英文半角**（`{attempt}/{maxAttempts}`），**纯中文说明用全角**（`正在重试压缩上下文（…）`）。这是标点级 1:1 最容易翻车的地方。

4. **欢迎页标题是英文**：`welcome.title = "Welcome to ZCode"`。整份 5070 键里只有这一处标题用英文，其余全中文。

---

## 七、功能规格

> 本章按 i18n 命名空间组织，每个模块标注其真源键与关键行为。
> 完整键值见 `i18n-zh.json`，本节只列结构与设计意图。

### 7.1 任务与工作区侧栏

真源：`workspaceSidebar.*`（44 键）、`taskList.*`（57）、`taskGroup.*`（24）、`taskNav.*`（4）、`taskSearch.*`（9）、`taskTimeline.*`（8）、`projectSelector.*`（2）

**概念模型**（从 `setting.json` 与 i18n 反推）：

```
Workspace（工作区）
  ├─ kind: "local" | "ssh" | "wsl" | "docker" | "remote"
  ├─ workspacePath: string          // 绝对路径
  ├─ workspacePurpose: "project" | "conversation"
  └─ Task（任务 = 一个 Agent 会话）
       ├─ id: "sess_<uuid>"         // 格式见 §9.5
       ├─ 消息流
       ├─ 文件改动 checkpoint
       └─ timeline（任务时间线）
```

`setting.json` 的 `lastWorkspaceSession` 数组给出 9 个真实样例，其中 8 个 `workspacePurpose: "project"`，1 个 `"conversation"`，指向 `~/.zcode/workspace/default`。**两种 purpose 是不同的东西**：project 绑定真实目录，conversation 是无目录的纯对话工作区。

**功能清单**：
- 任务列表（草稿任务也可见 `[官方]` 3.11.2）
- 归档任务（`archivedTasks`），自动归档 `taskAutoArchiveEnabled` + `taskAutoArchiveOlderThanDays: 7`
- 项目分组视图 / 时间线视图切换
- 排序：创建时间 / 更新时间
- 搜索（`Ctrl` + 面板内搜索）
- 拖拽重排分区（`reorderSection: 移动{section}分区`）
- 展开/收起全部分组
- 项目搜索（`chat.empty.workspaceSearchPlaceholder: 搜索工作区`）
- 取消选择当前项目（`chat.empty.detachProject`）
- 项目外工作（`chat.empty.workOutsideProject: 不在项目中工作`）

### 7.2 Composer（输入框）

真源：`chat.composer.*`、`chat.attachments.*`、`chat.draft.*`、`chat.mention.*`、`chat.edit.*`

**四个快捷键触发器**（`[i18n]`，这是核心交互，必须精确）：

```
chat.composer.insertMentionShortcut  使用 @ 添加上下文
chat.composer.insertSessionShortcut  插入 # 会话
chat.composer.insertSkillShortcut    使用 $ 选择技能
chat.composer.insertSlashShortcut    使用 / 选择能力
```

**注意措辞差异**：`@` 是「使用 @ 添加上下文」，`$` 和 `/` 是「使用 X 选择 Y」，`#` 是「插入 # 会话」。**三个动词都不一样**。

**@ 提及的 6 个分类**（`chat.mention.category.*` + `chat.mention.*.title`）：

| 分类 | 标题 | 空态 | 搜索提示 |
|------|------|------|---------|
| 文件 | 文件 | 没有匹配的文件 | 输入内容以搜索文件 |
| 会话 | 会话 | 没有匹配的近期会话 | 输入内容以搜索近期会话 |
| 技能 | 技能 | 没有匹配的技能 | 输入内容以搜索技能 |
| 子智能体 | 子智能体 | 没有匹配的子智能体 | — |
| 插件 | 插件 | 没有可引用的插件 | — |
| 画板 | 画板 | 没有匹配的画板 | — |

`chat.mention.plugins.description: {marketplace} · {skillCount} 技能 · {mcpCount} MCP` —— **分隔符是全角空格 + 中点 `·` + 全角空格**。

`chat.mention.category.files.searching: 在工作区文件中搜索 "{query}"` —— **引号是全角弯引号 `""`**。

`chat.mention.searching: 筛选：{query}` —— 冒号是全角。

**附件系统**（`chat.attachments.*`，40 键）：
- 类型：图片、PDF、视频、剪贴板文本
- 状态机：`排队 → 正在上传 {progress}% → 正在完成上传 → 上传完成`；失败 `上传失败：{message}` / `重试上传`
- 约束：`附件不能超过 {sizeMb} MB`、`最多只能添加 {count} 个附件`
- 拖拽：`松开以添加附件`
- 剪贴板文本：`{lineCount} 行`
- 缺失内容检测：图片/PDF 附件缺文件内容时拦截并提示「请重新添加」
- 重启恢复：`部分草稿附件在重启后无法恢复，请重新添加：{filenames}`
- 会话等待：`正在等待会话`、`运行时已重启，附件引用失效`
- 远程物化：`远程附件未完成物化，已阻断发送本地路径`

**草稿提示词**（`chat.draft.suggestedPrompt.*`）：
- `制作一份 PDF` → 提示词 `根据当前工作区内容制作一份 PDF 文档。`
- `检查近 7 天的 commit` → `检查当前工作区近 7 天的 Git commit，概括主要改动并指出潜在风险。`
- 插件关联建议：`文档技能`、`Github`
- 插件安装流：`正在检查插件状态…` → `安装{pluginLabel}插件` → `确认` → `正在安装插件…` → `安装成功` / `安装失败` / `安装超时`
- **注意省略号是全角三点 `…`**，不是 `...`。全文需统一检查。

**编辑区重置**（`chat.edit.*`）：
- `对话 + 文件重置`（`resetConversationAndFiles`）
- 三个动作：`仅重置对话并发送` / `恢复本轮文件、重置对话并发送` / `取消`
- 冲突检测：`文件无法安全重置` + `对话尚未裁剪。请检查冲突或忽略的文件，然后仅重置对话并发送，或取消。`
- 不可用态：`压缩中或有待处理交互时不能重置文件`、`请等待当前工作停止`

**上下文管理**（`chat.contextUsage.*` + `chat.contextCompaction.*`）：
- `上下文对话数 {used} / 总量 {total}`
- 来源分解 7 项：`系统提示词` / `系统工具` / `消息` / `MCP 工具` / `技能` / `工具提示词` / `其他`
- `平均缓存命中率`（cache hit rate 指标）
- 压缩动作：`压缩` → `正在压缩上下文` → `上下文已压缩` / `上下文已自动压缩` / `上下文已压缩`（跳过）/ `上下文已过期，无需压缩`
- 重试：`正在重试压缩上下文（{attempt}/{maxAttempts}）`
- 中断：`上下文压缩已中断` / `上下文压缩失败`

**后台任务指示**（`chat.composer.backgroundWorks.*`）：
- `后台任务：Bash {bashCount} 个，子智能体 {subagentCount} 个，共 {count} 个`
- 三种 tooltip：`运行中的智能体` / `运行中的终端与智能体` / `运行中的终端`

### 7.3 执行模式矩阵

真源：`mode.*`（47 键）。**这是 1:1 复刻中最结构化、最易验收的一块**。

ZCode 支持 5 个 Agent provider，每个有自己的模式集：

| Provider | 模式 | 标签 | 描述 |
|----------|------|------|------|
| claude | default | 默认模式 | 编辑和高风险操作前询问。 |
| claude | plan | 计划模式 | 先计划，确认后执行。 |
| claude | acceptEdits | 自动接受编辑 | 自动接受文件编辑。 |
| claude | dontAsk | 静默模式 | 跳过常规确认。 |
| claude | bypassPermissions | 跳过权限检查 | 跳过权限检查。 |
| claude | auto | 自动模式 | 自动选择权限模式。 |
| codex | readOnly | 只读模式 | 只读代码，不修改文件。 |
| codex | agent | Agent 模式 | 编辑和运行命令前保留确认。 |
| codex | auto | 自动编辑模式 | 在常规保护下编辑。 |
| codex | agentFullAccess | 全权限模式 | 完整文件和网络访问。 |
| codex | fullAccess | 全权限模式 | 无需确认地访问和执行。 |
| codex | default | — | — |
| gemini | default | 默认模式 | 使用默认确认策略。 |
| gemini | plan | 计划模式 | 先计划，确认后执行。 |
| gemini | autoEdit | 自动编辑模式 | 自动应用编辑。 |
| gemini | yolo | 全自动模式 | 减少确认次数。 |
| glm | default | 默认模式 | 使用默认确认策略。 |
| glm | plan | 计划模式 | 编辑前先出计划。 |
| glm | build | 变更前确认 | 改文件前先问我。 |
| glm | edit | 自动编辑 | 自动编辑文件。 |
| glm | yolo | 完全访问 | 减少确认次数。 |
| opencode | plan | 计划模式 | 先计划，确认后执行。 |
| opencode | build | 构建模式 | 实施并修改文件。 |

> **GLM provider 特殊说明**（§1.2 第三圈）：GLM 模型与智谱推理能力属于第三方服务，**不复刻后端接入**。但 GLM 的**模式 UI（5 个模式切换按钮）必须 1:1 复刻**——用户在 UI 上看到的 provider 列表、模式切换交互、Shift+Tab 循环必须包含 GLM。后端行为改为：选择 GLM provider 时，实际走 khy-os `aiGateway.js` 的 GLM 通道（如果可用），或给出「GLM 通道未配置」提示。

**实现要点**：
- 模式键名跨 provider 复用（`default`/`plan`/`yolo`/`auto` 都出现多次），所以命名空间是 `mode.label.<provider>.<mode>` 三段式。
- **`auto` 在不同 provider 语义完全不同**：claude 的 auto 是「自动选择权限模式」，codex 的 auto 是「自动编辑模式」，gemini 没有 autoEdit 之外的 auto。**不能做 provider 无关的模式枚举**。
- 切换快捷键 **Shift+Tab** `[官方]`，循环切换。
- `mode.plan` 和 `mode.acceptEdits` 是顶层通用键（对应 Shift+Tab 循环里的两个主态）。
- `setting.json` 的 `enabledBuiltinAgentCliProviders: ["glm"]` 说明 provider 是**可启停的**，默认只开 glm。

### 7.4 消息与模型轨迹

真源：`chat.message.*`、`modelTrajectory.*`、`chat.changeSummary.*`、`chat.history.*`

**消息气泡**：
- 折叠/展开：`收起` / `展开`
- 复制：`复制`
- 大消息预览：`这条回复较大，当前仅显示预览（{previewBytes} / {fullBytes}）。` → `查看完整消息` → `正在加载...` → `加载失败，重试`

**思考流**（`setting.json` 控制）：
- `messageStreamShowReasoning: true` —— 显示思考轨迹
- `messageStreamShowTodos: false` —— 不显示 todo 进度
- 思考强度 `Thought Level`，快捷键 **Ctrl+T** `[官方]`
- `config.json` 里 `reasoning.variants: ["low", "max", "high"]`，默认 `max`；部分模型含 `off` `[官方]`

**模型轨迹五态色**（见 §4.6）：user / assistant / reasoning / tool-call / tool-result。这五条颜色是「思考轨迹」时间线的骨架。

**交互来源标记**：`chat.interactionOrigin.subagent: 子智能体`、`chat.interactionOrigin.subagent.title: 来自子智能体：{agentType}`

**长任务面板**（`chat.longRunning.*`）：
- `展开长时间运行面板` / `收起长时间运行面板`
- 两种时长格式：`已运行 {minutes} 分 {seconds} 秒` / `已运行 {seconds} 秒`

**历史与状态**：
- `已工作 {duration}` / `工作中 {duration}` / `已停止` / `已处理`
- 时长单位：`{duration} 天` / `小时` / `分` / `秒`
- 分页：`正在加载更早消息...` / `加载更早消息`

**空结果**：
- `没有可展示内容`
- `这个任务没有生成聊天内容，可能是在模型返回正文前被停止了。`

### 7.5 文件改动与撤销（checkpoint 安全模型）

真源：`chat.changeSummary.*`（30 键）、`chat.edit.*`

**改动摘要**：
- `展开已更改文件` / `收起已更改文件`
- `{count} 个文件已更改`（one/other 复数）
- 动作：`审查` / `重新应用` / `撤销` / `已撤销` / `在编辑器中打开`
- 降级：`暂时无法预览这份 Diff。`

**撤销对话框的安全模型**（`chat.changeSummary.rewindDialog.*`）—— 这是 ZCode 的标志性设计，**必须 1:1**：

```
标题        撤销文件改动
安全区      可安全撤销 {count}
不安全区    不能安全撤销 {count}
忽略区      已忽略 {count}
操作数      {count} 次修改
确认        撤销文件
加载中      正在检查可撤销文件…
无预览      暂时没有预览结果。
无安全文件  没有可安全撤销的文件。
无不安全文件 没有发现不安全文件。
错误        文件撤销请求失败，请稍后再试。
```

**不安全原因 6 种**（`reason.*`）：

| 键 | 文案 |
|----|------|
| `reason.checkpointMissing` | 缺少 checkpoint |
| `reason.checkpointUnreadable` | 无法读取 checkpoint |
| `reason.externalModified` | 当前文件已被外部修改 |
| `reason.fileReadFailed` | 无法读取当前文件 |
| `reason.unsupportedCheckpoint` | 当前 checkpoint 无法安全还原 |
| `reason.bashIgnored` | bash/shell 修改已忽略 |

**核心安全原则**（`rewindDialog.description` 原文）：
> 撤销前会重新检查当前文件内容；如果文件已被其他进程改过，本次不会写入任何文件。

配合 `cannotApply`：`存在不能安全撤销的文件，未写入任何文件。`

这是**原子性保证**：全部安全才写，有任一根不安全就全不写（或分桶后仅写安全桶并明确告知）。实现时必须照此语义，不能"尽力而为"。

**存储层**：`~/.zcode/v2/checkpoints/` 目录存在 `[setting]`，印证 checkpoint 落盘。

### 7.6 交互式提问（elicitation）

真源：`chat.elicitation.*`、`chat.askQuestion.*`

Agent 主动向用户提问的完整交互：

```
标题           需要确认
键盘提示       使用 Tab / 上下键选择，回车或空格选中
提交           提交
继续           继续
忽略           忽略
自定义回答     自定义回答
自定义回答占位  输入你的回答...
上一题         上一题
下一题         下一题
展开问题       展开问题
收起问题       收起问题
展开问题弹窗   展开问题弹窗
折叠问题弹窗   折叠问题弹窗
倒计时         {seconds}秒
无答案         没有可回答的问题。
未提供回答     未提供回答
```

**Plan 审批**（`chat.elicitation.planApproval.*`）：
- `批准`
- 描述：`退出计划模式并开始实施。`

**计时器**：`{seconds}秒` —— 无空格，且**秒字紧贴数字**。

**自动解析**：`setting.json` 的 `askUserQuestionAutoResolutionEnabled: true` 与 `zcodeInteractionBehavior: "queue"`。后者说明交互可以排队（`chat.followup.addToQueue: 加入队列`）。

**追问三选**（`chat.followup.*`）：`立即发送` / `加入队列` / `引导当前任务`

**已提问状态**：`chat.askQuestion.asked: 已询问`、`chat.askQuestion.asking: 正在询问`、`chat.askQuestion.noAnswerProvided: 未提供回答`、`chat.askQuestion.questionsCount: {count} 个问题`、`chat.askQuestion.autoContinued: 无回答，已自动继续`

### 7.7 Goal 目标模式

真源：`chat.goal.*`、`chat.goalBanner.*`、`chat.goalVerification.*`、`planTool.*`

`[官方]` 官网描述：「用 Goal 管理复杂目标，持续规划、执行与验证」。

```
goalBanner.label       目标
goal.planModeBlocked   Goal 无法在 Plan 模式下使用，请切换模式。
goal.runningBlocked    请结束任务后设定目标。
```

**验证状态机**（`goalVerification.*`）：

| 状态 | 文案 |
|------|------|
| checking | 目标校验中 |
| complete | 目标已完成，任务结束 |
| incomplete | 目标未完成，任务继续 |
| cancelled | 目标校验已中断 |
| openSummary | 展开摘要 |

**闭环语义**：`incomplete` 时任务**自动继续**，`complete` 时才结束。这是与"普通任务"的本质区别——有可判定的验收条件。

### 7.8 Hooks 钩子

真源：`chat.hooks.*`

**来源三态**：

| 键 | 文案 |
|----|------|
| `hooks.label` | 钩子 |
| `hooks.source.plugin` | 插件 |
| `hooks.source.project` | 工作区 |
| `hooks.source.user` | 用户 |

**执行状态六态**：

| 键 | 文案 |
|----|------|
| `hooks.state.running` | 运行中 |
| `hooks.state.completed` | 已完成 |
| `hooks.state.failed` | 失败 |
| `hooks.state.blocked` | 已阻止 |
| `hooks.state.cancelled` | 已取消 |
| `hooks.state.timedOut` | 已超时 |

**7 个事件** `[官方]`：`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PermissionRequest` / `PostToolUse` / `PostToolUseFailure` / `Stop`

实现要点：`blocked` 与 `failed` 是**两个不同终态**——blocked 是 hook 主动拒绝（exit code 2 类语义），failed 是执行出错。UI 必须区分着色。

### 7.9 终端

真源：`terminal.*`

- 快捷键 **Ctrl+J** `[官方]`
- `setting.json`: `terminalInheritSystemProfile: true` —— 继承系统 shell profile（Windows 下即读 `%USERPROFILE%\.bashrc` / `%USERPROFILE%\.profile`）
- xterm 16 色从 CSS 令牌读取（§4.7）
- pty 宿主在 main 进程，renderer 只渲染，走 IPC `data/resize/closed/exit`
- `toolGroupingTerminalEnabled: true` —— 终端工具调用在消息流中分组折叠

### 7.10 文件树 / 代码查看器 / Diff

真源：`fileTree.*`、`fileActions.*`、`codeViewer.*`、`codeBlock.*`、`diff.*`、`directoryBrowser.*`、`markdownImage.*`、`markdownTable.*`、`treemapping.*`

- 文件树支持展开/折叠、拖拽引用、右键操作
- Composer 拖拽：`chat.composer.workspaceFileDragHint: 松开以引用此文件或目录`
- Diff 引擎用 @pierre/diffs（wasm），worker 化（`diffs.worker-*.js` 827 KB）
- 代码块可复制、可在编辑器打开（`chat.changeSummary.openInEditor: 在编辑器中打开`）
- 外部编辑器选择：`appHeader.selectOpenApp: 选择打开方式`、`appHeader.openInEditor: 在 {editor} 中打开`

### 7.11 Git 与 Git Graph

真源：`git.*`、`gitGraph.*`、`appHeader.*`

- 8 种 Git 状态色（§4.6）
- 面板含 Changes / Commit `[官方]`
- `appHeader.copyTaskPath` / `copyPath` / `copySessionId: 复制会话 ID` / `copyClaudeJsonlPath: 复制JSONL路径` / `copyLogPath: 复制日志路径`
- 目录打开：`appHeader.openInFileManager: 在文件管理器中打开` / `openInFileExplorer: 在资源管理器中打开`（Windows）/ `openInFinder: 在 Finder 中打开`（macOS）
- 打开失败：`appHeader.openInFileManagerFailed: 无法在系统文件管理器中打开`

### 7.12 会话头部操作（appHeader）

`appHeader.*` 22 键完整清单：

```
copyClaudeJsonlPath         复制JSONL路径
copyLogPath                 复制日志路径
copyPath                    复制路径
copySessionId               复制会话 ID
copyTaskPath                复制任务路径
goToProviderConfig          前往配置
goToProviderConfigPrefix    前往
goToProviderConfigSuffix    配置
openInEditor                在 {editor} 中打开
openInFileExplorer          在资源管理器中打开
openInFileManager           在文件管理器中打开
openInFileManagerFailed     无法在系统文件管理器中打开
openInFinder                在 Finder 中打开
openProviderConfigInEditorFailed  无法在 {editor} 中打开 Provider 配置文件
openProviderConfigWithEditorMiddle  打开
openProviderConfigWithEditorPrefix  用
openProviderConfigWithEditorSuffix  配置文件
reloadSession               重载会话
reloadSessionFailed         重载会话失败
reloadSessionSuccess        会话已重载
selectOpenApp               选择打开方式
workspaceSessionActionLoading  正在应用会话变更...
```

**注意**：
- `openProviderConfigWithEditor*` 三段拼出「用 {editor} 打开 Provider 配置文件」。
- `copyClaudeJsonlPath` 里 **Claude 字样无空格**：`复制JSONL路径`。
- `reloadSession` 有成功/失败双态文案。

### 7.13 设置页

真源：`settings.*` + §9.2 的 `setting.json` 全字段。

`[官方]` 设置分组：插件管理（含 Installed / Discover 两页签）、技能 Skills、子智能体 Subagents、MCP、浏览器控制、模型配置、用量统计、API Key 配置、使用统计、用户反馈与支持。

**设置迁移标记模式**（`[setting]`）—— 这是 ZCode 的工程细节，必须复刻：

```jsonc
"closeToTrayOnWindows": false,
"closeToTrayOnWindowsMigrationInitialized": true,     // ← 迁移标记
"messageStreamShowReasoning": true,
"messageStreamShowReasoningMigrationInitialized": true,
"optimizeAgentExperienceEnabled": false,
"optimizeAgentExperienceMigrationInitialized": true,
"settingsSyncFirstRunPromptHandled": true,             // ← 首跑提示标记
```

**模式**：当一个设置项的默认值随版本变化时，用 `<key>MigrationInitialized` 布尔标记区分「用户显式设置过」与「默认值演进」。这解决了「升级后老用户设置被重置」的经典问题。我们必须在共享代码里实现通用 `migrateSetting(key, default, migrationKey)` 工具。

**设置同步**：`settingsSync.*` + `settingsSyncFirstRunPromptHandled` —— 存在跨设备设置同步功能。

### 7.14 模型与套餐

真源：`model.*`、`codingPlan.*`、`manualClaimPlan.*`、`offPeak.*`、`usage.*`、`tokenDebug.*`

**套餐** `[官方]`：

| 套餐 | 价格 | 额度 |
|------|------|------|
| Lite | ¥94.4/月 | 每周 10,000 积分 |
| Pro | ¥430.4/月 | 6 倍 |
| Max | ¥862.4/月 | 14 倍 |
| Weekend Plan | 免费领取 | 可邀请好友 |

**手动领取**（`manualClaimPlan.*`）：

```
banner.aria          可领取的体验套餐
banner.tag           限时可领取
banner.unit.tokens   Tokens
banner.subtitle.daily   {model} 每日额度
banner.subtitle.oneTime {model} 一次性额度
claim.ticket.benefit        {model} {amount} {unit}
claim.ticket.benefit.daily  {model} 每日 {amount} {unit}
banner.close         关闭活动
banner.claim         领取
```

**闲时算力** `[官方]` 3.8.1：「算力闲时重置 5 小时额度」→ `offPeak.*` + `scheduledPreview.*`

**模型选择**：
- `setting.json`: `modelProviderFamilyModes: {zai: "oauth", bigmodel: "oauth"}`
- `modelProviderFamilySelectedKeys: {zai: "coding-plan:builtin:zai-coding-plan", bigmodel: "coding-plan:builtin:bigmodel-coding-plan"}`
- `providerFamilyDomain: "bigmodel"`
- 键格式：`coding-plan:builtin:<provider>-coding-plan`
- 发送按钮显示当前模型名（如 `GLM-5.3Max`）
- `chat.empty.cliMenu: 选择 CLI`

**替换策略**：套餐/计费 UI 结构复刻，但数据源接 khy-os `tokenUsageService.js`，套餐名称改为 KhyOS 自有方案。

### 7.15 插件市场与技能

真源：`chat.mention.plugins.*`、`chat.draft.suggestedPrompt.pluginFlow.*`、i18n 无独立 `plugins` 命名空间（并入 chat 与 settings）

`[官方]`：
- 3.8.1 首页新增插件市场
- 3.11.2 插件可按工作区单独安装
- 3.10.1 输入框菜单新增技能快捷入口
- 市场分 **Installed / Discover** 两页签
- 兼容 anthropics 官方 291 个插件（本机 `known_marketplaces.json` 印证）

**引用描述格式**：`{marketplace} · {skillCount} 技能 · {mcpCount} MCP`

**冲突处理**：`chat.mention.plugins.conflict: 同名插件冲突，暂不可引用`

**本机插件结构** `[setting]`：
```
C:\Users\25789\.zcode\cli\plugins\
├── cache/
├── data/
├── marketplaces/
├── icon-sources.json      25 527 B
└── known_marketplaces.json 1 013 B
```

### 7.16 MCP

真源：`chat.contextUsage.breakdown.mcpTools: MCP 工具`、`chat.mention.plugins.description` 中的 `{mcpCount} MCP`

`[官方]`：3.10.1 MCP 服务器支持配置协议版本；支持 OAuth。

实现要点：
- 传输：stdio / HTTP / SSE
- 协议版本协商（能力握手）
- OAuth 授权流
- 工具计数进入上下文用量分解（占独立预算槽位）

### 7.17 浏览器控制

真源：`browser.*`、`setting.json` 的 `embeddedBrowser*` 字段

`[官方]`：3.10.1「浏览器」菜单更名为「浏览器控制」。

```jsonc
"embeddedBrowserAllowInsecureCertificates": false,
"embeddedBrowserViewportPreference": {
  "mode": "normal",
  "viewport": { "width": 393, "height": 852 },
  "zoom": "fit"
}
```

- 视频录制能力（`browserVideoRecorder.cjs` preload + `browserWebmRecorder.js`）
- JS 对话框拦截（`embeddedBrowserJavaScriptDialog.cjs`）
- 记住窗口尺寸
- 底层 `playwright-core 1.59.1`

### 7.18 电脑控制（CUA）权限

真源：`cuaPermission.*`、`chat.cuaReadiness.*`、`setting.json` 的 `computerUseComposerEntryHidden`

```
chat.cuaPermission.openAccessibility    打开辅助功能设置
chat.cuaPermission.openScreenRecording  打开屏幕录制设置
chat.cuaPermission.openFailed           无法打开 CUA 权限引导：{error}
chat.cuaPermission.opening              正在打开...
```

**就绪态文案**（`chat.cuaReadiness.*`，两句，区别仅在有/无进度）：
- `电脑控制仍在准备中——工具尚未加载。请先授予下方权限，Helper 就绪后工具会自动出现。`
- `电脑控制仍在准备中——工具尚未加载（已加载 {count} 个）。请先授予下方权限，Helper 就绪后工具会自动出现。`

**注意破折号是全角双破折号 `——`**。

`[官方]` 3.9.2：使用电脑控制功能前会明确提示所需权限。

### 7.19 自动化与闲时任务

真源：`automations.*`、`scheduledPreview.*`、`offPeak.*`、`chat.hooks.*`

`[官方]`：定时任务、闲时算力额度（3.8.1「算力闲时重置 5 小时额度」）。

对应独立 `scheduler` 进程（1.34 MB）。实现要点：
- 定时任务（cron 表达式）
- 闲时任务（idle 触发）
- **必须走 AGENTS.md 规则 3 的活动感知超时**，不得硬 kill 长任务

### 7.20 Bot 通道

真源：`bots.*`

`[官方]`：微信 / 飞书 / Telegram 三通道。

本机真实配置 `[setting]`：

```jsonc
// .zcode/v2/bot-config.json
{ "provider": "weixin", ... }
```

Bot 命令集：`status` / `new` / `workspace` / `model` / `mode` / `thoughtLevel` / `reply`

`bot-state.v2.json`（33 B）持久化运行态。

实现要点：`@larksuiteoapi/node-sdk 1.61.1` 在 ZCode 依赖里，飞书走官方 SDK；微信/Telegram 走各自协议。我们的壳可先实现 UI 与本地命令解析，通道连接器按 KhyOS 网关能力接入。

### 7.21 远程 Web 控制

真源：`webRemoteControl.*`、`remote.*`、`remoteConnection.*`、`ssh.*`

```jsonc
// setting.json [setting]
"webRemoteControlExternalRelayDevice": {
  "deviceSid": "d_HgZDjMy8gNAt9U1zMQEnDx"
},
"webRemoteControlLastEnabledContext": {
  "workspacePath": "D:\\Portable\\khy-os",
  "initialTaskId": "sess_74b99e12-4b39-45a0-ac8f-539e2a5e1b8a"
}
```

- **deviceSid 格式**：`d_` + 16 位 base62
- **taskId 格式**：`sess_` + UUID v4
- relay device 说明走的是**中继设备**架构，不是直连
- 手机端扫码 `[官方]`

SSH 通道（`ssh.*`）配合 `ssh2 ^1.16.0`。

### 7.22 Wiki / Memory / 知识库

真源：`repoWiki.*`、`wikiReference.*`

```jsonc
"repoSnapshotIndexingEnabled": false,
"memoryEnabled": false,
"instantGrepIndexingEnabled": false,
"nativeSearchEnhancementsEnabled": true,
"modelIoFullRetentionEnabled": false,
```

五个独立开关，说明「快照索引」「即时 grep 索引」「原生搜索增强」「内存」「模型 IO 全量保留」是五个正交能力，不要合并。

### 7.23 白板

真源：`whiteboard.*`、`chat.mention.whiteboards.*`

```
chat.mention.whiteboards.title      画板
chat.mention.whiteboards.strokeCount {count} 条笔迹
chat.mention.whiteboards.empty      没有匹配的画板
```

画板可作为 `@` 提及的资源引用。

### 7.24 更新机制

真源：`update.*`、`updateAvailable.*`、`updateDialog.*`、`updateReady.*`、`forceUpdate.*`、`postUpdateReleaseNotes.*`、`desktopMenu.help.*`

**六个独立命名空间**说明更新流程被拆得很细：

```
desktopMenu.help.checkingForUpdates     正在检查更新...
desktopMenu.help.downloadingUpdateVersion 正在下载更新 {version}...
desktopMenu.help.downloadingUpdateProgress 正在下载更新... {progress}
desktopMenu.help.updateAvailableVersion 发现新版本 {version}
desktopMenu.help.restartToUpdate        重启以更新（{version}）
```

**注意标点规律**：
- `正在检查更新...` —— 英文省略号
- `正在下载更新 {version}...` —— 版本后接英文省略号
- `正在下载更新... {progress}` —— 省略号在版本位
- `发现新版本 {version}` —— 无省略号
- `重启以更新（{version}）` —— 全角括号

**设置**：
```jsonc
"receivePreviewUpdates": false,
"autoDownloadAndInstallUpdates": false,
"skippedElectronUpdateVersions": {},      // 被跳过的版本集合
```

`forceUpdate` 命名空间存在说明有强制更新场景（不可跳过）。

实现：`electron-updater` + `generic` provider 自托管源；`differentialPackage: false`（增量包生态不成熟）。

### 7.25 登录与会话过期

真源：`welcome.*`、`login.*`、`logout.*`、`onboarding.*`

```
welcome.title      Welcome to ZCode      ← 唯一英文标题
welcome.username   用户名
welcome.password   密码
welcome.login      登录
welcome.loggingIn  登录中...
welcome.loginFailed 登录失败
```

`[setting]` `credentials.json`（1 884 B）+ `certs/` 目录 + `node-forge` 依赖 → 证书级凭据管理。

`[官方]` Onboarding 支持读取 Claude/Codex 配置导入（「可以直接导入 ZCode」）。

### 7.26 错误体系

真源：`appError.*`、`chat.error.*`、`error.*`

**`appError` 命名空间的设计哲学**——错误被限制在出错区域内，不白屏：

```
appError.description  刚才的页面错误已经被拦住了，所以不会直接白屏。你可以先重试；如果问题持续，再刷新应用恢复界面。
appError.title        应用界面出了点问题
appError.details      查看组件堆栈
appError.hint         错误详情已记录到诊断日志里，方便继续排查。
appError.reload       刷新应用
appError.retry        重试
appError.sectionDescription  错误已经限制在当前区域，其他功能可以继续使用。你可以先重试这个区域；如果问题持续，再刷新应用。
appError.sectionHint  错误详情已记录到诊断日志里，方便继续排查。
appError.sectionRetry 重试此区域
appError.sectionTitle 这块界面出了点问题
appError.unknown      未知错误
```

**两级错误边界**：全局（`appError.*`）与区域（`appError.section*`）。这是「组件级 ErrorBoundary + 区域降级」的标准实现，必须复刻。

**`chat.error.*` 错误动作**：`重试` / `重新登录` / `重试验证码` / `稍后重试` / `切换模型` / `刷新额度` / `配置`

```
chat.error.copyFull          复制
chat.error.copyFull.copied   已复制完整报错信息
chat.error.copyFailed        复制报错信息失败：{error}
chat.error.copyTraceId       复制 TraceID
chat.error.dismiss           关闭错误提示
chat.error.expandDetails     查看详情
chat.error.collapseDetails   收起详情
chat.error.feedback          反馈问题
chat.error.feedbackOpened    已打开反馈，并自动带上报错现场
chat.error.reloginProvider   重新登录 {provider}
```

**`TraceID` 是英文大写**，且**无空格**：`复制 TraceID`。

### 7.27 菜单

真源：`desktopMenu.*`、`titleBar.menu.*`

**macOS 风格应用菜单**（ZCode 在 Windows 上也用同样的菜单语义）：

```
文件 (File)
├── 新建任务          titleBar.menu.file.newTask
├── 打开工作区        titleBar.menu.file.openWorkspace
└── 关闭窗口          titleBar.menu.file.closeWindow

视图 (View)
├── 切换全屏          titleBar.menu.view.toggleFullScreen
├── 放大              titleBar.menu.view.zoomIn
├── 缩小              titleBar.menu.view.zoomOut
└── 实际大小          titleBar.menu.view.actualSize

窗口 (Window)        titleBar.windowMenu

帮助 (Help)
├── 关于 ZCode                    titleBar.menu.help.about
├── 检查更新                      titleBar.menu.help.checkForUpdates
├── 问题反馈                      titleBar.menu.help.feedback
├── 导出日志                      titleBar.menu.help.exportLogs
├── 进程监视器                    titleBar.menu.help.processMonitor
├── 开始性能录制                  titleBar.menu.help.startPerformanceRecording
├── 停止性能录制                  titleBar.menu.help.stopPerformanceRecording
├── 切换开发者工具                titleBar.menu.help.toggleDevTools
├── 抓取 Agent stdio 通信         titleBar.menu.help.toggleZCodeStdioTap
└── 清除所有数据                  titleBar.menu.help.clearAllData
```

**注意**：`切换开发者工具` 与 `抓取 Agent stdio 通信` 是调试入口，`清除所有数据` 是危险操作（应加二次确认，`confirmDialog.*`）。

### 7.28 通知与 Toast

真源：`notification.*`

- Toast 背景色 `--color-toast`（暗色 `#2b2b2b` / 浅色 `#fff`）
- 产物有独立 chunk `toast-q6BVfrvy.js`（237 428 B）

### 7.29 命令中心

真源：`commandCenter.*`、`quickPick.*`

`[官方]`：Ctrl+K 命令面板，3.11.2 新增「最近使用和键盘提示」。

### 7.30 开发者工具与调试

真源：`developerTools.*`、`debugInfo.*`、`processMonitor.*`、`tokenDebug.*`

- 进程监视器（独立窗口 + 独立 preload）
- Agent stdio 抓取（`toggleZCodeStdioTap`）
- Token 调试面板
- 崩溃数据目录 `~/.zcode/v2/crash/` `[setting]`

### 7.31 快捷键总表 `[官方]`

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+N` | 新建任务 |
| `Ctrl+J` | 终端 |
| `Ctrl+Alt+B` | 右侧面板 |
| `Ctrl+K` | 命令中心 |
| `Ctrl+F` | 对话内搜索 |
| `Ctrl+T` | Thought Level |
| `Shift+Tab` | 切换执行模式 |
| `@` | 添加上下文（文件/会话/技能/子智能体/插件/画板） |
| `#` | 插入会话 |
| `$` | 选择技能 |
| `/` | 选择能力 |

`Ctrl+F` 的特殊性：3.11.2 更新「对话生成过程中也能正常搜索」。

---

## 八、RPC / IPC 契约

### 8.1 规模

从 `out/preload/index.cjs` 提取 **127 个 RPC 方法标识符**：

| 调用方式 | 数量 |
|---------|------|
| `invoke`（请求-响应） | 68 |
| `on`（事件订阅） | 40 |
| `send`（单向） | 19 |

真源：`zcode-analysis/rpc-surface.json`（含每个方法的调用方式计数）。

### 8.2 命名约定

ZCode 的通道名**不是字符串字面量**，而是通过一个常量对象引用（解包产物里是 `b.DoThing` 形式）。这意味着：

1. **通道名是编译期常量**，两端共享同一份定义（对应 `@zcode/rpc` 包）。
2. **不能靠 grep 字符串找通道**，必须从常量表反查。
3. 命名风格是 **PascalCase 动词开头**：`ReadFinalArmsCustomEventsE2E`、`ClearFinalArmsCustomEventsE2E`、`ConfigureFinalArmsCustomEventsE2E`。

### 8.3 暴露机制

```js
// preload 实际形态（从 unpacked/out/preload/index.cjs 提取）
h.contextBridge.exposeInMainWorld("__ZCODE_DEVICE_ID__", parseDeviceIdFromArgs());
h.contextBridge.exposeInMainWorld("__zcodeFinalArmsCustomEventsE2E", {
  read:    () => ipcRenderer.invoke(b.ReadFinalArmsCustomEventsE2E),
  clear:   () => ipcRenderer.invoke(b.ClearFinalArmsCustomEventsE2E),
  configure: (t) => ipcRenderer.invoke(b.ConfigureFinalArmsCustomEventsE2E, t),
});
```

**两个设计要点**：
1. 除 `window.api` 式聚合对象外，ZCode 还用**独立命名空间对象**暴露（`__zcodeFinalArmsCustomEventsE2E`）。
2. 设备 ID 通过 **`--device-id=` 命令行参数**注入（`parseDeviceIdFromArgs` 扫描 `process.argv`），不是配置文件。

### 8.4 Zod schema 校验

preload 里有 `zod` 的 schema 校验（产物可见 `e.object({id: e.string().uuid(), ok: e.literal(!1), error: e.string().min(1)}).strict()`）。

**`.strict()` 是强制的**——不允许额外字段。契约变更必须显式。

**我们的实现要求**：
- `src/shared/rpc/` 里每个通道定义 `{ channel: string, request: ZodSchema, response: ZodSchema }`，全部 `.strict()`。
- main / host / preload 三端从同一份导入。
- 契约测试：preload 每个方法都有 zod 校验的集成测试。

### 8.5 与旧文档的差异

旧版文档（v17）假设了 `window.api.auth.login` 这类**语义化聚合 API**。ZCode 真实做法是**平铺的 RPC 方法表 + 部分命名空间对象**。我们采用 ZCode 的真实形态，而非 v17 的理想化设计。

---

## 九、数据面与持久化

### 9.1 `~/.zcode/` 目录树 `[setting]`

```
.zcode/
├── cli/                          # CLI / Agent 运行时数据
│   ├── agents/                   # 子智能体执行记录
│   ├── artifacts/                # 产物
│   ├── db/db.sqlite              # 主数据库（本机 166 723 584 B ≈ 166 MB）
│   ├── db/db.sqlite-shm          # 32 768 B
│   ├── db/db.sqlite-wal          # 4 140 632 B
│   ├── exec/                     # 执行记录（按 session + call id）
│   ├── image-cache/              # 图片缓存
│   ├── log/                      # 日志
│   ├── plugins/                  # 插件
│   │   ├── cache/
│   │   ├── data/
│   │   ├── marketplaces/
│   │   ├── icon-sources.json     # 25 527 B
│   │   └── known_marketplaces.json  # 1 013 B
│   └── rollout/                  # 灰度发布
├── plugin-workspace/             # 插件工作区
├── skills/                       # 技能（符号链接）
├── v2/                           # 桌面端配置（v2 协议）
│   ├── certs/                    # 证书
│   ├── checkpoints/              # 文件改动 checkpoint（§7.5）
│   ├── crash/                    # 崩溃数据
│   ├── logs/                     # 日志
│   ├── bot-config.json           # 495 B（Bot 通道配置）
│   ├── bot-state.v2.json         # 33 B
│   ├── coding-plan-cache.json    # 600 B（套餐缓存）
│   ├── config.json               # 18 977 B（模型/推理配置）
│   ├── config.json.bak-<date>    # 13 145 B（自动备份）
│   ├── credentials.json          # 1 884 B（凭据）
│   ├── setting.json              # 3 653 B（桌面端设置）
│   └── tasks-index.sqlite        # 917 504 B（+ wal 4 140 632 B）
└── workspace/                    # 工作区数据
    └── default/                  # 纯对话工作区（workspacePurpose: "conversation"）
```

**关键事实**：
- 有**两个 SQLite**：`cli/db/db.sqlite`（166 MB，Agent 运行时主库）与 `v2/tasks-index.sqlite`（917 KB，任务索引）。职责分离。
- WAL 模式全程开启（`-wal` / `-shm` 文件存在）。
- `config.json.bak-<date>` 自动备份机制存在，必须实现。
- 版本前缀 `v2` 说明协议有过迁移，实现时应预留 `v3` 迁移路径。

### 9.2 `setting.json` 全字段表 `[setting]`

| 字段 | 类型 | 实测值 | 说明 |
|------|------|--------|------|
| `recentProjects` | string[] | 8 项 | 最近打开的项目路径 |
| `locale` | string | `"zh-CN"` | 当前语言 |
| `localePreference` | string | `"system"` | 语言偏好（system 跟随系统） |
| `terminalInheritSystemProfile` | bool | `true` | 终端继承系统 shell profile |
| `embeddedBrowserAllowInsecureCertificates` | bool | `false` | 内置浏览器允许不安全证书 |
| `embeddedBrowserViewportPreference.mode` | string | `"normal"` | 视口模式 |
| `embeddedBrowserViewportPreference.viewport.width` | number | `393` | 视口宽 |
| `embeddedBrowserViewportPreference.viewport.height` | number | `852` | 视口高 |
| `embeddedBrowserViewportPreference.zoom` | string | `"fit"` | 缩放策略 |
| `computerUseComposerEntryHidden` | bool | `true` | 隐藏 Composer 里的 CUA 入口 |
| `taskAutoArchiveEnabled` | bool | `false` | 任务自动归档 |
| `taskAutoArchiveOlderThanDays` | number | `7` | 归档阈值（天） |
| `closeToTrayOnWindows` | bool | `false` | Windows 关闭到托盘 |
| `closeToTrayOnWindowsMigrationInitialized` | bool | `true` | 迁移标记 |
| `keepAwakeWhileRunning` | bool | `true` | 运行时保持唤醒 |
| `desktopWindowSize.width` | number | `1216` | 窗口宽 |
| `desktopWindowSize.height` | number | `808` | 窗口高 |
| `desktopWindowSize.maximized` | bool | `true` | 是否最大化 |
| `desktopChromiumHardwareAccelerationEnabled` | bool | `true` | Chromium 硬件加速 |
| `messageStreamShowReasoning` | bool | `true` | 显示思考轨迹 |
| `messageStreamShowReasoningMigrationInitialized` | bool | `true` | 迁移标记 |
| `messageStreamShowTodos` | bool | `false` | 显示 todo 进度 |
| `toolGroupingExploreEnabled` | bool | `true` | 分组探索类工具调用 |
| `toolGroupingTerminalEnabled` | bool | `true` | 分组终端类工具调用 |
| `toolGroupingChangesEnabled` | bool | `false` | 分组文件改动类工具调用 |
| `zcodeInteractionBehavior` | string | `"queue"` | 交互行为（排队） |
| `askUserQuestionAutoResolutionEnabled` | bool | `true` | 提问自动解析 |
| `modelIoFullRetentionEnabled` | bool | `false` | 模型 IO 全量保留 |
| `optimizeAgentExperienceEnabled` | bool | `false` | 优化 Agent 体验 |
| `optimizeAgentExperienceMigrationInitialized` | bool | `true` | 迁移标记 |
| `enabledBuiltinAgentCliProviders` | string[] | `["glm"]` | 启用的内置 provider |
| `modelProviderFamilyModes.zai` | string | `"oauth"` | zai 家族认证方式 |
| `modelProviderFamilyModes.bigmodel` | string | `"oauth"` | bigmodel 家族认证方式 |
| `modelProviderFamilySelectedKeys.zai` | string | `coding-plan:builtin:zai-coding-plan` | zai 选中的套餐 |
| `modelProviderFamilySelectedKeys.bigmodel` | string | `coding-plan:builtin:bigmodel-coding-plan` | bigmodel 选中的套餐 |
| `providerFamilyDomain` | string | `"bigmodel"` | 当前 provider 域 |
| `providerFamilyDomainUpdatedAt` | number | `1788849986638` | 更新时间戳（ms） |
| `providerFamilyDomainMigrated` | bool | `true` | 迁移标记 |
| `repoSnapshotIndexingEnabled` | bool | `false` | 仓库快照索引 |
| `instantGrepIndexingEnabled` | bool | `false` | 即时 grep 索引 |
| `nativeSearchEnhancementsEnabled` | bool | `true` | 原生搜索增强 |
| `memoryEnabled` | bool | `false` | 记忆 |
| `lastWorkspaceSession` | object[] | 9 项 | 最近工作区会话（见 §9.5） |
| `lastActiveTabIndex` | number | `7` | 最后激活的 tab 索引 |
| `receivePreviewUpdates` | bool | `false` | 接收预览版更新 |
| `autoDownloadAndInstallUpdates` | bool | `false` | 自动下载安装更新 |
| `skippedElectronUpdateVersions` | object | `{}` | 跳过的更新版本集合 |
| `settingsSyncFirstRunPromptHandled` | bool | `true` | 设置同步首跑提示已处理 |
| `webRemoteControlExternalRelayDevice.deviceSid` | string | `d_HgZDjMy8gNAt9U1zMQEnDx` | 远程中继设备 ID |
| `webRemoteControlLastEnabledContext.workspacePath` | string | `D:\Portable\khy-os` | 上次启用远程的工作区 |
| `webRemoteControlLastEnabledContext.initialTaskId` | string | `sess_74b99e12-...` | 上次启用远程的任务 |

**40 个字段，必须逐个实现**。`setting.json` 是**用户可读写但需 schema 校验**的配置文件。

### 9.3 `config.json`（19 KB）

含 `reasoning.variants: ["low", "max", "high"]` 与默认 `max` `[官方]`。承载模型与推理配置。

### 9.4 `resources/config/default.json`（349 B）`[asar]`

```json
{
  "feedback_url": "https://zhipu-ai.feishu.cn/share/base/form/shrcnrXlh93cJIUFYBFndnnL7pe",
  "feedback_use_external_form": false,
  "community_urls": {
    "zh-CN": "https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=...",
    "en-US": "https://discord.gg/z9aBcQXZQ3"
  }
}
```

**实现要求**：这个文件是**可打包覆盖的**（放在 `resources/config/`，运行时读取），所以反馈 URL 与社区链接**不需要改代码**。我们放 KhyOS 自己的地址。

### 9.5 会话与工作区模型

```jsonc
// lastWorkspaceSession 元素结构 [setting]
{
  "kind": "local",              // "local" | "wsl" | "ssh" | "docker" | "remote"
  "workspacePath": "D:\\Portable\\khy-os\\docs",
  "workspacePurpose": "project" // "project" | "conversation"
}
```

**ID 格式**：
- 会话/任务：`sess_<uuid-v4>` —— `sess_74b99e12-4b39-45a0-ac8f-539e2a5e1b8a`
- 中继设备：`d_<16-base62>` —— `d_HgZDjMy8gNAt9U1zMQEnDx`

**WSL UNC 路径处理**（`[i18n]`）：
```
workspace.wslUncPrompt  建议通过 WSL 连接打开，也可以继续按路径打开。
workspace.wslUncPrompt.openWsl      打开 WSL 连接
workspace.wslUncPrompt.continuePath 继续按路径打开
```
说明 `\\wsl$\...` 与 `\\wsl.localhost\...` 路径会触发专门的引导，而不是直接当本地路径打开。

**Codex 预热检测**（`[i18n]`）：
```
taskList.codexConnectivityUnavailable
  Codex 预热检测到当前网络无法访问 {host}，后续对话可能无法正常开始
```

### 9.6 从 cc-switch 迁移策略

> **背景**：本项目旧版（CLAUDE.md v1）的数据源是 `Tools/cc-switch/.cc-switch/cc-switch.db`（SQLite）和 `Tools/claude/settings.json`（Claude Code 配置）。新版采用 ZCode 式的 `~/.khyos/v2/` 目录结构。两者需要共存过渡。

**迁移原则**：

1. **新安装用户**：直接使用 `~/.khyos/v2/` 结构，不触发迁移。
2. **旧用户升级**：检测到 `cc-switch.db` 存在时，自动执行一次性迁移。
3. **迁移后**：旧数据库保留不删除（降级回退用），新数据全部写入新结构。

**映射规则**：

| cc-switch 数据 | 新结构位置 | 迁移方式 |
|---------------|-----------|---------|
| `cc-switch.db` → `providers` 表 | `~/.khyos/v2/setting.json` → `providerConfigs` 字段 | 读取 DB，写入 JSON |
| `cc-switch.db` → `sessions` 表 | `~/.khyos/cli/db/db.sqlite` → `sessions` 表 | SQL INSERT 迁移 |
| `claude/settings.json` → `mcpServers` | `~/.khyos/v2/setting.json` → `mcpServers` 字段 | JSON 合并 |
| `data/sessions.db`（本项目） | `~/.khyos/v2/tasks-index.sqlite` | 读旧 DB → 写新 DB |

**迁移检测逻辑**（在 `src/main/index.ts` 启动时执行）：

```ts
function checkMigrationNeeded(): boolean {
  const ccSwitchPath = findCcSwitchDb()  // 扫描 Portable/Tools/cc-switch/
  const newDbPath = path.join(app.getPath('userData'), 'v2/setting.json')
  return fs.existsSync(ccSwitchPath) && !fs.existsSync(newDbPath + '.migrated')
}

async function runMigration() {
  // 1. 读取 cc-switch.db 的 providers
  // 2. 转换为 setting.json 格式
  // 3. 写入 ~/.khyos/v2/setting.json
  // 4. 创建 .migrated 标记文件
  // 5. 日志记录迁移完成
}
```

**迁移标记文件**：`~/.khyos/v2/cc-switch-migrated`（0 字节），存在即表示已迁移。

---

## 十、可观测性、合规与系统能力

### 10.1 RUM 与追踪

- `@arms/rum-electron ^0.0.3` + `@arms/rum-browser`：前端性能与错误上报
- OpenTelemetry OTLP proto 导出
- `TraceID` 出现在错误复制动作里（`chat.error.copyTraceId`），说明 trace 与 UI 双向关联

**我们的策略**：保留 OTel 本地 span，导出端可插拔；UI 保留 TraceID 展示位；默认不上报。

### 10.2 崩溃与日志

- `~/.zcode/v2/crash/`、`~/.zcode/v2/logs/`、`~/.zcode/cli/log/`
- `appError.hint: 错误详情已记录到诊断日志里，方便继续排查。` —— 文案承诺日志可用
- 菜单「导出日志」`titleBar.menu.help.exportLogs`
- `yazl ^3.3.1`（流式 zip 写入）用于打包导出

### 10.3 构建就绪标记 `[asar]`

```
out/.main-build-ready
out/.host-build-ready
out/.preload-build-ready
out/.scheduler-build-ready
```

四个 25 字节的标记文件。运行时据此判断是否需要重建对应进程产物。**这是开发期热更的支撑**——改 main 只需重建 main，不用全量。必须实现。

### 10.4 系统能力清单

| 能力 | 实现 |
|------|------|
| 单实例锁 | `app.requestSingleInstanceLock` |
| 全局快捷键 | `app.globalShortcut`（经 IPC 注册，退出必须 `unregister`） |
| 托盘 | `Tray` + `closeToTrayOnWindows` |
| 通知 | `Notification` |
| 自定义 scheme | 深链（如 `khyos://`） |
| 文件对话框 | `dialog.showOpenDialog`（工作区选择、文件附加） |
| 系统文件管理器 | `shell.openPath` / `shell.openExternal` |
| 外部编辑器 | `shell.openExternal` + `selectOpenApp` |
| 保持唤醒 | `powerSaveBlocker` / Windows PowerRequest |
| 硬件加速开关 | `app.commandLine` |
| 深链/命令行参数 | `--device-id=` 等 |

---

## 十一、打包、签名、分发与更新

### 11.1 electron-builder 配置要点 `[竞品]`

ZCode 产物特征：`Uninstall ZCode.exe`、`elevate.exe`（UAC 提权）、`icon.png`（215 707 B）、`icon_windows.png`（263 521 B）、`tray_icon.ico`（54 556 B）、`app-update.yml`（121 B）。

**`app-update.yml` 存在且只有 121 字节**，说明用 `generic` provider（结构简单）。

```yaml
# electron-builder.yml（核心配置）
appId: com.khy-os.desktop
productName: KhyOS Desktop
asar: true
asarUnpack:
  - "**/*.node"
  - "**/*.wasm"
files:
  - out/**/*
  - resources/**/*
  - "!**/*.map"
win:
  target:
    - target: nsis
    - target: portable
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  guid: <固定 UUID，永不变更>
  differentialPackage: false
  createDesktopShortcut: always
  createStartMenuShortcut: true
mac:
  target: [dmg, zip]
  hardenedRuntime: true
  entitlementsInherit: build/entitlements.mac.plist
publish:
  provider: generic
  url: https://<khyos-update-cdn>/desktop
```

**关键决策**：
- `oneClick: false` + `allowToChangeInstallationDirectory: true` —— Agent 类应用依赖模型/缓存路径稳定，**安装目录必须可迁移**。
- `guid` 固定 —— 变更会导致已安装实例无法识别更新。
- `differentialPackage: false` —— 增量包生态不成熟（Cherry/AionUi 均显式关闭）。
- `asarUnpack` 白名单制，只解包原生模块与 wasm。

### 11.2 asarUnpack 白名单

必须解包（不能从 asar 内加载）：

```
node-pty 的 .node 二进制
@lydell/node-pty-linux-x64 / linux-arm64
better-sqlite3（若使用）
sharp 的预编译 .node
@shikijs/engine-oniguruma 的 wasm
@pierre/diffs 的 wasm
@dukelib/sheets-wasm 的 wasm
pdfjs-dist 的 wasm
@extend-ai/react-xlsx/docx 的 wasm
内置 MCP 脚本（若打包）
```

**不推荐** `asar.smartUnpack: true`（会把整个包拆散，更新体积爆炸）。用显式白名单。

### 11.3 原生模块与 Windows

- node-pty：ConPTY，**要求 Windows 10 1809+**（低于此版本必须在启动时检测并给出明确错误）
- 编译：Windows SDK「Desktop C++ Apps」+ Spectre-mitigated CRT
- 预编译优先：`npmRebuild: false` + 拉取预编译二进制（AionUi 做法）
- `sharp 0.34.5` 用预编译平台包
- 版本必须与 Electron ABI 匹配，不匹配即崩

### 11.4 签名与公证

```yaml
win:
  signtoolOptions:
    sign:
      cmd: <signtool 脚本，支持跨机签名>
mac:
  notarize: true
  darkModeSupport: true
```

`@fiahfy/icns ^0.0.7` 用于生成 macOS 多尺寸图标（ZCode 依赖里有）。

### 11.5 更新流

`[i18n]` 六命名空间（`update` / `updateAvailable` / `updateDialog` / `updateReady` / `forceUpdate` / `postUpdateReleaseNotes`）说明完整状态机：

```
checking → available → downloading(progress) → ready → restarting
                                    ↓
                              forceUpdate（不可跳过）
restarting → postUpdateReleaseNotes（重启后展示发布说明）
```

`skippedElectronUpdateVersions: {}` 支持跳过指定版本，但 `forceUpdate` 不受此约束。

---

## 十二、实施路线图

### Phase 0a — 清场与两进程骨架（0.5 天）

> **目标**：删掉旧代码，建最小可运行的 Electron + React 骨架（仅 main + renderer），能 `npm run dev` 启动空窗口。

**步骤 1：删除旧文件**

```bash
# 删除 Vue 相关
rm -rf src/App.vue src/main.js src/stores/ src/themes/ src/composables/ src/views/
rm -rf src/components/ src/assets/ src/utils/
rm -rf node_modules/ package-lock.json pnpm-lock.yaml

# 删除历史试验产物
rm -f preview*.html BUILD_README.md build.log

# 删除旧的 khyos-out（历史解包产物，与真源无关）
rm -rf zcode-analysis/khyos-out/

# 保留 zcode-analysis/ 下的脚本与真源文件（禁止删除）
# 保留 CLAUDE.md（将在步骤 5 更新）
```

**步骤 2：创建 `package.json`（版本全部锁定）**

```json
{
  "name": "khyos-desktop",
  "version": "0.1.0",
  "description": "KhyOS Desktop — ZCode 1:1 clone",
  "main": "out/main/index.js",
  "type": "module",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "preview": "electron-vite preview",
    "electron:dev": "electron-vite dev",
    "electron:build": "electron-vite build && electron-builder",
    "start": "electron-vite preview",
    "check:rules": "node scripts/ci/check-agent-rules.js --changed",
    "check:i18n": "node scripts/ci/check-i18n-fidelity.js",
    "check:tokens": "node scripts/ci/check-tokens.js",
    "check:brand": "node scripts/ci/check-brand-replacement.js",
    "check:layout": "node scripts/ci/check-layout.js"
  },
  "dependencies": {
    "react": "^19.2.4",
    "react-dom": "^19.2.4",
    "@reduxjs/toolkit": "^2.5.0",
    "react-redux": "^9.2.0",
    "tailwindcss": "^4.2.2",
    "clsx": "^2.1.1",
    "tailwind-merge": "^2.6.0",
    "zod": "^3.24.0",
    "electron-updater": "6.8.9"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "electron": "44.2.0",
    "electron-builder": "26.15.3",
    "electron-vite": "5.0.0",
    "typescript": "^5.7.0",
    "vite": "^6.0.0"
  },
  "build": {
    "appId": "com.khy-os.desktop",
    "productName": "KhyOS Desktop",
    "asar": true,
    "asarUnpack": [
      "**/*.node",
      "**/*.wasm"
    ],
    "directories": {
      "output": "dist-electron"
    },
    "files": [
      "out/**/*",
      "resources/**/*"
    ],
    "win": {
      "target": [
        { "target": "nsis" },
        { "target": "portable" }
      ],
      "icon": "resources/icon/icon.ico",
      "signtoolOptions": {
        "sign": false
      }
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "guid": "com.khy-os.desktop",
      "differentialPackage": false,
      "createDesktopShortcut": "always",
      "createStartMenuShortcut": true
    },
    "mac": {
      "target": ["dmg", "zip"],
      "hardenedRuntime": true,
      "darkModeSupport": true
    },
    "publish": {
      "provider": "generic",
      "url": "https://update.khyquant.top/desktop"
    },
    "electronDownload": {
      "mirror": "https://npmmirror.com/mirrors/electron/"
    }
  }
}
```

**步骤 3：创建 `electron.vite.config.ts`（两产物：main + renderer）**

```ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: 'src/main/index.ts'
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: 'src/preload/index.ts'
      }
    }
  },
  renderer: {
    plugins: [react()],
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: 'src/renderer/index.html'
      }
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src/renderer')
      }
    }
  }
})
```

**步骤 4：创建最小文件结构**

```
src/
├── main/
│   └── index.ts              # 主进程入口（窗口 1216×808，无边框，可拖动）
├── preload/
│   └── index.ts              # 空 preload（Phase 0b 填充）
├── renderer/
│   ├── index.html            # <!DOCTYPE html><div id="root"></div>
│   ├── main.tsx              # ReactDOM.createRoot(...)
│   ├── App.tsx               # <div style={{background:'#161616',height:'100vh'}} />
│   └── theme/
│       └── globals.css       # @import "tailwindcss"; + 基础变量
├── shared/
│   └── rpc/
│       └── channels.ts       # 空的 RPC 通道常量（Phase 0b 填充）
scripts/
├── ci/
│   ├── check-agent-rules.js  # 从 AGENTS.md 仓库根复制或新建
│   └── check-i18n-fidelity.js
tsconfig.json
tsconfig.node.json
```

**步骤 5：更新 `CLAUDE.md`**

将 CLAUDE.md 内容替换为指向本设计文档的 stub（见 §0.1）。

**步骤 6：安装依赖并验证**

```bash
npm install
npm run dev
```

**验收**：窗口出现，1216×808，无边框，可拖动，背景色 `#161616`（暗色主题背景）。无报错。

---

### Phase 0b — 加 preload（0.5 天）

> **目标**：创建 preload 脚本，暴露首批 20 个高频 RPC 方法（stub 实现），renderer 能通过 `window.__KHYOS__` 访问。

**步骤 1：实现 `src/preload/index.ts`**

```ts
import { contextBridge, ipcRenderer } from 'electron'

// 暴露首批高频 RPC 方法（stub: 直接返回占位值）
const api = {
  // 窗口控制
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),

  // 设置读写
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),

  // 主题
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (mode: string) => ipcRenderer.invoke('theme:set', mode),

  // 文件系统
  openDirectoryPicker: () => ipcRenderer.invoke('fs:openDirectory'),
  readFile: (path: string) => ipcRenderer.invoke('fs:readFile', path),
  writeFile: (path: string, content: string) => ipcRenderer.invoke('fs:writeFile', path, content),

  // AI 网关
  aiSend: (payload: unknown) => ipcRenderer.invoke('ai:send', payload),
  aiStream: (payload: unknown) => ipcRenderer.invoke('ai:stream', payload),

  // 会话
  createSession: (workspacePath: string) => ipcRenderer.invoke('session:create', workspacePath),
  listSessions: () => ipcRenderer.invoke('session:list'),

  // 平台信息
  getPlatform: () => process.platform,

  // 版本
  getVersion: () => ipcRenderer.invoke('app:version'),
}

contextBridge.exposeInMainWorld('__KHYOS__', api)
```

**步骤 2：在 `src/main/index.ts` 中注册对应的 IPC handler（stub）**

每个 `ipcRenderer.invoke` 对应一个 `ipcMain.handle`。Phase 0b 先返回占位值。

**步骤 3：在 renderer 中验证**

```tsx
// App.tsx
function App() {
  const [platform, setPlatform] = useState('')
  useEffect(() => {
    (window as any).__KHYOS__?.getPlatform().then(setPlatform)
  }, [])
  return <div>Platform: {platform}</div>
}
```

**验收**：renderer 控制台输出 `Platform: win32`，无报错。

---

### Phase 0c — 加 host 进程（0.5 天）

> **目标**：创建 host 进程，直连 KhyOS 后端（localhost），不走五通道。

**步骤 1：更新 `electron.vite.config.ts`**

在 main 和 renderer 之外新增 host 和 scheduler 的 rollup input 配置（此时 scheduler 为空壳）。

**步骤 2：创建 `src/host/index.ts`**

```ts
// host 进程：Agent 运行时适配
// Phase 0c 只做进程启动和基础 IPC，不实现五通道桥接

import { app, ipcMain } from 'electron'

console.log('[host] 进程启动')

// 注册 host 专用 IPC handler
ipcMain.handle('host:status', async () => {
  return { running: true, pid: process.pid }
})
```

**步骤 3：在 `src/main/index.ts` 中 spawn host 进程**

```ts
import { fork } from 'child_process'
import path from 'path'

function startHostProcess() {
  const hostPath = path.join(__dirname, '../host/index.js')
  const child = fork(hostPath, [], { stdio: 'pipe' })
  child.stdout?.on('data', (data) => console.log('[host]', data.toString()))
  child.stderr?.on('data', (data) => console.error('[host]', data.toString()))
  return child
}
```

**步骤 4：构建验证**

```bash
npm run build
node out/main/index.js   # 应同时启动 host 进程
```

**验收**：控制台输出 `[host] 进程启动`，无崩溃。

---

### Phase 0d — 加 scheduler + 品牌替换预处理（0.5 天）

> **目标**：创建 scheduler 空壳 + 处理品牌替换，为 Phase 1 做准备。

**步骤 1：创建 `src/scheduler/index.ts`（空壳）**

```ts
// scheduler 进程：定时任务、闲时算力
// Phase 0d 只做进程启动，具体逻辑在 Phase 10 实现

console.log('[scheduler] 进程启动')

// 空的 cron 表达式解析占位
export function parseCron(expr: string): Date {
  // Phase 10 实现
  throw new Error('Not implemented')
}
```

**步骤 2：品牌替换预处理**

在 `zcode-analysis/` 目录下创建品牌替换后的文案文件：

```bash
# 复制真源
cp zcode-analysis/i18n-zh.json zcode-analysis/i18n-zh-raw.json

# 运行品牌替换脚本（创建 scripts/ci/brand-replace.js）
node scripts/ci/brand-replace.js
```

**`scripts/ci/brand-replace.js` 的逻辑**：

```js
const fs = require('fs')
const raw = JSON.parse(fs.readFileSync('zcode-analysis/i18n-zh-raw.json', 'utf8'))

function replaceBrand(obj) {
  const result = {}
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'object' && val !== null) {
      result[key] = replaceBrand(val)
    } else if (typeof val === 'string') {
      result[key] = val
        .replace(/ZCode/g, 'KhyOS')
        .replace(/zcode\.z\.ai/g, 'khyquant.top')
        .replace(/智谱/g, 'KhyOS')
        .replace(/GLM/g, 'KhyOS')  // 注意：此规则需根据实际文案细化
    } else {
      result[key] = val
    }
  }
  return result
}

const replaced = replaceBrand(raw)
fs.writeFileSync('zcode-analysis/i18n-zh.json', JSON.stringify(replaced, null, 2))
console.log('品牌替换完成')
```

**步骤 3：创建 `scripts/ci/check-brand-replacement.js`**

校验 `i18n-zh.json` 中不包含 ZCode/GLM/智谱 等品牌词（欢迎标题等需保留英文的除外）。

**步骤 4：更新 `tsconfig.json`**

确保 TypeScript 配置支持多进程构建。

**验收**：`npm run build && npm run start` 四个进程全部启动（main/host/scheduler/preload），控制台无报错。`zcode-analysis/i18n-zh.json` 不含品牌词。

### Phase 1 — 设计令牌与主题（1 天）

> 依赖：Phase 0a-0d 全部完成
> 真源：`zcode-analysis/tokens.txt`（572 条规则，456 个自定义属性）

**Step 1.1：创建主题基础文件**

文件：`src/renderer/theme/globals.css`

```css
@import "tailwindcss";

/* 基础变量（§4.2-4.3） */
:root {
  --spacing: .25rem;
  --radius-xs: .125rem;
  --radius-sm: .25rem;
  --radius-md: .375rem;
  --radius-lg: .5rem;
  --radius-xl: .75rem;
  --radius-2xl: 1rem;
  --radius-3xl: 1.5rem;
  --ease-out: cubic-bezier(0, 0, .2, 1);
  --ease-in-out: cubic-bezier(.4, 0, .2, 1);
  --font-sans: ui-sans-serif, system-ui, sans-serif,
    "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
    "Liberation Mono", "Courier New",
    "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC",
    monospace;
}

/* 色板基元 OKLCH（§4.8） */
@theme {
  --color-neutral-50: oklch(98.5% 0 0);
  --color-neutral-100: oklch(97% 0 0);
  --color-neutral-200: oklch(92.2% 0 0);
  --color-neutral-300: oklch(87% 0 0);
  --color-neutral-400: oklch(70.8% 0 0);
  --color-neutral-500: oklch(55.6% 0 0);
  --color-neutral-700: oklch(37.1% 0 0);
  --color-neutral-800: oklch(26.9% 0 0);
  --color-neutral-900: oklch(20.5% 0 0);
  --color-neutral-950: oklch(14.5% 0 0);
  --color-sky-50: oklch(97.7% .013 236.62);
  --color-sky-500: oklch(68.5% .169 237.323);
  --color-sky-600: oklch(58.8% .158 241.966);
}
```

暗色/浅色主题全量令牌见 §4.4-4.5，必须逐值落地。三主题类：`.dark`（通用暗色）、`.theme-zai-light`（品牌浅色）、`.theme-zai-dark`（品牌暗色）。

**Step 1.2：注册语义 utility（§4.11）**

在 `@theme` 块中注册 `.bg-sidebar` `.bg-panel` `.bg-card` `.bg-input` `.text-foreground` `.border-border` 等语义工具类。

**Step 1.3：创建 ThemeProvider**

文件：`src/renderer/theme/ThemeProvider.tsx` — 用 `useState` 管理 `themeMode: 'light' | 'dark' | 'system'`，`useEffect` 切换根节点 class。

**Step 1.4：创建令牌抽检脚本**

文件：`scripts/ci/check-tokens.js` — 读取 `tokens.txt` 提取 20 个关键令牌，用 Playwright `getComputedStyle` 抽检。

**验收**：`node scripts/ci/check-tokens.js` → 20/20 令牌匹配。三主题切换，背景色正确（暗色 `#161616`，浅色 `#f8f8f8`）。

---

### Phase 2 — 布局骨架（2 天）

> 依赖：Phase 1 完成
> 真源：§5.1-5.5

**Step 2.1：TitleBar 组件**

文件：`src/renderer/components/layout/TitleBar.tsx`

- Windows：无边框 + 自绘标题栏 48px，右侧 3 个 46px caption 按钮（最小化/最大化/关闭），`WebkitAppRegion: 'drag'`。
- macOS：隐藏原生标题栏，traffic lights 保留在左上，内容顶部留 48px 避让（`.platform-mac-desktop\:top-12`）。
- 平台 class 机制：根节点根据 `process.platform` 挂 `platform-windows-desktop` / `platform-mac-desktop`。

**Step 2.2：三段式布局**

文件：`src/renderer/components/layout/AppLayout.tsx`

```
┌──────────────────────────────────────────────┐
│ TitleBar (48px)                              │
├────┬─────────────────────┬───────────────────┤
│ 左 │    主内容区          │    右面板          │
│ 图 │  (chat/task)        │  (Ctrl+Alt+B)     │
│ 栏 │                     │  - 文件树          │
│    │                     │  - 终端 (Ctrl+J)   │
│ 12 │                     │  - Git             │
│ px │                     │                   │
├────┴─────────────────────┴───────────────────┤
│ StatusBar: 上下文用量/模型/模式/Thought Level  │
└──────────────────────────────────────────────┘
```

左图标栏（`Sidebar`）12px + 工作区侧栏（`WorkspaceSidebar`，CSS 变量 `--workspace-sidebar-panel-width` 驱动，可拖拽）+ 主内容 + 右面板（`SidePane`，`Ctrl+Alt+B` 切换）+ 状态栏（`StatusBar`）。

**Step 2.3：可拖拽侧栏宽度**

用 `useResizable` hook，监听 `mousedown/mousemove/mouseup`，宽度约束在 200-600px。

**Step 2.4：菜单系统（§7.27）**

文件：`src/main/menu.ts` — File/View/Window/Help 四个菜单，含「新建任务」「打开工作区」「检查更新」「导出日志」「进程监视器」「清除所有数据」等。

**Step 2.5：窗口尺寸持久化**

用 `electron-store` 持久化 `desktopWindowSize`，`win.on('close')` 时保存 bounds + maximized 状态。

**验收**：Windows 自绘标题栏，最小化/最大化/关闭可用。窗口调整大小后关闭再打开，尺寸还原。

---

### Phase 3 — i18n 与组件库（2 天）

> 依赖：Phase 2 完成
> 真源：§6, `zcode-analysis/i18n-zh.json`（5070 键）

**Step 3.1：i18n 基础设施**

```bash
npm install react-i18next i18next
```

文件：`src/renderer/i18n/index.ts` — `initReactI18next` + 缺失键报错（`missingKeyHandler`）。复制品牌替换后的 `zcode-analysis/i18n-zh.json` → `src/renderer/i18n/zh-CN.json`。

**Step 3.2：文案 CI 校验脚本**

文件：`scripts/ci/check-i18n-fidelity.js` — 逐键逐字符比对 `i18n-zh.json`（真源）与构建产物。差异非空即 fail。

**Step 3.3：shadcn/ui 组件库**

```bash
npm install @radix-ui/react-dialog @radix-ui/react-dropdown-menu @radix-ui/react-select \
  @radix-ui/react-tabs @radix-ui/react-tooltip @radix-ui/react-popover \
  class-variance-authority lucide-react
```

创建 `src/renderer/components/ui/` 目录，包含 button、dialog、dropdown-menu、select、tabs、tooltip、popover、scroll-area、input、badge、separator、skeleton、toast。

**Step 3.4：语义组件**

`ErrorBoundary`（两级：全局 + 区域，区域出错不白屏）、`Spinner`（遵守规则 2：动作+目标+进度）、`EmptyState`、`ConfirmDialog`。

**Step 3.5：lint 规则**

`no-restricted-syntax` 禁止 `.tsx` 中出现中文字面量。

**验收**：`node scripts/ci/check-i18n-fidelity.js` → 5070 keys match, 0 diffs。`npx eslint src/` → 无中文字面量报错。

### Phase 4 — 任务侧栏与会话（3 天）

> 依赖：Phase 3 完成
> 真源：§7.1, §9.5, `workspaceSidebar.*`（44 键）

**Step 4.1：工作区数据模型**

文件：`src/shared/types/workspace.ts` — `WorkspaceKind`（local/ssh/wsl/docker/remote）、`WorkspacePurpose`（project/conversation）、`Task`（id 格式 `sess_<uuid-v4>`）。

文件：`src/renderer/state/workspaceSlice.ts` — Redux Toolkit slice：`currentWorkspace`、`tasks`、`archivedTasks`、`viewMode`（grouped/chronological）、`sortBy`（createdAt/updatedAt）、`searchQuery`。async thunk `loadWorkspaces` 从 `__KHYOS__?.getSettings()` 读取。

**Step 4.2：WorkspaceSidebar 组件**

文件：`src/renderer/components/layout/WorkspaceSidebar.tsx`

结构：搜索框（`taskSearch.*`）→ 视图切换 + 排序（`organize.*`/`sortBy.*`）→ 任务列表（`taskList.*`，按项目分组或时间线排列）→ 底部操作（`newConversation`/`addProject`）。

子组件：`TaskGroup`（项目分组，展开/收起）、`TaskItem`（单个任务，标题 + 相对时间 + 选中态高亮）、`EmptyTaskList`（空态：`还没有任务`）、`ArchivedTasksSection`（归档区：`archivedTasks`）。

**Step 4.3：双视图切换**

`ViewOptions` 组件：DropdownMenu 切换 grouped/chronological，切换 sortBy。

**Step 4.4：拖拽重排**

```bash
npm install @dnd-kit/core @dnd-kit/sortable
```

`DndContext` + `SortableContext` + `arrayMove`，`PointerSensor` 激活距离 8px。

**Step 4.5：WSL UNC 引导**

检测 `\\wsl$\...` 或 `\\wsl.localhost\...` 路径，弹出引导：`建议通过 WSL 连接打开，也可以继续按路径打开。` + 两个按钮（`打开 WSL 连接` / `继续按路径打开`）。

**Step 4.6：空状态与归档**

空态文案 `还没有任务`、归档区文案 `归档任务` + 计数。

**验收**：44 个 i18n 键全部可用。双视图切换、搜索、排序、拖拽重排、WSL 引导均可交互。

---

### Phase 5 — Composer（3 天）

> 依赖：Phase 3 完成
> 真源：§7.2, `chat.composer.*` / `chat.attachments.*` / `chat.mention.*` / `chat.draft.*` / `chat.edit.*`

**Step 5.1：Composer 基础骨架**

文件：`src/renderer/components/composer/Composer.tsx`

四触发器检测：输入 `@` → 文件弹出，`#` → 会话弹出，`$` → 技能弹出，`/` → 能力弹出。注意措辞差异：`@` 是「使用 @ 添加上下文」，`$`/`/` 是「使用 X 选择 Y」，`#` 是「插入 # 会话」——三个动词都不一样。

**Step 5.2：MentionPopup 六分类**

文件：`src/renderer/components/composer/MentionPopup.tsx`

6 个分类：文件/会话/技能/子智能体/插件/画板。每个分类有标题、空态文案、搜索提示。键盘导航（↑↓ Enter Escape）。

插件描述格式：`{marketplace} · {skillCount} 技能 · {mcpCount} MCP`（分隔符是全角空格 + 中点 `·`）。搜索引号用全角弯引号 `""`。

**Step 5.3：附件系统状态机（6 态）**

`queued` → `uploading`（0%→100%）→ `finishing` → `completed`；失败 `failed` → `retrying`。

约束：`附件不能超过 {sizeMb} MB`、`最多只能添加 {count} 个附件`。剪贴板文本：`{lineCount} 行`。

重启恢复：`部分草稿附件在重启后无法恢复，请重新添加：{filenames}`。

**Step 5.4：上下文用量与压缩**

`上下文对话数 {used} / 总量 {total}` + 7 项来源分解（系统提示词/系统工具/消息/MCP 工具/技能/工具提示词/其他）+ 平均缓存命中率。

压缩状态机：`idle` → `compacting` → `compacted`/`failed`/`interrupted`。重试文案：`正在重试压缩上下文（{attempt}/{maxAttempts}）`（含变量用英文半角括号）。

**Step 5.5：草稿提示词与插件安装流**

建议提示词按钮（`制作一份 PDF` / `检查近 7 天的 commit`）。插件安装流状态机：`正在检查插件状态…` → `安装{pluginLabel}插件` → `确认` → `正在安装插件…` → `安装成功`/`安装失败`/`安装超时`。注意省略号是全角 `…`。

**Step 5.6：编辑区重置与冲突检测**

三选项：`仅重置对话并发送` / `恢复本轮文件、重置对话并发送` / `取消`。冲突检测：`文件无法安全重置` + 说明文案。不可用态：`压缩中或有待处理交互时不能重置文件`。

**Step 5.7：追问三选与交互排队**

`立即发送` / `加入队列` / `引导当前任务`。

**验收**：Composer 内所有 i18n 键可用。附件状态机 6 态可走通。触发器弹出正确。

---

### Phase 6 — 消息流与模型轨迹（3 天）

> 依赖：Phase 3 完成
> 真源：§7.4, §7.26, `chat.message.*` / `modelTrajectory.*` / `appError.*` / `chat.error.*`

**Step 6.1：消息气泡**

文件：`src/renderer/components/message/MessageBubble.tsx`

折叠/展开（`收起`/`展开`）、复制（`复制`）、大消息预览（`这条回复较大，当前仅显示预览（{previewBytes} / {fullBytes}）。` → `查看完整消息`）。

**Step 6.2：流式 Markdown 渲染**

```bash
npm install streamdown @shikijs/core @shikijs/langs
```

`streamdown` 2.6.0（peerDeps `react ^18||^19`）做流式渲染，`@shikijs/core` 做语法高亮。prose 令牌从 §4.10 CSS 变量读取。

**Step 6.3：思考轨迹五态色**

`TrajectoryTimeline` 组件：用户 `#60a5fa`、助手 `#2dd4bf`、思考 `#a78bfa`、工具调用 `#f59e0b`、工具结果 `#38bdf8`。左侧竖线 + 圆点时间线。

**Step 6.4：长任务面板**

`展开长时间运行面板` / `收起长时间运行面板`。两种时长：`已运行 {minutes} 分 {seconds} 秒` / `已运行 {seconds} 秒`。

**Step 6.5：历史分页与空结果**

`正在加载更早消息...` / `加载更早消息`。空态：`没有可展示内容` + `这个任务没有生成聊天内容，可能是在模型返回正文前被停止了。`

**Step 6.6：错误体系——两级边界**

`ErrorBoundary` 包裹全局和区域。`appError.title: 应用界面出了点问题`，`appError.sectionTitle: 这块界面出了点问题`，区域出错不白屏。

`chat.error.*` 动作集：`重试` / `重新登录` / `切换模型` / `关闭错误提示` / `复制` / `复制 TraceID`（注意 TraceID 英文大写无空格）。

**验收**：流式输出无闪烁。5 种 trajectory 色渲染正确。错误降级 UI 不白屏。

### Phase 7 — 文件改动与终端（3 天）

> 依赖：Phase 3 完成
> 真源：§7.5, §7.9, `chat.changeSummary.*` / `terminal.*`

**Step 7.1：Checkpoint 存储层**

文件：`src/main/checkpoints/index.ts`

等价路径 `~/.khyos/v2/checkpoints/`。`createCheckpoint(sessionId, files)` 写 JSON 到 `{sessionId}/{cp_xxx}.json`。`readCheckpoint` / `listCheckpoint` 读取。IPC handler 注册 `checkpoint:create/read/list`。

**Step 7.2：改动摘要与原子撤销（§7.5）**

`ChangeSummary` 组件：`展开已更改文件`/`收起已更改文件` + `{count} 个文件已更改`（one/other 复数）+ 操作按钮（`审查`/`撤销`/`已撤销`/`在编辑器中打开`）。

`RewindDialog` 撤销对话框——三桶原子语义：
- 安全区：`可安全撤销 {count}`
- 不安全区：`不能安全撤销 {count}`（6 种原因：缺少 checkpoint / 无法读取 / 外部修改 / 文件读取失败 / 不支持的 checkpoint / bash 已忽略）
- 忽略区：`已忽略 {count}`

核心安全原则：`撤销前会重新检查当前文件内容；如果文件已被其他进程改过，本次不会写入任何文件。` 全部安全才写，有任一根不安全就全不写。

**Step 7.3：终端组件**

```bash
npm install @xterm/xterm @xterm/addon-fit @xterm/addon-web-links @xterm/addon-search @xterm/addon-webgl
```

xterm 6 + 4 addons。16 色从 CSS 变量 `--color-terminal-*` 读取（§4.7）。pty 宿主在 main 进程，renderer 走 IPC `data/resize/closed/exit`。快捷键 **Ctrl+J** 打开/关闭。

**Step 7.4：工具分组折叠**

三个开关：`toolGroupingExploreEnabled: true`、`toolGroupingTerminalEnabled: true`、`toolGroupingChangesEnabled: false`。折叠/展开 + 计数。

**Step 7.5：node-pty Windows 1809+ 检测**

`os.release()` 解析 build 号，低于 18309 弹 `dialog.showErrorBox` 并 `app.exit(1)`。

**验收**：撤销三桶原子语义正确。终端可交互，16 色渲染正确。Ctrl+J 切换终端面板。

---

### Phase 8 — 文件树 / Diff / Git（2 天）

> 依赖：Phase 3 完成
> 真源：§7.10, §7.11, `fileTree.*` / `codeViewer.*` / `diff.*` / `git.*` / `gitGraph.*`

**Step 8.1：文件树**

`FileTree` 组件：递归渲染目录/文件节点，展开/折叠，拖拽引用到 Composer（`松开以引用此文件或目录`）。右键操作。

**Step 8.2：Diff 渲染**

```bash
npm install @pierre/diffs
```

`@pierre/diffs`（wasm + worker，827 KB）。新增行 `bg-diff-added`，删除行 `bg-diff-removed`，行号双列。降级文案：`暂时无法预览这份 Diff。`

**Step 8.3：代码查看器**

shiki 语法高亮 + 复制按钮 + `在编辑器中打开`。Markdown 图片/表格渲染。

**Step 8.4：Office/PDF 预览**

```bash
npm install pdfjs-dist @extend-ai/react-xlsx @extend-ai/react-docx @aiden0z/pptx-renderer
```

PDF → pdfjs-dist，XLSX → react-xlsx，DOCX → react-docx，PPTX → pptx-renderer。全部 dynamic import 懒加载。

**Step 8.5：Git 面板 + 8 态着色**

8 种 Git 状态色（§4.6）：none/modified/added/deleted/renamed/untracked/ignored/descendant。Tabs 切换 Changes/Commit。gitGraph 可视化分支历史。

**验收**：diff 渲染视觉一致。Git 8 色正确。Office 文件可预览。

---

### Phase 9 — 设置页（3 天）

> 依赖：Phase 3 完成
> 真源：§7.13, §9.2, `settings.*`（1724 键，最大命名空间）

**Step 9.1：设置页骨架**

10 个分组：插件管理（Installed/Discover 两页签）、技能、子智能体、MCP、浏览器控制、模型配置、用量统计、API Key 配置、使用统计、用户反馈与支持。左侧导航 + 右侧内容。

**Step 9.2：setting.json 40 字段全量 UI**

通用组件：`SettingToggle`（Switch 开关）、`SettingSelect`（Select 下拉）。40 个字段全部实现：locale、terminalInheritSystemProfile、closeToTrayOnWindows、keepAwakeWhileRunning、messageStreamShowReasoning、messageStreamShowTodos、toolGrouping*（3 个）、askUserQuestionAutoResolutionEnabled、taskAutoArchiveEnabled、autoDownloadAndInstallUpdates、receivePreviewUpdates、embeddedBrowserAllowInsecureCertificates、computerUseComposerEntryHidden、modelIoFullRetentionEnabled、optimizeAgentExperienceEnabled、repoSnapshotIndexingEnabled、instantGrepIndexingEnabled、nativeSearchEnhancementsEnabled、memoryEnabled 等。

**Step 9.3：迁移标记机制**

`migrateSetting(key, defaultValue, migrationKey, settings)` 工具函数。首次运行用默认值 + 设置 migrationKey；后续运行用当前值。删除 migrationKey → 回退为默认值演进。

**Step 9.4：模型与套餐**

结构复刻（Lite/Pro/Max/Weekend Plan），数据接 khy-os `tokenUsageService.js`。套餐名称改为 KhyOS 自有方案。

**Step 9.5：插件市场**

Installed/Discover 两页签。从 `known_marketplaces.json` 读取市场数据。兼容 anthropics 官方 291 个插件。

**Step 9.6：技能/子智能体/MCP/浏览器控制**

技能列表（启用/禁用）、子智能体配置（名称/模型/系统提示词）、MCP 服务器（名称/传输方式/协议版本/状态，支持 CRUD）、浏览器控制（视口设置 393×852，`zoom: "fit"`）。

**验收**：40 个字段全部有 UI 且有持久化。迁移标记生效。插件市场 Installed/Discover 可切换。

### Phase 10 — 扩展能力（4 天）

> 依赖：Phase 3 完成
> 真源：§7.19-7.23, `automations.*` / `bots.*` / `webRemoteControl.*` / `remote.*` / `repoWiki.*` / `whiteboard.*` / `cuaPermission.*`

**Step 10.1：自动化与闲时任务（scheduler 进程）**

文件：`src/scheduler/index.ts`

cron 表达式解析 + 闲时检测（5 分钟无活动 = idle）。`setInterval` 每分钟检查定时任务 + 闲时任务。IPC：`scheduler:listTasks/addTask/removeTask/toggleTask`。遵守 AGENTS.md 规则 3——活动感知超时，禁止硬 kill。

**Step 10.2：Bot 通道 UI**

三通道：微信/飞书/Telegram。每个通道独立配置卡片（Switch 开关 + Token 输入）。Bot 命令集：`status`/`new`/`workspace`/`model`/`mode`/`thoughtLevel`/`reply`。`bot-state.v2.json` 持久化运行态。

**Step 10.3：远程 Web 控制**

deviceSid 格式：`d_` + 16 位 base62。二维码扫码连接。中继设备架构（非直连）。

**Step 10.4：Wiki / Memory**

五个独立开关：仓库快照索引、即时 grep 索引、原生搜索增强、记忆、模型 IO 全量保留。不要合并。

**Step 10.5：白板 + @ 提及**

`chat.mention.whiteboards.title: 画板`、`{count} 条笔迹`、`没有匹配的画板`。画板可作为 @ 提及资源引用。

**Step 10.6：电脑控制权限面板（独立 preload）**

独立 preload：`cuaPermissionPanel.cjs`。文案：`打开辅助功能设置`/`打开屏幕录制设置`。就绪态：`电脑控制仍在准备中——工具尚未加载。`（注意破折号是全角双破折号 `——`）。

**验收**：每个模块的 i18n 键全部可用。定时任务可添加/执行。Bot 通道配置可保存。

---

### Phase 11 — 更新、遥测与进程管理（2 天）

> 依赖：Phase 0d 完成（四进程骨架可用）
> 真源：§7.24, §10, `update.*` / `developerTools.*` / `processMonitor.*`

**Step 11.1：electron-updater 集成**

```ts
autoUpdater.autoDownload = false  // 由 setting.json 控制
```

6 命名空间更新状态机：`checking` → `available` → `downloading(progress)` → `downloaded` → `installing`。跳过版本：`skippedElectronUpdateVersions: {}`。强制更新：`forceUpdate` 命名空间（不可跳过）。

UI：`UpdateDialog` 组件，显示检查中/发现新版本/下载进度/重启安装。文案：`正在检查更新...`（英文省略号）、`发现新版本 {version}`（无省略号）、`重启以更新（{version}）`（全角括号）。

**Step 11.2：进程监视器（独立窗口 + preload）**

独立 `BrowserWindow` + 独立 preload。显示 4 个进程（main/host/scheduler/renderer）的 PID/CPU/内存，每 2 秒刷新。

**Step 11.3：Agent stdio 抓取**

`toggleZCodeStdioTap` 菜单项。启用后捕获 host 进程 stdout/stderr，`stdio:getLogs` IPC 读取。

**Step 11.4：性能录制（rrweb 分片）**

```bash
npm install rrweb rrweb-snapshot rrdom
```

分片写 userData 目录（5MB/片）+ 后台合并 + 上限轮转（最多 10 次）。菜单：`开始性能录制`/`停止性能录制`。

**Step 11.5：导出日志（yazl 打包）**

```bash
npm install yazl
```

`yazl` 流式 zip 写入，包含 `logs/` + `crash/` + `setting.json`。保存对话框。

**Step 11.6：崩溃目录**

`~/.khyos/v2/crash/`。`process.on('uncaughtException')` 捕获并写入 JSON（message/stack/timestamp/platform/version）。

**验收**：更新流程走通模拟。进程监视器可见 4 个进程。导出日志 ZIP 包内容正确。

---

### Phase 12 — 1:1 验收与打磨（3 天）

> **目标**：逐项验收 §13 全部清单，修复差异，确保 1:1 通过。

**步骤 1：像素级比对（1 天）**

工具：`playwright` 截图 + `pixelmatch` diff。

```bash
npm install -D playwright pixelmatch pngjs
node scripts/ci/pixel-compare.js
```

`pixel-compare.js` 逻辑：
1. 启动 ZCode（从 `C:\Program Files\ZCode` 运行），截图保存为 `zcode-*.png`。
2. 启动 KhyOS Desktop（我们的构建产物），截图保存为 `khyos-*.png`。
3. 用 `pixelmatch` 逐像素对比，容差 `threshold: 0.1`，总差异率 ≤ 5% 为通过。
4. 对比场景：3 个主题 × 5 个页面（首页/对话/设置/Git/终端）= 15 组截图。

**步骤 2：文案 CI 零 diff（0.5 天）**

```bash
node scripts/ci/check-i18n-fidelity.js
```

**步骤 3：行为级测试（0.5 天）**

```bash
node scripts/ci/test-shortcuts.js
```

11 个快捷键全量测试：Ctrl+N/J/Alt+B/K/F/T、Shift+Tab、@/#/$/`/`。

**步骤 4：体积优化（0.5 天）**

```bash
ls -lh dist-electron/win-unpacked/resources/app.asar
# 目标：≤ 120 MB
node scripts/ci/check-dynamic-imports.js
```

**步骤 5：品牌替换终检（0.5 天）**

```bash
node scripts/ci/check-brand-replacement.js
```

校验 i18n-zh.json、setting.json 模板、resources/config/default.json 中不包含 ZCode/GLM/智谱/zcode.z.ai。

**验收**：§13 全部通过。

**总工期：约 30 个工作日**（单人，含调研已完成的 Phase 0 前置）。

> Phase 0a-0d 各 0.5 天（共 2 天），Phase 1-11 共 25 天，Phase 12 共 3 天。

---

## 十三、验收清单（1:1 判定标准）

### 13.1 像素级

- [ ] 三个主题各 20 个令牌抽检，与 `tokens.txt` 逐值相等
- [ ] 圆角 7 档（2/4/6/8/12/16/24px）全部命中
- [ ] 间距基单位 `--spacing: .25rem`，无写死 px
- [ ] 字体栈完整（含 4 个 CJK 回退字体）
- [ ] 缓动仅 2 条曲线，无第三自定义曲线
- [ ] prose 令牌 36 项（18 暗色 + 18 反色）逐值一致
- [ ] 终端 16 色全部一致
- [ ] Git 8 态、trajectory 5 态、diff 2 态、interaction 5 项全部一致
- [ ] 窗口 1216×808、titlebar 48px、caption 46px

### 13.2 文案级（标点级 1:1）

- [ ] `i18n-zh.json` 5070 键逐字节零 diff（CI 闸门）
- [ ] 82 命名空间全部接入，无缺失键
- [ ] 全角/半角括号规律正确（含变量用半角，纯说明用全角）
- [ ] 省略号统一：全角 `…` 与半角 `...` 的混用规则与原文一致
- [ ] 破折号 `——`（全角双）正确
- [ ] 弯引号 `""` 正确
- [ ] 变量前后空格保留（如 `开始在 {workspace} 项目新建任务`）
- [ ] 复数键 `.one` / `.other` / `.many` 正确
- [ ] 三段拼接键（`beforeWorkspace` / `workspace` / `afterWorkspace`）正确
- [ ] 代码组件内无中文字面量（lint 闸门）
- [ ] `welcome.title` 保持英文
- [ ] `TraceID` 保持英文大写
- [ ] 品牌替换清单执行（`ZCode` → `KhyOS`，`GLM` 图标素材自研）

### 13.3 行为级

- [ ] 11 个快捷键全部生效（§7.31）
- [ ] Shift+Tab 循环切换执行模式，5 个 provider 各自模式集正确
- [ ] 四触发器 `@` `#` `$` `/` 语义正确
- [ ] 撤销三桶原子语义（§7.5）
- [ ] Goal 验证闭环（incomplete 自动继续）
- [ ] 错误两级边界（区域不白屏）
- [ ] 设置迁移标记机制生效
- [ ] WSL UNC 路径引导
- [ ] 上下文压缩重试带进度（`{attempt}/{maxAttempts}`）
- [ ] 附件状态机 6 态可走通

### 13.4 数据级

- [ ] `setting.json` 40 字段全量读写
- [ ] `config.json` + `config.json.bak-<date>` 备份
- [ ] 双 SQLite 分离（主库 + 任务索引），WAL 模式
- [ ] checkpoint 目录落盘
- [ ] 会话 ID `sess_<uuid>`、设备 ID `d_<16-base62>` 格式正确
- [ ] 5 种 workspace kind + 2 种 purpose
- [ ] 127 个 RPC 方法全部实现且有 zod `.strict()` 校验
- [ ] 4 个构建就绪标记文件

### 13.5 架构级

- [ ] 4 进程（main / host / scheduler / preload）
- [ ] 6 个 preload 脚本
- [ ] `src/shared/rpc/` 单一真源，三端共享
- [ ] host 进程按五通道矩阵桥接 KhyOS 后端
- [ ] 无硬编码端点（AGENTS.md 规则 1）
- [ ] 状态文案符合「动作 + 目标 + 进度」（规则 2）
- [ ] 长任务无硬 kill（规则 3）
- [ ] 无 ANSI 滚动区（规则 4）
- [ ] `npm run check:layout` 通过
- [ ] `node scripts/ci/check-agent-rules.js --changed` 通过

### 13.6 体积级

- [ ] 主 asar ≤ 120 MB
- [ ] playwright 懒加载
- [ ] 图表引擎按需 chunk
- [ ] shiki 语言包首屏白名单
- [ ] msw 从生产包剔除

---

## 十四、风险与不做清单

### 14.1 主要风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| 从 Vue 切 React 的迁移成本 | 高 | 用户已授权清零；一次性重写优于渐进迁移 |
| node-pty Windows 1809+ 硬门槛 | 中 | 启动时检测并给出明确错误文案 |
| asar 307 MB → 目标 120 MB 的裁剪 | 中 | §3.11 逐项处置；重依赖全部 dynamic import |
| electron-builder v27 破坏性变更 | 低 | 锁 26.15.3 |
| i18n 逐字节校验过严导致频繁失败 | 低 | 只校验 `i18n-zh.json` 与产物，不校验源代码字符串 |
| 品牌替换不彻底 | 高 | §13.2 最后一项做清单化 CI |
| 4 进程架构调试复杂 | 中 | 构建就绪标记 + 单进程降级模式（dev 期可合并 main+host） |
| GLM 模型能力无法复刻 | 高（不可解） | 明确声明第三圈不复刻，接 khy-os 网关 |

### 14.2 明确不做

1. **不实现 `@zcode/server` 的 Agent 运行时** —— 用 KhyOS 后端替代
2. **不实现 GLM 模型接入** —— 用 KhyOS AI 网关多供应商替代
3. **不接入 ARMS RUM / 智谱遥测** —— 默认关，导出端可插拔
4. **不复刻智谱账号体系** —— 用 KhyOS 自有登录
5. **不复刻 GLM Coding Plan 计费** —— 用 `tokenUsageService.js` 本地统计
6. **不复刻飞书反馈表单与社群链接** —— `resources/config/default.json` 放自有地址
7. **不复刻 ZCode 品牌标识与 Logo** —— 全套自研资产
8. **不接入智谱 MCP 市场** —— 保留 MCP client 通用能力，市场数据来自 KhyOS
9. **不做增量更新包** —— `differentialPackage: false`
10. **不做 mac universal 双架构** —— 先 x64，arm64 视需要加 `x64ArchFiles`

### 14.3 后续演进建议（超出 1:1 范围）

- 同源 Web 端（AionUi 的 `web-host` 做法），让远程控制复用 UI 代码
- 插件市场按工作区安装的隔离存储
- checkpoint 的增量快照（当前是全量）
- 会话导入 Claude/Codex 配置（`[官方]` Onboarding 已支持，我们可作为增强项）

---

## 附录 A：真源文件索引

| 文件 | 内容 | 生成脚本 |
|------|------|---------|
| `zcode-analysis/tokens.txt` | 456 个 CSS 自定义属性，按选择器分组 | `css-tokens.cjs` |
| `zcode-analysis/i18n-zh.json` | 5070 条中文文案（嵌套） | `extract-i18n.cjs` |
| `zcode-analysis/i18n-zh.jsonl` | 同上（机器安全） | 同上 |
| `zcode-analysis/i18n-zh.tsv` | 同上（人工可读） | 同上 |
| `zcode-analysis/rpc-surface.json` | 127 个 RPC 方法 | `extract-rpc.cjs` |
| `zcode-analysis/rpc-surface.tsv` | 同上（含 invoke/on/send 计数） | 同上 |
| `zcode-analysis/unpacked/package.json` | ZCode 清单 | `asar-extract.cjs` |
| `zcode-analysis/unpacked/out/main/index.js` | 主进程 | 同上 |
| `zcode-analysis/unpacked/out/host/index.js` | 宿主进程 | 同上 |
| `zcode-analysis/unpacked/out/scheduler/index.js` | 调度进程 | 同上 |
| `zcode-analysis/unpacked/out/preload/index.cjs` | 主 preload | 同上 |
| `zcode-analysis/unpacked/out/renderer/assets/styles-t2tKjMWX.css` | 383 KB 样式 | 同上 |
| `zcode-analysis/unpacked/out/renderer/assets/IntlProvider-Db46X9QF.js` | 660 KB 文案包 | 同上 |

## 附录 B：外部证据

| 来源 | URL | 用途 |
|------|-----|------|
| 官网 | https://zcode.z.ai | 产品定位、功能、套餐 |
| 更新日志 | https://zcode.z.ai/changelog | 版本特性、快捷键 |
| 文档 | https://zcode.z.ai/cn/docs/* | hooks 事件、设置项 |
| npm registry | registry.npmjs.org | 竞品依赖版本取证 |
| GitHub API | api.github.com | 竞品 star 与 package.json |

**已排除的死链**（勿引用）：`zcode.ai` / `www.zcode.ai`（301 至无关站点 `zcodesystem.com`）、`docs.zcode.ai`（DNS 不存在）、`zcode.zhipu.ai`（证书过期）。真源只有 **`zcode.z.ai`**。

**已排除的 404 仓库**（勿引用）：`mostly-ai/msty`、`Msty-corp/Msty`、`codex-software/waveterm`（真名 `wavetermdev/waveterm`）、`Clinedev/cline`、`enchanted/Enchanted-Code-Editor`、`_pieces/pieces-app`、`pieces/pieces-app`、`cokethewizard/codeGPT`。`lobehub/lobe-chat` 已重定向至 `lobehub/lobehub`。

**Gitee 状态**：API 返回 HTTP 400，网页搜索 301 至 `so.gitee.com`（JS 渲染），本次未取到可用数据。需人工补抓。

---

## 附录 C：竞品技术选型依据

| 项目 | Stars | 栈 | 借鉴点 |
|------|-------|-----|--------|
| CherryHQ/cherry-studio | 51 567 | Electron 41.8 · React 19 · electron-vite · Tailwind 4.1 · shiki 3.12 · streamdown 2.5 · better-sqlite3 12.11 | `@shikijs/markdown-it` 流式代码块；`asarUnpack` 精确白名单 + `publish.provider: generic` |
| iOfficeAI/AionUi | 32 673 | Electron 37.10 · React 19 · Monaco/CM6 · better-sqlite3 · node-pty | `asar.smartUnpack:true` + `npmRebuild:false`；同仓 `web-host`/`web-cli` 桌面移动同源 |
| voideditor/void | 28 809 | VS Code fork：Electron 34.3.2 · @xterm/xterm 5.6 · node-pty 1.1 · marked 15 | xterm + node-pty 是终端事实标准 |
| Kilo-Org/kilocode | 27 220 | TypeScript（VS Code 扩展） | Agent 工具卡片、权限模式、MCP 配置交互 |
| wavetermdev/waveterm | 22 232 | Go + WebUI | 终端 + AI 面板 + 文件浏览混合布局 |
| pmbstyle/Alice | 321 | Electron 43.2 · Vue 3.5 · Pinia 3 · Vite 6.4 · marked 15 · Tailwind 4.2 | 最贴近原计划的 Vue 栈样板（本计划已改用 React，仅作参考） |
| Chasen-Liao/pi-agent-desktop | 270 | Electron 43.4 · Next 16.3 standalone · React 19 · Tailwind 4.2 | mac universal 用 `x64ArchFiles` 防 lipo 合并原生包 |
| ChatGPTNextWeb/NextChat | 88 720 | TypeScript PWA | 一份代码三端（桌面/移动/PWA） |
| danny-avila/LibreChat | 42 911 | TypeScript | 多模型网关、MCP、skills 服务端化 |
| open-webui/open-webui | 151 287 | Python + Svelte | 多模型后端与前端同源 |
| lobehub/lobehub | 82 305 | TypeScript | 插件市场 + Agent 目录化治理 |

**注**：ZCode 是 React 栈，因此 `streamdown` 可直接使用（peerDeps `react ^18\|\|^19`）；若沿用 Vue 则不可用，这是改栈的硬理由。

---

## 附录 D：术语对照

| 英文 | ZCode 中文 | 说明 |
|------|-----------|------|
| Task | 任务 | 一个 Agent 会话 |
| Workspace | 工作区 | 一个项目目录或纯对话区 |
| Conversation | 对话 | 项目下的对话 |
| Goal | 目标 | 长程可验证任务 |
| Thought Level | 思考强度 | low / high / max / off |
| Plan Mode | 计划模式 | 先计划后执行 |
| Subagent | 子智能体 | 子 Agent |
| Skill | 技能 | 可复用指令包 |
| Elicitation | 交互式提问 | Agent 主动向用户提问 |
| Checkpoint | 检查点 | 文件改动快照，用于撤销 |
| Rewind | 撤销 | 按 checkpoint 回滚 |
| Trajectory | 轨迹 | 模型动作时间线 |
| Hooks | 钩子 | 7 事件生命周期扩展 |
| Marketplace | 插件市场 | Installed / Discover |
| Off-peak | 闲时 | 闲时算力额度 |
| CUA (Computer Use) | 电脑控制 | 屏幕与输入控制 |
| Relay Device | 中继设备 | 远程控制中转 |

---

*定稿：2026-09-08*
*证据基线：ZCode Desktop v3.11.2（`C:\Program Files\ZCode`，`app.asar` 307 MB / 27 281 文件）*
*取代：v1～v17 合并版*
*维护规则：任何数值变更必须同步更新真源资产或在此标注新版本证据*
