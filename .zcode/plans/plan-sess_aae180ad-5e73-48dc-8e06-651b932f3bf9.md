# khy-os 不稳定因素：先测试、后修复 计划

## 背景
排查已确认的不稳定因素（证据在 `.zcode/instability-report-2026-09-11.md`）：
- P0：① ai-manage 守护进程「无会话 10 分钟自杀 + 按需拉起」抖动，且任何 uncaughtException/unhandledRejection 都整体退出（`scripts/ai-manage-daemon.js:757-772`）；② 控制面 token 头不一致（daemon 收 `x-khy-token`，lifecycle 发 `X-Control-Token` → 401 → 探测失败 → 双实例抖动）；③ `services/ai-backend/server.js:147` 端口冲突无 `error` 处理 → 未捕获异常崩溃；④ `autoConnect.js:30` 默认 manager 指错模块 → MCP auto-connect 静默失效；⑤ Electron 无单实例锁 + 无 `before-quit` → 48 个僵尸进程、退出留孤儿后端。
- P1：运行时文件路径分歧（lifecycle 读 `~/.khy`，daemon 在 portable 下写 `<root>/.khy`，且每 5s 双写 C: 旧家目录）；taskBoard DDL 遇 SQLITE_BUSY 永久禁用（无重试）；customerRegistry 跨进程 last-writer-wins（已见 4 个孤儿 .tmp）；`start-with-db.js` 写死 PG 路径；遗留垃圾文件（根目录 5 个 + backend 4 个）。
- 用户指令：先做好测试，再修复。用户未选范围 → 按 **P0+P1** 执行；P2（dist 重建、日志乱码、ilink/proxy 数据）不做。

## Phase 1：测试（RED 优先）
约定：后端测试用 jest 放 `services/backend/tests/`（jest 默认收集；setupFiles 已把 `KHY_DATA_HOME` 固定到临时目录，直接复用）；Electron 测试用 `node:test` 放 `scripts/tests/electron/`（被现有 `npm run test:scripts` 自动收集——遵守 OPS-MAN-174「不为单个测试文件建 npm 入口」，不加新入口）；**不新增 KHY_* 开关**（免 flagRegistry 登记）。

新增测试文件（标注 RED = 对当前行为失败）：
1. `tests/aiManageDaemonGc.test.js` — GC 循环：startup-timeout（seenAnySession=false）/idle（=true）语义固定；会话 TTL 过期；shuttingDown 幂等；**工作流 worker busy 时不得 startup-timeout 自杀（RED）**；**瞬态异常（ECONNRESET/SQLITE_BUSY/ENOENT）不退出、未知/致命才退出（RED）**。前置：给 `ai-manage-daemon.js` 加测试接缝（`require.main` 守卫 + `module.exports` + 可注入 tick 间隔），行为不变。
2. `tests/aiManageDaemonControlApi.test.js` — lifecycle `probeControl`/`requestShutdown` 对真实控制服务器成功（当前 401，RED）；portable 模式下 `_runtimeFile()` 与 daemon 写入位置一致（`getDataHome()`，RED）；stale PID 时 ensureStarted 用假 daemon 脚本完成重拉（基建 GREEN）。
3. `tests/aiBackendPortResilience.test.js` — spawn `services/ai-backend/server.js` 且 `AI_MGMT_PORT` 指向被占端口：进程存活并绑定下一可用端口（当前崩溃，RED）。
4. `tests/mcpAutoConnectWiring.test.js` — 默认 manager 具备 `loadConfig`+`connectAll` 且 `ensureMcpConnected` 真正派发（当前指向 agents/index，静默 no-op，RED）。
5. `tests/mcpStdioPythonResolution.test.js` — 裸 `python` 解析：VIRTUAL_ENV → PYTHON_PATH → 安装根 `tools/deepseek-eyes/.venv` → PATH（纯函数，TDD）；配置里的陈旧绝对路径 fail-fast 并给出可执行修复提示。
6. `tests/toolsCategoryConsistency.test.js` — 单一真源：所有 `src/tools` 的 category ∈ `CATEGORIES`；6 个 multimodal 扩展工具全部加载不被拒（钉死 09-05 回归，防 dist/src 漂移）。
7. `tests/taskBoardBusyRetry.test.js` — 打开期 DDL 遇 SQLITE_BUSY：有界重试后可用，不再终身禁用（RED）。
8. `tests/customerRegistryConcurrentWrites.test.js` — 双进程并发 load/save 无丢写（版本 CAS）+ 启动时清扫孤儿 `.tmp.*`（RED）。
9. `scripts/tests/electron/main.singleInstance.test.js` — main.js 必须 `requestSingleInstanceLock`；第二实例聚焦已有窗口；`before-quit` 调 `backendService.stop()`（当前缺失，RED；mock 用 require.cache 预置假 electron 模块）。

同时修两套已损坏的存量测试：
- `tests/mcpAutoConnect.test.js:13` 导入 `../src/services/mcp/autoConnect`（不存在）→ 改为 `domain/messaging/mcp/autoConnect`。
- `tests/services/__tests__/aiManageDaemonLifecycle.test.js:145` 用了未导入的 `assert` → 补 `node:assert`。

## Phase 2：修复（让 RED 转 GREEN），按序
- F1 `ai-manage-daemon.js` 测试接缝（守卫+导出+可注入 tick，行为不变）。
- F2 故障隔离：daemon 的 uncaught/unhandled 走 `crashRecovery` 分类——瞬态（含新增 ENOENT/spawn-ENOENT 条目；SQLITE_BUSY 已有）记录后继续，仅未知/致命退出。
- F3 活性信号：`workflowRunWorker.getStatus()` 增加 `busy`；GC 循环在 busy 时视为有活动（不触发 startup-timeout/idle 自杀）。
- F4 token 头：daemon `readAuthToken` 同时接受 `x-khy-token` 与 `x-control-token`。
- F5 运行时文件单一真源：lifecycle `_runtimeFile()` 改用 `getDataHome()`；daemon 在 portable 模式不再双写 C: `~/.khyquant` 旧家目录。
- F6 `services/ai-backend/server.js`：`server.on('error')` + EADDRINUSE 自动探测下一可用端口（对齐 backend 契约），实际端口写日志/传播。
- F7 `autoConnect.js` 默认 manager 指向真实 MCP 客户端（`./index`）。
- F8 MCP stdio `python` 解析（新叶子 `domain/messaging/mcp/pythonCommandResolver.js`，复用 `utils/pythonPath.js` 的 findPython；候选含安装根 `tools/deepseek-eyes/.venv`）。
- F9 taskBoard：DDL 初始化失败有界退避重试。
- F10 customerRegistry：版本 CAS + 孤儿 `.tmp.*` 清扫。
- F11 `electron/main.js`：单实例锁 + second-instance 聚焦 + `before-quit` 停止后端子进程。
- F12 抽取 `src/utils/pgPaths.js`（server.js 的 `_discoverPgPaths`：PG_HOME + 盘符扫描），`server.js` 与 `start-with-db.js` 共用。
- F13 删垃圾：根目录未跟踪碎片 3 个 + 跟踪文件 7 个（`SidePane.tsx`/`Composer.tsx`/backend `fix.js`/`fix2.js`/`fix3.js`/`survey.tmp.js`，用 `D:\Portable\Tools\git\cmd\git.exe` 做 `git rm`；不提交，留给用户）。

## 验证
- `npm run test:all --workspace services/backend`（jest + node --test 双跑全绿）。
- `npm run test:scripts`（含新 Electron 测试）。
- `node scripts/ci/check-agent-rules.js`（改动文件零 error）、`npm run check:layout`、`npm run check:flag-registry`（未加新 flag，应直接过）。
- 实机冒烟：重启 ai-manage daemon → 9090 可连、控制面探测 ok、`ai_manage_runtime.json` 写在 `D:\Portable\khy-os\.khy`、10 分钟内不再自杀（有工作流运行时）；清理 48 个僵尸 Electron 进程后重启桌面端验证单实例。

## 不做（P2/数据类）
dist 陈旧 bundle 重建、日志 GBK/UTF-8 乱码统一、ilink 通道与 `.khy/proxy.json` 的 404 订阅（用户数据）、sessions.db 事故深挖。