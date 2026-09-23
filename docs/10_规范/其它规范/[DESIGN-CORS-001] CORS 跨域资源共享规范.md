# [DESIGN-CORS-001] CORS 跨域资源共享规范

<!-- RULES-REGISTRY: CORS-001 -->

> **用途**：定义 khy-os 项目的 CORS（跨域资源共享）配置标准。
> ENV-001 §5 和 SEC-001 §7 给出了 CORS 的基本配置，本文档补全策略细节。

---

## 1. CORS 原则

1. **最小权限**：只允许必要的来源、方法、请求头
2. **严格 SameSite**：所有认证相关 Cookie 使用 `strict` 或 `lax`
3. **预检缓存**：合理设置 `Access-Control-Max-Age` 减少 OPTIONS 请求
4. **凭证隔离**：`credentials: true` 时不允许通配符来源

---

## 2. 允许的来源

### 2.1 环境分级

| 环境 | 允许来源 | 说明 |
|------|---------|------|
| **开发** | `http://localhost:*`、`http://127.0.0.1:*`、`http://localhost:5173`（Vite dev） | 本地开发 |
| **Staging** | `https://staging.khyquant.top`、`https://*.staging.khyquant.top` | 预发布 |
| **生产** | `https://khyquant.top`、`https://*.khyquant.top` | 仅正式域名 |

### 2.2 动态来源匹配

```javascript
const ALLOWED_ORIGINS = {
  development: [
    'http://localhost:5173',    // Vite dev server
    'http://localhost:8090',    // Legacy dev frontend
    'http://127.0.0.1:5173'
  ],
  staging: [
    'https://staging.khyquant.top',
    'https://app.staging.khyquant.top'
  ],
  production: [
    'https://khyquant.top',
    'https://app.khyquant.top',
    'https://admin.khyquant.top'
  ]
};

function getCorsOrigin(env) {
  const envName = process.env.NODE_ENV || 'development';
  const allowed = ALLOWED_ORIGINS[envName] || ALLOWED_ORIGINS.development;
  
  return (origin, callback) => {
    if (allowed.includes(origin) || process.env.ALLOW_CORS_ORIGIN === origin) {
      callback(null, true);
    } else {
      callback(new Error(`Origin ${origin} not allowed by CORS policy`));
    }
  };
}
```

---

## 3. 允许的方法

### 3.1 全局方法

```
GET, POST, PUT, PATCH, DELETE, OPTIONS
```

### 3.2 端点级方法限制

| 端点 | 允许方法 | 说明 |
|------|---------|------|
| `/api/v1/auth/*` | `POST, OPTIONS` | 认证端点仅 POST |
| `/api/v1/public/*` | `GET, OPTIONS` | 公开端点仅 GET |
| `/api/v1/admin/*` | `GET, POST, PUT, DELETE, OPTIONS` | 管理端点全开 |
| `/api/v1/upload/*` | `POST, OPTIONS` | 上传端点仅 POST |

```javascript
// 端点级 CORS
app.options('/api/v1/auth/*', cors({ origin: getCorsOrigin(), methods: ['POST', 'OPTIONS'] }));
```

---

## 4. 允许的请求头

### 4.1 必选请求头

```
Content-Type
Authorization
X-Request-ID
X-CSRF-Token        ← 见 §7 CSRF 防护
```

### 4.2 可选请求头

```
Accept
Accept-Language: zh-CN, en-US
X-Client-Version
X-Client-Platform: web | mobile | cli
X-Request-Id       ← 客户端自生成（服务端可覆盖）
```

### 4.3 暴露的响应头

```
X-Request-ID        ← 全链路追踪
X-RateLimit-Limit   ← 限流信息
X-RateLimit-Remaining
X-RateLimit-Reset
```

```javascript
app.use(cors({
  origin: getCorsOrigin(),
  credentials: true,
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Request-ID',
    'X-Request-Id',       // 客户端自生成
    'X-CSRF-Token',
    'X-Client-Version',
    'X-Client-Platform'
  ],
  exposedHeaders: [
    'X-Request-ID',
    'X-RateLimit-Limit',
    'X-RateLimit-Remaining',
    'X-RateLimit-Reset'
  ]
}));
```

---

## 5. 预检请求缓存

```javascript
// 缓存 24 小时
Access-Control-Max-Age: 86400

// 实际配置
app.options('*', cors({
  origin: getCorsOrigin(),
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [...],
  credentials: true,
  maxAge: 86400  // 24h in seconds
}));
```

> **注意**：`maxAge` 过长意味着配置变更后客户端需要等缓存过期才能感知。24 小时是合理平衡。

---

## 6. 凭证模式

### 6.1 何时开启 `credentials: true`

| 场景 | 需要凭证 | 说明 |
|------|---------|------|
| 前端 Web 应用 | ✅ | Refresh Token 存 httpOnly cookie |
| 移动端 App | ✅ | 原生 Cookie 存储 |
| 第三方 API 调用 | ❌ | 走 API Key header |

### 6.2 凭证模式约束

```javascript
// credentials: true 时不允许通配符 origin
// ✅ 正确
app.use(cors({
  origin: 'https://khyquant.top',      // 明确域名
  credentials: true
}));

// ❌ 错误 — credentials + wildcard 会被浏览器拒绝
app.use(cors({
  origin: '*',
  credentials: true   // CORS 协议禁止此组合
}));
```

---

## 7. CSRF 防护集成

### 7.1 SameSite Cookie 策略

```javascript
res.cookie('refresh_token', token, {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',     // 跨站请求不携带 cookie
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: '/api/v1/auth'    // 限制 cookie 作用域
});
```

### 7.2 CSRF Token 双重验证

```javascript
const csrf = require('csrf-cookie-token');

// 响应中返回 CSRF token
app.get('/api/v1/auth/csrf-token', (req, res) => {
  res.json({ csrfToken: req.csrfToken() });
});

// 变更请求的中间件校验
app.use('/api/', csrfProtection({
  ignoreMethods: ['GET', 'HEAD', 'OPTIONS']
}));
```

---

## 8. 特殊端点 CORS

### 8.1 WebSocket 端点

```javascript
const wsServer = new WebSocket.Server({ 
  path: '/ws',
  noServer: true 
});

const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin;
  if (!isAllowedOrigin(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  
  wsServer.handleUpgrade(req, socket, head, (ws) => {
    wsServer.emit('connection', ws, req);
  });
});
```

### 8.2 SSE 端点

SSE（Server-Sent Events）不受 CORS 限制（同 fetch），但需确保预检通过：

```javascript
app.get('/api/v1/stream/events', cors({
  origin: getCorsOrigin(),
  methods: ['GET'],
  exposedHeaders: ['Content-Type']
}), (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  // ...
});
```

---

## 9. CORS 调试

### 9.1 开发环境日志

```javascript
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    logger.debug('CORS preflight', {
      origin: req.headers.origin,
      method: req.headers['access-control-request-method'],
      headers: req.headers['access-control-request-headers']
    });
  }
  next();
});
```

### 9.2 常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| `Access-Control-Allow-Origin` 缺失 | Origin 不在白名单 | 添加到环境变量或白名单 |
| `Credentials flag not allowed` | 使用了 `origin: '*'` + `credentials: true` | 显式指定 origin |
| Preflight 循环 | `Access-Control-Max-Age` 为 0 | 设置合理的 maxAge |
| Cookie 不发送 | `sameSite` 太严格或跨站 | 按场景选择 `strict`/`lax`/`none` |

---

## 10. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-10 | 初始版本，定义 CORS 跨域资源共享规范 |

---

*本规范由 khy-os 平台团队维护*
