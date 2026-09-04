# [DESIGN-SEC-001] 安全规范

> 本文档定义 khy-os 项目的安全标准，包括认证、授权、数据保护等。

---

## 1. 安全概述

### 1.1 安全原则

1. **最小权限原则**：用户只拥有完成任务所需的最小权限
2. **纵深防御**：多层安全防护
3. **安全默认**：默认配置应该是安全的
4. **零信任**：不信任任何内部或外部网络

### 1.2 安全等级

| 等级 | 说明 | 示例 |
|------|------|------|
| P0 | 严重 | 认证绕过、数据泄露 |
| P1 | 高危 | 权限提升、注入攻击 |
| P2 | 中危 | XSS、CSRF |
| P3 | 低危 | 信息泄露、配置不当 |

---

## 2. 认证规范

### 2.1 密码策略

**最小要求**：
- 最小长度：8 个字符
- 包含大写字母、小写字母、数字
- 不能与用户名相同
- 不能使用常见密码

**密码存储**：
```javascript
const bcrypt = require('bcrypt');
const SALT_ROUNDS = 12;

// 加密密码
const hashPassword = async (password) => {
  return bcrypt.hash(password, SALT_ROUNDS);
};

// 验证密码
const verifyPassword = async (password, hash) => {
  return bcrypt.compare(password, hash);
};
```

### 2.2 JWT 规范

**Token 配置**：
```javascript
const jwtConfig = {
  algorithm: 'RS256',           // 使用 RSA 签名
  accessTokenExpiry: '15m',     // Access Token 15分钟
  refreshTokenExpiry: '7d',     // Refresh Token 7天
  issuer: 'khy-auth',
  audience: 'khy-api'
};
```

**Token 生成**：
```javascript
const jwt = require('jsonwebtoken');
const { privateKey } = require('./keys');

const generateAccessToken = (user) => {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      role: user.role
    },
    privateKey,
    {
      algorithm: 'RS256',
      expiresIn: '15m',
      issuer: 'khy-auth',
      audience: 'khy-api'
    }
  );
};
```

**Token 验证**：
```javascript
const { publicKey } = require('./keys');

const verifyToken = (token) => {
  try {
    return jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      issuer: 'khy-auth',
      audience: 'khy-api'
    });
  } catch (error) {
    throw new Error('Invalid token');
  }
};
```

### 2.3 会话管理

**会话配置**：
- Access Token 有效期：15 分钟
- Refresh Token 有效期：7 天
- 并发会话限制：5 个
- 会话超时：30 分钟无活动自动登出

**会话刷新**：
```javascript
const refreshAccessToken = async (refreshToken) => {
  // 验证 Refresh Token
  const decoded = verifyRefreshToken(refreshToken);
  
  // 检查会话是否存在
  const session = await Session.findOne({
    where: {
      userId: decoded.sub,
      refreshToken,
      revoked: false
    }
  });
  
  if (!session) {
    throw new Error('Invalid session');
  }
  
  // 生成新的 Access Token
  const user = await User.findByPk(decoded.sub);
  return generateAccessToken(user);
};
```

---

## 3. 授权规范

### 3.1 角色定义

| 角色 | 权限 |
|------|------|
| guest | 访问公开资源 |
| user | 管理自己的资源 |
| admin | 管理所有资源 |
| superadmin | 系统管理 |

### 3.2 权限检查

```javascript
// 中间件：检查认证
const requireAuth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'AUTH_REQUIRED',
        message: '请先登录'
      }
    });
  }
  
  try {
    const decoded = verifyToken(token);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'AUTH_TOKEN_INVALID',
        message: '认证令牌无效'
      }
    });
  }
};

// 中间件：检查权限
const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'AUTH_REQUIRED',
          message: '请先登录'
        }
      });
    }
    
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'PERM_INSUFFICIENT',
          message: '权限不足'
        }
      });
    }
    
    next();
  };
};
```

### 3.3 资源权限

```javascript
// 检查资源所有权
const requireOwnership = (model) => {
  return async (req, res, next) => {
    const resource = await model.findByPk(req.params.id);
    
    if (!resource) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'RES_NOT_FOUND',
          message: '资源不存在'
        }
      });
    }
    
    if (resource.userId !== req.user.sub && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: {
          code: 'PERM_DENIED',
          message: '无权访问此资源'
        }
      });
    }
    
    req.resource = resource;
    next();
  };
};
```

---

## 4. 数据保护

### 4.1 敏感数据分类

| 类别 | 示例 | 保护级别 |
|------|------|---------|
| 高度敏感 | 密码、API Key、私钥 | 加密存储 |
| 中度敏感 | 邮箱、手机号、身份证 | 脱敏显示 |
| 低度敏感 | 用户名、昵称 | 正常存储 |

### 4.2 加密规范

**密码加密**：
```javascript
const bcrypt = require('bcrypt');
const SALT_ROUNDS = 12;

const hashPassword = async (password) => {
  return bcrypt.hash(password, SALT_ROUNDS);
};
```

**API Key 加密**：
```javascript
const crypto = require('crypto');
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

const encryptApiKey = (apiKey) => {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY), iv);
  
  let encrypted = cipher.update(apiKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex')
  };
};

const decryptApiKey = (encryptedData) => {
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    Buffer.from(ENCRYPTION_KEY),
    Buffer.from(encryptedData.iv, 'hex')
  );
  
  decipher.setAuthTag(Buffer.from(encryptedData.authTag, 'hex'));
  
  let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
};
```

### 4.3 数据脱敏

```javascript
// 邮箱脱敏
const maskEmail = (email) => {
  const [local, domain] = email.split('@');
  const maskedLocal = local.charAt(0) + '***' + local.charAt(local.length - 1);
  return `${maskedLocal}@${domain}`;
};

// 手机号脱敏
const maskPhone = (phone) => {
  return phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2');
};

// 身份证脱敏
const maskIdCard = (idCard) => {
  return idCard.replace(/(\d{6})\d{8}(\d{4})/, '$1********$2');
};
```

---

## 5. 输入验证

### 5.1 验证规则

```javascript
const Joi = require('joi');

// 用户注册验证
const registerSchema = Joi.object({
  username: Joi.string()
    .alphanum()
    .min(3)
    .max(30)
    .required()
    .messages({
      'string.min': '用户名至少需要3个字符',
      'string.max': '用户名最多30个字符',
      'any.required': '用户名不能为空'
    }),
  
  email: Joi.string()
    .email()
    .required()
    .messages({
      'string.email': '邮箱格式不正确',
      'any.required': '邮箱不能为空'
    }),
  
  password: Joi.string()
    .min(8)
    .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .required()
    .messages({
      'string.min': '密码至少需要8个字符',
      'string.pattern.base': '密码必须包含大小写字母和数字',
      'any.required': '密码不能为空'
    })
});

// 验证中间件
const validate = (schema) => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true
    });
    
    if (error) {
      const details = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message,
        value: detail.context?.value
      }));
      
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          type: 'USER_ERROR',
          message: '请求参数验证失败',
          details
        }
      });
    }
    
    req.body = value;
    next();
  };
};
```

### 5.2 SQL 注入防护

```javascript
// ✅ 正确：使用参数化查询
const getUserById = async (id) => {
  return sequelize.query(
    'SELECT * FROM users WHERE id = :id',
    {
      replacements: { id },
      type: QueryTypes.SELECT
    }
  );
};

// ❌ 错误：字符串拼接
const getUserById = async (id) => {
  return sequelize.query(`SELECT * FROM users WHERE id = ${id}`);
};
```

### 5.3 XSS 防护

```javascript
// 输入清理
const xss = require('xss');

const sanitizeInput = (input) => {
  return xss(input, {
    whiteList: {},  // 不允许任何 HTML 标签
    stripIgnoreTag: true,
    stripIgnoreTagBody: ['script']
  });
};

// 输出编码
const escapeHtml = (str) => {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
};
```

---

## 6. 速率限制

### 6.1 限制策略

```javascript
const rateLimit = require('express-rate-limit');

// 公开端点限制
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1分钟
  max: 60,
  message: {
    success: false,
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: '请求过于频繁，请稍后重试'
    }
  }
});

// 认证端点限制（更严格）
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15分钟
  max: 5,
  message: {
    success: false,
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: '登录尝试次数过多，请15分钟后再试'
    }
  }
});

// API 限制
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1分钟
  max: 100,
  keyGenerator: (req) => {
    return req.user?.sub || req.ip;
  }
});
```

### 6.2 应用限制

```javascript
// 应用速率限制中间件
app.use('/api/', apiLimiter);
app.use('/api/auth/', authLimiter);
app.use('/api/public/', publicLimiter);
```

---

## 7. CORS 配置

### 7.1 允许的来源

```javascript
const cors = require('cors');

const corsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins = [
      'https://khyquant.top',
      'https://*.khyquant.top'
    ];
    
    // 开发环境允许所有来源
    if (process.env.NODE_ENV === 'development') {
      allowedOrigins.push('http://localhost:*');
    }
    
    if (!origin || allowedOrigins.some(allowed => {
      if (allowed.includes('*')) {
        const regex = new RegExp(allowed.replace('*', '.*'));
        return regex.test(origin);
      }
      return allowed === origin;
    })) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Request-ID',
    'X-Client-Version',
    'X-Client-Platform'
  ],
  exposedHeaders: ['X-Request-ID'],
  credentials: true,
  maxAge: 86400
};

app.use(cors(corsOptions));
```

---

## 8. 安全头

### 8.1 必需的安全头

```javascript
const helmet = require('helmet');

app.use(helmet());

// 自定义安全头
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', "default-src 'self'");
  next();
});
```

---

## 9. 日志安全

### 9.1 日志脱敏

```javascript
const sanitizeLog = (data) => {
  const sensitiveFields = ['password', 'token', 'apiKey', 'secret', 'authorization'];
  const sanitized = { ...data };
  
  for (const field of sensitiveFields) {
    if (sanitized[field]) {
      sanitized[field] = '***REDACTED***';
    }
  }
  
  return sanitized;
};

// 日志记录
logger.info('User login attempt', sanitizeLog({
  username: req.body.username,
  password: req.body.password,  // 会被脱敏
  ip: req.ip
}));
```

### 9.2 安全事件日志

```javascript
const logSecurityEvent = (event, details) => {
  logger.warn('Security event', {
    event,
    details: sanitizeLog(details),
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

## 10. 依赖安全

### 10.1 依赖审计

```bash
# 定期审计依赖
npm audit

# 修复已知漏洞
npm audit fix
```

### 10.2 依赖更新策略

- 每周检查依赖更新
- 及时修复高危漏洞
- 更新前进行充分测试

---

## 11. 安全测试

### 11.1 安全扫描

```bash
# 静态代码扫描
npm run security:scan

# 依赖漏洞扫描
npm audit --audit-level=high
```

### 11.2 渗透测试

定期进行渗透测试，检查：
- 认证绕过
- 权限提升
- 注入攻击
- XSS/CSRF

---

## 12. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本，定义安全规范 |

---

*本规范由 khy-os 安全团队维护*