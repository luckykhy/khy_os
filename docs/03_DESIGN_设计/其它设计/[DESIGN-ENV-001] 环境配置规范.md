# [DESIGN-ENV-001] 环境配置规范

> 本文档定义 khy-os 项目的环境配置标准，包括环境变量、配置文件格式、秘密管理等。

---

## 1. 环境概述

### 1.1 环境定义

| 环境 | 用途 | 域名 | 数据库 |
|------|------|------|--------|
| 开发 | 本地开发 | localhost:3000 | SQLite |
| 测试 | 功能测试 | test.khyquant.top | SQLite |
| 预发 | 预发布验证 | staging.khyquant.top | PostgreSQL |
| 生产 | 正式环境 | khyquant.top | PostgreSQL |

### 1.2 配置原则

1. **环境分离**：不同环境使用不同配置
2. **秘密隔离**：敏感信息不提交到版本控制
3. **默认安全**：默认配置应该是安全的
4. **可验证**：启动时验证配置

---

## 2. 环境变量

### 2.1 命名规范

**格式**：`{PREFIX}_{NAME}`

**前缀**：
| 前缀 | 说明 |
|------|------|
| KHY_ | khy-os 应用配置 |
| VITE_ | 前端构建时配置 |
| DB_ | 数据库配置 |
| JWT_ | JWT 配置 |

### 2.2 必需变量

```bash
# 应用配置
NODE_ENV=production
PORT=3000
HOST=0.0.0.0

# 数据库配置
DATABASE_URL=postgresql://user:pass@host:5432/dbname

# JWT 配置
JWT_SECRET=your-secret-key
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
```

### 2.3 可选变量

```bash
# Redis 配置
REDIS_URL=redis://localhost:6379

# 邮件配置
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=user@example.com
SMTP_PASS=password

# 监控配置
SENTRY_DSN=https://sentry.io/xxx

# 日志配置
LOG_LEVEL=info
LOG_DIR=./logs
```

### 2.4 前端变量

**规则**：前端环境变量必须以 `VITE_` 开头

```bash
VITE_API_BASE_URL=http://localhost:3000
VITE_APP_TITLE=Khy-OS
VITE_APP_VERSION=1.0.0
```

---

## 3. 配置文件

### 3.1 .env 文件

**结构**：
```bash
# .env.production
NODE_ENV=production
PORT=3000
DATABASE_URL=postgresql://...
JWT_SECRET=...
LOG_LEVEL=info
```

**规则**：
- .env 文件不提交到版本控制
- .env.example 提交到版本控制作为模板
- 每个环境有独立的 .env 文件

### 3.2 .env.example

```bash
# 应用配置
NODE_ENV=development
PORT=3000
HOST=0.0.0.0

# 数据库配置
DATABASE_URL=postgresql://user:pass@localhost:5432/dbname
# 或 SQLite
DATABASE_STORAGE=./data/development.db

# JWT 配置（生产环境必须设置）
JWT_SECRET=change-me-in-production
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d

# 日志配置
LOG_LEVEL=debug
LOG_DIR=./logs

# Redis 配置（可选）
REDIS_URL=redis://localhost:6379

# 邮件配置（可选）
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
```

### 3.3 配置验证

```javascript
// config/validate.js
const requiredEnvVars = [
  'NODE_ENV',
  'DATABASE_URL',
  'JWT_SECRET'
];

const validateConfig = () => {
  const missing = requiredEnvVars.filter(varName => !process.env[varName]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  
  // 生产环境额外检查
  if (process.env.NODE_ENV === 'production') {
    if (process.env.JWT_SECRET === 'change-me-in-production') {
      throw new Error('Default JWT_SECRET is not allowed in production');
    }
  }
};

module.exports = { validateConfig };
```

---

## 4. 秘密管理

### 4.1 秘密分类

| 类别 | 示例 | 存储位置 |
|------|------|---------|
| 高敏感 | API Key、私钥、密码 | 环境变量或密钥管理服务 |
| 中敏感 | 数据库连接字符串 | 环境变量 |
| 低敏感 | 配置选项 | 配置文件 |

### 4.2 秘密存储

**开发环境**：
- 使用 .env 文件
- .env 文件不提交到版本控制

**生产环境**：
- 使用密钥管理服务（AWS Secrets Manager、HashiCorp Vault）
- 或使用 CI/CD 系统的秘密管理功能

### 4.3 秘密轮换

| 秘密类型 | 轮换频率 |
|---------|---------|
| API Key | 每季度 |
| 数据库密码 | 每半年 |
| JWT 密钥 | 每年 |
| SSL 证书 | 到期前 30 天 |

---

## 5. 配置加载

### 5.1 加载顺序

1. 系统环境变量
2. .env 文件
3. 默认值

### 5.2 配置模块

```javascript
// config/index.js
require('dotenv').config();

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3000,
  host: process.env.HOST || '0.0.0.0',
  
  database: {
    url: process.env.DATABASE_URL,
    storage: process.env.DATABASE_STORAGE || './data/development.db'
  },
  
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d'
  },
  
  redis: {
    url: process.env.REDIS_URL
  },
  
  mail: {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  },
  
  log: {
    level: process.env.LOG_LEVEL || 'info',
    dir: process.env.LOG_DIR || './logs'
  }
};

module.exports = config;
```

---

## 6. 环境特定配置

### 6.1 开发环境

```javascript
// config/development.js
module.exports = {
  logLevel: 'debug',
  enableSwagger: true,
  enableCors: true,
  dbLogging: true
};
```

### 6.2 测试环境

```javascript
// config/test.js
module.exports = {
  logLevel: 'warn',
  enableSwagger: false,
  enableCors: true,
  dbLogging: false,
  database: {
    storage: './data/test.db'
  }
};
```

### 6.3 生产环境

```javascript
// config/production.js
module.exports = {
  logLevel: 'info',
  enableSwagger: false,
  enableCors: false,
  dbLogging: false,
  trustProxy: true
};
```

---

## 7. 配置文档

### 7.1 文档要求

- 每个环境变量都有说明
- 标注必需/可选
- 提供示例值

### 7.2 文档格式

```markdown
# 环境变量

## NODE_ENV
- **必需**：是
- **说明**：运行环境
- **可选值**：development, test, production
- **默认值**：development

## JWT_SECRET
- **必需**：是（生产环境）
- **说明**：JWT 签名密钥
- **示例**：your-secret-key
```

---

## 8. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本，定义环境配置规范 |

---

*本规范由 khy-os 平台团队维护*