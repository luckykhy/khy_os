<!-- 文档分类: OPS-MAN-172 | 阶段: 运维 | 原路径: docs/07_OPS_运维/[OPS-MAN-172] 自定义供应商接入指南.md -->
# 自定义供应商接入指南

> 把任意 OpenAI/Anthropic/Gemini 兼容的模型供应商接进 khy 网关（gateway）。本文覆盖**一键预设**与**手动编辑 `custom_providers.json`** 两条路径、`serviceType` 各值含义、字段说明、`khy gateway add` 命令用法、默认模型切换（`model_overrides.json`），以及各供应商 API Key 获取与 `env` 端点覆盖。
>
> 实现依据（核实来源）：
> - 一键预设单一真源：`services/backend/src/services/gateway/providerPresets.js`
> - 预设端点默认值：`services/backend/src/constants/serviceDefaults.js`
> - 注册逻辑与 11 种 `serviceType`：`services/backend/src/services/customProviderRegistrar.js`
> - 元数据落盘（`custom_providers.json` 字段）：`services/backend/src/services/customProviderRegistry.js`
> - CLI 入口：`services/backend/src/cli/handlers/gatewayProviderKeyPool.js`（`handleGatewayAdd`）
> - 默认模型覆盖：`services/backend/src/services/gateway/modelCuration.js`

---

## 一、两种接入方式一览

| 方式 | 适合谁 | 入口 | 是否需写 Key |
| --- | --- | --- | --- |
| 一键预设（preset） | 用主流供应商（OpenRouter/Groq/Together/Ollama/DeepSeek…） | `khy gateway add` / Web 网关卡片 | 需要（Ollama 例外） |
| 手动编辑 `custom_providers.json` | 私有/自建/未收录的 OpenAI 兼容端点 | 编辑 `.khy/custom_providers.json` | Key 走号池，端点写文件 |

> 预设只是**帮你填好表单**（公开的 base URL、协议、默认模型、Key 获取链接），Key 永远由你自己提供；`getProviderPresets()` 会主动剥除任何 `key`/`apiKey` 字段（零硬编码密钥）。

---

## 二、一键预设（新落地清单）

`providerPresets.js` 是内置常用供应商的单一真源。以下为本次新增/迁移的 5 个 OpenAI 线协议（`apiFormat: 'openai'`）预设，端点默认值取自 `serviceDefaults.js`，均可用 `env` 覆盖：

| 预设 id | 名称 | 分类 category | 默认端点（env 覆盖变量） | 默认模型 defaultModel | Key 示例 |
| --- | --- | --- | --- | --- | --- |
| `openrouter` | OpenRouter（聚合网关） | aggregator | `https://openrouter.ai/api/v1`（`KHY_OPENROUTER_BASE_URL`） | 无固定默认（按需选） | `sk-or-v1-…` |
| `groq` | Groq | official | `https://api.groq.com/openai/v1`（`KHY_GROQ_BASE_URL`） | `llama-3.3-70b-versatile` | `gsk_…` |
| `together` | Together AI | aggregator | `https://api.together.xyz/v1`（`KHY_TOGETHER_BASE_URL`） | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | — |
| `ollama` | 本地 Ollama | local | `http://localhost:11434/v1`（由 `OLLAMA_HOST` 派生；`KHY_OLLAMA_OPENAI_BASE_URL` 可覆盖整串） | `llama3.2` | `ollama`（占位，本地不校验） |
| `deepseek` | DeepSeek | official | `https://api.deepseek.com/v1`（`KHY_DEEPSEEK_BASE_URL`） | `deepseek-chat` | — |

说明：

- **端点单一真源**：以上默认 URL 只在 `serviceDefaults.js` 出现一次，`providerPresets.js` 从中 import；自建镜像/私有部署改这一处即可。
- **Ollama 是本地**：服务端会忽略它的 key，但表单仍需一个占位符（填 `ollama`）以通过校验；端点由 `OLLAMA_HOST`（默认 `http://localhost:11434`）派生出 `/v1` OpenAI 兼容线。
- **临时新增/覆盖预设**：设置 `env KHY_PROVIDER_PRESETS`（一个 JSON 数组），按 `id` 合并——覆盖内置端点或新增一个私有预设，无需改代码。示例：

  ```bash
  export KHY_PROVIDER_PRESETS='[{"id":"myrouter","label":"My Router","baseUrl":"https://router.example.com/v1","apiFormat":"openai","defaultModel":"gpt-4o-mini"}]'
  ```

> 除上述 5 个外，`providerPresets.js` 还内置 `openai`/`anthropic`/`gemini`/`vertex`/`agnes`/`moonshot`/`qwen`/`zhipu` 等；完整清单以源文件 `PROVIDER_PRESETS` 为准。

---

## 三、`khy gateway add` 用法

`khy gateway add` 快捷接入一个 OpenAI 兼容自定义 Provider（端点 + Key + 模型）。不带参数进入交互式；带参数为非交互式（脚本/CI 友好）。

```bash
khy gateway add \
  --name <display-name> \
  [--pool-key <id>] \
  --base-url <url> \
  --api-key <key> \
  --model-id <model> \
  [--extra-models a,b] \
  [--tier T0|T1|T2|T3] \
  [--test] \
  [--json]
```

参数说明（核实自 `_collectGatewayAddCliInput` / `_buildGatewayAddUsagePayload`）：

| 选项 | 含义 |
| --- | --- |
| `--name` | 显示名称（如 `Agnes AI`），必填 |
| `--pool-key` | 号池内部 id（小写字母/数字/连字符，字母或数字开头）；省略则由名称推导 |
| `--base-url` | 供应商 base URL（如 `https://api.deepseek.com/v1`），必填 |
| `--api-key` | API Key（支持一个或多个，`parseApiKeyEntries` 格式），必填 |
| `--model-id` | 默认模型 id，必填 |
| `--extra-models` | 追加模型 id，逗号分隔 |
| `--tier` | 可选能力档位 `T0`~`T3`；省略 = 自动分类（`modelTier` 正则） |
| `--test` | 添加后做一次连通性测试 |
| `--json` | 机读输出 |

执行后 `registerCustomProvider()` 会：① 把 Key 写入号池（`apiKeyPool`）；② 把 provider 元数据落盘到 `custom_providers.json`；③ 合并路由 `env`（`GATEWAY_API_POOL_SERVICE_MAP` / `GATEWAY_API_POOL_DEFAULT_MODEL_MAP` / `PROXY_MODEL_ROUTE_MAP`，同步写 `.env`）；④ 指定 `--tier` 时并入 `KHY_MODEL_TIER_MAP`。

> 内置 poolKey（`deepseek`/`qwen`/`glm`/`doubao`/`wenxin`）不能作为自定义名称。

---

## 四、手动编辑 `custom_providers.json`

对于未收录或私有的 OpenAI 兼容端点，可直接编辑 `.khy/custom_providers.json`（数组，每个元素是一个 provider）。字段说明（核实自 `customProviderRegistry.saveProvider`）：

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `name` | 是 | 显示名称 |
| `poolKey` | 是 | 号池内部 id（小写字母/数字/连字符）；不可与内置 poolKey 冲突 |
| `endpoint` | 是 | base URL（如 `https://api.example.com/v1`） |
| `serviceType` | 否 | 线协议服务，默认 `openai`；取值见第五节（11 种） |
| `defaultModel` | 否 | 默认模型 id |
| `models` | 否 | 该 provider 暴露的模型 id 数组 |
| `defaults` | 否 | 元数据默认 `{ contextWindow, maxOutputTokens }`，供动态 max_tokens 策略兜底 |
| `proxy` | 否 | 该 provider 专用出站代理（如 `http://127.0.0.1:7890`） |

最小可用示例（仓库现有 `Example Provider` 条目）：

```json
{
  "name": "Example Provider",
  "poolKey": "example-provider",
  "endpoint": "https://api.example.com/v1",
  "defaultModel": "example-chat",
  "serviceType": "openai",
  "models": ["example-chat"]
}
```

带元数据默认与代理的完整示例（对照现有 `Agnes` 条目）：

```json
{
  "name": "Agnes",
  "poolKey": "agnes",
  "endpoint": "https://apihub.agnes-ai.com/v1",
  "proxy": "http://127.0.0.1:7890",
  "defaultModel": "agnes-2.0-flash",
  "serviceType": "openai",
  "models": ["agnes-2.0-flash", "agnes-2.5-flash"],
  "defaults": { "contextWindow": 512000, "maxOutputTokens": 65536 }
}
```

> API Key 不写在本文件里——它走号池（`khy gateway add --api-key …` 或 `khy gateway key`）。本文件只存端点/模型等公开元数据。

---

## 五、`serviceType`：11 种取值与选择建议

`serviceType`（在注册器里对应 `service`，即号池键的线协议）决定网关按哪种 wire 协议调用该供应商。合法取值（核实自 `customProviderRegistrar.VALID_SERVICES`）：

```
openai · anthropic · zhipu · google · groq · openrouter · trae · xunfei · baidu · alibaba · huggingface
```

选择建议：

- **`openai`（默认，绝大多数情况）**：端点提供 `/v1/chat/completions` OpenAI 兼容线。OpenRouter/Together/Groq/Ollama/DeepSeek/Moonshot/千问兼容模式等都归这里。
- **`anthropic`**：端点提供 Anthropic 兼容 `/v1/messages` 线（如某些本地反代）。
- **`google`**：Gemini 原生线。
- **`zhipu` / `xunfei` / `baidu` / `alibaba` / `huggingface` / `trae`**：对应各家专有线；仅当端点确实是该家专有协议时才选。
- **`groq` / `openrouter`**：这两家本身走 OpenAI 兼容线，通常用 `openai` 即可；仅当需要走该服务的专门分支路由时才显式指定。

> 不确定就填 `openai`——本仓库现有自定义 provider 全部是 `openai`。

---

## 六、切换默认模型（`model_overrides.json`）

网关的 `api` 适配器默认模型持久化在 `<dataHome>/model_overrides.json`（默认 `.khy/`；`env KHY_MODEL_OVERRIDES_FILE` 可覆盖路径）。模型 id 形如 `api:<poolKey>:<model>`。

当前示例：

```json
{
  "api": {
    "defaultModel": "api:sensenova:deepseek-v4-flash"
  }
}
```

切换方式：

- **交互式**：`khy gateway model`（从可用模型列表里选），或按供应商切换。
- **手动**：编辑 `model_overrides.json` 的 `api.defaultModel`，改成目标 `api:<poolKey>:<model>`（例如 `api:agnes:agnes-2.0-flash`）。

> 该文件只存「用户意图的覆盖」，原始模型列表仍由各适配器实时产出；`applyOverrides` 把两者合并。

---

## 七、各供应商 API Key 获取与 `env` 端点覆盖

Key 获取入口（公开 console 链接，取自各预设 `links.console`）：

| 供应商 | 获取 Key | 端点覆盖 env |
| --- | --- | --- |
| OpenRouter | https://openrouter.ai/keys | `KHY_OPENROUTER_BASE_URL` |
| Groq | https://console.groq.com/keys | `KHY_GROQ_BASE_URL` |
| Together AI | https://api.together.ai/settings/api-keys | `KHY_TOGETHER_BASE_URL` |
| DeepSeek | https://platform.deepseek.com/api_keys | `KHY_DEEPSEEK_BASE_URL` |
| Ollama（本地） | 无需 Key（填占位 `ollama`） | `KHY_OLLAMA_OPENAI_BASE_URL`（或改 `OLLAMA_HOST`） |

端点覆盖示例（自建镜像 / 私有网关）：

```bash
export KHY_DEEPSEEK_BASE_URL="https://your-mirror.example.com/deepseek/v1"
export KHY_OLLAMA_OPENAI_BASE_URL="http://192.168.1.50:11434/v1"
```

---

## 八、常见问题

- **添加后模型选择器里看不到？** 确认 Key 已入号池、`models` 里含目标模型；用 `khy gateway add --test` 做连通性验证。
- **端点带尾斜杠？** 注册时会自动剥除 `endpoint` 末尾的 `/`。
- **想临时试一个新供应商但不落盘？** 用 `env KHY_PROVIDER_PRESETS` 注入一个预设，重启会话即可，无需改文件。

---

## 关联文档

- MCP 工具接入：`[OPS-MAN-173] MCP工具接入快速上手.md`
- 自定义 provider 案例（Agnes 全流程）：`[OPS-MAN-032] 网关-自定义provider配置-agnes.md`
- 多模型类型 Provider 配置对账：`[OPS-MAN-096] 多模型类型 Provider 配置对账.md`
- 账号池与多租户：`[OPS-MAN-045] 账号池与多租户-深度指南.md`
