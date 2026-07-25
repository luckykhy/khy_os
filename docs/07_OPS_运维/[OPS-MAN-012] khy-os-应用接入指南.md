<!-- 文档分类: OPS-MAN-012 | 阶段: 运维 | 原路径: docs/指南/khy-os-应用接入指南.md -->
# KHY OS 应用接入指南

> 让你的项目享受 KHY OS 的 AI 能力、工具体系和跨平台基础设施。

---

## 一、KHY OS 提供了什么

你的应用接入 KHY OS 后，可以直接使用以下平台能力：

| 能力 | 说明 | 接入方式 |
|------|------|----------|
| **AI 统一代理** | 16+ 模型一个端点调用，自动路由/降级/计费 | HTTP API (端口 9100) |
| **工具体系** | 50+ 内建工具 (文件/Shell/Git/搜索/MCP/...) | SDK / Tool API |
| **技能系统** | 可复用的 AI 技能包 (commit/review/debug/...) | Skill 目录 |
| **网关插件** | 拦截/修改/监控所有 AI 请求 | JS 插件文件 |
| **MCP 服务器** | 标准化上下文协议，连接任何数据源 | mcp.json 配置 |
| **扩展市场** | 发布/安装/更新完整扩展包 | openclaw.plugin.json |
| **监控 SSE** | 实时 AI 请求追踪流 | SSE 订阅 |
| **配置管理** | 统一配置读写 | REST API / CLI |

---

## 二、接入层级

根据你的需求深度，选择合适的接入层级：

```
┌─────────────────────────────────────────────────────┐
│  Level 0: API 消费者  —  调用 AI 代理 API 即可      │
│  (5 分钟接入，任何语言)                               │
├─────────────────────────────────────────────────────┤
│  Level 1: SDK 集成    —  用 @khy/sdk 深度集成        │
│  (Node.js/Python/Java)                               │
├─────────────────────────────────────────────────────┤
│  Level 2: 技能贡献    —  为生态贡献可复用 AI 技能     │
│  (prompt.md + manifest.json)                         │
├─────────────────────────────────────────────────────┤
│  Level 3: 扩展开发    —  完整扩展包（技能+插件+MCP）  │
│  (openclaw.plugin.json)                              │
└─────────────────────────────────────────────────────┘
```

---

## 三、Level 0 — API 消费者（5 分钟接入）

### 3.1 AI 代理 API

KHY OS 运行一个 **OpenAI/Anthropic/Gemini 兼容** 的代理服务器，你的应用用任何 AI SDK 都能直接调用。

**启动代理：**

```bash
khy                    # 启动 KHY OS，代理自动运行在 9100 端口
```

**Python (OpenAI SDK)：**

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:9100/v1",
    api_key="khy-your-token"     # 从 ~/.khy/proxy_server_auth.json 读取
)

resp = client.chat.completions.create(
    model="claude/claude-sonnet-4-20250514",   # 或 ollama/qwen2.5:7b, trae/deepseek-v3
    messages=[{"role": "user", "content": "你好"}],
    stream=True
)
for chunk in resp:
    print(chunk.choices[0].delta.content, end="")
```

**Node.js (Anthropic SDK)：**

```javascript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  baseURL: 'http://127.0.0.1:9100',
  apiKey: 'khy-your-token'
});

const msg = await client.messages.create({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 1024,
  messages: [{ role: 'user', content: '你好' }]
});
```

**curl：**

```bash
curl http://127.0.0.1:9100/v1/chat/completions \
  -H "Authorization: Bearer khy-your-token" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude/claude-sonnet-4-20250514","messages":[{"role":"user","content":"你好"}]}'
```

### 3.2 获取 Auth Token

```bash
# 自动生成的 token 在这里
cat ~/.khy/proxy_server_auth.json

# 或通过管理 API 创建专用 token
curl -X POST http://127.0.0.1:9090/api/ai-gateway/customers \
  -H "Content-Type: application/json" \
  -d '{"name":"my-app","tier":"standard"}'
```

### 3.3 模型路由规则

在 `model` 字段中指定适配器前缀即可路由到不同后端：

| model 格式 | 路由到 |
|-----------|--------|
| `claude/claude-sonnet-4-20250514` | Claude 适配器 |
| `ollama/qwen2.5:7b` | 本地 Ollama |
| `trae/deepseek-v3` | Trae IDE 适配器 |
| `kiro/claude-sonnet-4-20250514` | Kiro 适配器 |
| `relay/gpt-4o` | 中转站 |
| `deepseek-chat` | 无前缀时走默认适配器 |

### 3.4 管理 API

端口 9090 提供完整的管理接口：

```bash
# 健康检查
curl http://127.0.0.1:9090/api/health

# 列出所有可用模型
curl http://127.0.0.1:9090/api/models

# 查看用量
curl http://127.0.0.1:9090/api/usage

# 查看所有工具定义
curl http://127.0.0.1:9090/api/tools

# 执行一个工具
curl -X POST http://127.0.0.1:9090/api/tools/FileReadTool \
  -H "Content-Type: application/json" \
  -d '{"file_path":"/tmp/test.txt"}'
```

---

## 四、Level 1 — SDK 集成

### 4.1 Node.js SDK (`@khy/sdk`)

```bash
# 在 KHY OS 仓库的 monorepo 中已可用
cd packages/sdk
```

```javascript
const { KhyClient } = require('@khy/sdk');

// 连接到正在运行的 KHY 实例
const khy = new KhyClient();
await khy.connect();

// 发送查询
const stream = khy.query('帮我分析这段代码的性能问题', {
  model: 'claude-sonnet-4-20250514',
  tools: true             // 允许使用工具
});

for await (const event of stream) {
  if (event.type === 'text') process.stdout.write(event.text);
  if (event.type === 'tool_call') console.log('调用工具:', event.tool);
}
```

### 4.2 Python SDK (`@khy/sdk-python`)

```bash
cd packages/sdk-python
pip install -e .
```

```python
from khy_sdk import KhyClient

client = KhyClient()
response = client.chat("分析这个策略的回撤风险")
print(response.text)
```

### 4.3 Java SDK (`@khy/sdk-java`)

```xml
<dependency>
  <groupId>dev.khy</groupId>
  <artifactId>khy-sdk</artifactId>
</dependency>
```

### 4.4 MCP 客户端

你的应用可以通过 KHY OS 的 MCP 客户端连接任何 MCP 服务器：

```javascript
const { MCPClient } = require('@khy/sdk/mcp');

// 使用 KHY OS 已配置的 MCP 服务器
const tools = await khy.mcp.listTools();
const result = await khy.mcp.callTool('mcp__filesystem__read_file', {
  path: '/tmp/data.csv'
});
```

---

## 五、Level 2 — 技能贡献

技能是 KHY OS 中最轻量的复用单元 — 一个 prompt 模板 + 元数据。

### 5.1 创建技能

```bash
mkdir -p ~/.khy/skills/my-data-analyzer
```

**`~/.khy/skills/my-data-analyzer/manifest.json`：**

```json
{
  "name": "data-analyzer",
  "description": "分析 CSV/JSON 数据文件，输出统计摘要和可视化建议",
  "trigger": "analyze-data",
  "user_invocable": true,
  "tags": ["data", "analysis", "visualization"],
  "aliases": ["分析数据", "数据分析"]
}
```

**`~/.khy/skills/my-data-analyzer/prompt.md`：**

```markdown
You are a data analysis assistant. When the user provides a data file:

1. Read the file using the FileReadTool
2. Identify column types (numeric, categorical, datetime)
3. Calculate summary statistics (mean, median, std, missing %)
4. Suggest 3 visualizations with chart type rationale
5. Output a structured report in markdown

Focus on actionable insights, not just numbers.
```

**使用：**

```bash
khy
> /data-analyzer sales_2026.csv
# 或
> 分析数据 sales_2026.csv
```

### 5.2 项目级技能

放在项目目录下，仅对该项目生效：

```bash
mkdir -p .khy/skills/deploy-check
# manifest.json + prompt.md 同上
```

### 5.3 带 Handler 的技能

需要自定义逻辑时，添加 `handler.js`：

```javascript
// .khy/skills/my-skill/handler.js
module.exports = {
  async execute(args, context) {
    // context.tools — 可用工具
    // context.ai    — AI 调用接口
    // context.cwd   — 工作目录
    const data = await context.tools.execute('FileReadTool', { file_path: args });
    return { prompt: `分析以下数据:\n${data}` };
  }
};
```

---

## 六、Level 3 — 扩展开发

扩展是完整的功能包，可以同时注册技能、网关插件、MCP 服务器和 CLI 命令。

### 6.1 扩展结构

```
my-khy-extension/
├── openclaw.plugin.json      # 扩展清单（必需）
├── package.json
├── src/
│   └── index.js              # 入口（注册 CLI 命令）
├── skills/
│   └── my-skill/
│       ├── manifest.json
│       └── prompt.md
├── plugins/
│   └── my-gateway-plugin.js  # 网关插件
└── mcp/
    └── server.js             # MCP 服务器
```

### 6.2 扩展清单

**`openclaw.plugin.json`：**

```json
{
  "name": "my-khy-extension",
  "version": "1.0.0",
  "description": "为 KHY OS 添加数据分析能力",
  "author": "your-name",
  "capabilities": ["skill", "gateway-plugin", "mcp-server", "cli-command"],
  "entry": "./src/index.js",
  "skills": ["./skills/my-skill"],
  "mcp": {
    "command": "node",
    "args": ["./mcp/server.js"]
  }
}
```

### 6.3 注册 CLI 命令

```javascript
// src/index.js
module.exports = function activate(ctx) {
  ctx.commands.register({
    name: 'analyze',
    description: '数据分析命令',
    handler: async (subCommand, args) => {
      // 你的逻辑
      return true;
    }
  });
};
```

### 6.4 网关插件

```javascript
// plugins/my-gateway-plugin.js
module.exports = {
  name: 'my-analytics',
  priority: 100,
  enabled: true,
  hooks: {
    async onBeforeRequest(ctx, next) {
      // 在所有 AI 请求前注入上下文
      if (ctx.messages) {
        ctx.messages.unshift({
          role: 'system',
          content: '当前用户的数据分析偏好: ...'
        });
      }
      return next(ctx);
    },
    async onAfterResponse(ctx, next) {
      // 记录所有 AI 响应的 token 用量
      console.log(`[analytics] ${ctx.model}: ${ctx.usage?.totalTokens} tokens`);
      return next(ctx);
    }
  }
};
```

### 6.5 安装与发布

```bash
# 本地开发模式（符号链接，实时生效）
khy extension link /path/to/my-khy-extension

# 从 Git 仓库安装
khy extension install https://github.com/user/my-khy-extension

# 从扩展市场安装
khy extension install my-khy-extension

# 发布到扩展市场
khy extension publish
```

---

## 七、注册自定义工具

### 7.1 函数式定义

```javascript
const { defineTool } = require('@khy/plugin-sdk');

const myTool = defineTool({
  name: 'DataFetchTool',
  description: '从指定 API 拉取数据',
  category: 'data',
  risk: 'low',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'API 地址' },
      format: { type: 'string', enum: ['json', 'csv'], default: 'json' }
    },
    required: ['url']
  },
  async execute({ url, format }) {
    const resp = await fetch(url);
    return format === 'csv' ? await resp.text() : await resp.json();
  }
});
```

### 7.2 工具在扩展中自动注册

扩展入口的 `ctx` 对象提供工具注册能力，不需要直接操作 toolRegistry。

---

## 八、MCP 服务器接入

KHY OS 完整支持 MCP 协议 (2024-11-05)，你可以让你的应用作为 MCP 服务器暴露数据。

### 8.1 配置已有 MCP 服务器

**`~/.khy/mcp.json`：**

```json
{
  "mcpServers": {
    "my-database": {
      "command": "node",
      "args": ["./my-mcp-server.js"],
      "env": { "DB_URL": "postgres://localhost/mydb" }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-filesystem", "/data"]
    }
  }
}
```

### 8.2 项目级配置

**`.khy/mcp.json`** (项目目录下)：仅在该项目中加载。

### 8.3 内建 MCP 工具

配置后，MCP 服务器的工具会自动注册到 KHY OS 工具系统中，命名格式：`mcp__<server>__<tool>`。AI 可以直接调用。

---

## 九、实时监控接入

### 9.1 SSE 订阅

```javascript
const es = new EventSource('http://127.0.0.1:9090/api/ai-gateway/monitor/stream');

es.addEventListener('trace:start', (e) => {
  const trace = JSON.parse(e.data);
  console.log(`[请求开始] ${trace.adapter} / ${trace.model}`);
});

es.addEventListener('trace:end', (e) => {
  const trace = JSON.parse(e.data);
  console.log(`[请求完成] ${trace.tokens} tokens, ${trace.latencyMs}ms`);
});
```

### 9.2 WebSocket 实时聊天

```javascript
const ws = new WebSocket('ws://127.0.0.1:9090/ws');

ws.onopen = () => {
  ws.send(JSON.stringify({ type: 'auth', token: 'your-token' }));
  ws.send(JSON.stringify({ type: 'chat', message: '你好' }));
};

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'text') process.stdout.write(msg.content);
};
```

---

## 十、开发规范

你的应用如果要成为 KHY OS 生态的一部分，请遵守以下规范：

### 10.1 三大工程规则

1. **零硬编码** — 所有可变值（端口、路径、密钥、URL）必须走配置或环境变量
2. **状态透明** — 任何运行状态必须可查询、可导出
3. **活跃度超时** — 长连接/后台任务必须有超时和自愈机制

### 10.2 文件/命名规范

- 源码文件：`camelCase.js`
- CLI 命令：`kebab-case`
- 配置文件：`snake_case.json`
- 文档：`SCREAMING_SNAKE_CASE.md`

### 10.3 配置位置

| 范围 | 路径 | 说明 |
|------|------|------|
| 全局 | `~/.khy/` | 用户级配置、SDK、MCP、扩展 |
| 项目 | `.khy/` | 项目级技能、MCP、配置覆盖 |
| 运行时 | `~/.khyquant/` | Growth 数据、网关插件、运行状态 |

### 10.4 测试你的接入

```bash
# 检查 KHY OS 是否运行
curl http://127.0.0.1:9100/health

# 检查你的扩展是否加载
khy extension list

# 检查你的技能是否注册
khy skill list

# 检查你的 MCP 服务器是否连接
khy mcp status
```

---

## 十一、接入检查清单

开发完成后，用此清单验证：

- [ ] 应用能通过 `127.0.0.1:9100` 调用 AI（Level 0）
- [ ] 无硬编码端口/路径/密钥
- [ ] 配置通过环境变量或 `.khy/` 目录管理
- [ ] 长连接有超时和重连机制
- [ ] 技能有 `manifest.json` + `prompt.md`（Level 2+）
- [ ] 扩展有 `openclaw.plugin.json`（Level 3）
- [ ] `khy extension link` 可以加载你的扩展
- [ ] 文档更新到 KHY OS 学习课程（`learn edit add-topic`）

---

## 相关文档

- [KHY OS 开发者指南](%5BOPS-MAN-013%5D%20khy-os-开发者指南.md) — 环境搭建、构建、发布
- [KHY OS 用户指南](%5BOPS-MAN-015%5D%20khy-os-用户指南.md) — CLI 使用
- [KHY OS 学习课程](%5BOPS-MAN-011%5D%20khy-os-学习指南.md) — 从零学习
- [Claude Code 代理配置](%5BOPS-MAN-004%5D%20claude-code-代理配置.md) — Claude Code 接入
- [系统架构](../03_DESIGN_设计/%5BDESIGN-ARCH-010%5D%20核心架构.md) — 整体架构
