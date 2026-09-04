# [DESIGN-A2A-001] A2A 协议规范

> 本文档定义 khy-os 智能体间通信的 A2A (Agent-to-Agent) 协议规范。

---

## 1. 协议概述

### 1.1 设计目标

**A2A 协议**旨在实现：
- **智能体发现**：自动发现网络中的其他智能体
- **能力广播**：智能体广播自己的能力和服务
- **任务协商**：智能体之间协商任务分配和协作
- **状态同步**：智能体状态实时同步
- **安全通信**：加密和认证机制

### 1.2 设计原则

1. **去中心化**：无单点故障，支持 P2P 通信
2. **可扩展**：支持动态加入/退出智能体
3. **互操作**：基于标准协议，支持异构智能体
4. **安全可靠**：端到端加密，完整审计
5. **高性能**：低延迟，高吞吐

### 1.3 协议版本

- **当前版本**：`1.0.0`
- **协议标识**：`a2a/1.0`
- **兼容版本**：无（初始版本）

---

## 2. 协议架构

### 2.1 分层架构

```
┌─────────────────────────────────────────────────────────────┐
│                    A2A 协议栈                                 │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────┐   │
│  │              应用层 (Application Layer)              │   │
│  │  • 任务管理  • 能力发现  • 状态同步  • 结果聚合      │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              消息层 (Message Layer)                   │   │
│  │  • JSON-RPC 2.0  • 消息路由  • 优先级队列  • 序列化   │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              传输层 (Transport Layer)                 │   │
│  │  • WebSocket  • HTTP/2  • gRPC  • TCP  • UDP         │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              安全层 (Security Layer)                  │   │
│  │  • mTLS  • JWT  • RBAC  • 审计日志  • 密钥管理       │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              发现层 (Discovery Layer)                 │   │
│  │  • 服务注册  • 服务发现  • 健康检查  • 负载均衡       │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 组件架构

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   智能体 A   │────▶│   消息总线   │◀────│   智能体 B   │
│  (Agent A)   │     │ (Message Bus)│     │  (Agent B)   │
└──────────────┘     └──────────────┘     └──────────────┘
       │                    │                    │
       ▼                    ▼                    ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   能力注册   │     │   服务发现   │     │   任务队列   │
│ (Capability  │     │  (Service    │     │  (Task Queue)│
│  Registry)   │     │  Discovery)  │     │              │
└──────────────┘     └──────────────┘     └──────────────┘
```

---

## 3. 消息格式规范

### 3.1 基础消息格式

**所有 A2A 消息必须遵循以下基础格式**：

```json
{
  "jsonrpc": "2.0",
  "id": "msg-uuid",
  "method": "a2a.method.name",
  "params": {},
  "metadata": {
    "timestamp": "2026-09-04T12:00:00.000Z",
    "sender": "agent-id",
    "receiver": "agent-id | broadcast",
    "priority": "normal | high | low",
    "ttl": 30000,
    "correlationId": "request-uuid"
  }
}
```

**字段说明**：
- `jsonrpc`：JSON-RPC 版本，固定为 "2.0"
- `id`：消息唯一标识（UUID v4）
- `method`：方法名，格式为 `a2a.<category>.<action>`
- `params`：方法参数
- `metadata`：消息元数据

### 3.2 响应消息格式

**成功响应**：
```json
{
  "jsonrpc": "2.0",
  "id": "msg-uuid",
  "result": {
    "status": "success",
    "data": {}
  }
}
```

**错误响应**：
```json
{
  "jsonrpc": "2.0",
  "id": "msg-uuid",
  "error": {
    "code": -32600,
    "message": "Invalid Request",
    "data": {
      "details": "错误详情"
    }
  }
}
```

### 3.3 错误码定义

| 错误码 | 名称 | 说明 |
|--------|------|------|
| -32700 | Parse Error | JSON 解析错误 |
| -32600 | Invalid Request | 无效请求 |
| -32601 | Method Not Found | 方法不存在 |
| -32602 | Invalid Params | 无效参数 |
| -32603 | Internal Error | 内部错误 |
| -32000 | Agent Not Found | 智能体不存在 |
| -32001 | Capability Not Available | 能力不可用 |
| -32002 | Task Rejected | 任务被拒绝 |
| -32003 | Authentication Failed | 认证失败 |
| -32004 | Authorization Failed | 授权失败 |
| -32005 | Rate Limited | 请求限流 |
| -32006 | Timeout | 请求超时 |

---

## 4. 核心方法定义

### 4.1 发现类方法 (Discovery)

#### 4.1.1 智能体注册

**方法**：`a2a.discovery.register`

**请求**：
```json
{
  "method": "a2a.discovery.register",
  "params": {
    "agent": {
      "id": "agent-001",
      "name": "khy-quant",
      "version": "1.0.0",
      "description": "量化交易智能体",
      "capabilities": [
        {
          "name": "trading",
          "version": "1.0.0",
          "description": "量化交易执行",
          "parameters": {
            "symbols": ["BTC", "ETH"],
            "exchanges": ["binance", "okx"]
          }
        }
      ],
      "endpoint": "ws://localhost:3001",
      "healthCheck": "http://localhost:3001/health",
      "metadata": {
        "region": "asia",
        "environment": "production"
      }
    }
  }
}
```

**响应**：
```json
{
  "result": {
    "status": "success",
    "data": {
      "registered": true,
      "agentId": "agent-001",
      "expiresAt": "2026-09-04T12:30:00.000Z"
    }
  }
}
```

#### 4.1.2 智能体发现

**方法**：`a2a.discovery.query`

**请求**：
```json
{
  "method": "a2a.discovery.query",
  "params": {
    "filter": {
      "capabilities": ["trading"],
      "region": "asia",
      "status": "available"
    },
    "limit": 10,
    "offset": 0
  }
}
```

**响应**：
```json
{
  "result": {
    "status": "success",
    "data": {
      "agents": [
        {
          "id": "agent-001",
          "name": "khy-quant",
          "capabilities": ["trading"],
          "endpoint": "ws://localhost:3001",
          "status": "available",
          "lastSeen": "2026-09-04T11:59:00.000Z"
        }
      ],
      "total": 1,
      "hasMore": false
    }
  }
}
```

#### 4.1.3 智能体注销

**方法**：`a2a.discovery.unregister`

**请求**：
```json
{
  "method": "a2a.discovery.unregister",
  "params": {
    "agentId": "agent-001",
    "reason": "shutdown"
  }
}
```

### 4.2 能力类方法 (Capability)

#### 4.2.1 能力查询

**方法**：`a2a.capability.query`

**请求**：
```json
{
  "method": "a2a.capability.query",
  "params": {
    "agentId": "agent-001",
    "capability": "trading"
  }
}
```

**响应**：
```json
{
  "result": {
    "status": "success",
    "data": {
      "capability": {
        "name": "trading",
        "version": "1.0.0",
        "description": "量化交易执行",
        "parameters": {
          "symbols": {
            "type": "array",
            "items": {"type": "string"},
            "description": "交易对列表"
          },
          "exchanges": {
            "type": "array",
            "items": {"type": "string"},
            "description": "交易所列表"
          }
        },
        "returns": {
          "type": "object",
          "properties": {
            "orderId": {"type": "string"},
            "status": {"type": "string"},
            "filledPrice": {"type": "number"}
          }
        },
        "examples": [
          {
            "input": {"symbol": "BTC", "side": "buy", "amount": 0.1},
            "output": {"orderId": "ord-001", "status": "filled"}
          }
        ]
      }
    }
  }
}
```

#### 4.2.2 能力调用

**方法**：`a2a.capability.invoke`

**请求**：
```json
{
  "method": "a2a.capability.invoke",
  "params": {
    "agentId": "agent-001",
    "capability": "trading",
    "input": {
      "symbol": "BTC",
      "side": "buy",
      "amount": 0.1,
      "price": 50000
    },
    "options": {
      "timeout": 30000,
      "retries": 3,
      "priority": "high"
    }
  }
}
```

**响应**：
```json
{
  "result": {
    "status": "success",
    "data": {
      "executionId": "exec-001",
      "result": {
        "orderId": "ord-001",
        "status": "filled",
        "filledPrice": 50000,
        "filledAmount": 0.1,
        "timestamp": "2026-09-04T12:00:00.000Z"
      }
    }
  }
}
```

### 4.3 任务类方法 (Task)

#### 4.3.1 任务创建

**方法**：`a2a.task.create`

**请求**：
```json
{
  "method": "a2a.task.create",
  "params": {
    "task": {
      "id": "task-001",
      "type": "analysis",
      "name": "市场分析任务",
      "description": "分析 BTC/USDT 市场趋势",
      "input": {
        "symbol": "BTC/USDT",
        "timeframe": "1h",
        "limit": 100
      },
      "requirements": {
        "capabilities": ["market_analysis"],
        "priority": "high",
        "deadline": "2026-09-04T13:00:00.000Z",
        "maxCost": 10.0
      },
      "callback": {
        "url": "http://localhost:3000/callback",
        "method": "POST",
        "headers": {}
      }
    }
  }
}
```

**响应**：
```json
{
  "result": {
    "status": "success",
    "data": {
      "taskId": "task-001",
      "status": "created",
      "assignedTo": "agent-002",
      "estimatedCompletion": "2026-09-04T12:30:00.000Z"
    }
  }
}
```

#### 4.3.2 任务状态查询

**方法**：`a2a.task.status`

**请求**：
```json
{
  "method": "a2a.task.status",
  "params": {
    "taskId": "task-001"
  }
}
```

**响应**：
```json
{
  "result": {
    "status": "success",
    "data": {
      "taskId": "task-001",
      "status": "in_progress",
      "progress": 0.75,
      "assignedTo": "agent-002",
      "startedAt": "2026-09-04T12:00:00.000Z",
      "estimatedCompletion": "2026-09-04T12:30:00.000Z",
      "partialResults": {
        "trend": "bullish",
        "confidence": 0.85
      }
    }
  }
}
```

#### 4.3.3 任务取消

**方法**：`a2a.task.cancel`

**请求**：
```json
{
  "method": "a2a.task.cancel",
  "params": {
    "taskId": "task-001",
    "reason": "用户取消"
  }
}
```

### 4.4 状态类方法 (Status)

#### 4.4.1 状态推送

**方法**：`a2a.status.update`

**请求**：
```json
{
  "method": "a2a.status.update",
  "params": {
    "agentId": "agent-001",
    "status": {
      "state": "busy",
      "currentTask": "task-001",
      "progress": 0.75,
      "resourceUsage": {
        "cpu": 0.65,
        "memory": 0.45,
        "gpu": 0.80
      },
      "metrics": {
        "tasksCompleted": 150,
        "successRate": 0.98,
        "avgResponseTime": 1200
      }
    }
  }
}
```

#### 4.4.2 状态订阅

**方法**：`a2a.status.subscribe`

**请求**：
```json
{
  "method": "a2a.status.subscribe",
  "params": {
    "agentId": "agent-001",
    "events": ["state_change", "task_complete", "error"],
    "interval": 5000
  }
}
```

---

## 5. 传输层规范

### 5.1 WebSocket 传输

**连接地址**：`ws://<host>:<port>/a2a/v1`

**握手请求**：
```http
GET /a2a/v1 HTTP/1.1
Host: localhost:3001
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
Authorization: Bearer <jwt-token>
```

**消息帧**：
```
┌─────────┬─────────┬─────────┬─────────┐
│ FIN     │ RSV     │ Opcode  │ Mask    │
│ (1 bit) │ (3 bit) │ (4 bit) │ (1 bit) │
├─────────┴─────────┴─────────┼─────────┤
│ Payload Length              │ Masking │
│ (7/16/64 bit)               │ Key     │
├─────────────────────────────┼─────────┤
│ Payload Data                │         │
└─────────────────────────────┴─────────┘
```

### 5.2 HTTP/2 传输

**端点**：`https://<host>:<port>/a2a/v1`

**请求格式**：
```http
POST /a2a/v1 HTTP/2
Host: localhost:3001
Content-Type: application/json
Authorization: Bearer <jwt-token>
Content-Length: 123

{
  "jsonrpc": "2.0",
  "id": "msg-001",
  "method": "a2a.discovery.query",
  "params": {}
}
```

**流式响应**：
```http
HTTP/2 200 OK
Content-Type: application/json
Transfer-Encoding: chunked

{"jsonrpc":"2.0","id":"msg-001","result":{...}}
```

### 5.3 gRPC 传输

**Proto 定义**：
```protobuf
syntax = "proto3";

package a2a;

service A2AService {
  // 发现
  rpc Register(RegisterRequest) returns (RegisterResponse);
  rpc Query(QueryRequest) returns (QueryResponse);
  rpc Unregister(UnregisterRequest) returns (UnregisterResponse);
  
  // 能力
  rpc QueryCapability(QueryCapabilityRequest) returns (QueryCapabilityResponse);
  rpc InvokeCapability(InvokeCapabilityRequest) returns (InvokeCapabilityResponse);
  
  // 任务
  rpc CreateTask(CreateTaskRequest) returns (CreateTaskResponse);
  rpc GetTaskStatus(GetTaskStatusRequest) returns (GetTaskStatusResponse);
  rpc CancelTask(CancelTaskRequest) returns (CancelTaskResponse);
  
  // 状态
  rpc UpdateStatus(UpdateStatusRequest) returns (UpdateStatusResponse);
  rpc SubscribeStatus(SubscribeStatusRequest) returns (stream StatusEvent);
}
```

---

## 6. 安全规范

### 6.1 认证机制

**JWT Token 格式**：
```json
{
  "header": {
    "alg": "RS256",
    "typ": "JWT"
  },
  "payload": {
    "iss": "a2a-auth-server",
    "sub": "agent-001",
    "aud": "a2a-network",
    "exp": 1693833600,
    "iat": 1693830000,
    "scope": ["discovery", "capability", "task", "status"]
  }
}
```

**认证流程**：
1. 智能体向认证服务器注册
2. 获取客户端证书（mTLS）或 JWT Token
3. 在每次请求中携带认证信息
4. 服务端验证认证信息

### 6.2 授权机制

**RBAC 角色定义**：
```json
{
  "roles": {
    "admin": {
      "permissions": ["*"]
    },
    "agent": {
      "permissions": [
        "discovery:register",
        "discovery:query",
        "capability:query",
        "capability:invoke",
        "task:create",
        "task:status",
        "status:update"
      ]
    },
    "observer": {
      "permissions": [
        "discovery:query",
        "capability:query",
        "task:status",
        "status:read"
      ]
    }
  }
}
```

### 6.3 加密通信

**TLS 配置**：
- 最低版本：TLS 1.3
- 密码套件：TLS_AES_256_GCM_SHA384
- 证书验证：双向认证（mTLS）

**消息加密**：
```json
{
  "encrypted": true,
  "algorithm": "AES-256-GCM",
  "iv": "base64-encoded-iv",
  "tag": "base64-encoded-tag",
  "ciphertext": "base64-encoded-ciphertext"
}
```

---

## 7. 发现机制

### 7.1 服务注册

**注册中心**：
- 自注册：智能体启动时自动注册
- 心跳：定期发送心跳保持注册状态
- 注销：智能体关闭时主动注销

**注册信息**：
```json
{
  "agent": {
    "id": "agent-001",
    "name": "khy-quant",
    "endpoint": "ws://localhost:3001",
    "capabilities": ["trading"],
    "healthCheck": "http://localhost:3001/health",
    "metadata": {
      "version": "1.0.0",
      "region": "asia",
      "environment": "production"
    }
  },
  "registration": {
    "registeredAt": "2026-09-04T12:00:00.000Z",
    "expiresAt": "2026-09-04T12:30:00.000Z",
    "lastHeartbeat": "2026-09-04T12:05:00.000Z"
  }
}
```

### 7.2 服务发现

**发现方式**：
- **主动查询**：智能体主动查询其他智能体
- **订阅通知**：订阅智能体状态变化通知
- **广播发现**：广播发现请求

**负载均衡**：
- 轮询（Round Robin）
- 加权轮询（Weighted Round Robin）
- 最少连接（Least Connections）
- 响应时间（Response Time）

### 7.3 健康检查

**检查方式**：
- **HTTP 检查**：GET /health
- **TCP 检查**：端口连通性
- **自定义检查**：智能体自定义检查逻辑

**检查间隔**：30 秒

**超时时间**：5 秒

**失败阈值**：3 次

---

## 8. 实现计划

### 8.1 阶段 1：基础框架（1-2 周）

**目标**：建立 A2A 协议基础框架

**任务**：
- [ ] 定义消息格式和协议规范
- [ ] 实现基础消息解析和构建
- [ ] 建立 WebSocket 传输层
- [ ] 实现基础认证机制

**交付物**：
- A2A 协议核心库
- 基础测试用例
- 协议规范文档

### 8.2 阶段 2：核心功能（2-3 周）

**目标**：实现核心 A2A 功能

**任务**：
- [ ] 实现智能体注册和发现
- [ ] 实现能力广播和查询
- [ ] 实现任务创建和状态管理
- [ ] 实现状态同步机制

**交付物**：
- 完整的 A2A 协议实现
- 集成测试用例
- 使用示例

### 8.3 阶段 3：高级特性（3-4 周）

**目标**：实现高级特性和生产就绪

**任务**：
- [ ] 实现 mTLS 和高级认证
- [ ] 实现负载均衡和故障转移
- [ ] 实现审计和监控
- [ ] 性能优化和压力测试

**交付物**：
- 生产级 A2A 协议实现
- 性能测试报告
- 部署指南

---

## 9. 配置规范

### 9.1 配置文件

**文件位置**：`./.khy/a2a.json`

**配置格式**：
```json
{
  "a2a": {
    "enabled": true,
    "version": "1.0.0",
    "transport": {
      "websocket": {
        "enabled": true,
        "port": 3001,
        "path": "/a2a/v1"
      },
      "http": {
        "enabled": true,
        "port": 3002,
        "path": "/a2a/v1"
      },
      "grpc": {
        "enabled": false,
        "port": 3003
      }
    },
    "security": {
      "authentication": {
        "type": "jwt",
        "issuer": "a2a-auth-server",
        "audience": "a2a-network"
      },
      "authorization": {
        "enabled": true,
        "defaultRole": "agent"
      },
      "encryption": {
        "enabled": true,
        "tls": {
          "enabled": true,
          "cert": "./certs/server.crt",
          "key": "./certs/server.key",
          "ca": "./certs/ca.crt"
        }
      }
    },
    "discovery": {
      "registry": {
        "type": "memory",
        "ttl": 300
      },
      "healthCheck": {
        "interval": 30,
        "timeout": 5,
        "failureThreshold": 3
      }
    },
    "logging": {
      "level": "info",
      "format": "json",
      "output": "./logs/a2a.log"
    }
  }
}
```

### 9.2 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `A2A_ENABLED` | true | 启用 A2A 协议 |
| `A2A_PORT` | 3001 | WebSocket 端口 |
| `A2A_HTTP_PORT` | 3002 | HTTP 端口 |
| `A2A_GRPC_PORT` | 3003 | gRPC 端口 |
| `A2A_AUTH_TYPE` | jwt | 认证类型 |
| `A2A_TLS_ENABLED` | true | 启用 TLS |
| `A2A_LOG_LEVEL` | info | 日志级别 |

---

## 10. 测试规范

### 10.1 单元测试

**测试覆盖**：
- 消息解析和构建
- 协议方法实现
- 安全认证机制
- 错误处理

**测试命令**：
```bash
npm run test:a2a:unit
```

### 10.2 集成测试

**测试场景**：
- 智能体注册和发现
- 能力查询和调用
- 任务创建和状态管理
- 多智能体协作

**测试命令**：
```bash
npm run test:a2a:integration
```

### 10.3 性能测试

**测试指标**：
- 消息吞吐量
- 响应延迟
- 并发连接数
- 资源占用

**测试命令**：
```bash
npm run test:a2a:performance
```

---

## 11. 相关文档

- `[DESIGN-ARCH-072]` 项目规范化总纲
- `[DESIGN-MEM-001]` 记忆系统标准规范
- `[OPS-MAN-173]` MCP 工具接入快速上手

---

## 12. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本，定义 A2A 协议规范 |

---

*本规范由 khy-os 架构团队维护*