# [DESIGN-ARCH-073] 规范快速参考卡

> 快速查阅 khy-os 项目所有规范的参考卡。

---

## 规范总览

### 📋 核心规范

| 规范 | 文档 | 状态 | 说明 |
|------|------|------|------|
| **项目规范化总纲** | `[DESIGN-ARCH-072]` | ✅ 完成 | 项目规范化体系总览 |
| **MCP 协议** | 多份文档 | ✅ 成熟 | 工具集成协议 |
| **A2A 协议** | `[DESIGN-A2A-001]` | 🟡 设计完成 | 智能体通信协议 |
| **记忆规范** | `[DESIGN-MEM-001~005]` | ✅ 完成 | 记忆系统规范 |
| **通信协议** | `[DESIGN-COMM-001]` | ✅ 完成 | 服务间通信规范 |
| **代码规范** | `[DESIGN-ARCH-015]` | ✅ 强制 | 代码风格规范 |
| **文档规范** | `[MGMT-STD-001]` | ✅ 强制 | 文档管理规范 |

---

## MCP 协议速查

### 核心组件

| 组件 | 说明 | 配置 |
|------|------|------|
| MCP 客户端 | 连接外部工具 | `~/.khy/mcp.json` |
| MCP 服务端 | 暴露 khy 工具 | `KHY_MCP_SERVE=on` |
| 生态桥接 | 支持 14+ IDE | 自动检测 |

### 常用命令

```bash
# 查看 MCP 状态
khy mcp status

# 添加 MCP 服务器
khy mcp add <name> <command>

# 列出 MCP 工具
khy mcp tools

# 测试 MCP 连接
khy mcp test <name>
```

### 配置示例

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["server.js"],
      "env": {},
      "disabled": false
    }
  }
}
```

---

## A2A 协议速查

### 核心概念

| 概念 | 说明 |
|------|------|
| 智能体发现 | 自动发现网络中的智能体 |
| 能力广播 | 广播智能体能力和服务 |
| 任务协商 | 协商任务分配和协作 |
| 状态同步 | 实时同步智能体状态 |

### 消息类型

| 类型 | 方法 | 说明 |
|------|------|------|
| 发现 | `a2a.discovery.*` | 智能体注册/发现/注销 |
| 能力 | `a2a.capability.*` | 能力查询/调用 |
| 任务 | `a2a.task.*` | 任务创建/状态/取消 |
| 状态 | `a2a.status.*` | 状态推送/订阅 |

### 配置示例

```json
{
  "a2a": {
    "enabled": true,
    "transport": {
      "websocket": {
        "enabled": true,
        "port": 3001
      }
    }
  }
}
```

---

## 记忆规范速查

### 记忆类型

| 类型 | 用途 | 保鲜期 | 示例 |
|------|------|--------|------|
| `user` | 用户身份、核心偏好 | 3650 天 | 语言偏好、工作习惯 |
| `feedback` | 交互风格、反馈模式 | 540 天 | 回复风格、错误处理 |
| `project` | 项目背景、技术约定 | 180 天 | 架构设计、代码规范 |
| `reference` | 外部资源、参考资料 | 365 天 | API 文档、工具配置 |

### 常用命令

```bash
# 创建记忆
/remember --type feedback --name "回复风格" --desc "用户偏好简洁回复" 内容

# 查看记忆状态
khy memory project

# 记忆蒸馏
khy memory distill --apply

# 清空记忆
npm run memory:clear
npm run memory:clear:apply

# 恢复记忆
npm run memory:restore
npm run memory:restore:all
```

### 相关文档

- `[DESIGN-MEM-000]` 记忆系统总结
- `[DESIGN-MEM-001]` 记忆系统标准规范
- `[DESIGN-MEM-002]` 记忆时机指南
- `[DESIGN-MEM-003]` 记忆模板库
- `[DESIGN-MEM-004]` 记忆快速参考卡
- `[DESIGN-MEM-005]` 记忆系统使用指南

---

## 通信协议速查

### HTTP 响应格式

**成功响应**：
```json
{
  "success": true,
  "data": {},
  "message": "操作成功",
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "total": 100
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
    "type": "ERROR_TYPE",
    "details": {}
  }
}
```

### WebSocket 消息格式

```json
{
  "type": "request|response|event|ping|pong",
  "id": "msg-uuid",
  "method": "service.action",
  "params": {},
  "result": {},
  "error": null
}
```

### SSE 消息格式

```
event: message_type
id: event-uuid
data: {"key": "value"}

```

### 错误码分类

| 分类 | 前缀 | HTTP 状态码 | 示例 |
|------|------|------------|------|
| 用户错误 | `USER_` | 4xx | `USER_INVALID_PARAM` |
| 认证错误 | `AUTH_` | 401 | `AUTH_TOKEN_EXPIRED` |
| 授权错误 | `PERM_` | 403 | `PERM_DENIED` |
| 资源错误 | `RES_` | 404 | `RES_NOT_FOUND` |
| 业务错误 | `BIZ_` | 422 | `BIZ_VALIDATION_FAILED` |
| 限流错误 | `RATE_` | 429 | `RATE_LIMIT_EXCEEDED` |
| 网络错误 | `NET_` | 502/503 | `NET_CONNECTION_FAILED` |
| 内部错误 | `INT_` | 500 | `INT_INTERNAL_ERROR` |

---

## 代码规范速查

### JavaScript/TypeScript

```javascript
// ✅ 正确
const userName = 'john';
const MAX_RETRIES = 3;

function getUserById(userId) {
  // ...
}

// ❌ 错误
const user_name = 'john';  // 应该用 camelCase
const max_retries = 3;     // 应该用 camelCase
```

### Python

```python
# ✅ 正确
user_name = 'john'
max_retries = 3

def get_user_by_id(user_id):
    # ...

# ❌ 错误
userName = 'john'  # 应该用 snake_case
maxRetries = 3     # 应该用 snake_case
```

### 文件命名

```
# ✅ 正确
user-service.js
user_service.py
UserProfile.tsx

# ❌ 错误
UserService.js      # 应该用 kebab-case
user-service.py     # 应该用 snake_case
userprofile.tsx     # 应该用 PascalCase
```

---

## 文档规范速查

### 文档命名

**格式**：`[TYPE-CATEGORY-NNN] 标题.md`

**类型**：
- DESIGN：设计文档
- OPS：运维文档
- MGMT：管理文档
- API：API 文档
- GUIDE：指南文档

### 文档结构

```markdown
# [TYPE-CATEGORY-NNN] 标题

> 摘要

---

## 1. 概述
## 2. 详细内容
## 3. 示例
## 4. 相关文档
## 5. 版本历史
```

---

## 测试规范速查

### 测试类型

| 类型 | 目的 | 工具 | 命令 |
|------|------|------|------|
| 单元测试 | 函数/模块测试 | Jest/Vitest | `npm run test:unit` |
| 集成测试 | 模块间交互 | Jest/Vitest | `npm run test:integration` |
| 端到端测试 | 完整流程 | Playwright | `npm run test:e2e` |
| 性能测试 | 性能基准 | Artillery | `npm run test:performance` |

### 测试命名

```javascript
describe('UserService', () => {
  describe('getUserById', () => {
    it('should return user when user exists', () => {
      // ...
    });

    it('should throw error when user not found', () => {
      // ...
    });
  });
});
```

---

## 部署规范速查

### 环境配置

| 环境 | 配置文件 | 用途 |
|------|---------|------|
| 开发 | `.env.local` | 本地开发 |
| 测试 | `.env.test` | 功能测试 |
| 预发 | `.env.staging` | 预发布验证 |
| 生产 | `.env.production` | 正式环境 |

### 版本管理

**语义化版本**：`MAJOR.MINOR.PATCH`
- MAJOR：不兼容的 API 变更
- MINOR：向下兼容的功能性新增
- PATCH：向下兼容的问题修正

---

## CI/CD 检查速查

### 检查命令

```bash
# 代码规范检查
npm run check:agent-rules

# 文件格式检查
npm run check:change-safety

# 协议契约检查
npm run check:protocol-contracts

# 可靠性检查
npm run check:reliability

# 版本同步检查
npm run check:version-sync

# 仓库布局检查
npm run check:layout
```

### 预提交钩子

```bash
# 安装 Git Hooks
npm run hooks:install

# 手动运行检查
npm run check:changed
```

---

## 环境变量速查

### 核心变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `KHY_DISABLE_MEMORY` | off | 全局记忆开关 |
| `KHY_MCP_SERVE` | on | MCP 服务开关 |
| `KHY_A2A_ENABLED` | true | A2A 协议开关 |
| `KHY_SESSION_WATCHDOG` | on | 会话看门狗 |
| `KHY_PROTOCOL_ARBITRATION` | on | 协议仲裁 |

### 记忆相关变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `KHY_MEMORY_DIR` | - | 自定义记忆目录 |
| `KHY_PROACTIVE_MEMORY` | on | 主动回忆层 |
| `KHY_MEMORY_TIERS` | on | 分层模型 |
| `KHY_MEMORY_TRIGGER` | on | 自动捕获 |
| `KHY_MEMORY_DISTILL_AUTO` | report | 自动蒸馏模式 |

### A2A 相关变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `A2A_PORT` | 3001 | WebSocket 端口 |
| `A2A_HTTP_PORT` | 3002 | HTTP 端口 |
| `A2A_GRPC_PORT` | 3003 | gRPC 端口 |
| `A2A_AUTH_TYPE` | jwt | 认证类型 |
| `A2A_TLS_ENABLED` | true | 启用 TLS |

---

## 常见问题速查

### Q: 如何添加新的 MCP 工具？

**A**: 
```bash
# 方法 1：使用命令
khy mcp add <name> <command>

# 方法 2：编辑配置文件
vim ~/.khy/mcp.json
```

### Q: 如何创建记忆？

**A**:
```bash
# 快速记忆
/remember 用户偏好简洁回复

# 结构化记忆
/remember --type feedback --name "回复风格" --desc "用户偏好简洁回复" 内容
```

### Q: 如何检查代码规范？

**A**:
```bash
# 检查所有规范
npm run check:changed

# 检查特定规范
npm run check:agent-rules
npm run check:change-safety
```

### Q: 如何查看错误码？

**A**: 参考 `[DESIGN-COMM-001]` 通信协议规范中的错误码定义。

---

## 相关文档

- `[DESIGN-ARCH-072]` 项目规范化总纲
- `[DESIGN-A2A-001]` A2A 协议规范
- `[DESIGN-COMM-001]` 通信协议规范
- `[DESIGN-MEM-001]` 记忆系统标准规范

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本，提供规范快速参考 |

---

*本参考卡由 khy-os 架构团队维护*