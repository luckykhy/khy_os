# [DESIGN-ERR-001] 错误处理规范

> 本文档定义 khy-os 项目的错误处理标准，包括错误码、错误格式、错误传播等。

---

## 1. 错误处理概述

### 1.1 设计原则

1. **统一格式**：所有错误使用统一的响应格式
2. **错误码化**：每个错误都有唯一的错误码
3. **可追溯**：错误包含足够的上下文信息
4. **用户友好**：错误消息对用户友好

### 1.2 错误分类

| 分类 | 说明 | HTTP 状态码 |
|------|------|------------|
| 用户错误 | 请求参数错误 | 4xx |
| 认证错误 | 认证失败 | 401 |
| 授权错误 | 权限不足 | 403 |
| 资源错误 | 资源不存在 | 404 |
| 业务错误 | 业务逻辑错误 | 422 |
| 限流错误 | 请求过于频繁 | 429 |
| 网络错误 | 网络问题 | 502/503 |
| 内部错误 | 服务器内部错误 | 500 |

---

## 2. 错误码定义

### 2.1 错误码格式

**格式**：`{CATEGORY}_{ERROR_TYPE}`

**示例**：
- `USER_INVALID_PARAM` - 用户参数无效
- `AUTH_TOKEN_EXPIRED` - 认证令牌过期
- `RES_NOT_FOUND` - 资源不存在

### 2.2 错误码表

#### 用户错误（USER_）

| 错误码 | 说明 | 消息 |
|--------|------|------|
| USER_INVALID_PARAM | 参数无效 | 请求参数验证失败 |
| USER_MISSING_PARAM | 缺少参数 | 缺少必需参数 |
| USER_INVALID_FORMAT | 格式错误 | 数据格式不正确 |
| USER_INVALID_EMAIL | 邮箱格式错误 | 请输入有效的邮箱地址 |
| USER_WEAK_PASSWORD | 密码强度不足 | 密码必须包含大小写字母和数字 |
| USER_INVALID_PHONE | 手机号格式错误 | 请输入有效的手机号 |

#### 认证错误（AUTH_）

| 错误码 | 说明 | 消息 |
|--------|------|------|
| AUTH_REQUIRED | 需要认证 | 请先登录 |
| AUTH_TOKEN_EXPIRED | 令牌过期 | 登录已过期，请重新登录 |
| AUTH_TOKEN_INVALID | 令牌无效 | 认证令牌无效 |
| AUTH_CREDENTIALS_INVALID | 凭据无效 | 用户名或密码错误 |
| AUTH_ACCOUNT_LOCKED | 账户已锁定 | 账户已被锁定，请联系管理员 |
| AUTH_ACCOUNT_DISABLED | 账户已禁用 | 账户已被禁用 |

#### 授权错误（PERM_）

| 错误码 | 说明 | 消息 |
|--------|------|------|
| PERM_DENIED | 权限拒绝 | 无权访问此资源 |
| PERM_INSUFFICIENT | 权限不足 | 需要更高权限 |

#### 资源错误（RES_）

| 错误码 | 说明 | 消息 |
|--------|------|------|
| RES_NOT_FOUND | 资源不存在 | 请求的资源不存在 |
| RES_ALREADY_EXISTS | 资源已存在 | 资源已存在 |
| RES_CONFLICT | 资源冲突 | 资源状态冲突 |

#### 业务错误（BIZ_）

| 错误码 | 说明 | 消息 |
|--------|------|------|
| BIZ_VALIDATION_FAILED | 验证失败 | 数据验证失败 |
| BIZ_STATE_INVALID | 状态无效 | 当前状态不允许此操作 |
| BIZ_OPERATION_FAILED | 操作失败 | 操作执行失败 |
| BIZ_LIMIT_EXCEEDED | 超出限制 | 已达到限制 |

#### 限流错误（RATE_）

| 错误码 | 说明 | 消息 |
|--------|------|------|
| RATE_LIMIT_EXCEEDED | 超出限流 | 请求过于频繁，请稍后重试 |
| RATE_QUOTA_EXCEEDED | 超出配额 | 已达到配额限制 |

#### 网络错误（NET_）

| 错误码 | 说明 | 消息 |
|--------|------|------|
| NET_CONNECTION_FAILED | 连接失败 | 无法连接到服务器 |
| NET_TIMEOUT | 网络超时 | 请求超时 |
| NET_DNS_FAILED | DNS 解析失败 | 域名解析失败 |

#### 内部错误（INT_）

| 错误码 | 说明 | 消息 |
|--------|------|------|
| INT_INTERNAL_ERROR | 内部错误 | 服务器内部错误 |
| INT_SERVICE_UNAVAILABLE | 服务不可用 | 服务暂时不可用 |
| INT_DEPENDENCY_FAILED | 依赖失败 | 依赖服务调用失败 |
| INT_DATABASE_ERROR | 数据库错误 | 数据库操作失败 |

---

## 3. 错误响应格式

### 3.1 标准错误响应

```json
{
  "success": false,
  "error": {
    "code": "USER_INVALID_PARAM",
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

### 3.2 字段说明

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| code | string | ✅ | 错误码 |
| type | string | ✅ | 错误类型 |
| message | string | ✅ | 错误消息 |
| details | array | ❌ | 详细错误信息 |
| action | string | ❌ | 建议操作 |

### 3.3 建议操作

| 操作 | 说明 |
|------|------|
| RETRY | 重试 |
| REFRESH_TOKEN | 刷新令牌 |
| LOGIN | 重新登录 |
| CONTACT_ADMIN | 联系管理员 |

---

## 4. 后端错误处理

### 4.1 错误类定义

```javascript
class KhyError extends Error {
  constructor(code, type, message, details = []) {
    super(message);
    this.name = 'KhyError';
    this.code = code;
    this.type = type;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }
  
  toJSON() {
    return {
      code: this.code,
      type: this.type,
      message: this.message,
      details: this.details
    };
  }
}

// 用户错误
class ValidationError extends KhyError {
  constructor(message, details) {
    super('USER_INVALID_PARAM', 'USER_ERROR', message, details);
  }
}

// 认证错误
class AuthenticationError extends KhyError {
  constructor(message = '请先登录') {
    super('AUTH_REQUIRED', 'AUTH_ERROR', message);
  }
}

class TokenExpiredError extends KhyError {
  constructor() {
    super('AUTH_TOKEN_EXPIRED', 'AUTH_ERROR', '登录已过期，请重新登录');
  }
}

// 授权错误
class AuthorizationError extends KhyError {
  constructor(message = '无权访问此资源') {
    super('PERM_DENIED', 'AUTH_ERROR', message);
  }
}

// 资源错误
class NotFoundError extends KhyError {
  constructor(resource = '资源') {
    super('RES_NOT_FOUND', 'RESOURCE_ERROR', `${resource}不存在`);
  }
}

// 内部错误
class InternalError extends KhyError {
  constructor(message = '服务器内部错误') {
    super('INTERNAL_ERROR', 'INTERNAL_ERROR', message);
  }
}
```

### 4.2 错误处理中间件

```javascript
const errorHandler = (err, req, res, next) => {
  // 记录错误日志
  logger.error('Request error', {
    requestId: req.requestId,
    error: err.message,
    stack: err.stack,
    code: err.code,
    type: err.type
  });
  
  // 处理已知错误
  if (err instanceof KhyError) {
    return res.status(getHttpStatus(err.type)).json({
      success: false,
      error: err.toJSON(),
      metadata: {
        requestId: req.requestId,
        timestamp: err.timestamp
      }
    });
  }
  
  // 处理 Sequelize 错误
  if (err instanceof Sequelize.ValidationError) {
    const details = err.errors.map(e => ({
      field: e.path,
      message: e.message,
      value: e.value
    }));
    
    return res.status(400).json({
      success: false,
      error: {
        code: 'USER_INVALID_PARAM',
        type: 'USER_ERROR',
        message: '数据验证失败',
        details
      }
    });
  }
  
  // 处理未知错误
  const isDev = process.env.NODE_ENV === 'development';
  
  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      type: 'INTERNAL_ERROR',
      message: isDev ? err.message : '服务器内部错误',
      ...(isDev && { stack: err.stack })
    },
    metadata: {
      requestId: req.requestId,
      timestamp: new Date().toISOString()
    }
  });
};

// HTTP 状态码映射
const getHttpStatus = (errorType) => {
  const statusMap = {
    'USER_ERROR': 400,
    'AUTH_ERROR': 401,
    'PERMISSION_ERROR': 403,
    'RESOURCE_ERROR': 404,
    'BUSINESS_ERROR': 422,
    'RATE_ERROR': 429,
    'NETWORK_ERROR': 502,
    'INTERNAL_ERROR': 500
  };
  
  return statusMap[errorType] || 500;
};
```

### 4.3 使用示例

```javascript
// 抛出用户错误
const validateUser = (data) => {
  const errors = [];
  
  if (!data.email) {
    errors.push({ field: 'email', message: '邮箱不能为空' });
  } else if (!isValidEmail(data.email)) {
    errors.push({ field: 'email', message: '邮箱格式不正确' });
  }
  
  if (errors.length > 0) {
    throw new ValidationError('请求参数验证失败', errors);
  }
};

// 抛出认证错误
const requireAuth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    throw new AuthenticationError();
  }
  
  try {
    const decoded = verifyToken(token);
    req.user = decoded;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw new TokenExpiredError();
    }
    throw new AuthenticationError('认证令牌无效');
  }
};

// 抛出资源错误
const getUserById = async (id) => {
  const user = await User.findByPk(id);
  
  if (!user) {
    throw new NotFoundError('用户');
  }
  
  return user;
};
```

---

## 5. 前端错误处理

### 5.1 错误拦截器

```javascript
import axios from 'axios';

// 响应错误拦截器
axios.interceptors.response.use(
  response => response,
  error => {
    const { response } = error;
    
    if (response) {
      const { status, data } = response;
      
      // 认证错误
      if (status === 401) {
        // 清除本地存储的令牌
        localStorage.removeItem('token');
        
        // 跳转到登录页
        window.location.href = '/login';
        
        return Promise.reject(new Error('登录已过期，请重新登录'));
      }
      
      // 权限错误
      if (status === 403) {
        return Promise.reject(new Error('权限不足'));
      }
      
      // 使用服务器返回的错误消息
      if (data?.error) {
        return Promise.reject(new Error(data.error.message));
      }
    }
    
    // 网络错误
    if (!response) {
      return Promise.reject(new Error('网络连接失败，请检查网络'));
    }
    
    return Promise.reject(error);
  }
);
```

### 5.2 全局错误处理

```javascript
// Vue 全局错误处理
app.config.errorHandler = (err, vm, info) => {
  console.error('Vue error:', err);
  console.error('Component:', vm);
  console.error('Info:', info);
  
  // 上报错误
  reportError({
    type: 'vue_error',
    message: err.message,
    stack: err.stack,
    component: vm?.$options?.__name,
    info
  });
};

// 未处理的 Promise  rejection
window.addEventListener('unhandledrejection', event => {
  console.error('Unhandled promise rejection:', event.reason);
  
  reportError({
    type: 'unhandled_rejection',
    message: event.reason?.message || 'Unknown error',
    stack: event.reason?.stack
  });
});
```

### 5.3 错误上报

```javascript
const reportError = (errorInfo) => {
  // 发送到错误收集服务
  if (process.env.NODE_ENV === 'production') {
    fetch('/api/log/error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...errorInfo,
        userAgent: navigator.userAgent,
        url: window.location.href,
        timestamp: new Date().toISOString()
      })
    }).catch(() => {
      // 静默失败
    });
  }
};
```

---

## 6. 错误日志

### 6.1 日志格式

```json
{
  "timestamp": "2026-09-04T12:00:00.000Z",
  "level": "error",
  "message": "Database query failed",
  "requestId": "req-uuid",
  "userId": 123,
  "error": {
    "name": "SequelizeConnectionError",
    "code": "ECONNREFUSED",
    "message": "Connection refused",
    "stack": "..."
  },
  "context": {
    "method": "GET",
    "path": "/api/users",
    "query": {}
  }
}
```

### 6.2 日志记录

```javascript
// 记录错误日志
logger.error('Request failed', {
  requestId: req.requestId,
  error: {
    name: error.name,
    message: error.message,
    code: error.code,
    stack: error.stack
  },
  context: {
    method: req.method,
    path: req.path,
    body: req.body,
    query: req.query
  }
});
```

---

## 7. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本，定义错误处理规范 |

---

*本规范由 khy-os 平台团队维护*