<!-- khy-metadata:auto khy-metadata/4 fingerprint=6dee9af7c1cad71e -->
<!-- 本文件由 khy 机械生成，可被 `khy metadata refresh` 安全覆盖。删除上面这行标记即视为人工接管，刷新将不再覆盖本文件。 -->
# MAP — khy-os 骨架与导航

> 由 khy 自动生成的可维护性种子文档（无需 AI 即可据此维护）。配套 `.ai/CONTEXT.yaml`（契约/符号）`.ai/GUARDS.md`（红线/无AI维护指南）。
> 本文为确定性扫描产物：目录职责按约定推断，入口/构建命令来自 manifest，符号清单来自轻量正则。带 `TODO(人工)` 处需维护者补全意图。

## 技术栈
`node` · `monorepo` · `python` · `docker`

## 核心入口点
- `platform/packages/shared/src/index.js` (node-main, workspace:@khy/shared#main)
- `platform/packages/ui-shared/src/index.js` (node-main, workspace:@khy/ui-shared#main)
- `services/backend/server.js` (node-main, workspace:khy-os-backend#main)
- `services/backend/bin/khy.js` (cli-bin, workspace:khy-os-backend bin:khyquant)
- `services/backend/bin/khy.js` (cli-bin, workspace:khy-os-backend bin:khy-os)
- `services/backend/bin/khy.js` (cli-bin, workspace:khy-os-backend bin:khy)
- `services/ai-backend/server.js` (node-main, workspace:khy-ai-backend#main)
- `platform/khy_platform/cli.py` (python-entry, pyproject scripts)

## 目录结构与职责
- `apps/` — 多应用
  - `apps/ai-frontend/`
  - `apps/khy-os-client-app/` — Flutter Android 客户端（替代原 khy-mobile）
  - `apps/khyos-desktop/`
- `dist-electron/`
  - `dist-electron/portable/`
- `docs/` — 文档
  - `docs/01_INIT_立项/`
  - `docs/02_CONCEPTS_概念入门/`
  - `docs/03_DESIGN_设计/`
  - `docs/04_IMPL_实现/`
  - `docs/05_TEST_测试/`
  - `docs/06_DEPLOY_部署/`
  - `docs/07_OPS_运维/`
  - `docs/08_MGMT_项目管理/`
  - `docs/09_STORY_修仙学AI/`
  - `docs/_AI协作预设包/`
  - `docs/_assets/`
  - `docs/_ref/`
- `electron/`
  - `electron/services/` — 服务/业务逻辑
- `extensions/`
  - `extensions/bridges/`
  - `extensions/scripts/` — 脚本（构建/CI/运维）
  - `extensions/tools/` — 工具
- `kernel/` — 内核
  - `kernel/boot/` — 引导
  - `kernel/bridge/`
  - `kernel/docs/` — 文档
  - `kernel/iso/`
  - `kernel/moonbit/`
  - `kernel/src/` — 源代码主目录
  - `kernel/tools/` — 工具
  - `kernel/userland/`
- `khy_os.egg-info/`
- `packaging/` — 打包
  - `packaging/installer/`
  - `packaging/modules/`
  - `packaging/npm/`
- `platform/`
  - `platform/delivery/`
  - `platform/khy_platform/`
  - `platform/packages/`
  - `platform/tests/` — 测试
- `scripts/` — 脚本（构建/CI/运维）
  - `scripts/admin/`
  - `scripts/backend/` — 后端
  - `scripts/ci/`
  - `scripts/docs/` — 文档
  - `scripts/frontend/` — 前端
  - `scripts/install/`
  - `scripts/lib/` — 库代码
  - `scripts/maintenance/`
  - `scripts/memory/`
  - `scripts/moonbit/`
  - `scripts/portable/`
  - `scripts/quality-gate/`
- `services/` — 服务/业务逻辑
  - `services/ai-backend/`
  - `services/backend/` — 后端
- `software/`
  - `software/akshare_scripts/`
  - `software/khyquant/`
- `tests/` — 测试
- `tools/` — 工具
  - `tools/deepseek-eyes/`
- 根文件: `$null`, `.clinerules`, `.dockerignore`, `.editorconfig`, `.git-blame-ignore-revs`, `.gitattributes`, `.gitignore`, `.khy_orphan_sweep`, `.npmrc`, `.portable`, `.windsurfrules`, `AGENTS.html`, `AGENTS.md`, `CHANGELOG.html`, `CHANGELOG.md`, `CLAUDE.html`, `CLAUDE.md`, `CONTRIBUTING.html`, `CONTRIBUTING.md`, `Composer.tsx`

## 构建 / 运行 / 测试
- **安装**: `npm install` ; `pip install -e .`
- **测试**: `npm test --workspaces --if-present` ; `pytest`

## 关键文件符号速览
> 导航 teaser（按详略档位裁剪，`KHY_META_DETAIL=brief|standard|full`）。完整逐文件逐符号清单见 `CONTEXT.yaml`。
- `Composer.tsx` (typescript): Composer
- `SidePane.tsx` (typescript): SidePane
- `khy.sh` (shell): _无导出符号_
- `portable-setup.sh` (shell): _无导出符号_
- `electron/main.js` (javascript): createWindow, getMainWindow, registerIpcHandlers
- `electron/preload.js` (javascript): handler, handler, handler, handler
- `kernel/tools_gen_blob.sh` (shell): _无导出符号_
- `scripts/electron-dev.js` (javascript): _无导出符号_
- `scripts/findIgnored.js` (javascript): findStandaloneTestFiles
- `scripts/test-replace.js` (javascript): _无导出符号_
- `apps/ai-frontend/.eslintrc.cjs` (javascript): _无导出符号_
- `apps/ai-frontend/backendDiscovery.mjs` (javascript): readApiPortFromRuntime, readPointerDataHome, resolveBackendTarget
- `apps/ai-frontend/vite.config.js` (javascript): _无导出符号_
- `apps/khyos-desktop/electron.vite.config.ts` (typescript): _无导出符号_
- `apps/khyos-desktop/vite.config.js` (javascript): _无导出符号_
- `apps/khyos-desktop/vite.host.config.ts` (typescript): _无导出符号_
- `apps/khyos-desktop/vite.scheduler.config.ts` (typescript): _无导出符号_
- `docs/_assets/docs-site.js` (javascript): ensureCtx, tone, seq, initSoundToggle, sync, refreshSoundToggleIcon, initCalmToggle, applyCalm, sync, initGetStarted, …(+18)
- `docs/_assets/nav-data.js` (javascript): _无导出符号_
- `electron/services/aiGatewayService.js` (javascript): getApiConfig, httpRequest
- `electron/services/authService.js` (javascript): ensureConfigDir, readConfig, writeConfig
- `electron/services/backendService.js` (javascript): findBackendEntry
- `electron/services/connectionServer.js` (javascript): getServerUrl
- `electron/services/fileService.js` (javascript): buildTree
- `electron/services/messageService.js` (javascript): _无导出符号_
- `electron/services/sessionService.js` (javascript): ensureDir, sessionFile, loadSession, saveSession, listSessionFiles
- `electron/services/syncService.js` (javascript): sendToRenderer
- `electron/services/terminalService.js` (javascript): getShell, sendToRenderer
- `kernel/bridge/index.js` (javascript): _无导出符号_
- `kernel/bridge/khy-agent-run.js` (javascript): log, main, shutdown
- `kernel/bridge/khy-agent.js` (javascript): defaultBrain, KhyAgent
- `kernel/bridge/khy-brain-gateway.js` (javascript): readAuthTokenFile, defaultGatewayUrl, host, port, postJson, assistantText, firstLine, buildMessages, shapeReply, makeGatewayBrain, …(+2)
- `kernel/bridge/khy-bridge.js` (javascript): KhyStatusError, KhyBridge, reply, seq
- `kernel/bridge/khy-frame.js` (javascript): crc16, cobsEncode, cobsDecode, encodeFrame, decodeFrame, FrameSplitter
- `kernel/bridge/khy-mcp.js` (javascript): KhyMcpServer, sleep, connectWithWait, main, log, shutdown
- `kernel/bridge/khy-protocol.js` (javascript): enc, statReq, listReq, readReq, writeReq, pathReq, psReq, splitStatus, parseStat, parseListPage, …(+4)
- `kernel/bridge/khy-tools.js` (javascript): makeTools
- `kernel/src/agentask.c` (c): waiter, ask_crit_enter, ask_crit_leave, agentask_init, agentask_on_response, agentask_tick
- `kernel/src/agentask.h` (c): agentframe
- `packaging/installer/build_installer.js` (javascript): getVersion, findKhyExecutable, buildPayload, zipSize, checkNsis, compileNsi, main, size
- `platform/delivery/deliveryController.js` (javascript): DeliveryController
- `platform/delivery/demo.js` (javascript): main
- `platform/khy_platform/__init__.py` (python): _detect_version
- `platform/khy_platform/__main__.py` (python): _无导出符号_
- `platform/khy_platform/_bootstrap.py` (python): _is_china_network, _configure_npm_registry, _subprocess_kwargs, _run_npm_streaming, _watchdog, _write_marker, _path_exists_safe, _has_llama_pkg, _has_cw_sdk, _node_env, …(+20)
- …其余 72 个文件的符号见 `CONTEXT.yaml`（完整逐文件清单）。

