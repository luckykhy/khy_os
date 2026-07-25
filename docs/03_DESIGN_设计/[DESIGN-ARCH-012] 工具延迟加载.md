<!-- 文档分类: DESIGN-ARCH-012 | 阶段: 设计 | 原路径: docs/设计模式/工具延迟加载.md -->
# 功能：工具延迟加载（defer_loading）—— Anthropic API 协议集成

**日期**：2026-06-03
**适用范围**：Claude Direct 模式（`GATEWAY_CLAUDE_MODE=direct`）
**收益**：每次 API 请求节省约 65% 的 token（约 13,000 -> 约 4,500 tokens）

## 背景

KHY Direct 模式在每次 API 请求中都会发送全部约 65 个工具定义（约 12,000-15,000 tokens）。Anthropic 提供了一种 `defer_loading` 协议，允许将不常用的工具标记为"延迟加载"——初始只发送工具名称；当模型需要时，再在服务端按需加载完整的 schema。

KHY 此前已具备客户端侧的延迟加载基础设施（BaseTool 上的 `shouldDefer`/`alwaysLoad`、`toolSearch.js` 关键字搜索、`_revealedDeferred` 会话追踪）。缺失的部分是 Anthropic API 层面的协议集成。

## 本次改动前的差距

| 组件 | 状态 |
|-----------|--------|
| `anthropic-beta: tool-search-tool-2025-10-19` 请求头 | 未发送 |
| 工具定义上的 `defer_loading: true` | 未包含在 API 请求中 |
| `tool_search_tool_regex_20251119` 服务端工具 | 未注册 |
| `server_tool_use` SSE 事件解析 | 未实现 |
| 工具循环中的 `server_tool_use` 过滤 | 未实现 |
| `anthropic-version` | `2024-10-22`（保持不变，仍然兼容） |

## 实现

### 1. Beta 请求头 + 辅助函数（`claudeAdapter.js`）

两个模块级辅助函数：
- `_deferralActive()` —— 除非 `KHY_DEFER_TOOLS=0`，否则返回 `true`
- `_buildBetaHeader()` —— 返回 `tool-search-tool-2025-10-19`，并追加来自 `KHY_ANTHROPIC_BETA` 环境变量的任何额外项

`callAnthropicStream()` 有条件地包含 `anthropic-beta` 请求头：

```js
headers: {
  'x-api-key': apiKey,
  'anthropic-version': '2024-10-22',
  ...(_deferralActive() ? { 'anthropic-beta': _buildBetaHeader() } : {}),
  'Content-Type': 'application/json',
}
```

### 2. buildDirectToolDefs() 重写（`claudeAdapter.js`）

此前：从 `getToolDefinitions()` 取硬编码的 13 个工具白名单。

现在：从 `registry.assembleToolPool(undefined, 'coding')` 读取，该方法会遵循 profile、deny 规则以及延迟加载状态。

```
对工具池中的每个工具：
  if deferEnabled && tool.shouldDefer && !tool.alwaysLoad:
    emit { name, defer_loading: true }        // 约 5 tokens
  else:
    emit { name, description, input_schema }  // 约 200 tokens

if deferEnabled:
  append { type: 'tool_search_tool_regex_20251119', name: 'tool_search' }
```

兜底：如果 registry 加载失败，则返回原始的 6 个工具硬编码列表（不启用延迟加载）。

### 3. SSE 解析 —— `server_tool_use`（`_anthropicSseStream.js`）

当 Anthropic API 使用其服务端的 tool_search 来查找延迟加载工具的 schema 时，它会在 SSE 流中发出 `server_tool_use` 内容块。

三处改动：
- `content_block_start`：新增 `server_tool_use` 分支 —— 追踪 `id`、`name`、`inputJson`
- `content_block_delta`：允许 `server_tool_use` 块使用 `input_json_delta`（而不仅限于 `tool_use`）
- `content_block_stop`：将 `server_tool_use` 终结并以 `type: 'server_tool_use'` 写入 `toolUseBlocks` 数组

### 4. JSON 响应解析（`_protocolPipeline.js`）

`_createAnthropicHandler().parseJsonResponse()` 现在能够识别非流式响应中的 `server_tool_use` 块，并以 `type: 'server_tool_use'` 将其推入 `toolUseBlocks`。

### 5. 工具循环跳过（`toolUseLoop.js`）

```js
toolCalls = aiResult.toolUseBlocks
  .filter(block => block.type !== 'server_tool_use')  // <-- new
  .map(block => { ... });
```

`server_tool_use` 块（tool_search）完全由 Anthropic 在服务端处理。它们绝不能进入本地工具执行管线。

## 修改的文件

| 文件 | 改动行数 | 用途 |
|------|:---:|---------|
| `backend/src/services/gateway/adapters/claudeAdapter.js` | +35 -20 | Beta 请求头、buildDirectToolDefs 重写 |
| `backend/src/services/gateway/adapters/_anthropicSseStream.js` | +20 | server_tool_use SSE 解析 |
| `backend/src/services/gateway/adapters/_protocolPipeline.js` | +6 | server_tool_use JSON 解析 |
| `backend/src/services/toolUseLoop.js` | +3 | server_tool_use 过滤 |

## 环境变量

| 变量 | 默认值 | 说明 |
|----------|---------|-------------|
| `KHY_DEFER_TOOLS` | `1`（启用） | 设为 `0` 可完全禁用：不发送 beta 请求头、不发送 `defer_loading`、不注册 `tool_search` 服务端工具 |
| `KHY_ANTHROPIC_BETA` | （空） | 逗号分隔的额外 beta 标志，追加到请求头中 |

## 工作原理（端到端）

```
1. KHY 构建工具数组：
   - 核心工具（Bash、Read、Edit、……）→ 完整 schema
   - 延迟加载工具（NotebookEdit、CronCreate、……）→ { name, defer_loading: true }
   - 服务端工具：{ type: 'tool_search_tool_regex_20251119', name: 'tool_search' }

2. 请求发送至 Anthropic API，携带：
   - anthropic-beta: tool-search-tool-2025-10-19
   - tools: [完整 schema + 仅含名称的桩 + tool_search]

3. 模型决定调用某个延迟加载工具（例如 NotebookEdit）：
   - Anthropic 服务端拦截 → 内部运行 tool_search
   - SSE 发出 server_tool_use 块（tool_search 正在运行）
   - 服务端根据延迟加载的桩解析出完整 schema
   - 模型收到完整 schema，生成正确的 tool_use 调用

4. KHY 接收 SSE 流：
   - server_tool_use → 被解析，但从本地执行中过滤掉
   - tool_use（NotebookEdit）→ 走正常的本地执行路径

5. token 收益：
   - 约 45 个延迟加载工具 × 约 200 tokens 节省 = 约 9,000 tokens/请求
   - tool_search_tool 的开销：约 50 tokens
   - 净效果：工具定义 token 减少约 65%
```

## 向后兼容

- `KHY_DEFER_TOOLS=0` → 与改动前完全一致的行为（但现在使用 registry 而非硬编码白名单）
- 非 Claude 适配器（Ollama、Kiro、Codex 等）→ 不受影响（beta 请求头仅存在于 `callAnthropicStream`）
- Bridge 模式 → 不受影响（Claude CLI 子进程拥有自己的 ToolSearch）
- 代理透传 → 已保留 `defer_loading` 字段（`proxyServer.js:1347-1355`）

## 复用的现有基础设施

| 组件 | 文件 | 用途 |
|-----------|------|---------|
| `shouldDefer` / `alwaysLoad` | `_baseTool.js` | 各工具的延迟加载标志 |
| `assembleToolPool()` | `tools/index.js` | Profile + deny + 延迟加载过滤 |
| `toolSearch.js` | `tools/toolSearch.js` | 客户端兜底（非 Anthropic 适配器） |
| `_revealedDeferred` | `tools/index.js` | 已揭示工具的会话状态 |
| `filterToolsByProfile()` | `tools/toolProfile.js` | 基于 profile 的过滤（coding profile） |

## 验证

1. 模块加载：`node -e "require('./backend/src/services/gateway/adapters/claudeAdapter.js')"` —— 通过
2. 现有测试：零回归（通过改动前后的 `git stash` 对比验证）
3. 交互式测试（Direct 模式）：延迟加载工具仅发送名称，`anthropic-beta` 请求头存在
4. `KHY_DEFER_TOOLS=0`：已确认完全禁用路径

## 未来考量

- BM25 搜索变体：`tool_search_tool_bm25_20251119` 在面向自然语言的工具查询时可能表现更好 —— 可通过环境变量切换
- `tool_reference` 内容块：如果 Anthropic 在 assistant 消息中加入内联工具引用，`_anthropicSseStream.js` 应将其透传
- 缓存前缀稳定性：Anthropic 在计算缓存哈希时会跳过 `defer_loading` 工具 —— 增删延迟加载工具不会使 prompt 缓存失效
