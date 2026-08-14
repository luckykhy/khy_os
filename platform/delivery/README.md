# 跨平台交付工具 (Cross-Platform Delivery Tool)

将同一份内容投递到 Slack、Notion、Markdown、Webhook、Email、API 等多个平台，
并通过 DiffEngine 进行一致性校验。

## 快速开始

```js
const { DeliveryController } = require('./platform/delivery/deliveryController');

const controller = new DeliveryController({
  platforms: {
    slack: { botToken: process.env.SLACK_TOKEN, channel: '#general' },
    notion: { apiKey: process.env.NOTION_TOKEN, defaultPageId: 'xxx' },
    markdown: { outputDir: './deliveries' },
  },
  maxConcurrency: 3,
});

await controller.init();

const report = await controller.deliver({
  content: '# Hello World\n\nThis is a test message.',
  platforms: ['markdown', 'slack', 'notion'],
  priority: 1,
  metadata: { author: 'khy', tags: ['test'] },
});

console.log(report);
```

## API 接口

### POST /api/delivery/send
投递内容到指定平台。

```bash
curl -X POST http://localhost:3000/api/delivery/send \
  -H "Content-Type: application/json" \
  -d '{
    "content": "# Report\n\nSales: $1.2M",
    "platforms": ["markdown", "slack"],
    "priority": 1
  }'
```

### GET /api/delivery/status/:taskId
查询任务状态。

### GET /api/delivery/tasks
列出所有任务（支持 ?status=completed&platforms=slack,notion）。

### GET /api/delivery/adapters
查看所有适配器状态。

### GET /api/delivery/templates
列出所有 Prompt 模板。

### POST /api/delivery/validate
验证输入（不实际投递）。

### POST /api/delivery/retry/:taskId
重试失败的任务。

## 架构

```
User Request
    │
    ▼
DeliveryController
    │
    ├── TaskStore (persistence)
    ├── TaskQueue (concurrency control)
    │
    ▼
Orchestrator
    │
    ├── SlackAdapter ──────► Slack Web API
    ├── NotionAdapter ─────► Notion REST API
    ├── MarkdownAdapter ───► File System
    ├── WebhookAdapter ────► HTTP POST
    ├── EmailAdapter ──────► SMTP
    └── ApiAdapter ────────► Arbitrary API
    │
    ▼
DiffEngine (consistency check)
    │
    ▼
Delivery Report
```

## Prompt 模板

所有平台适配器的 Prompt 模板存储在 `platform/delivery/adapters/prompts/`：

| 模板 | 用途 |
|---|---|
| `slack.prompt.md` | Slack Block Kit 消息生成 |
| `notion.prompt.md` | Notion 页面/数据库条目创建 |
| `markdown.prompt.md` | Markdown 文件生成 |
| `webhook.prompt.md` | Webhook HTTP POST 调用 |
| `email.prompt.md` | 邮件生成 |
| `api.prompt.md` | REST API 调用 |

## DiffEngine 校验规则

| 规则 | 级别 | 说明 |
|---|---|---|
| R1 语义一致性 | CRITICAL | 各平台核心信息完全一致 |
| R2 截断检查 | HIGH | 内容未超出平台限制 |
| R3 格式合规 | MEDIUM | 投递格式符合平台规范 |
| R4 链接有效性 | MEDIUM | 链接可访问 |
| R5 敏感信息泄露 | CRITICAL | 密钥未泄露 |
| R6 平台特性 | LOW | 利用平台最佳实践 |

## 给其他 Agent 写 Prompt 的最佳实践

### 1. 角色定义
开头明确 Agent 的身份和职责范围，避免模糊。

### 2. 输入格式
用 JSON Schema 明确输入字段，Agent 才能正确解析。

### 3. 规则分层
- **必须遵守**（违反则失败）：用 `必须`、`禁止`、`永远不要`
- **优先执行**（有更好）：用 `优先`、`建议`、`推荐`
- **可选优化**：用 `可以`、`可选`、`建议`

### 4. 输出格式
固定输出 JSON schema，包含 success、error、data 字段。

### 5. 异常处理
列出每个平台可能的错误码及处理策略。

### 6. 示例
每个 Prompt 至少包含一个输入→输出示例。

## 目录结构

```
platform/delivery/
├── deliveryController.js      # 主入口
├── orchestrator/
│   ├── orchestratorAgent.js   # 调度总控实现
│   └── orchestrator.prompt.md # 调度总控 Prompt
├── adapters/
│   ├── baseAdapter.js         # 适配器基类
│   ├── index.js               # 导出
│   ├── promiseTimeout.js      # 超时工具
│   ├── slackAdapter.js        # Slack
│   ├── notionAdapter.js       # Notion
│   ├── markdownAdapter.js     # Markdown 文件
│   ├── webhookAdapter.js      # Webhook
│   ├── emailAdapter.js        # Email
│   ├── apiAdapter.js          # REST API
│   └── prompts/
│       ├── slack.prompt.md
│       ├── notion.prompt.md
│       ├── markdown.prompt.md
│       ├── webhook.prompt.md
│       ├── email.prompt.md
│       └── api.prompt.md
├── diff/
│   ├── diffEngine.js          # 一致性校验器
│   └── diff.prompt.md         # DiffEngine Prompt
├── tasks/
│   ├── taskStore.js           # 持久化 (SQLite/JSON)
│   └── taskQueue.js           # 任务队列
├── templates/
│   └── templateRegistry.js    # Prompt 模板管理
└── routes/
    └── delivery.routes.js     # Express 路由
```
