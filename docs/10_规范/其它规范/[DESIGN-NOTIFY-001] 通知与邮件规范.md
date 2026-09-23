# [DESIGN-NOTIFY-001] 通知与邮件规范

<!-- RULES-REGISTRY: NOTIFY-001 -->

> **用途**：定义 khy-os 系统通知、邮件发送、模板管理的统一标准。
> 当前项目中无统一邮件/通知系统（heartbeatService 有通知逻辑但未实现邮件投递）。

---

## 1. 原则

1. **异步投递**：通知不阻塞主流程，通过消息队列投递
2. **可配置**：用户可独立控制每种通知渠道的开关
3. **可追踪**：每个通知有唯一 ID，可查询投递状态
4. **可退订**：每封邮件包含退订链接（法律要求）
5. **模板化**：所有通知通过模板渲染，禁止硬编码文本

---

## 2. 通知类型

### 2.1 分类

| 类型 | 渠道 | 示例 | 优先级 |
|------|------|------|--------|
| 系统通知 | 站内信 + 邮件 | 服务维护通知、功能更新 | P1 |
| 安全通知 | 站内信 + 邮件 + 短信 | 异地登录、密码变更 | P0 |
| 任务通知 | 站内信 | 任务完成、审批请求 | P2 |
| 营销通知 | 邮件 | 新功能推荐、活动 | P3 |
| Webhook | HTTP POST | 第三方系统回调 | P2 |

### 2.2 渠道优先级

```
Webhook（如果配置）→ 站内信 → 邮件 → 短信
```

**规则**：高优先级渠道失败不阻塞低优先级渠道。

---

## 3. 邮件规范

### 3.1 发件人配置

| 环境 | 发件人 | 说明 |
|------|--------|------|
| 开发 | `dev@khyquant.local` | 仅本地投递 |
| 生产 | `noreply@khyquant.top` | 正式发件地址 |
| 备用 | `notify@khyquant.top` | 系统通知专用 |

### 3.2 传输安全

```
SMTP: STARTTLS 或 TLS 1.2+
端口: 587（STARTTLS）或 465（SMTPS）
认证: PLAIN / LOGIN（仅在 TLS 连接上）
```

**禁止**：
- 明文 SMTP（端口 25）
- 不验证 TLS 证书的连接
- 在日志中记录邮件正文

### 3.3 投递保障

| 参数 | 默认值 | 说明 |
|------|--------|------|
| 超时 | 10 秒 | 单封邮件发送超时 |
| 重试 | 3 次 | 指数退避：1s / 2s / 4s |
| 退队 | DLQ | 最终失败进入死信队列 |
| 批量限制 | 100/分钟 | 防止被邮件服务商限流 |

---

## 4. 模板系统

### 4.1 模板结构

```
services/backend/src/templates/email/
├── layouts/
│   ├── base.html          # 基础布局（Khy 品牌）
│   └── plain.txt           # 纯文本备用布局
├── locale/
│   ├── zh-CN/              # 中文模板
│   │   ├── password-reset.html
│   │   ├── password-reset.txt
│   │   ├── security-alert.html
│   │   └── security-alert.txt
│   └── en-US/              # 英文模板
│       ├── password-reset.html
│       └── password-reset.txt
└── registry.json           # 模板注册表
```

### 4.2 模板变量

| 变量 | 类型 | 说明 |
|------|------|------|
| `{{user.name}}` | 字符串 | 用户显示名称 |
| `{{user.email}}` | 字符串 | 用户邮箱 |
| `{{action.url}}` | URL | 操作链接（验证/重置等） |
| `{{action.token}}` | 字符串 | 操作令牌 |
| `{{action.expiresIn}}` | 字符串 | 链接有效期（如"24小时"） |
| `{{app.name}}` | 字符串 | 应用名称（"Khy"） |
| `{{app.url}}` | URL | 应用首页 |
| `{{support.email}}` | 邮箱 | 客服邮箱 |

### 4.3 模板示例

```html
<!-- password-reset.html -->
<!DOCTYPE html>
<html lang="{{locale}}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{subject}}</title>
  <style>
    body { font-family: -apple-system, sans-serif; color: #333; }
    .btn { background: #00BCD4; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; }
  </style>
</head>
<body>
  <p>你好，{{user.name}}！</p>
  <p>你请求重置密码，点击下方按钮继续：</p>
  <a href="{{action.url}}" class="btn">重置密码</a>
  <p>此链接将在 {{action.expiresIn}} 后过期。</p>
  <p>如果你未请求此操作，请忽略此邮件。</p>
  <hr>
  <p style="color: #999; font-size: 12px;">
    {{app.name}} · {{app.url}}<br>
    如需帮助请联系 {{support.email}}
  </p>
</body>
</html>
```

### 4.4 渲染引擎

```javascript
const nodemailer = require('nodemailer');
const consolidate = require('consolidate');

async function renderEmail(templateName, locale, data) {
  const html = await consolidate.ejs(
    fs.readFileSync(`templates/email/locale/${locale}/${templateName}.html`, 'utf8'),
    data
  );
  const text = await consolidate.ejs(
    fs.readFileSync(`templates/email/locale/${locale}/${templateName}.txt`, 'utf8'),
    data
  );
  return { html, text };
}
```

---

## 5. 通知投递

### 5.1 投递流程

```
触发事件
    ↓
选择模板（按 locale + 类型）
    ↓
渲染内容（HTML + 纯文本双版本）
    ↓
遍历用户通知偏好
    ↓
按渠道发送（Webhook → 站内信 → 邮件）
    ↓
记录投递日志
    ↓
失败 → 重试（指数退避） → DLQ
```

### 5.2 用户偏好

```javascript
{
  userId: 'user-123',
  preferences: {
    email: {
      enabled: true,
      categories: ['security', 'system'],  // 订阅的分类
      address: 'user@example.com'
    },
    webhook: {
      enabled: true,
      url: 'https://example.com/webhook',
      secret: 'webhook-secret'
    }
  }
}
```

---

## 6. 退订机制

### 6.1 邮件退订

```
https://api.khyquant.top/api/v1/notifications/unsubscribe?token=<signed-token>
```

| 参数 | 说明 |
|------|------|
| `token` | JWT，包含 userId + category，签名验证 |

**退订页**：
- 显示当前订阅的分类
- 允许逐项退订
- 保留"安全通知"不可退订（法律要求）

### 6.2 List-Unsubscribe 头

```http
List-Unsubscribe: <https://api.khyquant.top/api/v1/notifications/unsubscribe?token=xxx>,
                  <mailto:unsubscribe@khyquant.top?subject=unsubscribe>
```

---

## 7. Webhook 通知

### 7.1 配置

```javascript
{
  webhookId: 'wh-123',
  userId: 'user-123',
  url: 'https://example.com/webhook',
  secret: 'whsec_xxx',           // HMAC 签名密钥
  events: ['task.completed', 'security.alert'],
  active: true,
  createdAt: '2026-09-10T12:00:00.000Z'
}
```

### 7.2 投递

```http
POST https://example.com/webhook
Content-Type: application/json
X-Khy-Signature: sha256=<hmac>
X-Khy-Delivery: <delivery-id>
X-Khy-Timestamp: <unix-timestamp>

{
  "event": "task.completed",
  "timestamp": "2026-09-10T12:00:00.000Z",
  "data": { "taskId": "task-456", "status": "succeeded" }
}
```

### 7.3 签名验证

```javascript
function verifyWebhookSignature(payload, signature, secret) {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}
```

### 7.4 重试策略

| 参数 | 值 | 说明 |
|------|-----|------|
| 重试次数 | 5 | 最大重试次数 |
| 间隔 | 1m / 5m / 30m / 2h / 6h | 指数退避 |
| 超时 | 10s | 单次请求超时 |
| User-Agent | `Khy-Webhook/1.0` | 标识来源 |

**失败处理**：
- 连续 5 次失败 → 暂停 webhook，通知用户
- 4xx 错误 → 不重试（配置错误需人工处理）
- 5xx / 超时 → 按退避重试

---

## 8. 模板注册

```json
{
  "templates": {
    "password-reset": {
      "subject": "重置你的 {{app.name}} 密码",
      "categories": ["system"],
      "requiredVars": ["user.name", "action.url", "action.expiresIn"],
      "channels": ["email"],
      "priority": "high"
    },
    "security-alert": {
      "subject": "安全通知：{{app.name}} 账户异常活动",
      "categories": ["security"],
      "requiredVars": ["user.name", "alert.details", "action.url"],
      "channels": ["email", "inApp"],
      "priority": "critical"
    }
  }
}
```

---

## 9. 日志与审计

### 9.1 投递日志

```javascript
{
  deliveryId: 'del-xxx',
  template: 'password-reset',
  userId: 'user-123',
  channel: 'email',
  recipient: 'u***@example.com',
  status: 'sent',           // queued | sending | sent | failed | bounced
  sentAt: '2026-09-10T12:00:00.000Z',
  error: null,
  metadata: {
    messageId: '<smtp-message-id>',
    provider: 'smtp'
  }
}
```

### 9.2 审计要求

- 所有通知投递记录保留 180 天
- 安全通知必须记录（不可删除）
- 投递失败超过 3 次触发告警

---

## 10. 守卫

| 守卫 | 检查项 | 严重度 |
|------|--------|--------|
| `notify-gate` | 邮件必须同时提供 HTML 和纯文本版本 | P2 |
| `notify-gate` | 模板禁止硬编码用户敏感信息 | P1 |
| `notify-gate` | Webhook 必须验证 HMAC 签名 | P1 |
| `notify-gate` | 安全通知不可退订 | P0 |
| `notify-gate` | 邮件必须包含 List-Unsubscribe 头 | P1 |

---

## 11. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-10 | 初始版本，定义通知与邮件规范 |

---

*本规范由 khy-os 平台团队维护*
