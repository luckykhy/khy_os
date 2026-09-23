# [DESIGN-LAY-001] 后端分层架构规范

> **用途**：定义 khy-os 后端服务（`services/backend/src/`）的代码分层标准，包括目录结构、职责边界、通信规则。
> ARCH-068 §4 已定义仓库七层模型（L0 kernel → L6 tools），本文档聚焦 L2 services 内部的代码组织。

---

## 1. 后端目录结构

### 1.1 现状总览

```
services/backend/src/
├── agents/              # AI Agent 定义（built-in agents + 类型）
│   ├── built-in/        # 内置 Agent（debugAgent, securityAgent 等）
│   └── types.js
├── bootstrap/           # 服务启动引导
│   └── state.js
├── buddy/               # Buddy 相关类型
│   └── types.js
├── cli/                 # CLI 层（命令解析、REPL、TUI）
│   ├── handlers/        # 命令 Handler
│   ├── repl/            # REPL 子模块
│   ├── statusLine/      # 状态栏
│   ├── tui/             # TUI 界面
│   └── vim/             # Vim 模式
├── config/              # 配置加载
│   ├── database.js
│   ├── env.js
│   └── sqlite-adapter.js
├── constants/           # 常量定义
├── coordinator/         # 协调器
├── data/                # 数据模板
├── middleware/           # Express 中间件
├── migrations/          # 数据库迁移
├── models/              # Sequelize 数据模型
├── permissions/         # 权限系统
├── routes/              # REST API 路由
├── seeds/               # 种子数据
├── services/            # ★ 核心业务逻辑层
│   ├── gateway/         # AI 网关（适配器、OAuth）
│   ├── domain/          # 领域服务（按领域拆分）
│   └── *.js             # 公共服务
├── utils/               # 工具函数
├── bin/                 # CLI 入口
│   └── khy.js
├── app.js               # Express 应用入口
└── server.js            # HTTP 服务器入口
```

---

## 2. 分层定义

### 2.1 六层模型

| 层 | 目录 | 职责 | 允许依赖 |
|----|------|------|---------|
| **Routes** | `routes/` | HTTP 路由定义、参数提取、响应格式 | → Middleware → Services |
| **Middleware** | `middleware/` | 鉴权、限流、日志、错误处理 | → Services → Utils |
| **Services** | `services/` | 业务逻辑、数据编排、外部调用 | → Models → Utils |
| **Models** | `models/` | 数据模型、关联定义、实例方法 | → Utils（仅工具方法） |
| **Utils** | `utils/` | 纯函数、通用工具、无状态辅助 | 仅 Node.js 标准库 |
| **Config** | `config/` | 配置加载、环境变量解析 | 无 |

### 2.2 层间通信规则

```
Routes → Services → Models → DB
  ↓         ↓         ↓
Middleware  Utils    Standard Lib
```

**禁止**：
- Routes 直接调用 Models（必须通过 Services）
- Services 直接调用 Routes
- Utils 依赖 Models 或 Services
- Models 调用外部 API

---

## 3. Routes 层规范

### 3.1 路由文件组织

```javascript
// routes/index.js — 路由聚合
const authRouter = require('./auth');
const strategyRouter = require('./strategy');
const adminRouter = require('./admin');

module.exports = {
  authRouter,
  strategyRouter,
  adminRouter
};
```

### 3.2 路由定义规范

```javascript
// routes/strategy.js
const express = require('express');
const router = express.Router();
const strategyService = require('../services/strategyService');
const { requireAuth, validateBody } = require('../middleware');

// GET /api/v1/strategies — 列出策略
router.get('/strategies',
  requireAuth,
  async (req, res, next) => {
    try {
      const strategies = await strategyService.list(req.user.id);
      res.json({ success: true, data: strategies });
    } catch (error) {
      next(error);
    }
  }
);

// POST /api/v1/strategies — 创建策略
router.post('/strategies',
  requireAuth,
  validateBody(strategySchema),
  async (req, res, next) => {
    try {
      const strategy = await strategyService.create(req.user.id, req.body);
      res.status(201).json({ success: true, data: strategy });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
```

### 3.3 路由层只做的事

| 可以做 | 禁止做 |
|--------|--------|
| 参数提取（`req.params`、`req.query`） | 业务逻辑判断 |
| 调用 Service | 直接查询 Model |
| 包装响应（`res.json()`） | 事务管理 |
| 错误传递（`next(error)`） | 数据验证（交给 middleware） |
| 权限中间件 | 副作用操作（写文件、发邮件） |

---

## 4. Middleware 层规范

### 4.1 中间件分类

| 类型 | 位置 | 职责 |
|------|------|------|
| 安全中间件 | `middleware/` | `requireAuth`、`requireRole`、CSRF 保护 |
| 日志中间件 | `middleware/` | `requestLogger`、响应日志 |
| 限流中间件 | `middleware/` | `rateLimit` |
| 错误处理中间件 | `middleware/` | `errorHandler`（4 参数） |

### 4.2 中间件签名

```javascript
// 标准中间件（3 参数）
function myMiddleware(req, res, next) { }

// 错误处理中间件（4 参数）
function errorHandler(err, req, res, next) { }

// 路由级中间件工厂
function validateBody(schema) {
  return async (req, res, next) => { };
}
```

---

## 5. Services 层规范

### 5.1 文件组织

```
services/
├── gateway/                    # AI 网关（独立子系统）
│   ├── aiGateway.js            # 主入口
│   ├── adapters/               # AI 供应商适配器
│   ├── oauthManager.js         # OAuth 管理
│   ├── pluginChain.js          # 插件链
│   └── protocolConverter/      # 协议转换
├── domain/                     # ★ 按领域组织的服务
│   ├── security/
│   │   └── failsafe/
│   │       └── errorCodes.js
│   ├── trajectory/
│   │   └── dualTrack/
│   │       └── degradeStateMachine.js
│   ├── messaging/
│   │   └── channels/
│   │       └── _baseChannel.js
│   └── project/
│       └── management/
│           └── resourceContract.js
├── llmService.js               # LLM 公共服务
├── llmGenerateSink.js          # LLM 生成接收器
├── aiChatPort.js               # AI 对话端口
├── aiConversationPort.js       # 对话管理端口
├── modelCapabilityPort.js      # 模型能力端口
├── promptComposer.js           # Prompt 组合器
├── permissionPromptPort.js     # 权限 Prompt
├── sessionSourcePort.js        # Session 来源
├── commandDispatchPort.js      # 命令分发
├── gitSpawnHelper.js           # Git 进程辅助
├── toolCallNudges.js           # 工具调用提示
├── samplingPolicy.js           # 采样策略
├── clarificationsCards.js      # 澄清卡片
└── agnesImageModel.js          # 图像模型
```

### 5.2 服务职责

| 职责 | 说明 |
|------|------|
| 业务逻辑编排 | 调用多个 Model 完成业务操作 |
| 外部调用 | AI API、Git 命令、子进程 |
| 事务管理 | 确保多 Model 操作的原子性 |
| 缓存决策 | 什么该缓存、缓存多久 |
| 错误分类 | 区分用户错误、系统错误、外部错误 |

### 5.3 服务文件大小

| 文件 | 建议上限 | 超限处理 |
|------|---------|---------|
| 单一服务文件 | **200 行** | 按子领域拆分到 `domain/` |
| domain 子目录 | — | 按领域拆分 |

### 5.4 Service 入口签名

```javascript
// Service 函数签名统一：async，第一个参数是 userId（如有认证）
// 返回值统一为 { data } 或 throw KhyError

// ✅ 正确
async function listStrategies(userId, filters = {}) { }
async function createStrategy(userId, params) { }
async function deleteStrategy(userId, strategyId) { }

// ❌ 错误 — 缺少 userId 上下文
async function listStrategies(filters) { }  // 无法确定归属
```

---

## 6. Models 层规范

### 6.1 Model 文件命名

```text
PascalCase.js   — 与表名 snake_case 复数对应
```

| 模型类名 | 表名 | 文件 |
|---------|------|------|
| `User` | `users` | `models/User.js` |
| `ApiKey` | `api_keys` | `models/ApiKey.js` |
| `SystemSetting` | `system_settings` | `models/SystemSetting.js` |

### 6.2 Model 结构

```javascript
'use strict';
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const User = sequelize.define('User', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    username: {
      type: DataTypes.STRING(50),
      allowNull: false,
      unique: true
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
      unique: true
    },
    role: {
      type: DataTypes.STRING(20),
      defaultValue: 'user'
    },
    status: {
      type: DataTypes.STRING(20),
      defaultValue: 'active'
    }
  }, {
    tableName: 'users',
    underscored: true,   // createdAt / updatedAt（非 camelCase）
    timestamps: true
  });

  // 实例方法
  User.prototype.isAdmin = function() {
    return this.role === 'admin';
  };

  // 类方法
  User.findByUsername = async function(username) {
    return User.findOne({ where: { username } });
  };

  // 关联定义
  User.associate = function(models) {
    User.hasOne(models.UserProfile, { foreignKey: 'user_id' });
    User.hasMany(models.ApiKey, { foreignKey: 'user_id' });
  };

  return User;
};
```

### 6.3 Model 中禁止做的事

| 禁止 | 原因 |
|------|------|
| 业务逻辑 | Model 是数据映射，不是服务 |
| 外部 API 调用 | Model 不知道 HTTP |
| 邮件/通知发送 | 属于 Service 层 |
| 复杂的默认值计算 | 应放在 Service 层 |

---

## 7. Utils 层规范

### 7.1 工具函数特征

- **纯函数优先**：相同输入永远产生相同输出
- **无副作用**：不修改外部状态、不写文件、不打网络请求
- **单一职责**：一个工具函数只做一件事
- **导出方式**：具名导出，便于 tree-shaking

```javascript
// utils/toLowerCaseSafe.js
function toLowerCaseSafe(str) {
  if (typeof str !== 'string') return '';
  return str.toLowerCase();
}

module.exports = { toLowerCaseSafe };
```

### 7.2 工具分类

| 类别 | 目录 | 示例 |
|------|------|------|
| 字符串工具 | `utils/` | `stripCodeSpans.js` |
| 路径工具 | `utils/` | `expandEnvPath.js` |
| 环境工具 | `utils/` | `envIntNonNeg.js` |
| 进程工具 | `utils/` | `expressAsyncPatch.js` |
| 安全工具 | `utils/` | `ipAnonymizer.js` |

---

## 8. CLI 层规范

### 8.1 目录结构

```
cli/
├── router.js             # 命令路由器（switch 分发）
├── aliases.js            # 中文/拼音 → 命令名映射
├── formatters.js         # 输出格式化
├── handlers/             # 命令实现
│   ├── daemon.js
│   ├── webTools.js
│   └── ...
├── repl/                 # REPL 子模块
│   ├── atProjectionCache.js
│   ├── dirSkip.js
│   └── ...
├── statusLine/           # 状态栏
│   └── statusLineRunner.js
├── tui/                  # TUI 界面
│   ├── ink-components/
│   └── vim/
├── aiChatState.js        # AI 聊天状态
├── aiLocalState.js       # AI 本地状态
├── blockquoteStyle.js    # 引用样式
├── completionKeysLazy.js # 补全键
├── heapDump.js           # 堆转储
├── markdownLink.js       # Markdown 链接
├── retryCountdown.js     # 重试倒计时
├── starEmphasisFlanking.js
└── ...
```

### 8.2 Handler 规范

```javascript
// handlers/daemon.js
async function handleDaemon(args) {
  const { action } = args;
  
  switch (action) {
    case 'start':
      return startDaemon();
    case 'stop':
      return stopDaemon();
    case 'status':
      return getDaemonStatus();
    default:
      throw new Error(`Unknown daemon action: ${action}`);
  }
}

module.exports = { handleDaemon };
```

### 8.3 Handler 约束

| 约束 | 说明 |
|------|------|
| 返回 Promise | 所有 handler 必须是 async 函数 |
| 输出走 formatter | 不直接 `console.log`，走 `formatters.js` |
| 错误抛异常 | 不吞错误，由外层统一处理 |
| 无 HTTP 依赖 | Handler 不直接调用 Express |

---

## 9. 禁止跨层调用

### 9.1 依赖方向矩阵

| 从 → 到 | Routes | Middleware | Services | Models | Utils | Config |
|---------|--------|-----------|----------|--------|-------|--------|
| Routes | — | ✅ | ✅ | ❌ | ✅ | ❌ |
| Middleware | — | — | ✅ | ❌ | ✅ | ❌ |
| Services | — | — | — | ✅ | ✅ | ✅ |
| Models | — | — | ❌ | — | ✅ | ❌ |
| Utils | — | — | ❌ | ❌ | — | ❌ |
| Config | — | — | ❌ | ❌ | ❌ | — |

---

## 10. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-10 | 初始版本，定义后端分层架构规范 |

---

*本规范由 khy-os 架构团队维护*
