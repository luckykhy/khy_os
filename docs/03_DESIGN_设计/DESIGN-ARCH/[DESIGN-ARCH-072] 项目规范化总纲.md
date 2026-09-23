# [DESIGN-ARCH-072] 项目规范化总纲

> 本文档定义 khy-os 项目的完整规范化体系，涵盖工具协议、智能体通信、记忆系统、通信协议等核心领域。

---

## 1. 规范化体系概览

### 1.1 规范化层次结构

```
┌─────────────────────────────────────────────────────────────┐
│                    项目规范化总纲                              │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐      │
│  │ MCP 协议 │ │ A2A 协议 │ │ 记忆规范 │ │ 通信协议 │      │
│  │  (工具)  │ │ (智能体) │ │ (存储)   │ │ (服务)   │      │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘      │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐      │
│  │ 代码规范 │ │ 文档规范 │ │ 测试规范 │ │ 部署规范 │      │
│  │ (质量)   │ │ (管理)   │ │ (验证)   │ │ (运维)   │      │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘      │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 规范状态矩阵

| 规范领域 | 状态 | 文档 | 实现 | CI 强制 |
|---------|------|------|------|---------|
| **MCP 协议** | ✅ 成熟 | ✅ 3 份文档 | ✅ 客户端+服务端+桥接 | ✅ 15+ 测试 |
| **A2A 协议** | ❌ 缺失 | ❌ 无 | ❌ 无 | ❌ 无 |
| **记忆规范** | ✅ 完成 | ✅ 6 份文档 | 🟡 部分实现 | ✅ 蒸馏机制 |
| **通信协议** | 🟡 部分 | ❌ 缺失总纲 | ✅ 代码实现 | 🟡 部分强制 |
| **代码规范** | ✅ 强制 | ✅ ARCH-015 | ✅ ESLint/Prettier | ✅ CI |
| **文档规范** | ✅ 强制 | ✅ MGMT-STD-001 | ✅ 索引系统 | ✅ 检查脚本 |
| **测试规范** | ✅ 强制 | ✅ 多份文档 | ✅ 测试框架 | ✅ CI |
| **部署规范** | ✅ 完成 | ✅ 多份文档 | ✅ 脚本 | ✅ 门禁 |

---

## 2. MCP 协议规范（工具集成）

### 2.1 协议概述

**MCP (Model Context Protocol)** 是 AI 工具集成的标准协议，定义了 AI 模型与外部工具之间的通信方式。

**当前状态**：✅ 成熟实现

### 2.2 核心组件

| 组件 | 文件 | 功能 |
|------|------|------|
| MCP 客户端 | `services/backend/src/services/domain/messaging/mcp/index.js` | 连接外部 MCP 服务器 |
| MCP 服务端 | `services/backend/src/services/domain/messaging/mcp/mcpServerProtocol.js` | 暴露 khy 工具 |
| 生态桥接 | `mcpEcosystemRegistry.js` | 支持 14+ IDE/Agent |
| 治理策略 | `mcpGovernance.js` | 配置优先级和审批 |

### 2.3 协议规范

**传输方式**：
- **stdio**：标准输入输出（本地进程）
- **HTTP**：流式 HTTP（远程服务）
- **SSE**：服务器推送事件（实时更新）

**消息格式**：JSON-RPC 2.0
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "tool_name",
    "arguments": {}
  }
}
```

**协议版本**：`2024-11-05`

### 2.4 配置规范

**配置文件位置**：
- 用户级：`~/.khy/mcp.json`
- 项目级：`./.khy/mcp.json`

**配置格式**：
```json
{
  "mcpServers": {
    "server-name": {
      "command": "node",
      "args": ["server.js"],
      "env": {},
      "disabled": false
    }
  }
}
```

### 2.5 相关文档

- `[OPS-MAN-173]` MCP 工具接入快速上手
- `[DESIGN-RESEARCH]` 跨 Agent 技能 MCP 统一管理-阶段一调研
- `[DESIGN-LEGISLATION]` 跨 Agent 技能 MCP 统一管理-阶段二立法清单

---

## 3. A2A 协议规范（智能体通信）

### 3.1 协议概述

**A2A (Agent-to-Agent)** 是智能体间通信的标准协议，定义了智能体如何发现、协商和协作。

**当前状态**：❌ 完全缺失

### 3.2 设计目标

1. **智能体发现**：自动发现网络中的其他智能体
2. **能力广播**：智能体广播自己的能力和服务
3. **任务协商**：智能体之间协商任务分配
4. **状态同步**：智能体状态实时同步
5. **安全通信**：加密和认证机制

### 3.3 协议架构

```
┌─────────────────────────────────────────────────────────┐
│                    A2A 协议栈                              │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────┐   │
│  │              应用层 (Application)                │   │
│  │  • 任务协商  • 能力发现  • 状态同步  • 结果聚合  │   │
│  └─────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────┐   │
│  │              消息层 (Messaging)                   │   │
│  │  • JSON-RPC 2.0  • 消息路由  • 优先级队列        │   │
│  └─────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────┐   │
│  │              传输层 (Transport)                   │   │
│  │  • WebSocket  • HTTP/2  • gRPC  • P2P            │   │
│  └─────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────┐   │
│  │              安全层 (Security)                    │   │
│  │  • mTLS  • JWT  • RBAC  • 审计日志               │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### 3.4 核心消息类型

**1. 发现消息 (Discovery)**
```json
{
  "type": "discovery",
  "action": "announce",
  "agent": {
    "id": "agent-001",
    "name": "khy-quant",
    "capabilities": ["trading", "analysis", "backtest"],
    "endpoint": "ws://localhost:3001",
    "status": "available"
  }
}
```

**2. 能力查询 (Capability Query)**
```json
{
  "type": "capability",
  "action": "query",
  "filter": {
    "capability": "trading",
    "version": ">=1.0.0"
  }
}
```

**3. 任务请求 (Task Request)**
```json
{
  "type": "task",
  "action": "request",
  "task": {
    "id": "task-001",
    "type": "analysis",
    "payload": {},
    "priority": "high",
    "deadline": "2026-09-04T12:00:00Z"
  }
}
```

**4. 状态同步 (Status Sync)**
```json
{
  "type": "status",
  "action": "sync",
  "agent": {
    "id": "agent-001",
    "status": "busy",
    "currentTask": "task-001",
    "progress": 0.75
  }
}
```

### 3.5 实现计划

**阶段 1：基础框架**（1-2 周）
- 定义消息格式和协议规范
- 实现智能体注册和发现机制
- 建立基础通信通道

**阶段 2：核心功能**（2-3 周）
- 实现能力广播和查询
- 实现任务协商和分配
- 实现状态同步机制

**阶段 3：高级特性**（3-4 周）
- 实现安全认证机制
- 实现负载均衡和故障转移
- 实现审计和监控

---

## 4. 记忆系统规范（存储管理）

### 4.1 规范概述

**记忆系统**定义了 AI 助手如何存储、检索和管理持久化信息。

**当前状态**：✅ 规范完成，🟡 部分实现

### 4.2 核心组件

| 组件 | 说明 | 状态 |
|------|------|------|
| 记忆分类 | user/feedback/project/reference | ✅ 定义完成 |
| 保留层级 | short_term/cross_session/permanent | ✅ 定义完成 |
| 生命周期 | 创建→活跃→老化→归档→恢复 | ✅ 定义完成 |
| 蒸馏机制 | 去重、清理、归档 | ✅ 实现完成 |
| 检索机制 | 关键词、向量、主动回忆 | 🟡 部分实现 |

### 4.3 相关文档

- `[DESIGN-MEM-000]` 记忆系统总结
- `[DESIGN-MEM-001]` 记忆系统标准规范
- `[DESIGN-MEM-002]` 记忆时机指南
- `[DESIGN-MEM-003]` 记忆模板库
- `[DESIGN-MEM-004]` 记忆快速参考卡
- `[DESIGN-MEM-005]` 记忆系统使用指南

---

## 5. 通信协议规范（服务间通信）

### 5.1 协议概述

**通信协议**定义了 khy-os 内部服务之间、以及与外部系统的通信方式。

**当前状态**：🟡 部分实现，❌ 缺少统一文档

### 5.2 协议层次

| 层次 | 协议 | 用途 | 状态 |
|------|------|------|------|
| **应用层** | HTTP REST API | 前端↔后端通信 | ✅ 实现 |
| **应用层** | WebSocket | 实时通信 | ✅ 实现 |
| **应用层** | SSE | 服务器推送 | ✅ 实现 |
| **传输层** | HTTP/2 | 高性能传输 | ✅ 实现 |
| **传输层** | gRPC | 高效 RPC | 🟡 部分 |
| **传输层** | TCP/UDP | 底层传输 | ✅ 实现 |
| **安全层** | TLS/SSL | 加密传输 | ✅ 实现 |
| **安全层** | JWT | 身份认证 | ✅ 实现 |

### 5.3 消息格式规范

**HTTP 响应信封**：
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

**HTTP 错误信封**：
```json
{
  "success": false,
  "message": "错误描述",
  "statusCode": 400,
  "errorType": "VALIDATION_ERROR",
  "requestId": "req-001"
}
```

**WebSocket 消息格式**：
```json
{
  "type": "message_type",
  "payload": {},
  "timestamp": "2026-09-04T12:00:00Z",
  "id": "msg-001"
}
```

### 5.4 IPC 协议规范

**二进制协议**（内核桥接）：
```
┌─────────┬─────────┬─────────┬─────────┐
│ Verb    │ Length  │ Payload │ CRC     │
│ (2B)    │ (4B)    │ (nB)    │ (2B)    │
└─────────┴─────────┴─────────┴─────────┘
```

**控制面 Verb**：
- STAT (0x0001)：获取状态
- LIST (0x0002)：列表目录
- READ (0x0003)：读取文件
- WRITE (0x0004)：写入文件
- MKDIR (0x0005)：创建目录
- REMOVE (0x0006)：删除文件
- PS (0x0007)：进程列表

**事件面 Verb**：
- SPAWN (0x0001)：进程创建
- EXIT (0x0002)：进程退出
- FAULT (0x0003)：故障通知

### 5.5 创建通信协议文档

**需要创建**：`COMMUNICATION-PROTOCOL.md`

**内容框架**：
1. 协议概述和设计原则
2. 消息格式规范（HTTP/WebSocket/IPC）
3. 认证和授权机制
4. 错误处理和重试策略
5. 性能和扩展性考虑
6. 安全和合规要求

---

## 6. 代码规范

### 6.1 代码风格

**JavaScript/TypeScript**：
- 缩进：2 空格
- 引号：单引号
- 分号：必须
- 命名：camelCase
- 注释：英文

**Python**：
- 缩进：4 空格
- 命名：snake_case
- 注释：英文
- 类型提示：推荐

### 6.2 文件组织

**目录结构**：
```
src/
├── cli/              # CLI 命令处理
├── services/         # 业务服务
├── routes/           # API 路由
├── middleware/       # 中间件
├── utils/            # 工具函数
├── constants/        # 常量定义
└── types/            # 类型定义
```

### 6.3 错误处理

**统一错误格式**：
```javascript
{
  code: 'ERROR_CODE',
  message: '错误描述',
  details: {},
  stack: '堆栈信息'
}
```

**错误分类**：
- 用户错误（USER_ERROR）
- 配置错误（CONFIG_ERROR）
- 认证错误（AUTH_ERROR）
- 网络错误（NETWORK_ERROR）
- 内部错误（INTERNAL_ERROR）

---

## 7. 文档规范

### 7.1 文档命名

**格式**：`[TYPE-CATEGORY-NNN] 标题.md`

**类型**：
- DESIGN：设计文档
- OPS：运维文档
- MGMT：管理文档
- API：API 文档
- GUIDE：指南文档

### 7.2 文档结构

**标准结构**：
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

### 7.3 文档管理

**索引维护**：
- 所有文档必须在索引中注册
- 文档变更必须更新索引
- 定期检查文档完整性

---

## 8. 测试规范

### 8.1 测试类型

| 类型 | 目的 | 工具 | 覆盖率要求 |
|------|------|------|-----------|
| 单元测试 | 函数/模块测试 | Jest/Vitest | ≥80% |
| 集成测试 | 模块间交互 | Jest/Vitest | ≥70% |
| 端到端测试 | 完整流程 | Playwright | 关键路径 |
| 性能测试 | 性能基准 | k6/artillery | 按需 |

### 8.2 测试命名

**格式**：`describe > it > expect`
```javascript
describe('ModuleName', () => {
  describe('functionName', () => {
    it('should do something when condition', () => {
      expect(result).toBe(expected);
    });
  });
});
```

### 8.3 测试运行

```bash
# 运行所有测试
npm test

# 运行单元测试
npm run test:unit

# 运行集成测试
npm run test:integration

# 生成覆盖率报告
npm run test:coverage
```

---

## 9. 部署规范

### 9.1 环境管理

| 环境 | 用途 | 配置 | 部署方式 |
|------|------|------|---------|
| 开发 | 本地开发 | .env.local | 手动 |
| 测试 | 功能测试 | .env.test | CI/CD |
| 预发 | 预发布验证 | .env.staging | 自动 |
| 生产 | 正式环境 | .env.production | 审批后自动 |

### 9.2 版本管理

**语义化版本**：`MAJOR.MINOR.PATCH`
- MAJOR：不兼容的 API 变更
- MINOR：向下兼容的功能性新增
- PATCH：向下兼容的问题修正

**版本同步**：
- `pyproject.toml`
- `services/backend/package.json`
- `packaging/npm/package.json`
- `packaging/modules/modules.json`

### 9.3 发布流程

```bash
# 1. 版本检查
npm run check:version-sync

# 2. 质量门禁
npm run quality:gate

# 3. 构建产物
npm run build

# 4. 发布
npm run publish
```

---

## 10. 规范执行机制

### 10.1 CI/CD 强制

**检查脚本**：
```bash
# 代码规范检查
npm run check:agent-rules

# 文件格式检查
npm run check:change-safety

# 协议契约检查
npm run check:protocol-contracts

# 可靠性检查
npm run check:reliability
```

### 10.2 预提交钩子

**Git Hooks**：
- `pre-commit`：代码格式化、lint 检查
- `commit-msg`：提交信息格式检查
- `pre-push`：测试运行、构建检查

### 10.3 代码审查

**审查清单**：
- [ ] 代码符合风格规范
- [ ] 错误处理完整
- [ ] 测试覆盖充分
- [ ] 文档更新完整
- [ ] 安全考虑充分

---

## 11. 规范演进

### 11.1 规范变更流程

1. **提案**：提交规范变更提案
2. **讨论**：团队讨论和评审
3. **批准**：负责人批准
4. **实施**：更新文档和代码
5. **验证**：CI 检查和测试

### 11.2 版本管理

**规范版本**：`vMAJOR.MINOR`
- MAJOR：不兼容的变更
- MINOR：向下兼容的新增

### 11.3 反馈机制

**反馈渠道**：
- GitHub Issues
- 文档评论
- 团队会议
- 用户反馈

---

## 12. 相关文档

### 12.1 核心规范

- `[DESIGN-ARCH-068]` 仓库层级板块规范
- `[MGMT-STD-001]` 文档结构与索引铁律
- `[OPS-MAN-169]` 项目规则总索引

### 12.2 协议规范

- `[DESIGN-MEM-001]` 记忆系统标准规范
- `[DESIGN-A2A-001]` A2A 协议规范
- `[DESIGN-COMM-001]` 通信协议规范
- `[DESIGN-FE-001]` 前端页面规范
- `[DESIGN-FE-002]` 前端组件库规范
- `[DESIGN-FE-003]` 前端快速参考卡

### 12.3 实施工具

- `scripts/ci/check-agent-rules.js` - 代理规则检查
- `scripts/ci/check-change-safety.js` - 变更安全检查
- `scripts/ci/validate-protocol-contracts.js` - 协议契约验证
- `scripts/ci/validate-reliability.js` - 可靠性验证

---

## 13. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本，定义项目规范化总纲 |

---

*本总纲由 khy-os 架构团队维护*