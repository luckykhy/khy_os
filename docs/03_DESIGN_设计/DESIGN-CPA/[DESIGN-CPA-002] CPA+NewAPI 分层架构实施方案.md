# [DESIGN-CPA-002] CPA + New API 分层架构实施调研与方案

> **文档类型**: 实施调研与方案（只调研，不写代码）
> **创建日期**: 2026-09-11
> **状态**: 待评审
> **上位真源**: `AGENTS.md`（工程红线）、`[DESIGN-CPA-003]`（分层架构设计）、`[DESIGN-ARCH-071]`（通道选择决策矩阵）、`[DESIGN-LAY-005]`（层级板块规范）
> **配套快速指南**: `docs/06_DEPLOY_部署/[DEPLOY-0102] CPA+NewAPI分层架构快速指南.md`

---

## 0. 调研方法与输入

- 已读：`AGENTS.md`、`[DESIGN-CPA-003]`、`CPA+NewAPI分层架构快速指南.md`
- 代码实地核对：`apiKeyPool.js` / `channelApiService.js` / `gateway/customerRegistry.js` / `gateway/keySelector.js` / `concurrencySlots.js` / `agentLauncherRegistry.js` / `agentContext.js` / `gateway/aiGateway.js`（优先级 0–17 适配器链）/ `gateway/adapters/`（66 个，`relayApiAdapter` 范式）/ `cli/handlers/`（149 个）+ `router.js` 四分发簇 / `aliases.js`（862 行）/ `tests/`（734 项，node:test）
- 外部组件定位：CPA = `CLIProxyAPI`（router-for-me，接入层，:8317，config.yaml）；New API = `Calcium-Ion/new-api`（one-api 系，治理层，:3000，Web+REST+SQLite/MySQL）

---

## 1. 现状分析

### 1.1 已有什么（可复用组件）

| 组件 | 位置 | 与 CPA/NewAPI 的关系 | 复用方式 |
|------|------|--------------------|---------|
| 密钥池 `apiKeyPool` | `services/apiKeyPool.js` | New API 令牌 / CPA api-key 入池（provider=`newapi`/`cpa`），轮转+退避+env 叠加 | **密钥 SSoT ①**：令牌不入 CPA/NewAPI 文件，khy 池持有 |
| 渠道加密行 `channelApiService` | `services/channelApiService.js` | `channel_api` 表（AES-256-GCM，`revealChannelKey` 单一出口 + 审计） | 加密密钥行的**安全范式**参考；New API root token 建议直接走此表 |
| 客户/令牌/配额 `customerRegistry` | `services/gateway/customerRegistry.js` | khy 自家网关的客户配额 SSoT（`ai_gateway_customers.json`，`issueToken/rotateToken/adjustCustomerQuota`） | 与 New API 治理层**镜像映射**：khy 客户 ↔ New API 用户/令牌（1:1 同步，见 §2.3） |
| 选择策略 `keySelector` | `services/gateway/keySelector.js` | 6 策略（`round-robin/least-fail/least-used/hybrid/fill-first/random`） | **CPA 负载均衡镜像**：khy 侧 `fill-first` 策略对齐 CPA 的耗尽单账号再换语义 |
| 并发闸 `concurrencySlots` | `services/concurrencySlots.js` | 每 provider 槽位 + 用户级并发 | New API/CPA 通道级限流的前置闸（防打爆治理层） |
| 适配链 `aiGateway` | `services/gateway/aiGateway.js:2163-2191` | 优先级 0–17（kiro…openclaw）；`relay_api=10` | **新适配器插入点**：`cpa=18`、`newapi=19`（配置缺失时 `detect()` 自动出局，零副作用） |
| 适配器范式 `relayApiAdapter` | `services/gateway/adapters/` | OpenAI 兼容线 + `_protocolPipeline/_retryWithBackoff/_openaiSseStream/_proxyTunnel/_errorClassifiers/runtimeDiagnosticsStore` 全套基建 | **newApiAdapter/cpaAdapter 的模板**（设计文档里的裸 fetch 草图需按此范式重写） |
| Agent 启动器 `agentLauncherRegistry` | `services/agentLauncherRegistry.js` | 9 个外部 agent 的 SSOT 启动表（kiro/cursor/claude/codex/trae/opencode/warp/vscode/windsurf） | **Phase 3 配置分发目标集**（把 newapi 端点+令牌分发给各 agent） |
| Agent 上下文 `agentContext` | `services/agentContext.js` | `AgentContext` 类 | 分发时携带目标 agent 的上下文 |
| 卡片 SSoT `ccSwitch store` | `services/domain/config/ccSwitch/store.js` + `constants.js` | `cc_switch.json` 卡片（无凭据，keyId 引池）+ `APPS` 表（现 9 工具） | **APPS 扩 2**：`CPA:'cpa'`、`NEWAPI:'newapi'`；卡片 `apps` 字段承载双投递 |
| 写入器矩阵 `appWriters` | `services/domain/config/ccSwitch/appWriters.js` | preflight/apply/detect 三件套（8 工具 + zcode 登录门） | 新增 `cpaWriter`/`newApiWriter` 两个 case |
| provider 预设 `providerPresets` | `services/gateway/providerPresets.js` | 15 家公共端点真源（**无 cpa/newapi**——本地网关不入预设目录） | 不改；端点默认值走 `serviceDefaults`（见 §6 风险 R1） |
| CLI 四分发簇 | `cli/router.js` + `routerDispatch{Ops,Slash,Tail,Handlers}` + `aliases.js` | `khy <cmd>` 全链路 | 新增 `khy cpa` / `khy newapi` 两个命令簇 |
| 测试基建 | `tests/`（734 项，node:test + assert/strict） | 每服务 1–N 个 `.test.js`，mock fetch/文件系统 | 新模块全部 TDD 先行（§5） |
| 用量账本 `tokenUsageService` | `services/tokenUsageService.js` | `token_usage.json` 按日/月聚合（costUSD） | 两个适配器响应 usage 回写（计费对账源） |

### 1.2 缺什么（需新建模块）

| 缺口 | 说明 | 归属 Phase |
|------|------|-----------|
| CPA 配置写入器 `cpaWriter` | 管理 CLIProxyAPI 的 `config.yaml`（providers/accounts/负载策略），原子写+.bak，账号凭据加密或 env 引用 | P1 |
| CPA 生命周期服务 `cpaService` | 探测/启动/停止 CPA 进程或容器，运行时状态文件（端口动态发现，零硬编码） | P1 |
| CPA 直连适配器 `cpaAdapter` | OpenAI 兼容线直打 CPA:8317（个人自用路径，不经 New API） | P1 |
| New API 接入服务 `newApiService` | 探测/引导 New API 运行时 + REST 客户端（令牌/渠道/配额/用量，fail-soft） | P2 |
| New API 写入器 `newApiWriter` | 端点+令牌落 khy 侧（env 引用/池 keyId），**不写 New API 本体**（其状态在 DB） | P2 |
| New API 适配器 `newApiAdapter` | OpenAI 兼容线打 New API:3000（治理路径），令牌来自池，usage 回写账本 | P2 |
| 客户↔令牌同步器 `newApiSync` | `customerRegistry` 客户/配额 ↔ New API 用户/令牌/额度 的双向对账（单向 khy→NewAPI 优先） | P2 |
| Agent 分发扩展 | `agentLauncherRegistry` 目标集 × newapi/cpa 端点的配置分发（env 注入 + appWriters 复用） | P3 |
| 集成路由 | aiGateway 插入 cpa=18/newapi=19；keySelector `fill-first` 对齐 CPA 轮询语义 | P4 |
| CLI 命令簇 `khy cpa` / `khy newapi` | status/config/start/stop/channels/token/usage 子命令 | P4 |
| provider-hub 工具矩阵扩 2 | `APPS` 9→11；provider-hub `state.tools`/tray `TOOLS` 同步 | P4 |

---

## 2. 架构设计

### 2.1 分层与模块关系

```
用户层   khy CLI ─────────────── Web UI(8090) ──── IDE/外部 agent
                         │
应用层   ┌─ aiGateway 适配链(0–17 既有) ─ cpa=18 ─ newapi=19 ─┐
         │  ├ cpaAdapter ──── 直连 CPA(个人路径, 无治理)          │  读 cc_switch.json
         │  └ newApiAdapter ─ 令牌入池 keyId ─ 走 New API(治理) ──┘  + api_keys.json
         │
         ├─ cpaService   ─── 管理 CPA 进程/容器 + config.yaml(cpaWriter)
         ├─ newApiService ── REST(令牌/渠道/配额/用量) + 运行时发现
         ├─ newApiSync   ─── customerRegistry ◄──► New API 用户/令牌/额度
         ├─ keySelector(6 策略) / concurrencySlots(并发闸)
         │
治理层   New API(:3000, SQLite/MySQL) ── 用户/令牌/渠道/计费/限流
         渠道 CPA-Codex(:8317) / CPA-Claude(:8317) / 直连渠道…
接入层   CPA CLIProxyAPI(:8317, config.yaml) ── 多账号轮询/OAuth 刷新/协议转换
         上游 Codex / Claude Code / Gemini CLI / Qwen Code …
```

### 2.2 数据流（治理路径）

```
khy ai "Hello" --adapter=newapi
 → aiGateway(priority 19) → newApiAdapter
 → 读 cc_switch.json 卡片(newapi) → keyId → api_keys.json 池取令牌
 → POST New API :3000/v1/chat/completions (Bearer 令牌)
 → New API: 验令牌→查权限→查配额→选渠道(CPA-Codex)
 → CPA :8317 → 选账号(fill-first) → Codex OAuth → 响应
 → 回流: usage 回写 token_usage.json(对账) + 渠道健康(New API 自动)
```

### 2.3 模块依赖关系（新增 → 既有）

| 新模块 | 依赖的既有模块 | 依赖性质 |
|--------|---------------|---------|
| `cpaService` | `utils/dataHome`、`configGuard`（原子写）、`serviceDefaults`（端口真源） | 直接 require |
| `cpaWriter` | `cpaService`（配置目录解析）、`channelApiCrypto`（账号 token 加密，可选项） | 直接 require |
| `cpaAdapter` | `adapters/_responseBuilder`、`_protocolPipeline`、`_retryWithBackoff`、`apiKeyPool`（keyId→key） | 同 `relayApiAdapter` 范式 |
| `newApiService` | `customerRegistry`（对账源）、`dataHome`（运行时文件） | 直接 require |
| `newApiAdapter` | `ccSwitch/store`（卡片）、`apiKeyPool`（令牌）、`_protocolPipeline` 等 8 个 adapter 基建 | 同 `relayApiAdapter` 范式 |
| `newApiSync` | `customerRegistry`、`newApiService` | 直接 require |
| agent 分发 | `agentLauncherRegistry`、`appWriters`（env 注入范式）、`gatewayEnvFile` | 复用 writer |

---

## 3. 文件清单

### 3.1 新建文件（全部在 `services/backend/` 下）

| 文件 | 说明 |
|------|------|
| `src/services/cpaService.js` | CPA 运行时：`detect()/start()/stop()/status()`；运行时状态写 `dataHome/cpa_runtime.json`（动态端口发现，零硬编码）；启动探测 `config.yaml` 端口占用时自动顺延（规则 1 端口韧性） |
| `src/services/domain/config/ccSwitch/cpaWriter.js` | `applyCardToCpa(card,opts)`（providers/负载策略段 merge-write config.yaml，原子+.bak）、`detectCpaConfig()`（反向探测）、`preflightCardForCpa()`；账号 token 仅允许 env 引用或 `channelApiCrypto` 密文行（对齐 command-code「官方拒绝裸密钥」先例） |
| `src/services/gateway/adapters/cpaAdapter.js` | `detect/detectAsync/listModels/generate/getStatus/getRuntimeDiagnostics/destroy`；OpenAI 兼容线；配置链：卡片(active cpa) → env `KHY_CPA_ENDPOINT` → 运行时文件 → 出局（fail-soft） |
| `src/services/newApiService.js` | New API 运行时探测（`dataHome/newapi_runtime.json` 或 env）+ REST 客户端：`listTokens/createToken/revokeToken/listChannels/createChannel/getQuota/usageSummary`；全部 fail-soft（服务不可达 → `{ok:false,error:'动作…目标…'}`） |
| `src/services/domain/config/ccSwitch/newApiWriter.js` | `applyCardToNewApi`（端点+池 keyId 落 khy 侧 env 引用，**不写 New API DB**）、`detectNewApiConfig`、`preflightCardForNewApi`（协议必须 openai） |
| `src/services/gateway/adapters/newApiAdapter.js` | 同 cpaAdapter 范式；令牌解析顺序：卡片 keyId→池 → env `NEWAPI_API_KEY` → 出局；`usage` 回写 `tokenUsageService.recordUsage` |
| `src/services/newApiSync.js` | `customerRegistry.listCustomers()` ↔ `newApiService.listTokens()` 对账；`syncCustomerToNewApi(customerId)` 单向推送（创建令牌+配额镜像）；冲突策略：New API 侧人工改动只读标记、不反向覆盖（SSoT=khy 客户表） |
| `src/cli/handlers/cpa.js` | `khy cpa status\|config\|start\|stop` |
| `src/cli/handlers/newapi.js` | `khy newapi status\|channels\|token\|usage\|sync` |
| `tests/cpaService.test.js` | 端口探测顺延、运行时文件原子写、stop 幂等（node:test + mock child_process） |
| `tests/cpaWriter.test.js` | config.yaml merge 不丢无关段、凭据加密路径、preflight 拒绝非 openai 卡 |
| `tests/cpaAdapter.test.js` | mock fetch：流式/非流式/超时/401/出局；`_resetState` 测试缝 |
| `tests/newApiService.test.js` | mock fetch：REST fail-soft、令牌 CRUD、配额读取 |
| `tests/newApiAdapter.test.js` | 同 cpaAdapter 范式 + usage 回写断言 |
| `tests/newApiSync.test.js` | 对账矩阵（有/无/冲突/配额不一致 4 象限） |
| `tests/cliCpaNewApi.test.js` | 两个 handler 的 CLI 输出契约（状态文案合规：动作+目标+进度） |

### 3.2 修改文件

| 文件 | 修改内容 |
|------|---------|
| `services/backend/src/constants/serviceDefaults.js` | 新增 `CPA_DEFAULT_PORT=8317`、`NEWAPI_DEFAULT_PORT=3000`（**默认值唯一合法真源**，模块内一律 env 可覆盖） |
| `services/domain/config/ccSwitch/constants.js` | `APPS.CPA='cpa'`、`APPS.NEWAPI='newapi'` + `APP_LABELS`（9→11 工具） |
| `services/domain/config/ccSwitch/appWriters.js` | import 两 writer；`preflightCardForApp/applyCardToApp/detectCardInApp` 各 +2 case（zcode 同款接法） |
| `services/gateway/aiGateway.js` | 适配器数组追加 `{key:'cpa', priority:18}`、`{key:'newapi', priority:19}`（均在 `openclaw=17` 之后；配置缺失 `detect()` 出局） |
| `services/gateway/keySelector.js` | 无代码改动；文档层面声明 newapi 通道默认 `fill-first`（对齐 CPA 轮询语义，经 `parseStrategyMap` 配置） |
| `cli/router.js`（经 `routerDispatchOps`） | `case 'cpa'` / `case 'newapi'` 两分支 → 新 handler |
| `cli/aliases.js` | `cpa/反代接入` → `cpa`；`newapi/新api/渠道网关` → `newapi`（对齐既有别名表风格） |
| `apps/provider-hub/src/main/tray.ts` + `src/renderer/app.js` | `TOOLS` 常量 6→8（加 `cpa`、`newapi`；与后端 APPS 表同步，契约测试防漂移） |
| `apps/provider-hub/scripts/acceptance.mjs` | 探测工具清单 9→11（含 cpa/newapi 的 detect 结果） |
| `docs/00_INDEX_文档索引.md` | 本文档挂链（CP-3） |

### 3.3 明确不改（防腐边界）

- `customerRegistry` 数据结构（只读对账，不为其加 New API 字段——映射存 `newApiSync` 自己的 `dataHome/newapi_sync.json` 台账）
- `providerPresets.js`（本地网关不入公共预设目录）
- CPA / New API 上游项目本体（仅 config/REST 集成，**不 fork 其代码**——AGPL 边界）

---

## 4. 实施顺序

| Phase | 内容 | 前置 | 交付判据 |
|-------|------|------|---------|
| **P1 CPA 核心模块** | `cpaService` + `cpaWriter` + `cpaAdapter` + `APPS.CPA` 注册 + 3 组测试 | provider-hub 已完成（✅ 2026-09-11） | 单测全绿；`khy cpa status` 可用；cpa 适配器在 aiGateway 可出局 |
| **P2 New API 核心模块** | `newApiService` + `newApiWriter` + `newApiAdapter` + `newApiSync` + `APPS.NEWAPI` 注册 + 4 组测试 | P1（复用运行时文件范式） | 单测全绿；`khy newapi token/sync` 可用；客户对账 4 象限通过 |
| **P3 Agent 注册与配置分发** | `agentLauncherRegistry` 目标集 × newapi/cpa 端点分发（env 注入走 `gatewayEnvFile`；工具写入复用 appWriters）+ provider-hub 工具矩阵扩 2 | P2 | 至少 claude-code/opencode/zcode 三个 agent 端点指向 New API 卡；漂移可检测 |
| **P4 集成层与路由** | aiGateway 18/19 插入 + CLI 命令簇 + 别名 + keySelector fill-first 声明 + 端到端验收脚本 | P3 | `khy ai "test" --adapter=newapi` 走通治理路径（New API 有扣费记录）；守卫全绿 |

依赖关系：`P1 ∥ P2`（模块互不依赖，可并行；P2 的 newApiSync 依赖 customerRegistry 既有能力）；`P3` 需 P1+P2；`P4` 需全部。

---

## 5. 验收标准

### 5.1 每 Phase 验收条件

| Phase | 功能验收 | 命令/证据 |
|-------|---------|----------|
| P1 | CPA 可启动/探测/停止；config.yaml 原子写且 `.bak` 自愈；cpaAdapter 直连出流式回复；CPA 端口被占时自动顺延并把实际端口写运行时文件 | `node --test tests/cpa*.test.js` 全绿；`khy cpa status` 显示运行中+端口 |
| P2 | New API 令牌/渠道/配额 CRUD 经 REST 可达；`newApiSync` 把 khy 客户 1:1 映射为 New API 令牌（含配额）；newApiAdapter 治理路径出回复且 usage 入账本 | `node --test tests/newApi*.test.js` 全绿；New API 面板可见 khy 创建的令牌 |
| P3 | ≥3 个 agent（claude-code/opencode/zcode）的配置指向 New API 卡片（env 引用/槽位语义正确）；provider-hub 工具矩阵含 cpa/newapi 两列；手改 live 配置可被漂移检测标记 | `khy cc-switch status` 显示 11 工具探测；provider-hub 实机矩阵 8 工具 |
| P4 | 端到端：`khy ai "x" --adapter=newapi` 经 New API 扣费后回复；429/401/超时三态文案合规（规则 2.2）；`check-agent-rules` 新增文件零违规；`check:layout` 全绿 | 端到端脚本 exit 0；New API 用量看板 +1 |

### 5.2 测试覆盖目标

- 新模块行覆盖 ≥90%（对齐仓库既有服务测试密度：每服务 1 主测试 + 边界测试）
- 必测清单：CPA 端口顺延（mock EADDRINUSE）、config.yaml 损坏自愈、凭据密文路径（明文 key 绝不出现在 config.yaml/日志）、New API REST 超时（空闲超时非硬 kill，规则 3）、newApiSync 冲突四象限、aiGateway 出局判定（端点未配置时 cpa/newapi 不参与路由）
- 契约测试：`APPS` 表 11 值与 provider-hub `TOOLS` 同步（防漂移，参照 keyManagerContract 范式）
- CLI 文案合规扫描：`check-agent-rules` 对 2 个新 handler 零 warning

---

## 6. 风险点与规避

| # | 风险 | 等级 | 规避方案 |
|---|------|------|---------|
| R1 | **零硬编码红线**：CPA :8317 / New API :3000 字面量散落 | 高 | 端点/端口只允许出现在 `constants/serviceDefaults.js`（真源）+ env 覆盖；`check-agent-rules` 端点检查兜底 |
| R2 | **AGPL 传染**：CLIProxyAPI 为 AGPL-3.0 | 高 | khy 侧仅 config.yaml/REST/子进程集成，**不 import、不 fork、不打包其代码**；进程间通信走 HTTP（独立进程边界，AGPL 不传染 khy 代码库） |
| R3 | **凭据泄露**：CPA config.yaml 含 OAuth token；New API root token | 高 | 账号凭据走 `channelApiCrypto` 密文行或 env 引用（对齐 command-code/ycode 先例）；文件 0600；`reveal` 单一出口+冷却+审计（对齐 091 密钥规范） |
| R4 | **双 SSoT 分叉**：khy 客户表 vs New API 用户/令牌 | 中 | 单向同步（khy→NewAPI）+ 对账台账 `newapi_sync.json`；New API 侧人工改动只标记不同步，UI 明示漂移 |
| R5 | **端口冲突**（8317/3000 被占） | 中 | 规则 1 端口韧性：探测顺延 + 实际端口写运行时文件 + 全链路传播（CPA→NewAPI 渠道 URL 由 `newApiService.createChannel` 动态生成，不写死） |
| R6 | **New API 未部署时全链路不可用** | 中 | fail-soft 分层：newapi 适配器出局 → 回落到既有 0–17 链；`khy newapi status` 给出具体修复动作（规则 2.2 文案） |
| R7 | **超时语义违规**（治理层请求硬 kill） | 中 | 复用 `_retryWithBackoff` 既有空闲超时基建；禁止新增固定墙钟超时（规则 3 检查脚本会扫） |
| R8 | **设计文档草图与仓库范式不符**：`[DESIGN-CPA-003]` §4.2 的 newApiAdapter 是裸 fetch 草图 | 低 | 本文档 §1.1 已明确：适配器必须按 `relayApiAdapter` 范式（`_protocolPipeline` 等 8 基建）实现；落地时同步修订原设计文档变更记录 |
| R9 | **AI 网关优先级插入误伤既有路由** | 中 | 18/19 仅在 `detect()` 为真（端点已配置）时参与；插入点单测断言：未配置时 0–17 路由行为与插入前逐字节一致（characterization 测试） |

---

## 7. 待评审决策点

1. **CPA 部署形态**：docker（推荐，跨平台一致）vs 原生二进制（便携布局友好）——影响 `cpaService` 的进程管理分支
2. **New API 数据库**：SQLite（便携首选）vs MySQL/PG（生产）——影响 `newApiService` 初始化脚本
3. **newApiSync 方向**：单向 khy→NewAPI（推荐，SSoT 清晰）vs 双向（运营灵活但漂移风险）
4. **cpa/newapi 适配器默认策略**：`fill-first`（对齐 CPA 耗尽语义，推荐）vs `round-robin`

*变更记录：2026-09-11 v1.0 初稿（调研 + 四 Phase 方案；provider-hub 前置依赖已达成）*


**红线对照**：零硬编码（端点/端口全来自 `serviceDefaults` + env + 运行时文件）；状态透明（新 CLI 文案 = 动作+目标+进度）；空闲超时（适配器走 `_retryWithBackoff` 既有语义，不硬 kill）；写必走正门（New API 治理操作只经 REST，CPA 配置只经 cpaWriter 原子写）。
