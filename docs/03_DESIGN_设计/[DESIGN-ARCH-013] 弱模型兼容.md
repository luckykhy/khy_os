<!-- 文档分类: DESIGN-ARCH-013 | 阶段: 设计 | 原路径: docs/设计模式/弱模型兼容.md -->
# 弱模型兼容性修复

> Version: 0.1.88 | Date: 2026-06-01

## 背景

在使用小型/弱模型（minimax-m2.5、qwen:1.8b、deepseek-coder:6.7b、phi3:mini 等）执行工具调用工作流时，整条管线会暴露出四类失败：

1. 工具结果过大，超出模型上下文窗口，导致截断或幻觉
2. `max_tokens` 上限在冷启动场景下设得太低，使工具调用输出在生成中途被切断
3. `role: 'tool'` 消息被缺乏原生函数调用支持的模型拒绝
4. 非标准的工具调用输出格式（markdown 代码块中的 JSON）无法被循环解析

这四个问题在大模型（Claude、GPT-4、DeepSeek-V3）上完全不可见，但会在 7B 以下的本地模型上彻底破坏 Agent 循环。

---

## 修复 1：工具结果截断按比例缩放

**文件**：`backend/src/services/toolUseLoop.js`

**问题**：`_extractToolOutput()` 函数对工具结果使用固定的 65536 字符上下文预算。上下文窗口仅 2K-8K 的小模型收到的工具结果会占满其全部上下文，没有任何空间用于推理。

**改动**：
- 默认 `contextBudget`：65536 → 32768
- 硬截断兜底：50000 → 15000
- 新增辅助函数 `_getActiveModelContextWindow()`，向 gateway 查询当前活动模型的上下文窗口大小，并按比例缩放预算

**缩放逻辑**：
```
contextWindow >= 128K  →  budget = 65536 (full)
contextWindow >= 32K   →  budget = 32768
contextWindow >= 8K    →  budget = 8192
contextWindow < 8K     →  budget = 4096
```

该函数从 `serviceRegistry → gateway.getActiveAdapterInfo()` 读取信息，若不可用则回退到 32768 默认值。

---

## 修复 2：本地模型 max_tokens 上限

**文件**：`backend/src/cli/ai.js`

**问题**：本地模型（Ollama）的 `max_tokens` 上限设置过于保守，不足以生成工具调用。像 `{"name":"Bash","arguments":{"command":"find . -name '*.js' | head -20"}}` 这样的工具调用 JSON，在被 `<tool_call>` 标签包裹并附带推理内容时，很容易超过 1536 token。

**改动**：
| 场景 | 改前 | 改后 |
|----------|--------|-------|
| 温启动（近期有工具使用） | 3072 | 4096 |
| 冷启动（首条消息） | 1536 | 3072 |

这些上限仅作用于通过 Ollama 适配器检测到的本地模型。云端模型使用各自的限制。

---

## 修复 3：`role:'tool'` 兼容性兜底

**文件**：
- `backend/src/services/gateway/adapters/_toolSchemaConverter.js`
- `backend/src/services/gateway/adapters/_messageBuilder.js`
- `backend/src/services/gateway/adapters/_protocolPipeline.js`
- `backend/src/services/gateway/adapters/ollamaAdapter.js`

**问题**：OpenAI chat 协议使用 `role: 'tool'` 消息将工具执行结果回传给模型。在没有函数调用数据上训练的小模型（< 7B 参数）会拒绝或忽略这些消息，从而破坏工具调用循环。

**方案**：对 `useToolRole` 标志进行三层透传：

```
ollamaAdapter (detects model size)
  → _protocolPipeline.buildRequestBody (forwards useToolRole in options)
    → _messageBuilder.resolveMessages (passes convertMessagesOpts)
      → convertMessagesAnthropicToOpenAI(messages, hasTools, { useToolRole })
```

**当 `useToolRole: false` 时**：

不再生成：
```json
{ "role": "tool", "tool_call_id": "call_abc", "content": "file contents..." }
```

转换器改为生成：
```json
{ "role": "user", "content": "[Tool Result: call_abc]\nfile contents..." }
```

并且不再在 assistant 消息上使用 `tool_calls`：
```json
{ "role": "assistant", "content": "[Tool Call: Bash({\"command\":\"ls\"})]" }
```

**模型规模检测**（位于 `ollamaAdapter.js`）：
```javascript
// Extract param count from model tag: "qwen2:7b" → 7, "phi3:mini" → null
const match = model.toLowerCase().match(/:(\d+(?:\.\d+)?)b/);
const paramB = match ? parseFloat(match[1]) : null;
const useToolRole = paramB !== null ? paramB >= 7 : true;
```

没有可识别参数标签的模型（如 `llama3:latest`）默认 `useToolRole: true`，因为不带规模后缀的热门模型通常都是 7B 及以上。

---

## 修复 4：JSON 代码块工具调用解析

**文件**：`backend/src/services/toolUseLoop.js` — `_parseToolCalls()`

**问题**：部分弱模型会把工具调用包在 markdown 代码围栏中，而不是 `<tool_call>` XML 标签里：

````
```json
{"name": "Bash", "arguments": {"command": "ls -la"}}
```
````

或者：

````
```tool_call
{"name": "Read", "parameters": {"file_path": "/tmp/config.json"}}
```
````

解析器已有 6 种格式，但没有一种能匹配这种模式。

**方案**：作为格式 7 加入（位于截断的裸工具修复格式之前）：

```javascript
// Format 7: JSON in markdown code block
const codeBlockMatches = [
  ...text.matchAll(/```(?:json|tool_call|tool|function)?\s*\n(\{[\s\S]*?\})\s*\n```/g)
];
```

接受的围栏语言标记：`json`、`tool_call`、`tool`、`function`，或不带语言标记。

接受的参数 JSON 字段名：
- `arguments`（OpenAI 风格）
- `parameters`（Anthropic 风格）
- `params`（内部风格）
- `input`（Claude 风格）

解析结果会经过 `normalizeToolCall()` 进行别名解析（例如 `bash` → `Bash`、`readfile` → `Read`）和去重，与所有其他格式一致。

**安全性**：`_isFakeToolCall()` 守卫依然生效——嵌套在三反引号内部的代码块，或前面有解释性短语（"for example:"、"比如:"）的代码块会被跳过。

---

## 格式注册表汇总

经过这些改动后，`_parseToolCalls()` 支持 8 种格式 + 1 种自然语言格式：

| # | 格式 | 示例 | 目标模型 |
|---|--------|---------|---------------|
| 1 | XML 包裹的 JSON | `<tool_call>{"name":"Bash",...}</tool_call>` | 大多数模型 |
| 2 | XML 包裹的函数调用 | `<tool_call>Bash(ls)</tool_call>` | Qwen、DeepSeek |
| 3 | 自然语言（中文） | `【调用 Bash: ls -la】` | 中文本地模型 |
| 4 | 截断的 XML JSON | `<tool_call>{"name":"Ba...` (EOF) | 任意（max_tokens 截断） |
| 5 | UI 前缀 | `▶ Bash(ls)` | 终端训练的模型 |
| 6 | 裸独立调用 | `Bash(ls -la)` | SenseNova、小模型 |
| 7 | JSON 代码块 | `` ```json\n{"name":"Bash",...}\n``` `` | MiniMax、Qwen-small |
| 8 | 截断的裸调用 | `Bash(ls -la...` (EOF) | 任意（max_tokens 截断） |

格式 4 和 8 是修复格式，用于尝试恢复被 `max_tokens` 限制截断的工具调用。

---

## 验证

1. **语法检查**：所有 7 个被修改的文件均通过 `node -c`
2. **回归**：云端模型路径保持不变——`useToolRole` 默认为 `undefined`（真值），且格式 7 仅在格式 1-6 都未命中时才触发
3. **本地模型测试**：使用小型 Ollama 模型（如 `qwen2:1.8b`）运行并验证：
   - 工具结果以 `[Tool Result: ...]` 形式嵌入 user 消息中（而非 `role:'tool'`）
   - JSON 代码块工具调用被正确解析
   - Agent 循环顺利完成，不会卡死
