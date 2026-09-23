# [DESIGN-LOG-001] 日志规范

> 本文档定义 khy-os 项目的日志标准，包括格式、级别、存储等。

---

## 1. 日志概述

### 1.1 设计原则

1. **结构化**：所有日志使用结构化格式（JSON）
2. **可追溯**：每条日志包含请求 ID，便于追踪
3. **分级**：根据重要性使用不同日志级别
4. **安全**：敏感信息脱敏

### 1.2 日志级别

| 级别 | 值 | 用途 | 示例 |
|------|-----|------|------|
| error | 0 | 错误 | 数据库连接失败、API 调用失败 |
| warn | 1 | 警告 | 配置缺失、性能下降 |
| info | 2 | 信息 | 用户登录、订单创建 |
| debug | 3 | 调试 | 变量值、函数调用 |
| verbose | 4 | 详细 | 请求详情、响应内容 |

---

## 2. 日志格式

### 2.1 标准格式

```json
{
  "timestamp": "2026-09-04T12:00:00.000Z",
  "level": "info",
  "message": "User login successful",
  "requestId": "req-uuid",
  "userId": 123,
  "module": "auth",
  "action": "login",
  "duration": 150,
  "metadata": {
    "ip": "192.168.1.1",
    "userAgent": "Mozilla/5.0"
  }
}
```

### 2.2 字段说明

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| timestamp | string | ✅ | ISO 8601 格式时间戳 |
| level | string | ✅ | 日志级别 |
| message | string | ✅ | 日志消息 |
| requestId | string | ❌ | 请求 ID |
| userId | number | ❌ | 用户 ID |
| module | string | ❌ | 模块名 |
| action | string | ❌ | 操作名 |
| duration | number | ❌ | 执行时长（ms） |
| metadata | object | ❌ | 附加元数据 |

---

## 3. 日志使用

### 3.1 后端日志

**使用 Winston Logger**：
```javascript
const logger = require('@khy/shared/src/utils/logger');

// 错误日志
logger.error('Database connection failed', {
  error: err.message,
  stack: err.stack
});

// 警告日志
logger.warn('Configuration missing', {
  key: 'JWT_SECRET',
  defaultValue: 'fallback'
});

// 信息日志
logger.info('User login successful', {
  userId: user.id,
  username: user.username,
  ip: req.ip
});

// 调试日志
logger.debug('Processing request', {
  requestId: req.requestId,
  method: req.method,
  path: req.path
});
```

### 3.2 前端日志

**开发环境日志**：
```javascript
// 只在开发环境输出
if (import.meta.env.DEV) {
  console.log('Debug info:', data);
  console.warn('Warning:', message);
  console.error('Error:', error);
}
```

**生产环境日志**：
```javascript
// 使用结构化日志服务
import { logger } from '@/utils/logger';

logger.error('API request failed', {
  url: '/api/users',
  status: 500,
  error: error.message
});
```

---

## 4. 请求日志

### 4.1 请求日志中间件

```javascript
const { v4: uuidv4 } = require('uuid');

const requestLogger = (req, res, next) => {
  // 生成请求 ID
  req.requestId = req.headers['x-request-id'] || uuidv4();
  res.setHeader('X-Request-ID', req.requestId);
  
  // 记录请求开始
  const startTime = Date.now();
  
  logger.info('Request started', {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    query: req.query,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });
  
  // 响应完成时记录
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    
    logger.info('Request completed', {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration,
      contentLength: res.get('Content-Length')
    });
  });
  
  next();
};
```

### 4.2 请求日志格式

```
2026-09-04T12:00:00.000Z INFO req-uuid GET /api/v1/users 200 150ms 1024b
```

---

## 5. 错误日志

### 5.1 错误日志格式

```json
{
  "timestamp": "2026-09-04T12:00:00.000Z",
  "level": "error",
  "message": "Database query failed",
  "requestId": "req-uuid",
  "error": {
    "name": "SequelizeConnectionError",
    "message": "Connection refused",
    "code": "ECONNREFUSED",
    "stack": "..."
  },
  "context": {
    "query": "SELECT * FROM users",
    "params": {}
  }
}
```

### 5.2 错误日志记录

```javascript
// 捕获未处理的异常
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', {
    error: error.message,
    stack: error.stack
  });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection', {
    reason: reason?.message || reason,
    stack: reason?.stack
  });
});

// Express 错误处理
app.use((error, req, res, next) => {
  logger.error('Request error', {
    requestId: req.requestId,
    error: error.message,
    stack: error.stack,
    method: req.method,
    path: req.path
  });
  
  res.status(error.status || 500).json({
    success: false,
    error: {
      code: error.code || 'INTERNAL_ERROR',
      message: process.env.NODE_ENV === 'production'
        ? '服务器内部错误'
        : error.message
    }
  });
});
```

---

## 6. 日志存储

### 6.1 存储策略

| 类型 | 位置 | 保留时间 | 轮转 |
|------|------|---------|------|
| 错误日志 | logs/error.log | 30 天 | 每日 |
| 综合日志 | logs/combined.log | 14 天 | 每日 |
| 访问日志 | logs/access.log | 7 天 | 每日 |

### 6.2 Winston 配置

```javascript
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: {
    service: 'khy-os'
  },
  transports: [
    // 错误日志
    new DailyRotateFile({
      filename: 'logs/error-%DATE%.log',
      level: 'error',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '30d',
      maxSize: '20m'
    }),
    
    // 综合日志
    new DailyRotateFile({
      filename: 'logs/combined-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '14d',
      maxSize: '50m'
    }),
    
    // 控制台输出（开发环境）
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
      silent: process.env.NODE_ENV === 'production'
    })
  ]
});
```

---

## 7. 日志脱敏

### 7.1 敏感字段

```javascript
const SENSITIVE_FIELDS = [
  'password',
  'token',
  'apiKey',
  'secret',
  'authorization',
  'cookie',
  'creditCard',
  'ssn'
];

const sanitizeLog = (data) => {
  if (!data || typeof data !== 'object') {
    return data;
  }
  
  const sanitized = Array.isArray(data) ? [...data] : { ...data };
  
  for (const key of Object.keys(sanitized)) {
    if (SENSITIVE_FIELDS.some(field => 
      key.toLowerCase().includes(field.toLowerCase())
    )) {
      sanitized[key] = '***REDACTED***';
    } else if (typeof sanitized[key] === 'object') {
      sanitized[key] = sanitizeLog(sanitized[key]);
    }
  }
  
  return sanitized;
};
```

### 7.2 使用示例

```javascript
logger.info('User login attempt', sanitizeLog({
  username: req.body.username,
  password: req.body.password,  // 会被脱敏为 ***REDACTED***
  ip: req.ip
}));
```

---

## 8. 性能日志

### 8.1 慢查询日志

```javascript
const SLOW_QUERY_THRESHOLD = 1000; // 1秒

const logSlowQuery = (query, duration) => {
  if (duration > SLOW_QUERY_THRESHOLD) {
    logger.warn('Slow query detected', {
      query,
      duration,
      threshold: SLOW_QUERY_THRESHOLD
    });
  }
};
```

### 8.2 API 性能日志

```javascript
const logApiPerformance = (req, res, duration) => {
  const threshold = {
    GET: 200,
    POST: 500,
    PUT: 500,
    DELETE: 300
  };
  
  if (duration > threshold[req.method]) {
    logger.warn('Slow API response', {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      duration,
      threshold: threshold[req.method]
    });
  }
};
```

---

## 9. 安全日志

### 9.1 安全事件类型

| 事件 | 级别 | 说明 |
|------|------|------|
| LOGIN_SUCCESS | info | 登录成功 |
| LOGIN_FAILED | warn | 登录失败 |
| LOGOUT | info | 登出 |
| PASSWORD_CHANGE | info | 修改密码 |
| PERMISSION_DENIED | warn | 权限拒绝 |
| RATE_LIMIT | warn | 速率限制 |
| SUSPICIOUS_ACTIVITY | error | 可疑活动 |

### 9.2 安全日志记录

```javascript
const logSecurityEvent = (event, details) => {
  logger.info('Security event', {
    event,
    ...sanitizeLog(details),
    ip: details.ip,
    userAgent: details.userAgent,
    timestamp: new Date().toISOString()
  });
};

// 使用示例
logSecurityEvent('LOGIN_FAILED', {
  username: req.body.username,
  ip: req.ip,
  reason: 'Invalid password'
});
```

---

## 10. 日志监控

### 10.1 监控指标

| 指标 | 说明 | 阈值 |
|------|------|------|
| error_rate | 错误率 | > 5% |
| response_time | 响应时间 | > 2s |
| request_rate | 请求速率 | 异常波动 |

### 10.2 告警规则

```javascript
const checkLogAlerts = () => {
  // 检查错误率
  const errorRate = calculateErrorRate();
  if (errorRate > 0.05) {
    sendAlert('High error rate', { errorRate });
  }
  
  // 检查响应时间
  const avgResponseTime = calculateAvgResponseTime();
  if (avgResponseTime > 2000) {
    sendAlert('Slow response time', { avgResponseTime });
  }
};
```

---

## 11. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本，定义日志规范 |

---

*本规范由 khy-os 平台团队维护*