# [DESIGN-ARCH-078] khyos桌面端与CLI-TUI互联共享方案

> **定位**：裁决 `apps/khyos-desktop`（Electron 桌面端）与 `khy` CLI/TUI（`src/cli/` REPL + Ink TUI）之间「建立联系与共享」的目标架构与分阶段落地路径的**设计方案**。
> **适用边界**：只定义两端互联的通道选择、真源归属、发现机制与实施阶段；不替代 `[DESIGN-ARCH-068]`（层级依赖方向）、`[DESIGN-ARCH-070]`（治理总纲）、`[DESIGN-ARCH-071]`（通道决策矩阵）——冲突时以各单一真源为准，本文是它们在「桌面端 ↔ TUI」场景下的应用与细化。
> **证据基准**：本文所有 file:line 均来自 2026-09-06 实际代码勘察，落地时如代码已漂移，以代码为准并回改本文。

---

## 0. 现状盘点（为什么要做）

### 0.1 三个端各自的现状

| 端 | 形态 | 与后端的关系 | 会话/配置真相源 |
|---|---|---|---|
| **桌面端** `apps/khyos-desktop` | Electron + Vite（主进程 `electron/main.js`） | **零耦合**：无 HTTP/WS/SSE、不读任何 `_runtime.json`、不 require 后端代码、不在 pnpm workspace（根 `package.json:9-10` 只含 `services/backend`、`services/ai-backend`） | 主进程直读两个 SQLite：`Tools/cc-switch/.cc-switch/cc-switch.db`（供应商，`main.js:18-20`）与自有 `apps/khyos-desktop/data/sessions.db`（仅会话元数据+pid，`main.js:151-173`）；直接 spawn `Tools/claude/claude.exe`（`main.js:240-291`，注入 provider 的 ANTHROPIC_* env） |
| **CLI/TUI** `src/cli/` | REPL（`repl.js`）+ Ink 终端组件（`tui/ink-components/`） | **CH-2 服务层直调**（同进程 require），AI 对话走 gateway 服务 | 数据家目录（`.khy/`）下的 sessions/conversations，由服务层统一读写 |
| **主后端** `services/backend/server.js` | Express + WS（同端口，`BACKEND_PORT = PORT \|\| 3000`，`constants/serviceDefaults.js:86`） | — | 端口被占时 `listenWithAutoPort` 顺延，实际坐标落盘 `backend_runtime.json` |
| **AI 守护进程** `services/aiManagementServer`（9090） | 由 `daemonManager.js` 以 detached 后台进程运行（`daemonManager.js:4-8`） | — | `daemon.pid`（`daemonManager.js:17`）+ `ai_manage_runtime.json`（`:21-22`） |

### 0.2 已经存在的三条「联络网」（可直接复用，不新造协议）

1. **`backend_runtime.json` 落盘契约**（主后端 3000）：
   `src/utils/backendRuntime.js:35-52` 由 server.js 写入 `<数据家>/backend_runtime.json`，格式
   `{ apiPort, pid, startedAt }`，进程退出清除（`:78-84`）。注释明说：因为端口会自动顺延，
   「CLI 是独立进程，只能通过磁盘上的运行时文件得知真实坐标」——**桌面端与 CLI 同属这一类消费者**。
   本机现值：`.khy/backend_runtime.json` → `{"apiPort":3000,"pid":23244}`。
2. **AI 守护进程坐标**（9090）：`daemon.pid` + `ai_manage_runtime.json` 的 `apiPort`，
   解析优先级真源在 `serviceDefaults.getAiBackendUrl()`（`serviceDefaults.js:54-82`）。
3. **LAN bridge（9222）**：`src/bridge/bridgeServer.js` —— HTTP + WebSocket 的「远程 CLI 控制」服务，
   已支持：向 REPL 发消息、审批/拒绝权限请求、实时镜像 AI 输出、移动端 HTML 页（`GET /`）、
   6 位 PIN + 30 分钟 token 鉴权（`:17-33`）、断线重连的消息回放环形缓冲（`:35-37`，HISTORY_MAX=50）。
   启动点：`khy md`（`handlers/md.js:134`）、`khy docs`（`handlers/docs.js:840`）；
   TUI 侧已接线：`tui/hooks/useQueryBridge.js:1230` 直接 require bridgeServer 广播输出；
   状态快照 SSOT：`bridgeServer.getStatusSnapshot()`（`handlers/ideStatus.js:35-37` 消费）。
   其上的 `aiChatConsumer.js` + `sessionHistoryStore.js`（按用户落盘 `chat_history/<userId>.json`，
   每用户上限 200 轮）已把「桥上 AI 聊天」做成独立消费端。

### 0.3 缺口结论

桌面端与 TUI 之间**今天没有任何联系**，且存在四处真源分叉：

| # | 分叉 | 后果 |
|---|---|---|
| G1 | 桌面端 `data/sessions.db`（元数据+pid）≠ 后端数据家 sessions/conversations（完整对话真相） | 桌面端看不到/续不了 TUI 的会话，反之亦然 |
| G2 | 桌面端直读 cc-switch SQLite ≠ 后端 `routes/ccSwitch.js` + `.khy/custom_providers.json` | 供应商配置两套并存，改一边另一边不知情（是否同源需 P1 勘察确认） |
| G3 | 桌面端绕过 gateway 直接 spawn `claude.exe` | token 用量（`token_usage.json`）、轨迹、审批等系统能力全部旁路 |
| G4 | 桌面端不读任何运行时文件、无服务发现 | 后端/守护进程/桥在不在跑，桌面端无从得知，也无从拉起 |

另有一个**既有缺陷**顺带登记：`Settings.vue:285-338` 调用 `window.api.saveFile/openFile/readFile/writeFile`，
但 `electron/preload.js` 并未暴露这四个方法 → 静默 no-op（可选链吞错）。P0 修复。

---

## 1. 目标与非目标

**目标**
1. 桌面端成为 khy-os 生态的一等公民：能发现、能体检、能拉起后端/守护进程/桥。
2. 会话互通：桌面端能列出、查看、续写 TUI 创建的会话（反向同理），单一真相源。
3. 实时共享：桌面端实时镜像 TUI 的 AI 输出与状态行，可远程发消息、可代审批权限请求。
4. 供应商与用量归一：provider 配置与 token 用量走后端正门，桌面端不再各自为政。

**非目标**
- 不把桌面端改造成 TUI 的替代品（TUI 仍是 CLI 主交互面）。
- 不新增第六通道（不引入新的 IPC 协议）；全部复用 CH-1/CH-3/CH-4 既有通道。
- 不改变 068 的依赖方向：L3（桌面端）永远不 require L2（backend src）源码。

---

## 2. 总体架构

```text
┌─────────────────────────── Electron 桌面端（L3, apps/khyos-desktop）───────────────────────────┐
│  渲染进程 (Vue)  ──window.api IPC──>  主进程                                                    │
│                                        ├─ backendDiscovery.js   ← CH-1 只读发现（三合法来源）     │
│                                        ├─ HTTP 客户端 ────────→ 主后端 :3000 (CH-4)              │
│                                        │     会话/供应商/用量/健康 端点（routes/）                 │
│                                        ├─ WS 客户端 ──────────→ bridge :9222 (CH-4)              │
│                                        │     实时输出镜像 / 远程发消息 / 权限审批 / 断线回放        │
│                                        └─ 拉起器（detached spawn）──→ khy server start / daemon  │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                     ▲
                              CLI/TUI（REPL + Ink）──┘ 同进程 CH-2 直调服务层；
                              TUI 输出经 useQueryBridge → bridgeServer 广播（既有接线）
```

**通道裁决（对齐 071 矩阵）**
- 桌面端读运行时坐标文件（`backend_runtime.json` / `daemon.pid` / `ai_manage_runtime.json`）→ **CH-1，仅只读**。
- 桌面端一切**写操作**（会话续写、供应商增删改、审批、配置）→ **CH-4 正门**（HTTP → routes），
  禁止直写 `.khy/` 下任何状态文件（071 反模式 1）。
- 桌面端「拉起服务」→ **CH-3**（spawn `khy server start` / `khy daemon start`，复用 CLI 的校验与审计）。
- 桌面端 **永不** require `services/backend/src/**`（068：L3→L2 仅 HTTP）。

---

## 3. 服务发现与生命周期（P0）

### 3.1 发现链（新文件 `apps/khyos-desktop/electron/backendDiscovery.js`）

照抄仓库既有先例 `apps/ai-frontend/backendDiscovery.mjs` 的做法：前端是独立包、不能 import 后端代码，
所以**镜像** `serviceDefaults` 的解析优先级并加 lock-step 注释。主后端发现链：

```text
1. env KHY_BACKEND_PORT / PORT        （显式覆盖）
2. <数据家>/backend_runtime.json.apiPort   ← 主真源（端口顺延后的事实坐标）
3. 数据家目录解析：沿 KHY_OS_DIR / .khy/.location.json / portable 根上溯
   （复用 utils/dataHome.js 的既有顺序，桌面端镜像之）
4. 兜底 3000（镜像 serviceDefaults.BACKEND_PORT，注释标注 lock-step）
```

桥（9222）与守护进程（9090）同理：读 `bridgeServer` 状态快照端点 / `ai_manage_runtime.json`。
**红线**：桌面端源码不出现 `localhost:3000`/`9222` 字面量（工程规则 1；镜像常量处加
「mirror of serviceDefaults.js, keep in lock-step」注释，与 ai-frontend 先例同构，属可评审豁免）。

### 3.2 健康体检与一键拉起

- 桌面端启动即探测三服务（`/api` 健康 + `backend_runtime.json` 的 pid 存活检查），主窗口仪表盘显示
  「后端 / 守护进程 / 桥」三枚状态灯，数据源统一走 `bridgeServer.getStatusSnapshot()` 暴露的快照端点
  （SSOT 已存在，勿再造）。
- 未运行时提供**一键拉起**：主进程 detached spawn `khy server start`（走 CH-3 正门，绝不自己 listen 一个
  私有后端）。拉起后轮询发现文件直到坐标出现。
- 端口韧性由后端既有 `listenWithAutoPort` + 运行时落盘保证，桌面端**永远以发现文件为准**，
  不缓存端口号（缓存 = 端口顺延后的静默失联）。

---

## 4. 数据共享：会话 / 供应商 / 用量（P1–P2）

### 4.1 会话真源归一（P1 读，P2 写）

- **真相源裁定**：后端服务层管辖的数据家 sessions/conversations 是唯一真相源；
  桌面端 `data/sessions.db` **降级为本地缓存/索引**（保留 pid 管理等纯桌面端本地职责），不再是对话真相。
- P1（只读互通）：桌面端会话列表/详情改调后端 session/conversation 端点（routes 层既有能力），
  展示 TUI 创建的全部会话。
- P2（续写互通）：桌面端「继续会话」两种实现，按场景二选一：
  - **A（推荐，先做）**：桌面端 spawn 终端执行 `khy` CLI resume 流程（CH-3）——用户在真实 TUI 里续聊，
    零新协议；
  - **B（后做）**：走 bridge 的 `aiChatConsumer` 通道在桌面端 UI 里直接对话（CH-4），
    历史由 `sessionHistoryStore` 按用户落盘，天然与 TUI 解耦但同属一个数据家。

### 4.2 供应商配置归一（P2）

- 桌面端对供应商的增删改**改走后端 ccSwitch 正门**（`routes/ccSwitch.js`），停止直写
  `Tools/cc-switch/.cc-switch/cc-switch.db`；直读仅保留为迁移期的只读兼容。
- P1 勘察项：确认后端 ccSwitch 服务与 cc-switch.db 是否同一 SQLite；若不同源，制定一次性迁移脚本
  （cc-switch.db → 后端真源），迁移后桌面端只读 API。
- spawn `claude.exe` 的长期归宿：桌面端保留「启动终端」的产品体验，但底层改经 khy 会话服务拉起，
  使 gateway、token 用量、轨迹溯源（`[DESIGN-ARCH-047]`）不旁路。迁移完成前，用量旁路是已知债务。

### 4.3 用量与账单

token 用量统一从后端 tokenUsageService 端点读取（CH-4），桌面端不做本地第二份统计。

---

## 5. 实时共享：bridge 通道（P3）

**不新造协议**：桌面端作为 bridge 的第四类客户端（移动浏览器 / 移动页 / IDE 状态之外），复用既有全部机制：

| 能力 | 复用的既有机制 | 桌面端 UI |
|---|---|---|
| 实时输出镜像 | WS 广播 + 50 条环形缓冲重放（`bridgeServer.js:35-37`） | 会话实况面板 |
| 远程发消息 | bridge 消息通道（移动页已在用） | 桌面端输入框 → REPL |
| 权限审批 | bridge 审批/拒绝通道 | 桌面端审批卡片（复用 `permissions/` 网关语义） |
| 在跑工具状态 | TUI `statusBroadcast.js` 聚合状态行（门控 `KHY_STATUS_BROADCAST`，默认开） | 桌面端状态条 |

- **鉴权**：复用 PIN + token 既有机制；token 30 分钟过期后的重连做**基于活动的退避**
  （规则 3：重连是长生命周期循环，禁止固定墙钟硬 kill；用指数退避 + 每次收到帧即重置）。
- **备选捷径（可与 P3 并行验证）**：桌面端开一个 BrowserWindow 直接加载桥的移动聊天页
  （`bridge/mobilePage.chat.js` 产物）——零协议工作，先验证产品价值，再决定自研面板深度。
- **安全边界**：桥默认绑 `127.0.0.1`（`bridgeServer.js:21`，`BRIDGE_BIND_HOST` 可放 LAN）；
  桌面端不主动放宽绑址，遵循 `[DESIGN-ARCH-045]` 非活跃通道治理与 `[DESIGN-ARCH-074]` 账号体系。

---

## 6. 分阶段实施清单

| 阶段 | 交付物 | 验收 |
|---|---|---|
| **P0 对齐** | ① 修 preload 漂移（Settings.vue 四个文件方法）② `electron/backendDiscovery.js`（主后端发现链 + lock-step 注释）③ 启动体检：三服务状态灯 | 桌面端启动后正确显示 3000/9090/9222 三灯；杀掉后端灯变红并给出拉起按钮 |
| **P1 会话读通** | 桌面端会话列表/详情改调后端端点；`data/sessions.db` 标记为缓存 | 桌面端能看到 TUI 创建的会话；`node scripts/ci/check-agent-rules.js --changed` 0 error |
| **P2 会话写通 + 供应商归一** | resume（方案 A）→ aiChatConsumer（方案 B）；provider 写路径切 ccSwitch 正门；用量走 API | 桌面端发起的对话在 `khy` 侧可续；改供应商后 CLI 立即可见 |
| **P3 实时共享** | 桌面端 bridge WS 客户端：输出镜像/远程发消息/审批卡片；或先嵌移动页验证 | 桌面端实时看到 TUI 流式输出；手机与桌面端同时在线互不踩踏 |
| **P4 生命周期收口** | 一键拉起/停止三服务；异常路径（端口顺延、pid 失效、桥 token 过期）全覆盖 | 端口占用→顺延→桌面端自动跟随新坐标，全程无手工配置 |

每阶段遵循 `[DESIGN-ARCH-076]` 任务最小闭环与 `[DESIGN-ARCH-077]` 稳定交付总纲：一个阶段一个任务入口，
收工全绿再推。

---

## 7. 治理与红线对照

| 红线 | 本文落法 |
|---|---|
| 068：L3→L2 仅 HTTP | 桌面端零 require 后端源码；发现常量用「镜像 + lock-step 注释」模式（ai-frontend 先例） |
| 071 反模式 1/4 | 不直写状态文件；端点来自 env/发现文件/镜像常量，无裸 `localhost:3000` |
| 工程规则 1 端口韧性 | 桌面端永不缓存端口，以运行时文件为准；后端顺延机制复用 |
| 工程规则 2 状态文本 | 状态灯/连接提示按「动作+目标+进度」措辞（如「探测后端 (127.0.0.1:3000)，第 2/5 次…」） |
| 工程规则 3 超时 | WS 重连/拉起轮询均为活动重置型（退避 + 收帧重置），无硬 kill |
| `[DESIGN-ARCH-062]` 生命周期边界 | 桌面端拉起的服务是 detached 后台进程，退出桌面端不连带杀后端（明确标注谁拥有谁） |

---

## 8. 开放问题

1. **主目标后端选谁**：本方案以 3000 为主（数据/配置正门）、9222 为实时通道、9090 按需
   （AI 管理功能）。若未来两后端合并，本文只改发现链一节。
2. **Electron 打包形态**：桌面端假定「同机已装 khy」（portable 根上溯发现）。若要求独立分发
   （用户未装 khy），需在 P4 前决策：内嵌 khy runtime 或强制引导安装。
3. **cc-switch.db 归一策略**：P1 勘察后定一次性迁移脚本 vs 长期只读适配器。
4. **账号体系接线**：`[DESIGN-ARCH-074]` 的用户名唯一键登录是否作为桌面端→后端 HTTP 的强制鉴权，
   还是本机回环豁免——P1 时裁决。

---

## 9. 维护与验证

```powershell
node scripts/ci/check-gov-rules.js
npm run check:layout
node scripts/ci/check-agent-rules.js --changed
```

- 桌面端新增文件后，同步维护 `apps/khyos-desktop/CLAUDE.md` 与 `.ai/MAP.md` 的入口点表。
- 修改发现链时，必须同步三处镜像：`apps/ai-frontend/backendDiscovery.mjs`、
  本文 §3.1、`apps/khyos-desktop/electron/backendDiscovery.js`。

---

## 10. 实施记录

### 10.1 P0 已落地（2026-09-06）

| 项 | 交付物 | 验证 |
|---|---|---|
| P0-② 发现链 | `apps/khyos-desktop/electron/backendDiscovery.js`（ESM、零依赖、只读；数据家候选镜像 `dataHome.js`，端口镜像 `serviceDefaults`/`bridgeServer` 并带 lock-step 注释） | 冒烟脚本 `apps/khyos-desktop/scripts/smoke-discovery.mjs`：便携根经 `.portable` 识别、`backend_runtime.json` 读出 `{apiPort:3000,pid}`、`daemon.pid` 读出 `{port:9090,pid}`、失效 PID 如实报 `false` |
| P0-③ 状态灯+拉起 | `main.js` 新增 `probeHttp`（任意 HTTP 响应判活）/`getServicesStatus`/`startBackendService`（CH-3 正门 `cmd /c khy.bat server start`，detached + windowsHide）+ IPC `services:status`/`services:startBackend`；`Dashboard.vue` 三服务状态灯 + 一键启动按钮（活动重置型轮询，60s 上限后如实报错并给下一步） | `node --check` ×3 通过；`vite build` 通过；`khy.bat server start` 实测 exit 0（幂等分支「已在运行 (端口 3000)」） |
| P0-① preload 漂移 | 范围扩大并全修：Settings.vue 四个文件方法 + **App.vue 七个窗口控制方法**（无框窗口的最小化/最大化/关闭此前全部静默失效）；preload 按「渲染层实际调用形态」暴露（裸调平铺顶层），并新增回归守卫 `apps/khyos-desktop/scripts/check-api-drift.mjs` | 漂移守卫输出 `NO-DRIFT`（22 个调用点全对齐） |

**顺带修复的既有缺陷（非本方案引入，均阻断 P0 验收）**

1. `main.js` 两处 `require('fs')`/`require('child_process')`：ESM 主进程无 `require`，`claude:spawn` 与 sessions 初始化在真机必炸 → 改顶部 ESM 导入。
2. `services/backend/src/services/extensions/quantApp.js` 缺失（疑似孤儿清理误删重导出 shim）：20 个路由 shim（strategy/backtest/market 等）加载即 MODULE_NOT_FOUND，**后端完全无法启动** → 恢复重导出 shim（指向 `domain/extensions/extensions/quantApp.js`）。
3. `src/routes/freeLLM.js:12` 引用已删除的 `FreeLLMService` 类 → 按文件内注释本意改用 `MultiFreeService`（同一 testConnection/getStatus 面）。
4. `domain/config/ccSwitch/store.js:42` 从无关模块导入 `PROTOCOLS/APPS/DATA_FILE/SCHEMA_VERSION`（全 undefined → `path.join` 即崩）→ 改从同目录 `./constants` 导入。
5. `platform/khy_platform/cli.py` 的 `_KNOWN_COMMANDS` 建议表过期：对合法命令 `server` 给出误导建议「khy where」→ 补 `server/daemon/bridge/mobile/md/resume`。

**验证工具沉淀**：`services/backend/scripts/check-routes-load.js`（3 秒内 require 全部 52 个路由模块暴露加载期崩溃——上述 2/3/4 任何一个都能被它秒抓，修复后输出 `ALL-ROUTES-LOAD-OK`）。

**遗留观察**：`/api/health` 返回 503 `{"status":"degraded"}`（服务在监听、子系统预热/降级中）——状态灯语义取「有响应即在线」不受影响；degraded 的具体成因属后端健康检查自身议题，另行跟进。

### 10.2 下一步（P1 待办）

1. 会话读通：勘察 `routes/` 会话端点 + `[DESIGN-ARCH-074]` 账号鉴权在回环场景的豁免裁决（§8.4），桌面端 Sessions 列表改调后端。
2. 后端 `/api/health` degraded 成因排查（阻塞 P1 的「会话列表数据可信」验收）。
3. cc-switch.db 与 `cc_switch.json` 真源关系勘察（§8.3）。

### 10.3 health 503 degraded 根因修复（2026-09-06，P1 前置）

三层同源病灶（一次目录迁移的连锁债），修复后 `/api/health` 实测 **200 {"status":"ok"}**：

| # | 病灶 | 修复 |
|---|---|---|
| 1 | `domain/extensions/extensions/quantApp.js` 的迁移兜底 `L4_DIR` 仍按旧址 `src/services/extensions/` 上溯 **5** 层；文件迁入 `domain/extensions/extensions/` 后深了 2 层，指向不存在的 `services/backend/software/khyquant` → quant-app 整级被误判「未安装」→ `cacheService` 等 57 个壳全部 null（此前「已跳过 21/21 条量化应用路由」同根因） | 层数 5→7，注释标注迁移史 |
| 2 | L4 `software/khyquant/` 无自身 node_modules，裸 require 上溯到**仓库根 pnpm 提升的 express 5.2.1**（path-to-regexp 8）；L4 路由写的 express4 语法 `/markets/:marketCode?` 在 ptr8 下启动期崩（`Unexpected ? at index 20`）—— 与 ai-backend 的 dev 符号链接先例同款问题 | 建立junction `software/khyquant/node_modules → services/backend/node_modules`（打包安装本就内置该 fallback，dev 树补齐） |
| 3 | `server.js` healthHandler 硬断言 `cacheStats.type ∈ {redis,memory}`；L4 cacheService 的 `getStats()` 返回纯计数器 `{size,hits,misses,expired}` 无 type → 恒 degraded | 能应答出统计形状即健康，type 校验仅对声明 type 的实现生效 |

### 10.4 P1 已落地（2026-09-06）

**后端（L2）**
- 新增只读路由 `src/routes/khySessions.js`：`GET /api/khy-sessions`（列表，limit≤200）与 `GET /api/khy-sessions/:sessionId`（元数据+uuid 消息链，≤500 条），真源 = `services/sessionPersistence`（`.khy/sessions/` JSONL+JSON）；**不提供写端点**（写仍走 CLI/服务层正门）。
- 挂载：`app.use('/api/khy-sessions', authMiddleware, ...)`（JWT Bearer / API key）。

**顺带修复的既有断裂（第五批，同族「constants/models 叶子化」迁移债）**：`constants/models.js` 被重构为纯模型名叶子后，4 个文件仍从它解构数据库模型 → 全部改引 `src/models`（DB 模型 shim）：`authSessionService.js`（User/AuthSession/UserAuthState —— **此前注册/登录必然 500**）、`systemSettingService.js`（SystemSetting/User 等 2 处）、`manageDbBootstrap.js`（sequelize，2 处）、`domain/project/management/resources/users.resource.js`（User）。

**桌面端（L3）**
- 新增 `electron/backendClient.js`：发现链取端口 + `/api/auth/login` 正门登录（token/refreshToken/user 存 electron-store，端口变更即判失效）+ `/api/khy-sessions` 只读消费。
- `main.js` IPC：`auth:login/logout/state`、`khySessions:list/get`；`preload.js` 暴露 `backendAuth`/`khySessions` 组。
- `Sessions.vue`：新增「TUI 会话（khy 后端）」卡片 —— 未登录显示登录表单，登录后列出后端持久化会话（标题/模型/条数/时间/首条消息预览）；后端不可达时引导到 Dashboard 一键启动，本地会话列表原样保留（降级回退）。

**P1 端到端验收（实测）**：登录 200 → `GET /api/khy-sessions` 200（真实 TUI 会话列表）→ 单会话 200（消息链）→ 前门 logout 200 → 登出后 401、无 token 401。`check-api-drift` NO-DRIFT；`vite build` 通过；`check-agent-rules` 11 文件零违规；路由加载检查 54 模块全绿。

**遗留观察**：
- 并行协作提醒：`main.js` 在 P1 期间被另一工作流并行扩展（crossPlatform 同步接线、根发现 walkUpTo 化）——本次改动已按共存方式合入，后续改 main.js 前先重读文件。
- cc-switch 勘察结论（§8.3）：桌面端直读 `Tools/cc-switch/.cc-switch/cc-switch.db`（SQLite，已有数据），后端 store 为 `<数据家>/cc_switch.json`（本机尚未建立）——两套存储确认分叉、零同步；P2 落地一次性导入 + 写路径切 ccSwitch 正门。

### 10.5 下一步（P2 待办）

1. cc-switch.db → `cc_switch.json` 一次性导入脚本 + 桌面端供应商写路径切 `/api/cc-switch` 正门。
2. 会话续写：方案 A（`khy` CLI resume）先行，方案 B（bridge aiChatConsumer）跟进。
3. token 刷新闭环：backendClient 持有 refreshToken，401 时先 `/api/auth/refresh` 再重试一次。
4. `/api/khy-sessions` 的会话详情 UI（消息链渲染）与 P3 实时共享（bridge WS）。

---
*创建：2026-09-06 · 依据实际代码勘察（桌面端/bridge/daemon/backendRuntime 全链路 file:line 见 §0）· 隶属 [DESIGN-ARCH-070] 治理体系的应用层方案*
