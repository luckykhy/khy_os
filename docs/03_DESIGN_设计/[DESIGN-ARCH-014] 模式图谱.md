<!-- 文档分类: DESIGN-ARCH-014 | 阶段: 设计 | 原路径: docs/设计模式/模式图谱.md -->
# GoF 23 设计模式全量映射

> 自动生成，请勿手动编辑。源: `docs/design-patterns/pattern-registry.json`

## 项目级模式 — Facade（外观模式）

Khy-OS 对外暴露单一入口（`khy` CLI / Web UI / REST API），将内核、AI 网关、量化引擎、插件、前端 UI 等异构子系统封装在统一外观之后。

## 文件级统计概览

| 类别 | 模式 | 中文 | 文件数 |
|------|------|------|--------|
| 创建型 | Singleton | 单例 | 48 |
| 创建型 | Factory Method | 工厂方法 | 10 |
| 创建型 | Abstract Factory | 抽象工厂 | 3 |
| 创建型 | Builder | 建造者 | 15 |
| 创建型 | Prototype | 原型 | 4 |
| 结构型 | Adapter | 适配器 | 66 |
| 结构型 | Bridge | 桥接 | 19 |
| 结构型 | Composite | 组合 | 91 |
| 结构型 | Decorator | 装饰器 | 14 |
| 结构型 | Facade | 外观 | 235 |
| 结构型 | Flyweight | 享元 | 45 |
| 结构型 | Proxy | 代理 | 43 |
| 行为型 | Chain of Responsibility | 责任链 | 13 |
| 行为型 | Command | 命令 | 246 |
| 行为型 | Interpreter | 解释器 | 14 |
| 行为型 | Iterator | 迭代器 | 14 |
| 行为型 | Mediator | 中介者 | 15 |
| 行为型 | Memento | 备忘录 | 23 |
| 行为型 | Observer | 观察者 | 116 |
| 行为型 | State | 状态 | 26 |
| 行为型 | Strategy | 策略 | 192 |
| 行为型 | Template Method | 模板方法 | 95 |
| 行为型 | Visitor | 访问者 | 25 |
| **合计** | **23 种** | — | **1372 次标注** |

> 源文件总数: 1128，覆盖率: 100%

---

## 创建型

### Singleton (单例) — 48 个文件

- `ai-backend/server.js`
- `ai-backend/src/services/cacheService.js`
- `ai-backend/src/services/gateway/aiGateway.js`
- `ai-backend/src/services/gateway/oauthManager.js`
- ... (40 个省略)
- `frontend/src/stores/strategyStore.js`
- `frontend/src/stores/user.js`
- `packages/shared/src/services/cacheService.js`

### Factory Method (工厂方法) — 10 个文件

- `backend/src/agents/builtInAgents.js`
- `backend/src/agents/index.js`
- `backend/src/agents/loadAgents.js`
- `backend/src/plugin-loader/contextFactory.js`
- `backend/src/services/channels/_baseChannel.js`
- `backend/src/services/gateway/adapters/_baseAdapter.js`
- `backend/src/skills/index.js`
- `backend/src/skills/skillLoader.js`
- `backend/src/tools/_baseTool.js`
- `frontend/src/plugins/pluginManager.js`

### Abstract Factory (抽象工厂) — 3 个文件

- `backend/src/plugin-loader/contextFactory.js`
- `backend/src/plugin-loader/index.js`
- `packages/plugin-sdk/src/index.js`

### Builder (建造者) — 15 个文件

- `ai-frontend/vite.config.js`
- `backend/esbuild.config.js`
- `backend/src/agents/prompt.js`
- `backend/src/constants/prompts.js`
- `backend/src/constants/systemPromptSections.js`
- ... (7 个省略)
- `kernel/src/gdt.c`
- `kernel/src/idt.c`
- `packages/khy-quant/frontend/vite.config.js`

### Prototype (原型) — 4 个文件

- `backend/src/coordinator/workerAgent.js`
- `backend/src/services/agentContext.js`
- `backend/src/services/projectTemplateService.js`
- `kernel/src/process.c`

## 结构型

### Adapter (适配器) — 66 个文件

- `ai-backend/src/services/gateway/adapters/apiAdapter.js`
- `ai-backend/src/services/gateway/adapters/claudeAdapter.js`
- `ai-backend/src/services/gateway/adapters/cliToolAdapter.js`
- `ai-backend/src/services/gateway/adapters/clipboardRelayAdapter.js`
- `ai-backend/src/services/gateway/adapters/codexAdapter.js`
- ... (58 个省略)
- `kernel/src/wincompat.h`
- `packages/shared/config/sqliteCompat.js`
- `packages/shared/src/config/sqliteCompat.js`

### Bridge (桥接) — 19 个文件

- `ai-backend/src/services/gateway/protocolConverter/index.js`
- `ai-frontend/src/views/BridgeChannels.vue`
- `backend/src/bridge/bridgeClient.js`
- `backend/src/bridge/bridgeServer.js`
- `backend/src/bridge/stateSync.js`
- ... (11 个省略)
- `packages/sdk-python/src/khy_sdk/transport.py`
- `packages/sdk/src/bridgeTransport.js`
- `packages/sdk/src/processTransport.js`

### Composite (组合) — 91 个文件

- `ai-frontend/src/App.vue`
- `ai-frontend/src/views/AIAssetsCustomers.vue`
- `ai-frontend/src/views/AIChat.vue`
- `ai-frontend/src/views/AIDashboard.vue`
- `ai-frontend/src/views/AIGateway.vue`
- ... (83 个省略)
- `kernel/src/ramfs.c`
- `kernel/src/vfs.c`
- `packages/khy-quant/frontend/dev/DevApp.vue`

### Decorator (装饰器) — 14 个文件

- `ai-backend/src/utils/logger.js`
- `backend/src/bootstrap/startupProfiler.js`
- `backend/src/middleware/auditLog.js`
- `backend/src/middleware/requestLogger.js`
- `backend/src/services/advancedDiagnostics.js`
- ... (6 个省略)
- `backend/src/utils/logger.js`
- `packages/sdk/src/logger.js`
- `packages/shared/src/utils/logger.js`

### Facade (外观) — 235 个文件

- `ai-backend/src/services/aiAssetCustomerService.js`
- `ai-backend/src/services/cloudSync.js`
- `ai-backend/src/services/gateway/appLaunchInterceptor.js`
- `ai-backend/src/services/gateway/example_plugins/cache-plugin.js`
- ... (227 个省略)
- `packages/khy-quant/src/tools/index.js`
- `packages/moonbit-plugin-sdk/cmd/weather-demo/main.mbt`
- `packages/shared/src/models/index.js`

### Flyweight (享元) — 45 个文件

- `ai-backend/src/config/database.js`
- `ai-backend/src/config/env.js`
- `ai-backend/src/services/gateway/protocolConverter/formats.js`
- `ai-frontend/src/styles/newapi-theme.css`
- `backend/check-env.js`
- ... (37 个省略)
- `packages/shared/src/config/database.js`
- `packages/shared/src/config/env.js`
- `packages/shared/src/config/sqliteCompat.js`

### Proxy (代理) — 43 个文件

- `ai-backend/src/middleware/auth.js`
- `ai-backend/src/services/gateway/proxyServer.js`
- `ai-backend/src/services/securityGuardService.js`
- `ai-frontend/src/api/request.js`
- `backend/scripts/proxy-daemon.js`
- ... (35 个省略)
- `packages/shared/src/middleware/auth.js`
- `packages/shared/src/middleware/errorHandler.js`
- `packages/shared/src/middleware/rateLimit.js`

## 行为型

### Chain of Responsibility (责任链) — 13 个文件

- `ai-backend/src/services/gateway/pluginChain.js`
- `backend/src/cli/hooks/hookRunner.js`
- `backend/src/cli/hooks/hookSystem.js`
- `backend/src/middleware/errorHandler.js`
- `backend/src/permissions/bashSecurity.js`
- ... (5 个省略)
- `backend/src/services/keyHealthProbe.js`
- `backend/src/services/toolPipeline.js`
- `packages/shared/src/middleware/errorHandler.js`

### Command (命令) — 246 个文件

- `ai-backend/scripts/reset-admin-password.js`
- `ai-backend/src/routes/ai.js`
- `ai-backend/src/routes/aiGatewayAdmin.js`
- `ai-backend/src/routes/auth.js`
- `ai-backend/src/routes/news.js`
- ... (238 个省略)
- `scripts/release/check-pip-dist-size.sh`
- `scripts/release/generate-pip-part-manifest.py`
- `scripts/release/publish-from-pip-dual.ps1`

### Interpreter (解释器) — 14 个文件

- `backend/scripts/patch_gguf_rope.py`
- `backend/scripts/patch_gguf_tensors.py`
- `backend/src/cli/commandSchema.js`
- `backend/src/services/binaryAnalyzer.js`
- `backend/src/services/directiveParser.js`
- ... (6 个省略)
- `backend/src/tools/shellClassifier.js`
- `kernel/src/elf.c`
- `kernel/src/pe.c`

### Iterator (迭代器) — 14 个文件

- `ai-backend/src/services/apiKeyPool.js`
- `backend/src/cli/lineBuffer.js`
- `backend/src/services/apiKeyPool.js`
- `backend/src/services/gateway/adapters/_sseParser.js`
- `backend/src/services/gateway/adapters/_streamProcessor.js`
- ... (6 个省略)
- `packages/sdk/src/asyncStream.js`
- `packages/sdk/src/jsonLines.js`
- `packages/sdk/src/sseParser.js`

### Mediator (中介者) — 15 个文件

- `backend/src/cli/liteRepl.js`
- `backend/src/cli/pty.js`
- `backend/src/cli/repl.js`
- `backend/src/cli/router.js`
- `backend/src/coordinator/coordinatorMode.js`
- ... (7 个省略)
- `backend/src/services/wasm-sandbox/ipcCodec.js`
- `kernel/src/ipc.c`
- `kernel/src/wm.c`

### Memento (备忘录) — 23 个文件

- `ai-frontend/src/stores/user.js`
- `backend/src/bridge/stateSync.js`
- `backend/src/services/arenaResultStore.js`
- `backend/src/services/crashRecovery.js`
- `backend/src/services/fileHistoryService.js`
- ... (15 个省略)
- `frontend/src/stores/analysis.js`
- `frontend/src/stores/strategyStore.js`
- `frontend/src/stores/user.js`

### Observer (观察者) — 116 个文件

- `ai-backend/src/services/aiMonitor.js`
- `ai-frontend/src/App.vue`
- `ai-frontend/src/composables/useAIMonitor.js`
- `ai-frontend/src/composables/useAccountPool.js`
- `ai-frontend/src/composables/useAssetCustomer.js`
- ... (108 个省略)
- `frontend/src/views/Trading.vue`
- `frontend/src/views/admin/Dashboard.vue`
- `packages/khy-quant/frontend/dev/DevApp.vue`

### State (状态) — 26 个文件

- `ai-backend/src/services/accountPool.js`
- `ai-backend/src/services/concurrencySlots.js`
- `ai-backend/src/services/planModeService.js`
- `ai-frontend/src/composables/useAccountPool.js`
- `ai-frontend/src/views/AccountPool.vue`
- ... (18 个省略)
- `backend/src/vim/transitions.js`
- `backend/src/vim/vimInput.js`
- `kernel/src/sched.c`

### Strategy (策略) — 192 个文件

- `ai-backend/src/utils/pythonPath.js`
- `ai-frontend/src/router/index.js`
- `backend/create-test-users.js`
- `backend/reset-database.js`
- `backend/src/agents/built-in/exploreAgent.js`
- ... (184 个省略)
- `packages/shared/src/utils/apiKeyHash.js`
- `packages/vscode-extension/src/extension.js`
- `scripts/obfuscate.js`

### Template Method (模板方法) — 95 个文件

- `backend/inference_server.py`
- `backend/ml/check_model_features.py`
- `backend/ml/data_collector.py`
- `backend/ml/distillation/__init__.py`
- `backend/ml/distillation/generate_labels.py`
- ... (87 个省略)
- `setup.py`
- `todo/__init__.py`
- `upgrade_khy.sh`

### Visitor (访问者) — 25 个文件

- `backend/check-env.js`
- `backend/src/cli/taskMindMap.js`
- `backend/src/services/agentsight/discover.js`
- `backend/src/services/antivirusService.js`
- `backend/src/services/documentSnippetService.js`
- ... (17 个省略)
- `scripts/ci/generate-pattern-registry.js`
- `scripts/install/check-boot-capability.sh`
- `scripts/release/check-pip-dist-size.sh`

