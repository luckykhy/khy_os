# [DESIGN-ARCH-091] 密钥与端点中心管理（KeyManager）GUI 设计规范

> 状态：**提案**（待评审）· 2026-09-10（§8b GitHub 调研补充同日）
> 上位文档：`AGENTS.md`（工程红线）、`[DESIGN-ARCH-071] 通道选择决策矩阵`、`[DESIGN-ARCH-068] 仓库层级板块规范`
> 相关既有文档：`docs/opencode-provider-keys.md`（现有散落 key 清单，本规范的数据源之一）
> 外部调研源：`farion1231/cc-switch`（架构参考）、`avaritiachaos/qoder-proxy`（qodercli 激活模式）、opencode 官方 docs/providers、cc-switch-cli

---

## 1. 背景与问题

用户同时运行大量 Agent（Claude Code、OpenCode、Qoder CLI、Y-code、Codex、Command Code、Gemini CLI、DeepSeek TUI、Reasonix…），每个 Agent 的 API Key / 端点配置分散在：

- 各 Agent 自己的配置文件（`~/.claude/settings.json`、`~/.config/opencode/opencode.json`、`~/.codex/config.toml`+`auth.json`、`~/.ycode/config.json` …）
- 环境变量（`ANTHROPIC_API_KEY`、`AGNES_API_KEY`、`OPENROUTER_API_KEY` …）
- 各类 `.env` / `api_keys.json` / `custom_providers.json` / `cc_switch.json` / 数据库 ChannelApi 行

结果是「这个 Agent 配了、那个没配」，换端点要改 N 处。参考业界方案（direnv 按目录注 env、cc-switch 卡片切换、Infisical 中央面板、Vault 加密存储），本规范在 **khy-os 内建一个「密钥与端点中心」**：一处配置，全部 Agent 自动跟随。

## 2. 目标 / 非目标

**目标（P0）**
1. khyos-desktop（Electron）提供**独立 GUI 窗口** KeyManager：管理各 Provider 的 Key 池 + 端点（Base URL）。
2. 一处写入 `api_keys.json` 后，khy 自家网关/CLI（hot-reload watcher）与各外部 Agent（appWriters）无需手工重配。
3. 密钥默认脱敏展示；reveal 一次性 + 审计；日志/IPC 全程不落明文。

**非目标（本规范不做）**
- 不做多机同步/团队共享（Infisical/Vault 级），仅本机便携单用户。
- 不重写 `apiKeyPool` / `ccSwitch` 既有服务，只为其加 GUI 门面。
- 不管理 OAuth 令牌生命周期（已有 `oauthManager`，另行演进）。
- 不改动 Portable 侧 `bin/*.cmd` 启动器（作为集成说明给出，不属本仓库交付物）。

## 3. 现状资产盘点（复用，不另起炉灶）

| 资产 | 位置 | 角色 | 复用策略 |
|---|---|---|---|
| `apiKeyPool.js` + `api_keys.json` | `services/backend/src/services/`，`<dataHome>/api_keys.json` | Key 池（provider→[{key,endpoint,priority,label}]），round-robin/退避 | **数据 SSoT ①**，GUI 直接读写此格式 |
| `apiKeyPoolWatcher.js` | 同上 | fs.watch + 轮询热重载，跨进程收敛 | 直接依赖；GUI 写完文件即全系统收敛 |
| `ENV_KEY_MAP`（env 叠加层） | `apiKeyPool.js` 内 | `AGNES_API_KEY` 等 env 作为回退叠加 | GUI 只读展示 env 来源标记 |
| `customProviderRegistry.js` + `custom_providers.json` | 同上 | 自定义 provider 元数据（名/端点/默认模型） | **数据 SSoT ②** |
| `ccSwitch/store.js` + `cc_switch.json` | `services/backend/src/services/domain/config/ccSwitch/` | 卡片模型 `{id,name,baseUrl,keyId,protocol,models,apps[],active}`，**无凭据设计**（keyId→池） | **数据 SSoT ③**；「应用到 Agent」走卡片 |
| `ccSwitch/appWriters.js` + `externalApps/*Adapter` | 同上 | 8 个外部 app 的 live-config writer（preflight + fail-soft） | **应用通道**，GUI 编排调用 |
| `channelApiService.js` + `channelApiCrypto.js` | 同上 | DB 级加密 key（AES-256-GCM、KEK 轮转、一次性 reveal、审计） | 安全模式参考；Phase 3 复用 |
| `gatewayEnvFile.js` | 同上 | `.env` 补丁写入（`KHY_ENV_FILE` 可指） | 「应用到 env 型 Agent」通道 |
| `providerPresets.js` / `serviceDefaults.js` | 同上 | 公共端点目录（零硬编码真源） | 端点预设下拉框数据源 |
| `dataHome.js` | 同上 | 便携 dataHome 解析（`<root>/.khy`、`KHY_DATA_HOME`） | GUI 落盘位置遵循它 |
| `configGuard.js` | 同上 | JSON 原子写 + `.bak` 自愈 | GUI 写盘必须同语义 |
| 桌面壳 | `apps/khyos-desktop/` | Electron44+React19；`SettingsPage.tsx` 的 `providers` 组是空 stub；i18n 已有 `settings.modelProvider.*` 5070 条真源 | **GUI 宿主** |
| `proxyServer.js` + `protocolConverter` | `services/backend/src/services/gateway/` | **本地双协议反向代理**：`POST /v1/chat/completions`（OpenAI 线）+ `POST /v1/messages`（Anthropic 线）+ `GET /v1/models` 聚合 + 协议互转 + failover/熔断；鉴权走 `proxy_server_auth.json`（relay token），实际端口写 `proxy_server_runtime.json`（动态发现，零硬编码） | **Mode B 激活基建**（见 §8b） |
| `openclawAdapter` / `cozeAdapter` | `services/backend/src/services/domain/network/externalApps/` | openclaw（`~/.openclaw/openclaw.json` + `.env` 密钥旁路）、coze-studio（项目级 YAML 模板）**adapter 已存在但未入 ccSwitch APPS 表** | 二期接入矩阵 |
| `qoderProxyModels.js` + `ensureBuiltinQoder` | `services/backend/src/services/gateway/` | qodercli 采用 **qoder-proxy 模式**：本地反代同时暴露 OpenAI+Anthropic 线；khy opt-in（`KHY_QODER_PROXY`）时向池注册 `qoder` / `qoder-anthropic` 哨兵条目 | qodercli 激活走 proxy 模式 |
| `providerPresets.js` | 同上 | 15 个预设目录：openai/anthropic/gemini/vertex/deepseek/agnes/shengsuanyun/packycode/moonshot/qwen/zhipu/openrouter/groq/together/ollama（公共端点真源） | 预设下拉框数据源 |

> 结论：**不存在「缺后端」的问题，缺的是 GUI 门面与跨 Agent 应用编排**。本规范 90% 是接线，不是发明。

## 4. 总体架构

### 4.1 进程与模块布局（新增文件）

```
apps/khyos-desktop/
├── src/main/
│   ├── keyManager/
│   │   ├── keyStore.ts      # 纯逻辑：三 JSON 的 CRUD + 原子写 + .bak 自愈 + 脱敏
│   │   ├── endpoints.ts     # 端点预设目录（import providerPresets 逻辑的 TS 镜像，env 可覆盖）
│   │   ├── agentWriters.ts # 应用编排：resolve backend 服务 → ccSwitch/appWriters；不可解析时用内置最小 writer
│   │   ├── health.ts        # key 健康探测（1 次 GET /models，空闲超时，绝不硬 kill）
│   │   └── audit.ts       # key_manager_audit.jsonl 追加审计
│   └── keyManagerWindow.ts  # 独立 BrowserWindow（「单独 GUI 界面」）
├── src/preload/index.ts     # 扩展 __KHYOS__：keys:* / endpoints:* / agents:* / health:*
├── src/renderer/components/keyManager/
│   ├── KeyManagerPage.tsx   # 4 Tab 主界面
│   ├── ProviderKeyList.tsx  # 池 + env 叠加标记 + 脱敏 + reveal
│   ├── EndpointPresetForm.tsx
│   ├── AgentMatrix.tsx      # Agent × 卡片 应用矩阵
│   └── HealthAuditPanel.tsx
└── tests/
    ├── keyStore.test.mjs
    ├── agentWriters.test.mjs
    ├── health.test.mjs
    └── keyManagerContract.test.cjs
```

依赖方向：`renderer → preload(__KHYOS__) → main(keyManager/*) → 文件系统(三 JSON)`。
renderer 永不直接触碰 key 明文以外的文件系统；main 不依赖 renderer 状态。

### 4.2 数据层：不新增第四种存储

| 数据 | 文件 | 写者 |
|---|---|---|
| Key 池 | `<dataHome>/api_keys.json` | KeyManager（本 GUI）/ CLI / Vue Web / 手动 |
| 自定义 provider 元数据 | `<dataHome>/custom_providers.json` | KeyManager |
| 卡片（端点组合→Agent 应用） | `<dataHome>/cc_switch.json` | KeyManager |
| 审计 | `<dataHome>/key_manager_audit.jsonl`（唯一新增文件，追加只读） | KeyManager |

跨进程收敛链（写完即生效，无需重启任何一方）：

```
KeyManager 写 api_keys.json（原子写 + .bak）
   └→ apiKeyPoolWatcher（CLI/daemon 进程内）热重载 → khy 网关/CLI 立即用上
   └→ KeyManager 写 cc_switch.json（卡片 active）
        └→ agentWriters 改写目标 Agent 的 live config（正门写入，保留无关内容）
             → claude-code / opencode / codex / ycode / command-code / gemini / deepseek / reasonix 下次启动即生效
```

### 4.3 后端服务解析策略（便携安全）

`apps/khyos-desktop` 不在 pnpm workspace 内，打包态不能假设 `services/backend` 在相对位置。解析顺序（全部失败 → 降级「内置 writer 模式」，功能不减，只是不共享 adapter 代码）：

1. `KHY_BACKEND_SERVICES` env（显式指定 `services/backend/src/services` 绝对路径）
2. 便携根探测：`KHYQUANT_PORTABLE_ROOT` / `KHY_PORTABLE_ROOT` → `<root>\khy-os\services\backend\src\services`
3. 仓库内相对（开发态）：`<repoRoot>\services\backend\src\services`
4. 降级：`agentWriters.ts` 内置的最小 writer（claude-code / opencode / ycode / command-code 四个高频，JSON 原子写语义与 ccSwitch 完全一致）

解析结果与降级事件必须记入审计日志（Rule 2：动作+目标+进度）。

## 5. GUI 设计（独立窗口）

### 5.1 窗口

- 新建 `keyManagerWindow.ts`：`BrowserWindow` 1080×720（min 880×560），`frame:false`（与主窗一致），`contextIsolation:true`，同 preload。
- 三个入口：① 主窗菜单 `工具 → 密钥与端点管理`；② 设置页 `providers` 组（替换现 stub 的「设置项将在后续 Phase 完善」）；③ **独立启动** `npm run dev -- --key-manager`（只开此窗，不建主窗）；便携侧可加 `bin\khy-keymanager.cmd` 快捷方式。
- 加载视图 `index.html#/key-manager`；无登录态门槛（本机工具，登录门不适用于独立窗口）。

### 5.2 四个 Tab

**T1 Provider 与密钥**（数据 = api_keys.json + custom_providers.json + env 叠加）
- 左：provider 列表（内置目录 + custom）；右：该 provider 的 key 条目卡片。
- 每条显示：`label` / 端点 / `sk-…abcd`（脱敏：前 3 + 后 4，中间 sha256 前 8 hex 指纹）/ 优先级 / 状态（启用·停用·冷却中+原因）/ 来源标记（`pool` 或 `env:AGNES_API_KEY`）。
- 操作：新增 / 编辑 / 停用 / 删除 / 一次性 reveal（二次确认 + 审计）/ 设为默认优先级。
- 自定义 provider 保存时**自动拉取模型列表**（`GET /models`，§8b.2），成功填充模型下拉，失败不阻塞。
- 顶部「＋ 导入」：从 `docs/opencode-provider-keys.md` 一键导入（解析其 9 节 provider 表格，生成池条目；见 §9）。
- 只读区「网关聚合模型目录」：展示 khy 池当前可服务的全部模型 id（`proxyServer` `/v1/models` 聚合结果缓存）。

**T2 端点预设**（数据 = cc_switch.json 卡片）
- 卡片列表：名称 / 端点 / 协议（openai / anthropic / responses）/ 默认模型 / 绑定 keyId / 目标 apps[]。
- 新建卡片：端点下拉（内置预设目录，可自定义，预设值全部来自 `providerPresets` 等价数据，零硬编码）；key 从 T1 池选择（下拉，**不落卡片**——维持 cc_switch 无凭据设计）。
- 卡片端点可达性即时校验（GET，3s 短超时，I/O 例外合法）。

**T3 Agent 应用矩阵**（本规范核心：一处配置→全 Agent）
- 表：行 = Agent（§8 矩阵，含 Mode 开关列：直连/聚合），列 = 已应用卡片 / 协议兼容 / 最后应用时间 / 状态。
- 操作列：「应用到该 Agent」（调 agentWriters，preflight 失败给出中文原因，Rule 2.2 错误模板）、「撤销」恢复该 Agent 上一份 live config 备份（writer 写前存 `.pre-khy.bak`）。
- 应用结果状态文案示例：`已写入 opencode ~/.config/opencode/opencode.json（provider.supxh，模型 glm-5.3）`。
- 应用后附提示：「重启 Agent 生效（仅 claude-code 支持热切换）」（对齐 cc-switch 行为调研结论）。

**T4 健康与审计**
- 批量探测：逐条 key 发 1 次最小请求（`GET {endpoint}/models` 或 provider 约定路径，10s 短 I/O 超时合法例外）；状态：`200 可用 / 401 失效 / 429 限流 / 超时`。
- 审计流水（key_manager_audit.jsonl 只读展示，可导出）：reveal / apply / import / backend 降级事件，含时间戳 + keyId 指纹（**不含明文**）。

### 5.3 i18n 与品牌

- 新文案统一 `settings.keyManager.*` 命名空间（沿用已有 `settings.modelProvider.*` 真源中可复用条目），zh-CN 先行；过 `check-i18n-fidelity`。
- 品牌规则照旧（KhyOS 字样，不复用 ZCode 资产），过 `check-brand-replacement`。

## 6. IPC 契约（`namespace:action`，过 desktopUiContract D6）

| 通道 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `keys:list` | — | `{providers:[{id,keys:[{keyId,label,endpoint,priority,enabled,source,mask,fingerprint}],envOverlay:[{provider,envName}]}]}` | **永不含明文** |
| `keys:add` | `{provider,label?,endpoint?,key?,priority?}` | `{ok,keyId}` | key 可为空（纯端点卡片型 provider） |
| `keys:update` | `{keyId,patch}` | `{ok}` | 可改 endpoint/priority/label；改 key 需重传 |
| `keys:remove` / `keys:toggle` | `{keyId,enabled?}` | `{ok}` | 删除前级联检查卡片引用，有引用→`{ok:false,reason}` |
| `keys:reveal` | `{keyId}` | `{ok,key}` | 一次性；写审计；每 60s 同 key 限 1 次（冷却） |
| `endpoints:presets` | — | `{presets:[{provider,endpoint,protocol}],custom:[...]}` | 预设目录，全部来自 serviceDefaults 等价真源 |
| `endpoints:validate` | `{endpoint,protocol,timeoutMs?}` | `{ok,status?,latencyMs?,error?}` | 短 I/O 探测 |
| `agents:matrix` | — | `{rows:[{app,cards[],appliedCard?,compatible,protocol,lastApplied,writer:'ccswitch'\|'builtin'}]}` | 读各 app live config 探测当前指向 |
| `agents:apply` | `{app,cardId,mode:'direct'\|'proxy'}` | `{ok,app,detail?,error?}` | 失败给出 preflight/写入原因；`proxy` 模式写 relay 哨兵端点（§8b.3） |
| `agents:revert` | `{app}` | `{ok}` | 回滚 `.pre-khy.bak` |
| `proxy:status` | — | `{running,endpoint,relayFingerprint,models:[...]}` | proxy 未运行时 `running:false`，UI 显示「启动本地网关后重试」 |
| `health:probe` | `{keyId?|all:true}` | `{results:[{keyId,status,latencyMs}],[进度增量事件]}` | 长任务走事件流，空闲语义见 §7.4 |
| `health:audit:list` / `health:audit:export` | `{limit?,path?}` | `{entries}` / `{ok,path}` | 只读 / 导出 |

preload 扩展（`__KHYOS__` 命名风格一致）：`keysList, keysAdd, keysUpdate, keysRemove, keysToggle, keysReveal, endpointsPresets, endpointsValidate, agentsMatrix, agentsApply, agentsRevert, proxyStatus, healthProbe, healthAuditList, healthAuditExport` + 主进程事件 `onHealthProgress(fn)`。

错误契约（Rule 2.2 模板）：`{ok:false, error:'认证失败 (401)：密钥 <sk-…abcd> 已失效，请在 T1 更新或换用 env 叠加'}`。

## 7. 安全规范

1. **脱敏不变式（硬契约）**：除 `keys:reveal` 外，任何 IPC 序列化负载、日志行、审计行、状态文案中不得出现完整 key。`keyStore.ts` 导出 `maskKey()` 唯一脱敏函数，contract test 扫描所有 handler 返回值。
2. **文件权限**：写三 JSON 时 POSIX `chmod 600`（Windows 尽力而为，不阻塞）；`key_manager_audit.jsonl` 同权。
3. **原子写 + 自愈**：写流程 = 写 `.tmp` → 校验 JSON.parse → rename；写前把旧文件存 `.bak`；读失败自动从 `.bak` 恢复（对齐 `configGuard` 语义）。
4. **reveal 一次性 + 限流 + 审计**：冷却 60s/key；审计行含 keyId 指纹与来源进程（main only）。
5. **Agent 侧裸密钥策略**：ycode / command-code writer 维持「只写 env 引用，不写裸密钥」的既有约定（`appWriters.js` 注释约定）；claude-code / opencode / codex 按各自 adapter 既有行为。
6. **仓库红线**：`api_keys.json` / 审计 / `.env` 全部在 `.gitignore`（现有条目覆盖，新增 `key_manager_audit.jsonl` 需进 gitignore 与 `MANIFEST.in` 排除清单）；`docs/opencode-provider-keys.md` 当前含真实密钥——**违反「勿提交凭据」红线，处置见 §9**。
7. **Phase 3（可选加密静态存储）**：复用 `channelApiCrypto` AES-256-GCM 模式，KEK 取 `KHY_CHANNEL_KEY_SECRET`；不在 P0 范围。

### 7.4 超时与状态（Rule 2 / Rule 3 合规声明）

- 探测 10s 超时属「短 I/O 握手例外」（合法）；批量探测为逐条独立任务，**无整批硬 kill**；任何单条卡死不阻塞其余（并发上限 4）。
- 长任务状态文案一律 `步骤 n/m` + 目标名，例：`探测第 3/12 条：SupXH (speed44.toter.me/v1)…`。

## 8. Agent 应用矩阵（P0 覆盖）

| Agent | live config 目标 | 协议约束 | writer | 期 |
|---|---|---|---|---|
| claude-code | `~/.claude/settings.json` env 块 | anthropic（openai 经 khy 代理可转） | ccSwitch/claudeCodeAdapter | P1 |
| opencode | `~/.config/opencode/opencode.json` provider 树 | openai / anthropic | ccSwitch/opencodeAdapter | P1 |
| codex | `~/.codex/config.toml` + `auth.json` | openai / responses | ccSwitch/codexWriter | P1 |
| gemini | `~/.gemini/settings.json` | — | geminiCliAdapter | P2 |
| deepseek | `~/.deepseek/config.toml` | — | deepseekTuiAdapter | P2 |
| reasonix | `~/.reasonix/config.toml` + `.env` | — | reasonixAdapter | P2 |
| command-code | `~/.commandcode/providers.json` + config.json | openai/anthropic/responses | commandCodeAdapter（仅 env 引用） | P2 |
| ycode | `.ycode/config.json` | openai / responses | ycodeAdapter（仅 api_key_env 引用） | P2 |
| qodercli | 无 live config 直写：**qoder-proxy 模式**（`KHY_QODER_PROXY` opt-in + 端点指向 khy 代理） | openai/anthropic 双线 | `qoderProxyModels` + `ensureBuiltinQoder`（既有） | P1 |
| openclaw | `~/.openclaw/openclaw.json` + `.env` 密钥旁路 | openai | **已有 openclawAdapter，未入 APPS 表**（P3 接线） | P3 |
| coze | 项目级 `backend/conf/model/*.yaml` | openai | **已有 cozeAdapter**（需显式项目根，fail-soft） | P3 |
| grok-build / hermes / claude-desktop | 配置位未调研（cc-switch 支持，khy 无 adapter） | — | P3 扩展项 | P3 |

**便携注意**：各 writer 的目标路径尊重当前进程 env（`HOME` / `XDG_CONFIG_HOME` / `OPENCODE_CONFIG` 等）——Portable 环境下 opencode 真实配置在 `Tools/opencode/xdg/opencode/opencode.json`，由 `bin/opencode.cmd` 注入的 XDG env 决定；KeyManager 应用时应在「继承当前 env 的上下文」里解析目标路径，不自行拼 `~`（零硬编码红线）。矩阵页对每个 Agent 显示**它实际将写到的解析路径**，用户可见可核。

## 8b. GitHub 调研结论与「任意模型 + 一键激活」设计（2026-09-10 补充）

### 8b.1 参考项目结论

**cc-switch**（`farion1231/cc-switch`，~132k★，Rust+Tauri）是目前最接近本目标的开源实现，khy 的对应能力盘点：

| cc-switch 能力 | khy 现状 | 结论 |
|---|---|---|
| 8 工具统一管理（Claude Code/Desktop、Codex、Gemini CLI、Grok Build、OpenCode、OpenClaw、Hermes） | 8 个 APPS + 2 个未入表 adapter（openclaw/coze） | khy 覆盖面持平，缺 grok-build/hermes/claude-desktop writer（P3） |
| SQLite SSoT + 原子写 + 自动备份轮转（10 份） | 三 JSON SSoT + configGuard 原子写/.bak 自愈 | 等价，JSON 更易便携 |
| **本地代理热切换**（协议转换 + 自动 failover + 熔断 + 健康监控） | **`proxyServer.js` 已具备全部**（protocolConverter + keySelector failover + 401/429 退避） | **khy 反超**：代理是常驻网关而非 GUI 内置 |
| 50+ 预设一键导入 | 15 预设 + 自定义 + `/models` 聚合 | 预设目录按 §8b.2 扩充 |
| 切换需重启 CLI（仅 Claude Code 热切换） | 同（writer 语义一致） | GUI 状态文案必须提示「重启 Agent 生效」 |
| MCP/Skills/Prompts 统一 | khy 有 agentfs/MCP（`.khy/mcp.json`），KeyManager 不越界 | 非本规范范围 |

### 8b.2 「方便配置任何模型」— 模型可得性设计

khy 要能配置**任何模型**，三条腿：

1. **预设目录**（15 个，`providerPresets.js`）：覆盖国内主流（deepseek/qwen/zhipu/agnes/moonshot）+ 国际（openai/anthropic/gemini/vertex/openrouter/groq/together）+ 本地（ollama）。预设端点零硬编码（真源在 `serviceDefaults.js`/`providerPresets.js`，env 可覆盖）。
2. **自定义 provider**（任意端点+任意模型，`custom_providers.json`）：
   - 端点 + 协议（openai/anthropic/responses/gemini）+ key 必填
   - **模型列表自动拉取**：保存时对 `GET {endpoint}/models`（OpenAI 线）或 `/v1/models`（Anthropic 线）做 1 次探测（10s 短 I/O 超时，合法例外），成功则填充模型下拉；失败则允许手工填模型 id 列表，不阻塞保存。
   - 本地模型场景（Ollama/LM Studio/llama.cpp/khy 自家网关）自动命中：它们都暴露 `/v1/models`。
3. **khy 网关聚合**（`proxyServer` 的 `GET /v1/models` 聚合 13 类 adapter：kiro/cursor/claude/codex/trae/warp/windsurf/vscode/localLLM/ollama/cursor2api/relay_api/api）：T1 新增只读视图「网关聚合模型目录」，展示 khy 当前池能服务的全部模型 id——这是「khy 配好模型」的事实呈现层。

**「任何模型」的落地语义**：只要某端点讲四种协议之一（openai/anthropic/responses/gemini）并能用 key 鉴权，khy 就能管它、给它切 key、把它路由给任何 Agent。非协议模型（如 Bedrock 凭证链、GitLab OAuth）标记「仅 khy 网关直用，不进入 Agent 矩阵」。

### 8b.3 「Khy 配好模型 → 其余 Agent 点击激活即用」— 双激活模式

T3 Agent 矩阵页每行一个 **模式开关**，两种模式：

**Mode B：khy 聚合（推荐默认，「一键激活」的核心）**

所有 Agent 只指向 **khy 本地代理**（一个端点 + 一个 relay token，来自 `proxy_server_auth.json`；端口从 `proxy_server_runtime.json` 动态读，零硬编码）：

| Agent | 激活写入内容（Mode B） |
|---|---|
| claude-code | `settings.json` env：`ANTHROPIC_BASE_URL=<proxy>（anthropic 线）` + `ANTHROPIC_AUTH_TOKEN=<relay>` |
| opencode | 自定义 provider `khy`：`npm: "@ai-sdk/openai-compatible"` + `baseURL: <proxy>/v1` + `apiKey: <relay>`（opencode 文档确认：任意 OpenAI 兼容端点只需此三字段） |
| codex | `config.toml [model_providers.khy]`：`base_url=<proxy>/v1`（**需先验证 proxy 对 responses 线的支持，见 §12-Q5**）+ `auth.json` relay token |
| gemini / deepseek / reasonix | 各自 env/端点字段指向 proxy（协议不兼容者由 proxy `protocolConverter` 转线） |
| command-code / ycode | env 引用型：`KHY_RELAY_ENDPOINT` / `KHY_RELAY_TOKEN` 变量，不落裸密钥 |
| qodercli | **proxy 模式天然激活**：`KHY_QODER_PROXY` opt-in 后 khy 池出现 `qoder` 哨兵条目，qoder CLI 端点指向 khy 代理（`qoderProxyModels.js` 既有机制，GUI 只做开关+端点回填） |

激活后：**换模型/换 key/换端点 = 纯 khy 侧操作**（T1 池或 T2 卡片），所有 Agent 零改动——这就是用户要的「配一次，点击激活，以后不用再配」。

**Mode A：直连（低延迟/代理不可用场景）**

现有 `ccSwitch/appWriters.js` 行为：Agent 配置直接指向 provider 端点+真实 key。代价是换模型/换 key 需要重新点一次「激活」。

**安全边界**：Mode B 写入 Agent 配置的唯一凭据是 **本地 relay token**（127.0.0.1 代理鉴权，非外网凭据）——真实 provider key 永不出 khy 池，比 cc-switch 直连模式更收敛。contract test 需断言 Mode B 产物中不含真实 key 明文（只允许 relay 哨兵值）。

**状态文案（Rule 2/2.2）**：
- 激活成功：`已激活 opencode → khy 聚合 (proxy:31288/v1, 模型 glm-5.3)` + 提示「重启 opencode 生效（仅 claude-code 支持热切换）」
- 激活失败：`激活失败 codex：responses 线未就绪 (E501)，请改用 Mode A 直连`
- proxy 未启动：`khy 代理未运行：启动本地网关后重试（动作: 启动 proxy 目标: 127.0.0.1）`

## 9. 数据导入与散落 key 收编

1. **导入源**：`docs/opencode-provider-keys.md`（9 个 provider，含 SupXH/CommandCode/GLM/OpenCodeGo/StepFun/SenseNova/Agnes/Zen/OpenRouter）+ 现有 `api_keys.json` + env 扫描（`ENV_KEY_MAP` 已知变量）。
2. **导入行为**：生成池条目（endpoint+key+label，key 冲突按指纹去重）；`public`/`<your-...>` 占位值拒收并提示。
3. **安全处置**：该 md 内真实密钥属仓库红线违例。导入完成后：文件中的真实 key 替换为 `<已收编至 khy keypool>`，文件本身移至 `3-assets/knowledge-base/`（或就地标注「仅本地」并确认 git 历史清理不在本轮范围）。导入向导在 T1 内提供该一键流程。

## 10. 测试规范（先计划后实现）

### 10.1 单元（`apps/khyos-desktop/tests/`，node:test，与现有 `desktopUiContract.test.cjs` 同风格）

| 文件 | 用例 |
|---|---|
| `keyStore.test.mjs` | ① 正常读 `api_keys.json`→脱敏列表无明文；② addKey 原子写（.tmp→rename）且生成 .bak；③ 注入损坏 JSON→.bak 自愈并告警事件；④ env 叠加：设 `AGNES_API_KEY` 后 list 出现 env 来源条目且**不写文件**；⑤ removeKey 被卡片引用时拒绝；⑥ toggle/优先级语义；⑦ 写盘后权限位 600（POSIX 断言，Win 跳过） |
| `agentWriters.test.mjs` | ⑧ tmp HOME 下 claude-code writer：settings.json env 块正确 + 无关字段保留；⑨ opencode writer：provider 树 merge 正确；⑩ ycode/command-code 产物中**不含裸 key 明文**（grep 断言）；⑪ preflight 协议不匹配→`{success:false,reason}` 且不落盘；⑫ backend 不可解析→内置 writer 接管且审计记录降级；**⑲ Mode B 激活产物断言：opencode 自定义 provider `khy` 三字段（npm/baseURL=proxy/v1/apiKey=relay 哨兵值）+ 所有 Agent 产物中不含真实 provider key 明文** |
| `health.test.mjs` | ⑬ mock fetch：200/401/429/超时四分类；⑭ 并发上限 4 条；⑮ 单条卡死不阻塞批次（空闲语义，无整批 kill）；**⑳ 模型自动拉取：`GET /models` 成功→下拉填充 / 404→允许手工填模型 id 不阻塞保存 / 端点拒答（401）→标「未验证」但可保存** |
| `keyManagerContract.test.cjs` | ⑯ 所有 `keys:*/endpoints:*/agents:*/health:*` handler 已注册且与 preload 方法一一对应；⑰ 序列化扫描：除 reveal 外任何返回值不含传入的测试 key 明文（脱敏不变式）；⑱ 新文件过 `check-agent-rules`（零硬编码/状态文案）；**㉑ qoder 门控：未设 `KHY_QODER_PROXY` 时池无 `qoder`/`qoder-anthropic` 死条目；设了则注册且端点从 runtime 文件解析（不硬编码 3000）** |

### 10.2 回归（共享格式不破后端）

- `npm test --prefix services/backend`（jest + node:test；重点 `tests/apiKeyPoolHotReload.test.js`、`tests/keySelector.test.js`、`tests/customProviderRegistrar.test.js`、ccSwitch 相关）必须全绿——GUI 写的文件后端要能读。

### 10.3 跨进程 e2e（脚本化手工矩阵，纳入 P1 验收）

| # | 步骤 | 通过判据 |
|---|---|---|
| E1 | GUI `keys:add`(agnes) → 另开进程 `khy gateway` key 列表 | 5s 内热重载可见（watcher） |
| E2 | GUI `agents:apply` opencode（便携 XDG 环境）→ `opencode run "ping"` | 使用新 key 成功，配置落在 `Tools/opencode/xdg/...` |
| E3 | `agents:apply` claude-code → `claude -p "ping"` | 成功且 settings.json 无关字段完好 |
| E4 | `agents:revert` → 对照 `.pre-khy.bak` | 恢复逐字节一致 |
| E5 | 并发：GUI 写 + CLI 同写 api_keys.json | 原子写无交叉损坏；损坏时 .bak 自愈（与 ③ 互验） |
| E6 | reveal 限流：60s 内二次 reveal | 被拒且审计记一条 `reveal-rejected` |
| E7 | **Mode B 一键闭环**：GUI 激活 opencode+claude-code（指向 proxy）→ 两 Agent 冒烟成功 → GUI 只换卡片模型（不动 Agent 配置）→ 重跑 `opencode run` 命中新模型 | 全程 Agent 配置零 diff（`git diff` 式比对 live config），只 khy 侧数据变化 |
| E8 | qodercli 激活：`KHY_QODER_PROXY=true` + proxy 端点 → `khy gateway status` 可见 `qoder` 池条目 → qodercli 会话命中 khy 模型 | 死条目不出现（opt-in 门控） |

### 10.4 覆盖率门槛

`keyStore.ts` / `agentWriters.ts` / `health.ts` 行覆盖 ≥ 80%；contract test ⑯⑰ 为 P0 交付的 CI 硬门。

## 11. 分期交付

| 期 | 内容 | 出口准则 |
|---|---|---|
| P1（本轮） | T1+T2（池/卡片 CRUD、脱敏、审计、端点预设、**模型自动拉取**、backend 解析+内置 writer 降级）、独立窗口+三入口、**Mode B 一键激活（claude-code/opencode/qodercli 三高频）**、全部单元/contract 测试 | §10.1+§10.2 全绿；E1/E5/E7/E8 通过 |
| P2 | T3 完整应用矩阵（Mode A 直连 8 agent writers + revert）、T4 健康探测与审计面板、导入向导（§9）、E2–E4 | e2e 矩阵全过 |
| P3 | openclaw/coze 接线进 APPS 表、grok-build/hermes/claude-desktop writer 调研+实现、静态加密存储（§7.7）、预设目录扩充（对齐 opencode 75+ provider 目录） | — |

> **P1 重心说明**：用户核心诉求是「khy 配好模型，其余 Agent 点击激活即用」——**Mode B（khy 聚合）是 P1 交付主线**，Mode A（直连）完整矩阵放 P2。理由：Mode B 一次写入后 Agent 侧永久免维护，且凭据最收敛（只落 relay 哨兵）。

## 12. 开放问题（实现前需拍板）

1. ~~qodercli 配置位~~ **已解**：走 qoder-proxy 模式（`KHY_QODER_PROXY` opt-in + 端点指向 khy 代理，`qoderProxyModels.js` 既有机制），GUI 提供开关与端点回填。
2. **打包分发**：electron-builder 是否把 `services/backend/src/services`（仅 keyStore 依赖的 dataHome/configGuard 部分）打进 extraResources？倾向 P1 不打包（走 env 解析 + 内置 writer 降级），P3 再定。
3. `agents:matrix` 探测「各 app 当前指向」需要读 8 个异构 live config（json/toml/env）——P2 先做写后记录（store 记 lastApplied），不做全量逆向探测。
4. 独立窗口是否需要与主窗会话共用登录态：本规范按「本机工具免登录」处理，若产品侧要求统一门则加 `app:auth` 校验（一行，不影响数据层）。
5. **Q5（P1 阻塞项）**：`proxyServer` 现有端点 `/v1/chat/completions` + `/v1/messages`，**codex 需要的 `/v1/responses`（openai_responses 线）是否已支持需实测 `protocolConverter`**；不支持则 codex 在 Mode B 下降为「responses 未就绪 (E501)」文案 + 自动建议 Mode A。
6. **grok-build / hermes-agent / claude-desktop 配置位**（P3 扩展项）：cc-switch 均支持，khy 无 adapter；实现前各做一轮实测调研（仿 `qoderProxyModels` 的叶模块写法）。

## 13. 红线自查清单（交付时逐项打勾）

- [ ] 零硬编码：新文件无字面量端点/端口/绝对路径（预设全部来自 serviceDefaults 等价真源或 env）
- [ ] 状态文案：动作+目标+进度；错误走 Rule 2.2 模板
- [ ] 超时：无整批硬 kill，单条 I/O 短超时走合法例外
- [ ] 脱敏不变式：contract test ⑰ 常开
- [ ] Mode B 激活产物断言：contract test ⑲（Agent 配置只落 relay 哨兵端点+token，真实 provider key 不出 khy 池）
- [ ] `proxy:status` / 端点解析：端口一律读 `proxy_server_runtime.json`，不出现硬编码 3000/127.0.0.1 字面量（qoder 门控 ㉑ 覆盖）
- [ ] gitignore/MANIFEST：`key_manager_audit.jsonl` 排除
- [ ] `check-agent-rules.js --changed` / `check-i18n-fidelity.js` / `check-brand-replacement.js` 全绿
- [ ] 回归：`services/backend` 测试全绿（共享 JSON 格式未破）
