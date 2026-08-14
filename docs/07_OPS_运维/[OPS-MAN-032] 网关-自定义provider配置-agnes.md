<!-- 文档分类: OPS-MAN-032 | 阶段: 运维 | 原路径: docs/指南/网关-自定义provider配置-agnes.md -->
# 网关 · 自定义 Provider 配置（以 Agnes 为例）

> 适用版本：2026-06-08 起。本文记录如何在 **Web 前端 / khy TUI / 命令行** 三种入口，
> 一站式接入 Agnes（及任意 OpenAI 兼容自定义 Provider）。

## 0. 这是什么

KHY 网关支持把任意「OpenAI-Compatible」服务作为一个**自定义 Provider** 接入密钥池
（`apiAdapter` + `apiKeyPool` + `customProviderRegistry` 路径）。接入后：

- 模型以 `api:<poolKey>:<model>` 形式自动出现在 `/v1/models`，无需静态注册；
- 可与其它 Provider（deepseek/qwen/relay…）并存，支持多模型；
- 三个入口（Web / TUI / CLI）共用**同一套注册逻辑**，行为一致、互通。

注册核心是单一真源 `services/backend/src/services/customProviderRegistrar.js`；
env 读写集中在 `services/backend/src/services/gatewayEnvFile.js`。CLI 与后端实时 API 都复用它们。

### Agnes 连接参数

| 项 | 值 |
| --- | --- |
| Base URL | `https://apihub.agnes-ai.com/v1` |
| 默认模型 | `agnes-2.0-flash` |
| 鉴权 | API Key（标准 OpenAI `Authorization: Bearer`） |
| 协议 | OpenAI Chat Completions 兼容 |

Agnes 已作为**内置预设**提供，三个入口选「Agnes」即自动 prefill base URL / 模型 / 显示名，
只需补 API Key。

---

## 1. Web 前端（AIGateway 页面）

最直观，推荐日常使用。

1. 启动后端与 `apps/ai-frontend`，登录后进入 **AI 网关（AIGateway）** 页。
2. 在「**API 密钥池**」卡片头部点击「**添加自定义 Provider**」（绿色按钮，与「添加 Key」并列）。
3. 弹窗中：
   - **预设**下拉选「**Agnes AI**」→ 自动填好显示名 / Provider ID / Base URL / 默认模型；
     选「手动填写」则逐项自填，可接入任意 OpenAI 兼容服务。
   - 填入 **API Key**（支持一行一个/逗号分隔的多 key，进池轮询）。
   - 可选「其他模型」「能力档位（tier）」——见 [§4 tier 覆盖](#4-逐模型能力档位-tier-覆盖)。
4. 提交后，卡片下方「已注册自定义 Provider」列表出现该条目；右侧「删除」可移除
   （默认保留池中 key，勾选连带删除才清 key）。

底层 REST 接口（真正入口 `aiManagementServer.js handleAiGatewayNamespace`）：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/ai-gateway/custom-providers` | 返回 `{ providers, presets }` |
| `POST` | `/api/ai-gateway/custom-providers` | 注册（body 同 CLI 字段） |
| `DELETE` | `/api/ai-gateway/custom-providers/:poolKey` | 删除；`?removeKeys=true` 连带删 key |

> 响应**绝不回显原始 API Key**，仅返回脱敏元数据。

---

## 2. khy TUI（终端图形界面）

TUI 内有两类网关命令：

- `/gateway model` → 原生 **ModelPicker** 覆盖层，切换当前模型；
- `/gateway config` → 原生 **API Key 配置** 覆盖层（`runApiKeyConfig`），改 key / endpoint。

**注册新的自定义 Provider** 走 `gateway add`：在 TUI 输入框输入 `gateway add` 即可。
该命令未被 TUI 拦截为原生覆盖层，会**让出全屏**进入交互式问答（inquirer）流程——
与 CLI 的 `khy gateway add` 完全一致（含 Agnes 预设、tier 追问、连接测试），
完成后自动回到 TUI。期间顶栏临时挂起，结束即恢复。

> 提示：若偏好图形化表单，直接用 Web 前端（§1）体验更顺滑；TUI 的 `gateway add`
> 适合纯终端环境下不离开会话即可完成接入。

---

## 3. 命令行（CLI）

```bash
khy gateway add
# 别名同样可用： khy wg add / khy 网关 add
```

交互流程：

1. **选择预设**：`Agnes AI` / `手动填写`。选 Agnes 自动 prefill 显示名 / Provider ID（`agnes`）/
   Base URL / 默认模型，仅追问 API Key 与可选 tier。
2. 输入 **API Key**（可多 key）。
3. 可选 **能力档位（tier）**：自动 / T0 / T1 / T2 / T3。
4. 注册完成后做一次**连接测试**（用首个 key 探活），成功即落盘。

完成后验证：

```bash
khy gateway status          # 看到 agnes Provider 与其模型
curl http://<gateway>/v1/models | grep agnes   # 出现 api:agnes:agnes-2.0-flash
```

相关命令：

- `khy gateway config` / `khy apikey` / `khy 密钥配置` → 改已有池的 key/endpoint。
- `khy gateway model` → 切模型。

---

## 4. 逐模型能力档位（tier）覆盖

KHY 按模型能力分档（T0 前沿 / T1 强 / T2 默认 / T3 弱）套不同脚手架。
`agnes-2.0-flash` 名字含 `flash`，会被默认正则误判为 **T3（弱）**。若实际更强，可显式声明：

- **入口**：上面三处「tier」字段任选其一（Web 下拉 / TUI/CLI 追问）；
- **底层**：写入环境映射 `KHY_MODEL_TIER_MAP`，形如
  `{"agnes-2.0-flash":"T1"}`（JSON，大小写不敏感精确匹配）。
- **优先级**：全局 `KHY_CAPABILITY_TIER` > `KHY_MODEL_TIER_MAP` > 正则自动判定。
  不声明时维持自动（`flash` → T3）。

也可直接手改 `.env`，无需重注册——`KHY_MODEL_TIER_MAP` 即时生效。

---

## 5. 写入的环境变量

注册成功后，下列变量被合并写入 `.env`（规范文件 `services/backend/.env`，
并镜像到 `services/.env`，除非 `KHY_ENV_SYNC_ROOT=false`）：

| 变量 | 作用 | 示例片段 |
| --- | --- | --- |
| `GATEWAY_API_POOL_SERVICE_MAP` | poolKey → 适配器类型 | `{"agnes":"openai"}` |
| `GATEWAY_API_POOL_DEFAULT_MODEL_MAP` | poolKey → 默认模型 | `{"agnes":"agnes-2.0-flash"}` |
| `PROXY_MODEL_ROUTE_MAP` | 模型 → 路由目标 | `{"agnes-2.0-flash":{"target":"api:agnes:agnes-2.0-flash","strict":true}}` |
| `KHY_MODEL_TIER_MAP` | 模型 → 能力档位（仅声明 tier 时） | `{"agnes-2.0-flash":"T1"}` |

Provider 元数据（显示名 / endpoint / 默认模型 / 可选 tier）另存于
`~/.khyquant/custom_providers.json`（`customProviderRegistry`）。

> 覆盖锚点可用 `KHY_ENV_FILE` 改写规范 .env 路径，`KHY_ENV_SYNC_ROOT=false` 关闭根镜像。

---

## 5.5 不止 Agnes：内置预设目录与自定义覆盖（API-Key 模式通用机制）

Agnes 只是**内置预设目录**里的一条。本文的所有步骤对任意 OpenAI 兼容服务都通用——这正是网关「四类配置模式」中的**模式 ③（API-Key 直连）**（四类总览见 [OPS-MAN-003] §8）。

预设的来源是两层单一真源：

- **内置 provider 目录** `services/backend/src/services/builtinProviderConfig.js`（`BUILTIN_PROVIDERS`，`:33-43`）——决定哪些 provider 默认可被网关识别。
- **预设清单** `services/backend/src/services/providerPresets.js`（`:49-62`）——为每个预设提供 prefill 字段。Agnes 即其中一条（`:55`，`id:'agnes'` / `baseUrl: https://apihub.agnes-ai.com/v1` / `apiFormat:'openai'`），同目录还内置了 moonshot、zhipu 等常见服务。选预设时这些字段被自动填好，你只需补 API Key。

**自定义/覆盖预设**：用环境变量 `KHY_PROVIDER_PRESETS` 注入或覆盖预设（JSON），无需改源码即可让 `khy gateway add` 的预设下拉出现你自己的服务：

```bash
# 追加一个自定义预设（按目标服务的 id / baseUrl / 默认模型填）
export KHY_PROVIDER_PRESETS='[{"id":"myllm","displayName":"My LLM","baseUrl":"https://api.example.com/v1","defaultModel":"my-model-1","apiFormat":"openai"}]'
khy gateway add     # 预设下拉里就会多出 "My LLM"
```

> 即使不写预设也能接入：`khy gateway add` 选「手动填写」，逐项填 Base URL / 模型 ID / API Key 即可。预设只是把常用服务的字段提前填好，省去手填。

落键流程统一走 `khy gateway config`（改已有池的 key/endpoint）与 `khy gateway add`（新接入），三入口（Web / TUI / CLI）共用同一套注册逻辑（`customProviderRegistrar.js`）。

---

## 5.6 中转站 / relay 一分钟接入（同一机制，换个叫法）

很多人把「不是官方直连、而是**代理转发官方模型**的 OpenAI 兼容服务」叫**中转站**（relay / 代理站 / API 中转）。
在 KHY 网关里，**中转站不是一种新东西**——它就是本文一路讲的**自定义 Provider（模式 ③ API-Key 直连）**：
你从中转站拿到的永远是「一个 Base URL + 一个 API Key + 若干模型名」，接入路径与上面接 Agnes **完全一致**。

**最短接入（任选一入口）**：

```bash
# CLI：一条命令进入交互接入向导
khy gateway add
#   预设下拉选「手动填写」
#   Base URL   ← 中转站给你的地址（形如 https://xxx.example.com/v1，务必带 /v1）
#   模型 ID    ← 中转站文档里列出的模型名（如 gpt-4o / claude-3-5-sonnet）
#   API Key    ← 中转站分配的 key（支持一行一个 / 逗号分隔多 key 进池轮询）
```

Web 入口：AIGateway 页 →「API 密钥池」卡片 →「添加自定义 Provider」→ 预设选「手动填写」，同样三项。
接入后模型以 `api:<poolKey>:<model>` 出现在 `/v1/models`，与官方直连模型并存、可混用。

**常配错的三个点（照着自查）**：

| 症状 | 多半原因 | 处理 |
| --- | --- | --- |
| 401 / 鉴权失败 | Key 填错，或中转站要求非标准鉴权头 | 确认 Key；标准中转站走 `Authorization: Bearer`，本文机制默认即此 |
| 404 / 路径不对 | Base URL 漏了 `/v1`，或把网页地址当成了 API 地址 | Base URL 以 `/v1` 结尾；用中转站**文档里的 API 地址**，不是它的官网 |
| 模型名对不上 | 中转站的模型命名与官方不一致（如加了前缀） | 用中转站文档里**原样**的模型名，别自己猜 |

> **内置 `relay` 与你接的中转站是两回事**：`relay/gpt-4o` 里的 `relay` 是一个**内置预设 poolKey 名**（见 [OPS-MAN-012] §模型清单），
> 指某个已内置配置的转发通道；而你自己接的中转站是**新建**一个自定义 Provider，poolKey 由你命名。二者互不影响，可并存。

> **安全提醒**：中转站会看到你的全部请求内容。只接**你信任的**中转站；Key 通过上述向导写入本机 `.env`（见 §5），
> **绝不要**把含 Key 的 `.env` 提交进 git（仓库 `.gitignore` 已默认忽略 `.env`，但自建目录时请自行确认）。

---

## 6. 排错

- **模型没出现在 `/v1/models`**：确认 `PROXY_MODEL_ROUTE_MAP` 已含该模型，且后端已重载
  （注册会同步写 `process.env`，但已运行的进程需重启或触发刷新）。
- **被当作弱模型套了重脚手架**：见 §4，声明 tier。
- **删了仍能调用**：删除默认保留池中 key；需 `?removeKeys=true`（Web 勾选「连带删除 key」）。
- **接入非 Agnes 服务**：预设选「手动填写」，按目标服务的 Base URL / 模型 ID 填即可，路径通用。
