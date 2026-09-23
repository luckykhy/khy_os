# [DESIGN-AUTH-002] Session 管理规范

<!-- RULES-REGISTRY: AUTH-002 -->

> **用途**：定义 khy-os 项目的 Session / 认证令牌管理标准，补充 SEC-001 §2 未覆盖的细节。
> SEC-001 定义了 JWT 结构和密码策略，本文档覆盖生命周期、存储、revocation、CSRF 防护等运行时规范。

---

## 1. Session 模型

### 1.1 Token 双轨制

| Token | 用途 | 有效期 | 存储位置 |
|-------|------|--------|---------|
| Access Token | API 鉴权 | **15 分钟** | 内存（前端 state） |
| Refresh Token | 获取新 Access Token | **7 天** | `httpOnly` cookie + 服务端 DB |
| Session ID | 服务端会话标识 | 与 Refresh Token 同步 | DB 表 `sessions` |

**设计理由**：
- Access Token 短生命周期 → 泄露窗口小
- Refresh Token 存 `httpOnly` cookie → 防 XSS 窃取
- Refresh Token 存 DB → 支持服务端 revocation

---

## 2. Token 生成

### 2.1 JWT Claims 规范

```javascript
// Access Token payload
{
  "sub": "user-123",           // 用户唯一标识
  "username": "zhangsan",      // 用户名（缓存友好，避免每次查 DB）
  "role": "user",             // 角色（用于快速鉴权）
  "scope": ["read", "write"],  // 权限范围
  "iat": 1693833600,          // issued at
  "exp": 1693834500,          // expires at (iat + 900s)
  "jti": "jti-uuid"           // JWT ID（用于 revocation 黑名单）
}
```

**必选字段**：`sub`、`iat`、`exp`、`jti`
**禁止字段**：`password`、`apiKey`、`secret` 等敏感信息

### 2.2 生成代码

```javascript
const jwt = require('jsonwebtoken');
const { publicKey, privateKey } = require('./keys');

const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY = '7d';

function generateAccessToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      role: user.role,
      scope: user.scope || ['read'],
      jti: uuidv4()
    },
    privateKey,
    {
      algorithm: 'RS256',
      expiresIn: ACCESS_TOKEN_EXPIRY,
      issuer: 'khy-auth',
      audience: 'khy-api'
    }
  );
}

function generateRefreshToken(user) {
  // Refresh Token 是纯随机字符串（非 JWT），存 DB
  return crypto.randomBytes(64).toString('hex');
}
```

---

## 3. Session 存储

### 3.1 数据库表

```sql
CREATE TABLE sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash TEXT NOT NULL,        -- bcrypt hash（不能明文存）
    jti         TEXT NOT NULL,                -- 关联的 Access Token jti
    ip_address  TEXT,
    user_agent  TEXT,
    last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    revoked     BOOLEAN DEFAULT 0,
    expires_at  TIMESTAMP NOT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_sessions_user_id (user_id),
    INDEX idx_sessions_jti (jti),
    INDEX idx_sessions_expires (expires_at)
);

CREATE UNIQUE INDEX uq_sessions_refresh_hash ON sessions(refresh_token_hash);
```

### 3.2 并发 Session 限制

| 场景 | 策略 |
|------|------|
| 用户已有 5 个活跃 Session | 新建 Session 时，淘汰最早的 |
| 管理员用户 | 无限制（但可审计） |

```javascript
const MAX_CONCURRENT_SESSIONS = 5;

async function createSession(userId, ipAddress, userAgent) {
  const activeCount = await Session.count({
    where: { userId, revoked: false, expiresAt: { [Op.gt]: new Date() } }
  });
  
  if (activeCount >= MAX_CONCURRENT_SESSIONS) {
    // 淘汰最早的
    const oldest = await Session.findOne({
      where: { userId, revoked: false },
      order: [['lastUsedAt', 'ASC']]
    });
    await oldest.update({ revoked: true });
  }
  
  return Session.create({ ... });
}
```

---

## 4. Refresh Token 流程

### 4.1 获取 Refresh Token

```
POST /api/v1/auth/refresh
Cookie: refresh_token=<raw_token>
```

```javascript
async function refreshAccessToken(req, res) {
  const rawToken = req.cookies.refresh_token;
  if (!rawToken) {
    return res.status(401).json({
      success: false,
      error: { code: 'AUTH_REFRESH_MISSING', message: '请重新登录' }
    });
  }

  // 从 DB 查找
  const session = await Session.findOne({
    where: {
      revoked: false,
      expiresAt: { [Op.gt]: new Date() }
    },
    include: [{ model: User, as: 'user' }]
  });

  if (!session || !bcrypt.compareSync(rawToken, session.refresh_token_hash)) {
    // 可能被窃取，revoke 该用户所有 Session
    await Session.update({ revoked: true }, { where: { userId: session.userId } });
    res.clearCookie('refresh_token');
    return res.status(401).json({
      success: false,
      error: { code: 'AUTH_REFRESH_INVALID', message: '请重新登录' }
    });
  }

  // 轮换：刷新同时更换 Refresh Token
  const newRefreshToken = generateRefreshToken(session.user);
  const newAccessToken = generateAccessToken(session.user);
  
  await session.update({
    refresh_token_hash: bcrypt.hashSync(newRefreshToken, 12),
    last_used_at: new Date(),
    jti: decode(newAccessToken).jti
  });

  // 将新 Refresh Token 写入 httpOnly cookie
  res.cookie('refresh_token', newRefreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/api/v1/auth/refresh'
  });

  return res.json({
    success: true,
    data: { accessToken: newAccessToken, expiresIn: 900 }
  });
}
```

### 4.2 安全特性

| 特性 | 实现 |
|------|------|
| Token 轮换 | 每次刷新更换 Refresh Token（防重放） |
| Revocation | DB 标记 + 黑名单（短期 jti cache） |
| IP 绑定 | 记录 IP，显著变化时重新认证 |
| 用户代理 | 记录 UA，变化时降级确认 |

---

## 5. Session Revocation

### 5.1 触发 Revocation 的场景

| 场景 | 操作 |
|------|------|
| 用户主动登出 | 标记当前 Session revoked |
| 密码修改 | Revoke 该用户所有 Session |
| 管理员封禁 | Revoke 该用户所有 Session |
| Token 泄露检测 | Revoke 单 Session / 全用户 Session |
| Refresh Token 过期 | 自然过期，无需操作 |

### 5.2 登出接口

```
POST /api/v1/auth/logout
```

```javascript
async function logout(req, res) {
  const jti = decode(req.headers.authorization?.split(' ')[1])?.jti;
  
  // 标记当前 Session 为 revoked
  if (jti) {
    await Session.update({ revoked: true }, { where: { jti } });
  }
  
  res.clearCookie('refresh_token', { path: '/api/v1/auth/refresh' });
  return res.json({ success: true, message: '已登出' });
}
```

---

## 6. CSRF 防护

### 6.1 同站 Cookie（第一道防线）

```javascript
res.cookie('refresh_token', token, {
  sameSite: 'strict',   // 跨站请求不携带 cookie
  httpOnly: true,       // JS 无法读取
  secure: isProduction  // 仅 HTTPS 传输
});
```

### 6.2 CSRF Token（双重提交 Cookie）

对于有副作用的请求（POST/PUT/DELETE），使用 CSRF Token：

```javascript
// 登录成功后返回 CSRF Token
res.json({
  success: true,
  data: {
    accessToken,
    csrfToken: csrfSecret()  // 存在 session / 内存中
  }
});

// 前端在后续请求的 header 中携带
headers: {
  'X-CSRF-Token': csrfToken
}

// 中间件校验
app.use('/api/', csrfProtection({
  ignoreMethods: ['GET', 'HEAD', 'OPTIONS']
}));
```

---

## 7. SameSite 与 Cookie 策略

| Cookie | SameSite | HttpOnly | Secure | 用途 |
|--------|----------|----------|--------|------|
| `refresh_token` | `strict` | ✅ | 生产环境 | Refresh Token |
| `session_id` | `lax` | ✅ | 生产环境 | 可选：服务端 Session 标识 |

---

## 8. 安全实践

### 8.1 禁止事项

| 禁止 | 原因 |
|------|------|
| 在 localStorage 存 Refresh Token | XSS 可窃取 |
| Access Token 有效期 > 30 分钟 | 泄露窗口过大 |
| Refresh Token 永不过期 | 泄露后永久有效 |
| URL 传 Token | 日志/浏览器历史泄露 |
| JWT Secret 硬编码 | 必须走 env / secrets manager |

### 8.2 Token 安全最佳实践

```javascript
// ✅ 黑名单（短期缓存）
const revokedJtis = new Set(); // 生产环境用 Redis

// 验证时检查
function verifyToken(token) {
  const decoded = jwt.verify(token, publicKey);
  if (revokedJtis.has(decoded.jti)) {
    throw new TokenRevokedError();
  }
  return decoded;
}

// ✅ 短期 Access Token + 轮换 Refresh Token
// ✅ 登录态变动时 Revoke 相关 Session
// ✅ 关键操作（改密码、删资源）要求重新认证
```

---

## 9. 登录态修复

### 9.1 401 → 401 + 自动刷新

```javascript
// axios 拦截器
let isRefreshing = false;
let pendingQueue = [];

async function responseInterceptor(error) {
  const { response } = error;
  
  if (response?.status === 401 && !response.config._retry) {
    if (isRefreshing) {
      // 排队等待刷新完成
      return new Promise((resolve, reject) => {
        pendingQueue.push({ resolve, reject });
      }).then(token => {
        return axios(response.config);
      }).catch(err => reject(err));
    }
    
    response.config._retry = true;
    isRefreshing = true;
    
    try {
      const { data } = await axios.post('/api/v1/auth/refresh', null, {
        withCredentials: true  // 带 cookie
      });
      const newToken = data.data.accessToken;
      axios.defaults.headers.common['Authorization'] = `Bearer ${newToken}`;
      
      // 处理排队请求
      pendingQueue.forEach(({ resolve }) => resolve(axios(response.config)));
      pendingQueue = [];
      
      return axios(response.config);
    } catch (refreshError) {
      // 刷新也失败 → 跳登录
      pendingQueue.forEach(({ reject }) => reject(refreshError));
      pendingQueue = [];
      window.location.href = '/login';
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  }
  
  return Promise.reject(error);
}
```

---

## 10. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-10 | 初始版本，定义 Session / 认证令牌管理规范 |

---

*本规范由 khy-os 平台团队维护*
