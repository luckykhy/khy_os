<!-- 文档分类: DESIGN-ARCH-006 | 阶段: 设计 | 原路径: docs/架构/ai-gateway-适配器协议架构.md -->
# AI Gateway 适配器协议架构

> 版本: v0.1.100 | 日期: 2026-06-14

## 概述

AI Gateway 通过 16 个适配器对接不同的 AI 服务端点（云端 API、IDE 插件、本地模型、中继代理等）。
本文档描述协议层的统一抽象设计，以及模型接入后如何自动选择最合适的协议。

## 架构总览

```text
客户端请求 (OpenAI / Anthropic / Gemini / Codex)
    │
    ▼
proxyServer.js ── protocolConverter/ ── 路径检测协议
    │
    ▼
modelRouter.resolveModelRoute()
    │  返回 { adapterKey, modelId, protocolHint }
    ▼
aiGateway.generate()
    │  级联选择适配器 → 注入 _resolvedProtocol
    ▼
adapter.generate(prompt, { ..., _resolvedProtocol })
    │  内部调用 _protocolPipeline handler
    ▼
_protocolPipeline.createProtocolHandler({ protocol })
    │  ┌─ openai:     _messageBuilder + _toolSchemaConverter + _openaiSseStream
    │  ├─ anthropic:  _messageBuilder + _anthropicSseStream
    │  └─ (扩展: codewhisperer / codex / ...)
    ▼
_responseBuilder.buildSuccess / buildFailure → 标准化响应
```

## 核心模块

### `_protocolRegistry.js` — 协议元数据与自动选择

声明每个适配器支持的协议，多协议适配器提供 `resolveProtocol()` 动态选择。

```js
// 查询适配器的协议
getProtocolForAdapter('cursor', 'gpt-4o', {})       // → 'openai'
getProtocolForAdapter('claude', 'claude-sonnet', {}) // → 'anthropic'
getProtocolForAdapter('trae', model, opts)           // → 动态: 'openai' | 'codewhisperer' | 'trae-native'

// 查询支持某协议的所有适配器
getAdaptersForProtocol('anthropic')  // → ['claude', 'relay_api', 'api']

// 从模型名推断协议
inferProtocolFromModel('claude-sonnet-4-6')  // → 'anthropic'
inferProtocolFromModel('gpt-4o')             // → 'openai'
inferProtocolFromModel('unknown-model')      // → null
```

**协议标识符**:

| 协议 | 适配器 |
|------|--------|
| `openai` | cursor, vscode, windsurf, cursor2api, ollama, trae(HTTP), relay_api, api |
| `anthropic` | claude(直连), relay_api(Anthropic端点), api |
| `codewhisperer` | kiro, trae(CW路径) |
| `codex` | codex(直连) |
| `responses` | relay_api(Responses 端点) — 出站消费 OpenAI `/v1/responses` |
| `cli-stream-json` | claude(桥接), codex(CLI), cli |
| `trae-native` | trae(原生协议) |
| `direct` | localLLM |
| `manual` | relay, clipboard, warp |

> **命名陷阱**:`codex` 与 `responses` 都对应 OpenAI 的 Responses 线格式(`/v1/responses`),但分属两个方向:
> - `codex` —— **入站服务端**。`proxyServer.js` 把外部 Responses 客户端的请求转为内部 canonical,
>   并以真流式 Responses 事件序列回写(见下文「Responses API 入站服务」)。
> - `responses` —— **出站消费端**。KhyOS 作为客户端经 `relay_api` 向上游 Responses 端点发请求
>   (见下文「Responses API 出站消费」)。两者共用 `protocolConverter` 的 codex 转换器,但走不同的管线分支。

### `_protocolPipeline.js` — 协议管线工厂

为每种协议提供统一的请求构建和响应解析，消除适配器间的重复代码。

```js
const handler = createProtocolHandler({ protocol: 'openai', adapterName: 'cursor' });

// 构建请求体（自动处理消息格式、工具转换、图片附加）
const { body, system } = handler.buildRequestBody(prompt, options);

// 解析 JSON 响应（提取 content、toolUseBlocks、usage、thinking）
const result = handler.parseJsonResponse(rawResponse);

// 解析 SSE 流式响应
const result = await handler.parseStreamResponse(stream, onChunk, { signal });
```

内部按协议委托到专用模块：

- **openai**: `_messageBuilder`(消息解析) → `_toolSchemaConverter`(Anthropic→OpenAI工具转换) → `_openaiSseStream`(流解析)
- **anthropic**: `_messageBuilder`(消息解析) → `_imageCompat`(图片转换) → `_anthropicSseStream`(流解析)
- **responses**: 复用 openai handler 构建 canonical 后经 `protocolConverter` 转 Responses `input[]`+`instructions` → `_responsesSseStream`(流解析) / `_responsesFormat.parseDirectResponse`(JSON 解析)

### `_responsesSseStream.js` — Responses API SSE 流解析(出站)

KhyOS 作为客户端消费上游 `/v1/responses` 的 SSE 时使用。`parseResponsesSseStream(stream, onChunk, opts)`
按 `item_id` 累积输出项,返回 `{ content, model, toolUseBlocks, finishReason, usage }`:

- `response.output_text.delta` → 累积 content,`onChunk({type:'text'})`
- `response.output_item.added`(function_call) → 记录 `item_id`(`fc_…`)/`call_id`(`call_…`)/name,`onChunk({type:'tool_use_start'})`
- `response.function_call_arguments.delta` → 累积 argsBuffer,`onChunk({type:'tool_use_input_delta'})`
- `response.function_call_arguments.done` / `response.output_item.done` → `onChunk({type:'tool_use_end'})`
- `response.completed` → 读 `usage` 终止(**无 `[DONE]` 哨兵**);若流中未见增量事件,
  退回 `completed` 快照的 `output[]` 经 `parseDirectResponse` 重建 content/toolCalls
- name 始终取自 `output_item.added`(忽略 `…arguments.done` 内 `name:null` 的 SDK 怪癖)
- `item_id`(`fc_`)与 `call_id`(`call_`)严格区分:前者键 arg-delta 事件,后者供客户端下一轮
  `function_call_output` 引用

### `_responsesFormat.js` — Responses 输出共享纯函数

从 `codexAdapter.js` 抽取,供出站 handler 与 codex 适配器共用,消除重复:

- `extractMessageText` / `extractThinkingTags` / `extractReasoningText`
- `parseDirectResponse(output)` → `{ textParts, functionCalls, reasoningParts }`:
  解析非流式 Responses `output[]`(message→text、function_call→`JSON.parse(arguments)`+`call_id`、reasoning→thinking)

### Responses API 入站服务(`proxyServer.handleMultiProtocol`,codex 分支)

外部 Responses 客户端 POST `/v1/responses` 时,`proxyServer.js` 把请求经 `protocolConverter`
转为 canonical,生成回复后以**真流式** Responses 事件序列回写(单调 `sequence_number` 从 0 起):

- 文本:`response.created` → `response.in_progress` → `response.output_item.added`(message)
  → `response.content_part.added` → `response.output_text.delta`(多次)
  → `response.output_text.done` → `response.content_part.done` → `response.output_item.done`
  → `response.completed`
- 工具调用:`output_item.added`(function_call)→ `response.function_call_arguments.delta`(多次)
  → `response.function_call_arguments.done` → `response.output_item.done`(function_call **无** content_part 事件)
- `created` / `completed` 必带完整 `response` 快照;`completed` 快照由 `fromCanonical` 生成,
  杜绝流事件与终态分叉;**禁发 `[DONE]`**(`response.completed` 即终止)
- 首版丢弃入站 thinking,避免发畸形 reasoning item

**会话状态链(`previous_response_id` / `store`)** —— `responseSessionStore.js`(进程内 LRU+TTL):

- `put/get`,env `RESPONSES_STORE_TTL_MS`(默认 3600000)、`RESPONSES_STORE_MAX`(默认 1000)
- 非流式/流式两路完成后生成 `resp_`+24hex 作 response `id`;`store !== false` 时持久化
  `{id, messages, createdAt}`
- 请求带 `previous_response_id`:命中则把持久化历史**前置**到当前 input;未命中/过期 →
  Responses 风格 `400`(`{error:{type:'invalid_request_error', code:'previous_response_not_found'}}`),
  `RESPONSES_STORE_STRICT=false` 可改宽松忽略
- 多进程局限:集群下后续请求可能命中无该条目的 worker → 当过期处理。接口稳定,
  未来可换 sqlite/redis 不动调用方

### Responses API 出站消费(`relay_api` 的 `responses` 协议)

`relay_api` 适配器在 `serviceType==='responses'` 或端点指向 `/responses` 时,经 `responses` handler:

- URL 构造 `${endpoint}/v1/responses`(或 `/responses`),Bearer 鉴权
- `buildRequestBody` 复用 openai handler 产 canonical 后 `convertRequestBetween(body,'openai','codex')`
  得 `input[]`+`instructions`,不重写
- 非流式经 `parseDirectResponse` 解析 `output[]`,usage 映射 `input_tokens`/`output_tokens`/`total_tokens`
- 流式委托 `_responsesSseStream`

### `_anthropicSseStream.js` — Anthropic SSE 流解析

与 `_openaiSseStream.js` 对称，处理 Anthropic Messages API 的 SSE 事件：

- `message_start` → 提取 model、input_tokens
- `content_block_start/delta/stop` → 累积 text、tool_use、thinking 块
- `message_delta` → 提取 stop_reason、output_tokens
- 兼容两种 SSE 帧格式（两行 `event: + data:` 和内联 `data: {type:...}`）
- 工具输入 JSON 容错：`safeJsonParse` 兜底

### `_responseBuilder.js` — 标准化响应构建

所有适配器统一使用：

```js
buildSuccess(content, { adapter, provider, model, toolUseBlocks, stopReason, usage })
buildFailure(error, { adapter, provider, statusCode, errorType })
```

## 自动协议选择流程

当模型接入后，系统自动选择最合适的协议，无需手动配置：

```text
1. modelRouter.resolveModelRoute({ model: 'claude-sonnet-4-6' })
   → protocolHint: 'anthropic'  (从模型名前缀推断)

2. aiGateway.autoSelectModel(taskType, { model })
   → 优先选择支持 'anthropic' 协议的适配器 (claude > relay_api > api)
   → 若协议过滤后无可用适配器，退回全量优先级列表

3. aiGateway._generateWithAdapterIsolation(entry, prompt, options)
   → options._resolvedProtocol = getProtocolForAdapter(entry.key, model, options)
   → 适配器内部读取 _resolvedProtocol 选择正确的管线处理器
```

**多协议适配器的动态选择**:

| 适配器 | 决策逻辑 |
|--------|---------|
| `claude` | `GATEWAY_CLAUDE_MODE` env / `model::mode` 后缀 / API key 存在性 → `anthropic` 或 `cli-stream-json` |
| `trae` | nativeToken 存在 → `trae-native`；否则 → CW 或 `openai` 级联 |
| `codex` | `GATEWAY_CODEX_MODE=direct` 或有图片 → `codex`；否则 → `cli-stream-json` |
| `relay_api` | `serviceType==='responses'` 或端点含 `/responses` → `responses`;端点含 `/anthropic` → `anthropic`;否则 → `openai` |

## 适配器开发指南

### 新建适配器

1. 在 `_protocolRegistry.js` 的 `ADAPTER_PROTOCOL_MAP` 中声明协议支持
2. 在适配器中创建管线处理器：
   ```js
   const { createProtocolHandler } = require('./_protocolPipeline');
   const _handler = createProtocolHandler({ protocol: 'openai', adapterName: 'myAdapter' });
   ```
3. `generate()` 中使用管线：
   ```js
   const { body } = _handler.buildRequestBody(prompt, options);
   // ... 发送 HTTP 请求 ...
   const result = _handler.parseJsonResponse(rawResponse);
   return buildSuccess(result.content, { adapter: 'myAdapter', ...result });
   ```
4. 在 `aiGateway.js` 的 `_adapters` 数组中注册

### 添加新协议

1. 在 `_protocolRegistry.js` 的 `PROTOCOLS` 中添加协议标识符
2. 在 `_protocolPipeline.js` 的 `createProtocolHandler` switch 中添加分支
3. 实现 `buildRequestBody` / `parseJsonResponse` / `parseStreamResponse`

## 共享模块依赖图

```text
_protocolPipeline.js
 ├── _messageBuilder.js        消息源解析 (rawMessages / structuredMessages / messages / prompt)
 ├── _toolSchemaConverter.js   工具格式转换 (Anthropic ↔ OpenAI ↔ CW)
 ├── _imageCompat.js           图片格式转换 (OpenAI / Anthropic / Ollama / Codex / Gemini)
 ├── _openaiSseStream.js       OpenAI SSE 流解析
 └── _anthropicSseStream.js    Anthropic SSE 流解析

_responseBuilder.js            标准化响应构建 (独立，所有适配器直接引用)
_protocolRegistry.js           协议元数据 (独立，aiGateway / modelRouter 引用)
_errorClassifiers.js           错误分类 (_responseBuilder 引用)
```

## 文件清单

| 文件 | 行数 | 职责 |
|------|------|------|
| `_protocolRegistry.js` | ~190 | 协议声明 + 自动选择 + 模型名推断 (含 `responses`) |
| `_protocolPipeline.js` | ~260 | 管线工厂 (openai / anthropic / cw / responses handler) |
| `_anthropicSseStream.js` | ~230 | Anthropic SSE 流解析 |
| `_responsesSseStream.js` | ~200 | Responses API SSE 流解析 (出站) |
| `_responsesFormat.js` | ~120 | Responses 输出共享纯函数 (parseDirectResponse 等) |
| `responseSessionStore.js` | ~90 | Responses 会话状态链 LRU+TTL (previous_response_id / store) |
| `_responseBuilder.js` | ~108 | 标准化响应 buildSuccess / buildFailure |
| `_messageBuilder.js` | ~127 | 消息源解析 (4 种输入 → 统一消息数组) |
| `_toolSchemaConverter.js` | ~210 | 工具格式转换 (Anthropic / OpenAI / CW) |
| `_openaiSseStream.js` | ~222 | OpenAI SSE 流解析 |
| `_imageCompat.js` | ~220 | 图片格式转换 |
| `_errorClassifiers.js` | - | 错误类型分类 |

## 设计原则

1. **组合优于继承** — 适配器通过组合共享模块获得协议能力，不通过类继承。每个适配器保持独立的 `module.exports = { detect, generate, getStatus }` 模式。
2. **协议归协议，传输归传输** — 管线只负责消息格式和响应解析，HTTP/SDK/CLI 等传输逻辑留在适配器内部。
3. **渐进增强** — 管线不是强制的。不使用管线的适配器（如 kiro 的 CW 路径）可以继续直接操作协议格式。
4. **协议选择可覆盖** — 自动选择是建议性的，适配器的 `resolveProtocol()` 有最终决定权。
