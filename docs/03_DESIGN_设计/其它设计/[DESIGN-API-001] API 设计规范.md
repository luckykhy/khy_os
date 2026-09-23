# [DESIGN-API-001] API 设计规范

> 本文档定义 khy-os 项目的 API 设计标准，包括命名、版本控制、请求/响应格式等。

---

## 1. API 概述

### 1.1 设计原则

1. **RESTful 风格**：遵循 REST 设计原则
2. **一致性**：所有 API 使用统一的格式和约定
3. **版本化**：API 版本化，避免破坏性变更
4. **安全性**：所有 API 都需要认证（公开端点除外）

### 1.2 协议基础

**基础 URL**：
```
开发环境: http://localhost:3000/api/v1
生产环境: https://api.khyquant.top/api/v1
```

**Content-Type**：`application/json`

**字符编码**：`UTF-8`

---

## 2. URL 设计规范

### 2.1 URL 结构

```
/api/v1/{resource}
/api/v1/{resource}/{id}
/api/v1/{resource}/{id}/{sub-resource}
```

**示例**：
```
GET    /api/v1/users
GET    /api/v1/users/123
GET    /api/v1/users/123/orders
POST   /api/v1/users/123/orders
PUT    /api/v1/users/123/orders/456
DELETE /api/v1/users/123/orders/456
```

### 2.2 命名规则

**资源名称**：
- 使用复数名词：`users`、`orders`、`products`
- 使用小写字母：`user-profile`、`order-items`
- 使用连字符分隔：`api-keys`、`trading-strategies`

**查询参数**：
- 使用 camelCase：`pageSize`、`sortBy`、`filterBy`
- 分页参数统一：`page`、`pageSize`
- 排序参数统一：`sort`、`order`

### 2.3 HTTP 方法

| 方法 | 用途 | 幂等性 | 安全性 |
|------|------|--------|--------|
| GET | 获取资源 | ✅ | ✅ |
| POST | 创建资源 | ❌ | ❌ |
| PUT | 更新资源（全量） | ✅ | ❌ |
| PATCH | 更新资源（部分） | ❌ | ❌ |
| DELETE | 删除资源 | ✅ | ❌ |

---

## 3. 请求规范

### 3.1 请求头

**必需请求头**：
```http
Content-Type: application/json
Authorization: Bearer <jwt-token>
X-Request-ID: <uuid>
```

**可选请求头**：
```http
Accept: application/json
Accept-Language: zh-CN,en-US
X-Client-Version: 1.0.0
X-Client-Platform: web|mobile|cli
```

### 3.2 请求体

**创建/更新请求**：
```json
{
  "name": "策略名称",
  "description": "策略描述",
  "config": {
    "key": "value"
  }
}
```

### 3.3 查询参数

**分页**：
```
GET /api/v1/users?page=1&pageSize=20
```

**排序**：
```
GET /api/v1/users?sort=createdAt&order=desc
```

**过滤**：
```
GET /api/v1/users?status=active&role=admin
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

## 4. 响应规范

### 4.1 成功响应

**单资源响应**：
```json
{
  "success": true,
  "data": {
    "id": 123,
    "name": "张三",
    "email": "zhangsan@example.com"
  },
  "metadata": {
    "requestId": "req-uuid",
    "timestamp": "2026-09-04T12:00:00.000Z"
  }
}
```

**列表响应**：
```json
{
  "success": true,
  "data": [
    { "id": 1, "name": "张三" },
    { "id": 2, "name": "李四" }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "total": 100,
    "totalPages": 5
  },
  "metadata": {
    "requestId": "req-uuid",
    "timestamp": "2026-09-04T12:00:00.000Z"
  }
}
```

**创建成功响应**（201）：
```json
{
  "success": true,
  "data": {
    "id": 123,
    "name": "新策略"
  },
  "message": "创建成功"
}
```

### 4.2 错误响应

**验证错误**（400）：
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "type": "USER_ERROR",
    "message": "请求参数验证失败",
    "details": [
      {
        "field": "email",
        "message": "邮箱格式不正确",
        "value": "invalid-email"
      }
    ]
  },
  "metadata": {
    "requestId": "req-uuid",
    "timestamp": "2026-09-04T12:00:00.000Z"
  }
}
```

**认证错误**（401）：
```json
{
  "success": false,
  "error": {
    "code": "AUTH_TOKEN_EXPIRED",
    "type": "AUTH_ERROR",
    "message": "认证令牌已过期，请重新登录"
  }
}
```

**授权错误**（403）：
```json
{
  "success": false,
  "error": {
    "code": "PERM_INSUFFICIENT",
    "type": "AUTH_ERROR",
    "message": "权限不足，无法访问此资源"
  }
}
```

**未找到错误**（404）：
```json
{
  "success": false,
  "error": {
    "code": "RES_NOT_FOUND",
    "type": "RESOURCE_ERROR",
    "message": "请求的资源不存在"
  }
}
```

**服务器错误**（500）：
```json
{
  "success": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "type": "INTERNAL_ERROR",
    "message": "服务器内部错误，请稍后重试"
  }
}
```

---

## 5. 状态码使用

### 5.1 成功状态码

| 状态码 | 说明 | 使用场景 |
|--------|------|---------|
| 200 | OK | 请求成功 |
| 201 | Created | 资源创建成功 |
| 204 | No Content | 删除成功（无返回内容） |

### 5.2 客户端错误

| 状态码 | 说明 | 使用场景 |
|--------|------|---------|
| 400 | Bad Request | 请求参数错误 |
| 401 | Unauthorized | 未认证 |
| 403 | Forbidden | 无权限 |
| 404 | Not Found | 资源不存在 |
| 409 | Conflict | 资源冲突 |
| 422 | Unprocessable Entity | 验证失败 |
| 429 | Too Many Requests | 请求限流 |

### 5.3 服务器错误

| 状态码 | 说明 | 使用场景 |
|--------|------|---------|
| 500 | Internal Server Error | 服务器内部错误 |
| 502 | Bad Gateway | 网关错误 |
| 503 | Service Unavailable | 服务不可用 |
| 504 | Gateway Timeout | 网关超时 |

---

## 6. 认证规范

### 6.1 JWT 认证

**Token 格式**：
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
    "scope": ["read", "write"]
  }
}
```

**请求头**：
```http
Authorization: Bearer <jwt-token>
```

### 6.2 API Key 认证

**请求头**：
```http
X-API-Key: <api-key>
```

### 6.3 认证错误处理

**Token 过期**：
```json
{
  "success": false,
  "error": {
    "code": "AUTH_TOKEN_EXPIRED",
    "type": "AUTH_ERROR",
    "message": "认证令牌已过期",
    "action": "REFRESH_TOKEN"
  }
}
```

---

## 7. 速率限制

### 7.1 限制策略

| 端点类型 | 限制 | 窗口 |
|---------|------|------|
| 公开端点 | 60 次 | 1 分钟 |
| 认证端点 | 5 次 | 1 分钟 |
| 普通 API | 100 次 | 1 分钟 |
| 管理 API | 30 次 | 1 分钟 |

### 7.2 响应头

```http
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1693833600
```

### 7.3 超限响应

```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "type": "RATE_ERROR",
    "message": "请求过于频繁，请稍后重试",
    "retryAfter": 60
  }
}
```

---

## 8. 版本控制

### 8.1 版本策略

**URL 版本化**：
```
/api/v1/users
/api/v2/users
```

**请求头版本化**（可选）：
```http
Accept: application/vnd.khy.v1+json
```

### 8.2 版本兼容性

- 次版本号变更：向下兼容
- 主版本号变更：可能不兼容
- 废弃功能至少保留一个版本周期

### 8.3 版本废弃通知

```http
Deprecation: true
Sunset: Sat, 01 Mar 2026 00:00:00 GMT
Link: </api/v2/users>; rel="successor-version"
```

---

## 9. CORS 规范

### 9.1 允许的来源

```
开发环境: http://localhost:*
生产环境: https://khyquant.top, https://*.khyquant.top
```

### 9.2 允许的方法

```
GET, POST, PUT, PATCH, DELETE, OPTIONS
```

### 9.3 允许的请求头

```
Content-Type, Authorization, X-Request-ID, X-Client-Version, X-Client-Platform
```

### 9.4 预检请求缓存

```
Access-Control-Max-Age: 86400
```

---

## 10. 日志规范

### 10.1 请求日志

**格式**：
```
[timestamp] [level] [requestId] [method] [path] [status] [duration] [userAgent] [clientIp]
```

**示例**：
```
2026-09-04T12:00:00.000Z INFO req-uuid GET /api/v1/users 200 150ms "Mozilla/5.0" 192.168.1.1
```

### 10.2 错误日志

**格式**：
```
[timestamp] [level] [requestId] [method] [path] [error] [stack]
```

---

## 11. 安全规范

### 11.1 输入验证

- 所有输入必须验证
- 使用白名单验证
- 防止 SQL 注入、XSS、CSRF

### 11.2 敏感数据

- 密码必须加密存储
- API Key 必须加密存储
- 日志中不得包含敏感数据

### 11.3 HTTPS

- 生产环境必须使用 HTTPS
- 使用 HSTS 头

---

## 12. 文档规范

### 12.1 API 文档

- 使用 OpenAPI 3.0 规范
- 提供请求/响应示例
- 包含错误码说明

### 12.2 变更日志

- 记录所有 API 变更
- 标注废弃功能
- 提供迁移指南

---

## 13. 示例

### 13.1 用户注册

**请求**：
```http
POST /api/v1/auth/register
Content-Type: application/json

{
  "username": "john",
  "email": "john@example.com",
  "password": "securePassword123"
}
```

**响应**（201）：
```json
{
  "success": true,
  "data": {
    "id": 123,
    "username": "john",
    "email": "john@example.com",
    "createdAt": "2026-09-04T12:00:00.000Z"
  },
  "message": "注册成功"
}
```

### 13.2 用户登录

**请求**：
```http
POST /api/v1/auth/login
Content-Type: application/json

{
  "email": "john@example.com",
  "password": "securePassword123"
}
```

**响应**（200）：
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "refresh-token",
    "expiresIn": 3600,
    "user": {
      "id": 123,
      "username": "john",
      "email": "john@example.com"
    }
  }
}
```

### 13.3 获取用户列表

**请求**：
```http
GET /api/v1/users?page=1&pageSize=20&sort=createdAt&order=desc
Authorization: Bearer <jwt-token>
```

**响应**（200）：
```json
{
  "success": true,
  "data": [
    {
      "id": 123,
      "username": "john",
      "email": "john@example.com",
      "createdAt": "2026-09-04T12:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "total": 100,
    "totalPages": 5
  }
}
```

---

## 14. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本，定义 API 设计规范 |

---

*本规范由 khy-os API 设计团队维护*