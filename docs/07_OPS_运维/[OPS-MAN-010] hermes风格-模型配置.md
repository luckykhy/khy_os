<!-- 文档分类: OPS-MAN-010 | 阶段: 运维 | 原路径: docs/指南/hermes风格-模型配置.md -->
# KHY 中的 Hermes 风格模型配置

本指南将 Hermes 风格的模型配置映射到 KHY CLI。

## 方式一：命令行配置（推荐）

```bash
khy config set model.provider custom
khy config set model.base_url https://your-provider.com/v1
khy config set model.api_key "sk-xxxxx"
khy config set model.name your-model-id
khy config set model.default custom/your-model-id
```

快速检查：

```bash
khy config get model.default
khy config list
```

## 方式二：交互式向导

```bash
khy setup   # full initialization wizard
# or
khy model   # model/provider selection only
```

对于 OpenAI 兼容的自定义服务商，填写：

- Base URL：`https://your-provider.com/v1`
- API Key：你的密钥
- 模型名称：`your-model-id`

## 方式三：前端管理界面（AI Gateway 标签页）

对于管理员用户，KHY 现已支持可视化配置流程，位于：

- `Admin Dashboard -> AI Gateway -> 模型与 API Key 配置`

该界面设计为兼容 Hermes/OpenClaw/OpenCode 风格的输入。

步骤：

1. 选择一个预设配置（`Hermes`、`OpenClaw`、`OpenCode` 或 `Custom`）。
2. 填写 `Base URL` 和 `Model ID`（模型是动态的，并不固定为单一值）。
3. 可选地以灵活格式粘贴 API key（`sk-xxx`、`Bearer sk-xxx`、`key=...`、多行、JSON 数组/对象）。
4. 选择兼容性（`openai`、`anthropic`、`unknown`）。
5. 点击保存。

行为细节：

- 如果 Base URL 缺少 `/v1`，KHY 会自动规范化并显示保存提示。
- 如果 `Clear Key` 处于关闭状态且 API key 输入为空，则保留现有密钥不变。
- 如果 `Clear Key` 处于开启状态，KHY 会移除 `RELAY_API_KEY` 和 `RELAY_API_KEYS`。

## 键映射（Hermes 风格 -> KHY 环境变量）

| Input key | Written env vars |
|---|---|
| `model.provider=custom` | `GATEWAY_PREFERRED_ADAPTER=relay_api`, `GATEWAY_PREFERRED_STRICT=true` |
| `model.base_url=...` | `RELAY_API_ENDPOINT=...` (+ prefers `relay_api`) |
| `model.api_key=...` | `RELAY_API_KEY=...` (+ prefers `relay_api`) |
| `model.name=...` | `RELAY_API_MODEL=...` (+ prefers `relay_api`) |
| `model.default=custom/<model>` | `GATEWAY_PREFERRED_ADAPTER=relay_api`, `GATEWAY_PREFERRED_MODEL=<model>`, `GATEWAY_PREFERRED_STRICT=true`, `RELAY_API_MODEL=<model>` |

## 为什么 `model.default` 很重要

`model.default` 会同时固定适配器和模型路由（`provider/model`），以实现确定性路由。
若不设置它，运行时仍可能通过适配器默认值工作，但模型选择会不够明确。

## API Key 格式兼容性

`khy config set model.api_key ...` 支持多格式输入（与网关/密钥池所用的解析器相同）：

- 单个密钥：`sk-xxx`
- 多个密钥（逗号/分号/换行分隔）：`sk-a,sk-b`
- Bearer 风格：`Bearer sk-xxx`
- KV 风格：`key=sk-xxx` 或 `token: sk-xxx`
- JSON 数组/对象形式

当提供多个密钥时：

- 主密钥 -> `RELAY_API_KEY`
- 完整列表 -> `RELAY_API_KEYS`（逗号拼接）

## OpenClaw 兼容配置

KHY 还支持 OpenClaw 风格的非交互式自定义服务商配置：

```bash
khy config openclaw \
  --custom-base-url "https://your-provider.com/v1" \
  --custom-model-id "<your-model-id>" \
  --custom-api-key "sk-xxxxx" \
  --custom-compatibility openai
```

说明：

- `--custom-model-id` 是动态的且为必填项。它并不固定为单一值。
- `--custom-api-key` 是可选的（类似 OpenClaw 自定义服务商流程）。若省略，运行时仍可能需要鉴权。
- 支持的兼容性取值：`openai`、`anthropic`、`unknown`。

## OpenCode 兼容配置

KHY 还支持 OpenCode 风格的配置输入。

### 方案 A：直接传参

```bash
khy config opencode \
  --base-url "https://your-provider.com/v1" \
  --model-id "<your-model-id>" \
  --api-key "sk-xxxxx" \
  --compatibility openai
```

### 方案 B：从 `opencode.json` 导入

```bash
khy config opencode \
  --config "~/.config/opencode/opencode.json" \
  --provider "<provider-name>"
```

说明：

- `model-id` 是动态的；它并不固定为单一值。
- 如果 base URL 未以 `/v1` 结尾，KHY 会自动将其规范化为 `/v1` 端点并打印警告。
- `api-key` 是可选的；若省略，运行时仍可能需要鉴权。
