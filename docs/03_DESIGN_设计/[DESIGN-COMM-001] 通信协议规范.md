# [DESIGN-COMM-001] 通信协议规范

> 本文档定义 khy-os 项目中服务间通信的统一协议规范。

---

## 1. 协议概述

### 1.1 设计目标

**通信协议规范**旨在统一：
- **HTTP REST API**：前后端通信
- **WebSocket**：实时双向通信
- **SSE**：服务器推送事件
- **IPC**：进程间通信
- **RPC**：远程过程调用

### 1.2 设计原则

1. **一致性**：所有通信使用统一的消息格式
2. **可扩展**：支持新协议和消息类型
3. **可靠性**：完整的错误处理和重试机制
4. **安全性**：端到端加密和认证
5. **可观测**：完整的日志和监控

### 1.3 协议版本

- **当前版本**：`1.0.0`
- **协议标识**：`khy-comm/1.0`
- **兼容版本**：无（初始版本）

---

## 2. 消息格式规范

### 2.1 HTTP 响应信封

**成功响应**：
```json
{
  "success": true,
  "data": {},
  "message": "操作成功",
  "metadata": {
    "requestId": "req-uuid",
    "timestamp": "2026-09-04T12:00:00.000Z",
    "version": "1.0.0"
  },
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "total": 100,
    "totalPages": 5
  }
}
```

**错误响应**：
```json
{
  "success": false,
  "message": "错误描述",
  "error": {
    "code": "ERROR_CODE",
    "type": "VALIDATION_ERROR",
    "details": {},
    "stack": "堆栈信息（仅开发环境）"
  },
  "metadata": {
    "requestId": "req-uuid",
    "timestamp": "2026-09-04T12:00:00.000Z"
  }
}
```

**字段说明**：
- `success`：操作是否成功
- `data`：响应数据
- `message`：人类可读的消息
- `error`：错误信息（仅失败时）
- `metadata`：请求元数据
- `pagination`：分页信息（仅列表接口）

### 2.2 WebSocket 消息格式

**请求消息**：
```json
{
  "type": "request",
  "id": "msg-uuid",
  "method": "service.action",
  "params": {},
  "metadata": {
    "timestamp": "2026-09-04T12:00:00.000Z",
    "timeout": 30000
  }
}
```

**响应消息**：
```json
{
  "type": "response",
  "id": "msg-uuid",
  "result": {},
  "error": null,
  "metadata": {
    "timestamp": "2026-09-04T12:00:00.000Z",
    "processingTime": 150
  }
}
```

**事件消息**：
```json
{
  "type": "event",
  "event": "event.name",
  "data": {},
  "metadata": {
    "timestamp": "2026-09-04T12:00:00.000Z",
    "source": "service-name"
  }
}
```

**心跳消息**：
```json
{
  "type": "ping",
  "id": "ping-uuid",
  "timestamp": 1693833600000
}
```

```json
{
  "type": "pong",
  "id": "ping-uuid",
  "timestamp": 1693833600000
}
```

### 2.3 SSE 消息格式

**事件格式**：
```
event: message_type
id: event-uuid
data: {"key": "value"}

```

**事件类型**：
- `message`：普通消息
- `error`：错误消息
- `heartbeat`：心跳消息
- `close`：关闭消息

**示例**：
```
event: ai_response
id: resp-001
data: {"content": "AI回复内容", "model": "gpt-4", "tokens": 150}

event: tool_call
id: tool-001
data: {"name": "search", "arguments": {"query": "关键词"}}

event: heartbeat
id: hb-001
data: {"timestamp": 1693833600000}

```

### 2.4 IPC 消息格式

**二进制协议**：
```
┌─────────┬─────────┬─────────┬─────────┬─────────┐
│ Magic   │ Version │ Type    │ Length  │ Payload │
│ (2B)    │ (1B)    │ (1B)    │ (4B)    │ (nB)    │
└─────────┴─────────┴─────────┴─────────┴─────────┘
```

**字段说明**：
- Magic：魔数，固定为 `0x4B48` ("KH")
- Version：协议版本，当前为 `0x01`
- Type：消息类型
- Length：负载长度（大端序）
- Payload：消息负载

**消息类型**：
- `0x01`：请求
- `0x02`：响应
- `0x03`：事件
- `0x04`：心跳

---

## 3. HTTP REST API 规范

### 3.1 URL 设计

**格式**：
```
/api/v{version}/{resource}
/api/v{version}/{resource}/{id}
/api/v{version}/{resource}/{id}/{sub-resource}
```

**示例**：
```
GET    /api/v1/users
GET    /api/v1/users/123
POST   /api/v1/users
PUT    /api/v1/users/123
DELETE /api/v1/users/123
GET    /api/v1/users/123/orders
```

### 3.2 HTTP 方法

| 方法 | 用途 | 幂等性 | 安全性 |
|------|------|--------|--------|
| GET | 获取资源 | ✅ | ✅ |
| POST | 创建资源 | ❌ | ❌ |
| PUT | 更新资源（全量） | ✅ | ❌ |
| PATCH | 更新资源（部分） | ❌ | ❌ |
| DELETE | 删除资源 | ✅ | ❌ |

### 3.3 状态码使用

**成功状态码**：
- `200 OK`：请求成功
- `201 Created`：资源创建成功
- `204 No Content`：删除成功（无返回内容）

**客户端错误**：
- `400 Bad Request`：请求参数错误
- `401 Unauthorized`：未认证
- `403 Forbidden`：无权限
- `404 Not Found`：资源不存在
- `409 Conflict`：资源冲突
- `422 Unprocessable Entity`：验证失败
- `429 Too Many Requests`：请求限流

**服务端错误**：
- `500 Internal Server Error`：服务器内部错误
- `502 Bad Gateway`：网关错误
- `503 Service Unavailable`：服务不可用
- `504 Gateway Timeout`：网关超时

### 3.4 请求头规范

**标准请求头**：
```http
Content-Type: application/json
Accept: application/json
Authorization: Bearer <jwt-token>
X-Request-ID: <uuid>
X-Client-Version: 1.0.0
X-Client-Platform: web|mobile|cli
Accept-Language: zh-CN,en-US
```

**标准响应头**：
```http
Content-Type: application/json
X-Request-ID: <uuid>
X-Response-Time: 150
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1693833600
```

### 3.5 分页规范

**请求参数**：
```
GET /api/v1/users?page=1&pageSize=20&sort=createdAt&order=desc
```

**响应格式**：
```json
{
  "success": true,
  "data": [],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "total": 100,
    "totalPages": 5,
    "hasNext": true,
    "hasPrev": false
  }
}
```

### 3.6 过滤和搜索

**过滤**：
```
GET /api/v1/users?status=active&role=admin
GET /api/v1/orders?createdAt[gte]=2026-01-01&createdAt[lte]=2026-12-31
```

**搜索**：
```
GET /api/v1/users?q=john&fields=name,email
```

**字段选择**：
```
GET /api/v1/users?fields=id,name,email
```

---

## 4. WebSocket 规范

### 4.1 连接管理

**连接地址**：
```
ws://host:port/ws/v1
wss://host:port/ws/v1
```

**握手请求**：
```http
GET /ws/v1 HTTP/1.1
Host: localhost:3000
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
Authorization: Bearer <jwt-token>
```

**握手响应**：
```http
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
```

### 4.2 消息类型

**文本消息**：JSON 格式
```json
{
  "type": "request",
  "id": "msg-001",
  "method": "chat.send",
  "params": {
    "content": "Hello"
  }
}
```

**二进制消息**：用于文件传输
```
[Header (4B)] [Payload (nB)]
```

### 4.3 心跳机制

**心跳间隔**：30 秒

**心跳流程**：
1. 客户端发送 ping 消息
2. 服务端响应 pong 消息
3. 超过 60 秒无响应，断开连接

**心跳消息**：
```json
{
  "type": "ping",
  "id": "ping-001",
  "timestamp": 1693833600000
}
```

### 4.4 重连机制

**重连策略**：
- 初始延迟：1 秒
- 最大延迟：30 秒
- 退避因子：2
- 最大重试：10 次

**重连流程**：
1. 检测连接断开
2. 等待退避时间
3. 尝试重新连接
4. 恢复订阅和状态
5. 重连失败，通知上层

### 4.5 订阅机制

**订阅请求**：
```json
{
  "type": "subscribe",
  "id": "sub-001",
  "channel": "ai.responses",
  "filter": {
    "model": "gpt-4"
  }
}
```

**订阅确认**：
```json
{
  "type": "subscribed",
  "id": "sub-001",
  "channel": "ai.responses",
  "subscriptionId": "sub-uuid"
}
```

**取消订阅**：
```json
{
  "type": "unsubscribe",
  "id": "unsub-001",
  "subscriptionId": "sub-uuid"
}
```

---

## 5. SSE 规范

### 5.1 连接管理

**连接地址**：
```
GET /api/v1/events
GET /api/v1/events?channel=ai&model=gpt-4
```

**请求头**：
```http
Accept: text/event-stream
Cache-Control: no-cache
Authorization: Bearer <jwt-token>
```

**响应头**：
```http
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

### 5.2 事件格式

**标准事件**：
```
event: message
id: event-001
data: {"content": "Hello", "model": "gpt-4"}

```

**多行数据**：
```
event: message
id: event-002
data: {"content": "第一行"}
data: {"content": "第二行"}

```

**重试间隔**：
```
retry: 5000
event: message
data: {"content": "Hello"}

```

### 5.3 事件类型

| 事件类型 | 说明 | 数据格式 |
|---------|------|---------|
| `message` | 普通消息 | `{content, model, tokens}` |
| `tool_call` | 工具调用 | `{name, arguments, id}` |
| `tool_result` | 工具结果 | `{id, result, error}` |
| `error` | 错误 | `{code, message}` |
| `heartbeat` | 心跳 | `{timestamp}` |
| `done` | 完成 | `{usage, cost}` |

### 5.4 错误处理

**错误事件**：
```
event: error
data: {"code": "RATE_LIMIT", "message": "请求过于频繁，请稍后重试"}

```

**连接关闭**：
```
event: close
data: {"reason": "timeout", "retry": true}

```

---

## 6. IPC 规范

### 6.1 通信方式

**命名管道**：
- Windows：`\\.\pipe\khy-{name}`
- Unix：`/tmp/khy-{name}.sock`

**共享内存**：
- 用于高性能数据传输
- 配合信号量同步

### 6.2 消息格式

**请求消息**：
```
┌─────────┬─────────┬─────────┬─────────┬─────────┬─────────┐
│ Magic   │ Version │ Type    │ ID      │ Length  │ Payload │
│ (2B)    │ (1B)    │ (1B)    │ (4B)    │ (4B)    │ (nB)    │
└─────────┴─────────┴─────────┴─────────┴─────────┴─────────┘
```

**响应消息**：
```
┌─────────┬─────────┬─────────┬─────────┬─────────┬─────────┬─────────┐
│ Magic   │ Version │ Type    │ ID      │ Status  │ Length  │ Payload │
│ (2B)    │ (1B)    │ (1B)    │ (4B)    │ (2B)    │ (4B)    │ (nB)    │
└─────────┴─────────┴─────────┴─────────┴─────────┴─────────┴─────────┘
```

### 6.3 状态码

| 状态码 | 名称 | 说明 |
|--------|------|------|
| 0x0000 | SUCCESS | 成功 |
| 0x0001 | INVALID_REQUEST | 无效请求 |
| 0x0002 | NOT_FOUND | 未找到 |
| 0x0003 | PERMISSION_DENIED | 权限拒绝 |
| 0x0004 | TIMEOUT | 超时 |
| 0x0005 | INTERNAL_ERROR | 内部错误 |

### 6.4 连接管理

**连接建立**：
1. 创建命名管道/Unix Socket
2. 等待客户端连接
3. 握手认证
4. 建立消息通道

**连接断开**：
1. 发送关闭消息
2. 等待确认
3. 清理资源
4. 记录日志

---

## 7. 错误处理规范

### 7.1 错误分类

| 分类 | 说明 | HTTP 状态码 | 错误码前缀 |
|------|------|------------|-----------|
| 用户错误 | 请求参数错误 | 4xx | `USER_` |
| 认证错误 | 认证失败 | 401 | `AUTH_` |
| 授权错误 | 权限不足 | 403 | `PERM_` |
| 资源错误 | 资源不存在 | 404 | `RES_` |
| 业务错误 | 业务逻辑错误 | 422 | `BIZ_` |
| 限流错误 | 请求过于频繁 | 429 | `RATE_` |
| 网络错误 | 网络问题 | 502/503 | `NET_` |
| 内部错误 | 服务器内部错误 | 500 | `INT_` |

### 7.2 错误码定义

**用户错误**：
- `USER_INVALID_PARAM`：无效参数
- `USER_MISSING_PARAM`：缺少参数
- `USER_INVALID_FORMAT`：格式错误

**认证错误**：
- `AUTH_TOKEN_EXPIRED`：Token 过期
- `AUTH_TOKEN_INVALID`：Token 无效
- `AUTH_CREDENTIALS_INVALID`：凭据无效

**授权错误**：
- `PERM_DENIED`：权限拒绝
- `PERM_INSUFFICIENT`：权限不足

**资源错误**：
- `RES_NOT_FOUND`：资源不存在
- `RES_ALREADY_EXISTS`：资源已存在
- `RES_CONFLICT`：资源冲突

**业务错误**：
- `BIZ_VALIDATION_FAILED`：验证失败
- `BIZ_STATE_INVALID`：状态无效
- `BIZ_OPERATION_FAILED`：操作失败

**限流错误**：
- `RATE_LIMIT_EXCEEDED`：超出限流
- `RATE_QUOTA_EXCEEDED`：超出配额

**网络错误**：
- `NET_CONNECTION_FAILED`：连接失败
- `NET_TIMEOUT`：网络超时
- `NET_DNS_FAILED`：DNS 解析失败

**内部错误**：
- `INT_INTERNAL_ERROR`：内部错误
- `INT_SERVICE_UNAVAILABLE`：服务不可用
- `INT_DEPENDENCY_FAILED`：依赖失败

### 7.3 错误响应格式

**标准错误响应**：
```json
{
  "success": false,
  "message": "用户友好的错误描述",
  "error": {
    "code": "USER_INVALID_PARAM",
    "type": "VALIDATION_ERROR",
    "details": {
      "field": "email",
      "message": "邮箱格式不正确",
      "value": "invalid-email"
    },
    "stack": "Error: ...\n    at ...",
    "timestamp": "2026-09-04T12:00:00.000Z",
    "requestId": "req-uuid"
  }
}
```

### 7.4 错误处理流程

**客户端错误处理**：
1. 捕获网络异常
2. 解析错误响应
3. 根据错误类型处理
4. 显示用户友好消息
5. 记录错误日志

**服务端错误处理**：
1. 捕获业务异常
2. 记录详细日志
3. 返回标准错误响应
4. 发送告警（严重错误）
5. 更新监控指标

---

## 8. 安全规范

### 8.1 认证机制

**JWT Token**：
```json
{
  "header": {
    "alg": "RS256",
    "typ": "JWT"
  },
  "payload": {
    "iss": "khy-auth",
    "sub": "user-id",
    "aud": "khy-api",
    "exp": 1693833600,
    "iat": 1693830000,
    "scope": ["read", "write"],
    "roles": ["user", "admin"]
  }
}
```

**认证流程**：
1. 用户登录，获取 Token
2. 请求携带 Token
3. 服务端验证 Token
4. 提取用户信息
5. 检查权限

### 8.2 授权机制

**RBAC 角色**：
```json
{
  "roles": {
    "admin": {
      "permissions": ["*"]
    },
    "user": {
      "permissions": [
        "users:read",
        "users:update:self",
        "orders:read",
        "orders:create"
      ]
    },
    "guest": {
      "permissions": [
        "users:read:self"
      ]
    }
  }
}
```

### 8.3 加密通信

**TLS 配置**：
- 最低版本：TLS 1.2
- 推荐版本：TLS 1.3
- 密码套件：强密码套件
- 证书验证：双向认证（可选）

**数据加密**：
- 敏感字段加密存储
- 传输数据加密
- 密钥安全存储

### 8.4 输入验证

**验证规则**：
- 类型检查
- 长度限制
- 格式验证
- 范围检查
- 白名单验证

**防护措施**：
- SQL 注入防护
- XSS 防护
- CSRF 防护
- 文件上传防护

---

## 9. 性能规范

### 9.1 响应时间

| 接口类型 | 目标响应时间 | 最大响应时间 |
|---------|-------------|-------------|
| 简单查询 | < 100ms | 500ms |
| 复杂查询 | < 500ms | 2s |
| 写入操作 | < 200ms | 1s |
| 批量操作 | < 1s | 5s |

### 9.2 并发处理

**连接池配置**：
```json
{
  "pool": {
    "min": 5,
    "max": 20,
    "idleTimeout": 30000,
    "connectionTimeout": 5000
  }
}
```

**限流配置**：
```json
{
  "rateLimit": {
    "windowMs": 60000,
    "max": 100,
    "message": "请求过于频繁，请稍后重试"
  }
}
```

### 9.3 缓存策略

**缓存层次**：
- 浏览器缓存
- CDN 缓存
- 应用缓存
- 数据库缓存

**缓存配置**：
```json
{
  "cache": {
    "ttl": 300,
    "maxSize": 1000,
    "strategy": "lru"
  }
}
```

---

## 10. 监控规范

### 10.1 监控指标

**性能指标**：
- 响应时间（P50/P90/P99）
- 吞吐量（QPS）
- 错误率
- 并发连接数

**业务指标**：
- 用户活跃度
- 功能使用率
- 业务成功率

### 10.2 日志规范

**日志格式**：
```json
{
  "timestamp": "2026-09-04T12:00:00.000Z",
  "level": "info",
  "message": "请求处理完成",
  "context": {
    "requestId": "req-uuid",
    "method": "GET",
    "path": "/api/v1/users",
    "statusCode": 200,
    "duration": 150,
    "userAgent": "Mozilla/5.0",
    "clientIp": "192.168.1.1"
  }
}
```

**日志级别**：
- `error`：错误日志
- `warn`：警告日志
- `info`：信息日志
- `debug`：调试日志

### 10.3 告警规则

**告警阈值**：
- 错误率 > 5%
- 响应时间 P99 > 5s
- 并发连接 > 80%
- 磁盘使用 > 90%

**告警通知**：
- 邮件通知
- 短信通知
- 即时通讯通知

---

## 11. 测试规范

### 11.1 接口测试

**测试覆盖**：
- 正常流程测试
- 异常流程测试
- 边界条件测试
- 性能测试

**测试工具**：
- Jest/Vitest（单元测试）
- Supertest（HTTP 测试）
- Artillery（性能测试）

### 11.2 契约测试

**契约定义**：
```yaml
openapi: 3.0.0
info:
  title: khy-os API
  version: 1.0.0
paths:
  /api/v1/users:
    get:
      summary: 获取用户列表
      responses:
        '200':
          description: 成功
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/UserList'
```

**契约验证**：
```bash
npm run check:protocol-contracts
```

---

## 12. 相关文档

- `[DESIGN-ARCH-072]` 项目规范化总纲
- `[DESIGN-A2A-001]` A2A 协议规范
- `[DESIGN-MEM-001]` 记忆系统标准规范

---

## 13. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本，定义通信协议规范 |

---

*本规范由 khy-os 架构团队维护*