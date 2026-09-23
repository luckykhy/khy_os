# khy-os 运行不稳定因素排查（2026-09-11）

> 目标：找出 khy-os 在**运行期**（不是编译期）真正导致崩溃、抖动、静默劣化的因素。
> 方法：以本机 `D:\Portable\khy-os` 的**真实运行时证据**（`.khy/` 状态文件 + 日志 + 活进程 +
> 仓库自带检查脚本）为主，以代码走查为辅。每条都附可复核的证据。

---

## 一、当前真实运行时状态（证据基线）

| 组件 | 状态文件 | 记录 | 实际 |
|---|---|---|---|
| KHY daemon | `.khy/daemon.pid` | pid 35556, port 9090 | **进程已死（NOT RUNNING）** |
| ai-manage daemon | `.khy/ai_manage_runtime.json` | pid 37944, apiPort 9090, controlPort 23165 | **进程已死**；`frontendAvailable:false` |
| backend 单体 | `.khy/backend_runtime.json` | pid 39716, apiPort 3000 | **存活**，RSS ≈ 708 MB |
| 桌面端 | `tasklist` | — | **48 个 `KhyOS Desktop.exe`**，起始时间跨 09-06 → 09-08 数天 |

结论：**除 backend 单体外，两个常驻管理守护进程都不在运行**；桌面端进程在持续堆积。
这就是“开 App 才临时拉起、拉起来又 10 分钟自杀”的抖动现场。

---

## 二、确定的不稳定因素（按影响排序）

### 1. 守护进程「自杀 + 按需重启」抖动循环（最高优先级）
- 证据：`.khy/logs/ai_manage_daemon.log` 尾部反复出现
  `[ai-manage-daemon] 正在关闭守护进程: 原因=startup-timeout 无活动≈600000ms 阈值=600000ms 曾见会话=false`
  → `shutdown: startup-timeout` → `[workflow-worker] started` → 再 shutdown，成对循环。
- 根因：`scripts/ai-manage-daemon.js` 的 GC 循环（L517-545）：
  `limit = seenAnySession ? idleMs : startupGraceMs`，两者默认都是 **10 分钟**（L77/L79）。
  只要守护进程**从没等到任何会话**（`曾见会话=false`），就在 10 分钟空闲后被
  `shutdown('startup-timeout')` 自杀；随后由 `aiManageDaemonLifecycle.ensureStarted()`
  在用户再次触及时临时拉起 → 又 10 分钟自杀 → **常驻进程永远驻留不住**。
- 后果：工作流任务在守护进程停摆的空窗里停留在 `queued`（源码注释自证：
  “Without a worker in-process nothing claims those rows, so runs sit in `queued` forever”）。

### 2. 历史崩溃：`MODULE_NOT_FOUND` + 模块 shim 脆弱
- 证据：`ai_manage_daemon.log` 中
  `Error: Cannot find module '../src/services/workflow/workflowRunWorker'`（`ai-manage-daemon.js:49`）。
- 现状：已重构为 `src/services/workflow/index.js`（自动生成的 shim，re-export 到
  `domain/project/workflow/workflowRunWorker.js`，该文件**现已存在**）。
- 风险：守护进程把一个 shim 的 re-export 当作启动必需（L48 `require` 顶层同步），
  一旦 domain 侧文件再被移动/改名，**整个管理守护进程会在启动即崩**（不是 fail-soft）。

### 3. 桌面端无单实例锁 → Electron 僵尸进程堆积
- 证据：`tasklist` 有 48 个 `KhyOS Desktop.exe`，StartTime 横跨 09-06/07/08 数天；
  `electron/` 全目录 grep 不到 `requestSingleInstanceLock` / `second-instance`。
- 根因：`electron/main.js` 仅 `window-all-closed → app.quit()`，**没有单实例锁**，
  用户多次启动 / 旧实例未清干净时，每个实例各自拉起一套 Electron 进程树，
  且退出时可能残留 GPU/utility/renderer 子进程 → **进程与句柄持续累积**。

### 4. 端口 9090 被两个守护共享（潜在 EADDRINUSE 抖动）
- `.khy/daemon.pid`（KHY daemon，`daemonManager.js` 写）与 `.khy/ai_manage_runtime.json`
  （ai-manage，`ai-manage-daemon.js` 写）**都用 apiPort 9090**。
- 缓解：`aiManagementServer.js` L3301-3336 有 EADDRINUSE 自动 +1 重试（最多 +10，
  符合“端口韧性”红线）。
- 残留风险：两者各自写 runtime 文件记录“实际端口”，一旦 9090 被占后重试到 9091，
  缓存了 9090 的下游消费者会打到错误服务 → 间歇性“连不上 / 连错”。

### 5. 硬编码绝对路径破坏可移植性（本仓为 portable 部署，重点违规）
- 证据 A（真实运行报错）：`ai_manage_daemon.log`
  `[MCP] auto-connect failed: spawn C:\khy-os\tools\deepseek-eyes\.venv\Scripts\python.exe ENOENT`
  —— 本机在 `D:\Portable\khy-os`，`C:\khy-os\...` 的 venv 不存在 → **视觉 MCP（deepseek-eyes）在本机永久不可用**。
  （用户 `mcp.json` 写的是动态 `python`，但 MCP 客户端把 `python` 解析到了旧机器的绝对 venv。）
- 证据 B（检查脚本实锤，`check-agent-rules.js` 14 error）：
  - `services/backend/fix.js` / `fix2.js` / `fix3.js` / `survey.tmp.js`：**遗留的临时调试脚本**，
    内含 `D:/Portable/khy-os/...` 硬路径，且直接改写 `proxy.js`（其中还夹带 `apiKey`）——本应删除。
  - `services/backend/start-with-db.js` L21-26：写死 6 条 PostgreSQL 安装绝对路径
    （`C:\Program Files\PostgreSQL\18` 等），正是 AGENTS.md 规则 1 点名的反例（应走 `PG_HOME`/扫盘）。
  - `inference_server.py:185`：硬编码 host:port。

### 6. SQLite 会话库曾发生「损坏 + 孤儿 WAL」事件
- 证据：`.khy/sessions.db.incident-2026-08.zip` 内含
  `sessions.db.corrupted-*`（两次损坏存档）+ `sessions.db-shm.orphan-*` / `sessions.db-wal.orphan-*`。
- 含义：**写会话库的进程经历过非正常终止（崩溃/被 kill），留下未合并的 WAL/SHM**，
  后续启动靠“检测损坏→归档→恢复”兜底。这与第 1 条的守护进程抖动/崩溃同源。

### 7. 配置漂移 / 外部通道故障
- **代理订阅失效**：`.khy/proxy.json` 的 `activeSubscriptionId` 指向一个 `lastStatus:"error",
  HTTP 404` 的订阅；`daemon.log` 反复 `RELAY-PROXY-FALLBACK ... target=api.codeium.com
  err=ECONNREFUSED/ socket hang up → falling back to direct`。代理不可用、只能回退直连。
- **微信 ilink 通道轮询失败**：`daemon.log` `ilink 轮询失败(连续 3 次),30000ms 后重试 fetch failed`。
- **ToolRegistry 曾静默丢工具**（已修）：`daemon.log`(09-05) `Failed to load
  EmbeddingExtendedTool / ImageGenExtendedTool: invalid category "multimodal"`。
  根因：`_baseTool.js` 的 `CATEGORIES` 当时没有 `multimodal`，而 6 个 `*ExtendedTool` 已声明该分类
  （分类表两处不同步）。**09-08 已在 `_baseTool.js`/`index.js` 补齐 `multimodal` 修复**，但属回归事件。
- **后端 ML 依赖缺失**：`backend.out` `[WARN] ML Python dependencies missing`。

### 8. 日志编码乱码（可诊断性劣化）
- `ai_manage_daemon.log` / `daemon.log` 大量中文是 GBK/UTF-8 错配产生的乱码
  （如 `姝ｅ湪鍏抽棴` = “正在关闭”）。不影响功能，但**严重削弱线上排障能力**——
  本次排障必须靠上下文反推每条日志的真实含义。

---

## 三、相对健康的部分（避免误判）

- `bin/khy.js` 的 `unhandledRejection` / `uncaughtException` 处理成熟（L572-582，
  交给 `crashRecovery`，致命码才 `exit`，交互式兜底不崩）。
- `aiManagementServer.js` 的端口 EADDRINUSE 自动重试（+1..+10）合规。
- `ai-manage-daemon.js` 把 workflow worker 启动失败做了 fail-soft（L669-678，
  worker 崩不影响管理栈服务）。
- `check-agent-rules.js` 共扫 5285 文件，仅 14 error（全在临时脚本/dev 脚本）+
  3 warning（`feedback.js`/`remoteSsh.js` 模糊状态文案），主链路无硬超时/滚动区违规。

---

## 四、修复优先级建议（供决策，未改动任何代码）

| 优先级 | 动作 | 对应因素 |
|---|---|---|
| P0 | 给 `electron/` 加 `requestSingleInstanceLock` + 旧实例清理，止住 48 进程堆积 | #3 |
| P0 | 让守护进程“曾见会话”后不再 `startup-timeout` 自杀（或提高 startupGrace / 改为常驻 + 真空闲回收），消除 10 分钟抖动 | #1 |
| P0 | 删除 `fix.js/fix2.js/fix3.js/survey.tmp.js` 遗留脚本；`start-with-db.js` 改 `PG_HOME`/扫盘 | #5 |
| P1 | MCP `python` 解析改为“从当前 install root / PATH 动态解析”，不再回落到旧机器绝对 venv | #5A |
| P1 | 修 `proxy.json` 失效订阅（删掉 404 订阅或换可用节点），止住 RELAY-PROXY-FALLBACK | #7 |
| P1 | 统一 daemon / ai-manage 的 9090 归属，或让 runtime 文件的实际端口传播到所有消费者 | #4 |
| P2 | 加 WAL 正常关闭钩子 + 启动时孤儿 WAL 清理告警，避免再触发“损坏→恢复” | #6 |
| P2 | 统一 `CATEGORIES` 单一真源（`_baseTool` 与 ToolRegistry 校验），防分类漂移复发 | #7 |
| P2 | 日志统一 UTF-8 输出（或终端强制 codepage 65001），止住乱码 | #8 |
