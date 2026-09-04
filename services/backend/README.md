# Khy Backend

khy-os 后端服务，基于 Node.js 构建。

## 项目概述

Khy Backend 是 khy-os 项目的核心后端服务，提供以下功能：

- AI 网关与多模型支持
- CLI 命令处理
- WebSocket 实时通信
- REST API 服务
- 任务调度与执行
- 记忆系统管理
- MCP 协议支持

## 技术栈

- **运行时**: Node.js 18+
- **框架**: Express.js
- **实时通信**: WebSocket (ws)
- **数据库**: SQLite (better-sqlite3)
- **AI 集成**: OpenAI, Anthropic, Ollama 等
- **协议**: MCP (Model Context Protocol)
- **日志**: Winston

## 项目结构

```
src/
├── cli/                # CLI 命令处理
│   ├── handlers/      # 命令处理器
│   ├── router.js      # 路由器
│   └── repl.js        # REPL 接口
├── constants/          # 常量定义
├── data/               # 数据层
├── memdir/             # 记忆目录管理
├── middleware/         # 中间件
├── routes/             # API 路由
├── services/           # 业务服务
│   ├── domain/        # 领域服务
│   ├── gateway/       # AI 网关
│   └── memory/        # 记忆服务
├── tasks/              # 任务调度
└── utils/              # 工具函数
```

## 快速开始

### 安装依赖

```bash
npm install
# 或
pnpm install
```

### 启动服务

```bash
# 开发模式
npm run dev

# 生产模式
npm start
```

### CLI 命令

```bash
# 启动 CLI
node bin/khy.js

# 运行特定命令
node bin/khy.js status
node bin/khy.js gateway config
node bin/khy.js memory project
```

## 开发规范

### 代码风格

- 使用 ESLint 进行代码格式化
- 使用 2 空格缩进
- 使用单引号
- 使用分号
- 使用 camelCase 命名

### 错误处理

```javascript
// ✅ 正确
try {
  await someAsyncOperation();
} catch (error) {
  console.error('操作失败:', error.message);
  throw error;
}

// ❌ 错误
try {
  await someAsyncOperation();
} catch (error) {
  console.error('错误'); // 不够具体
}
```

### 状态消息

遵循"动作 + 目标 + 进度"规范：

```javascript
// ✅ 正确
console.log('连接 PostgreSQL (127.0.0.1:5432)，第 2/3 次重试...');

// ❌ 错误
console.log('正在连接数据库...');
```

### 超时处理

使用活动超时，而非固定超时：

```javascript
// ✅ 正确
let lastActivity = Date.now();
const IDLE_LIMIT = 120_000;

onToolResult = () => { lastActivity = Date.now(); };

if (Date.now() - lastActivity > IDLE_LIMIT) {
  // 超时处理
}

// ❌ 错误
const start = Date.now();
if (Date.now() - start > 120_000) {
  // 硬超时
}
```

## API 文档

### REST API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/health` | GET | 健康检查 |
| `/api/status` | GET | 系统状态 |
| `/api/chat` | POST | AI 对话 |
| `/api/models` | GET | 模型列表 |
| `/api/memory` | GET | 记忆列表 |

### WebSocket

```javascript
const ws = new WebSocket('ws://localhost:3000/ws');

ws.onopen = () => {
  console.log('已连接');
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('收到消息:', data);
};
```

### MCP 协议

```javascript
// MCP 客户端配置
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["server.js"],
      "env": {}
    }
  }
}
```

## 测试

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

## 配置

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `3000` |
| `NODE_ENV` | 运行环境 | `development` |
| `KHY_AI_GATEWAY` | AI 网关地址 | - |
| `KHY_MCP_SERVE` | MCP 服务开关 | `on` |
| `KHY_MEMORY_DIR` | 记忆目录 | `.khy/memory` |

### 配置文件

- `~/.khyquant/config.json` - 用户配置
- `.khy/mcp.json` - MCP 服务器配置
- `.khy/memory/` - 记忆存储

## 部署

### Docker 部署

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3000
CMD ["node", "bin/khy.js"]
```

### PM2 部署

```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'khy-backend',
    script: 'bin/khy.js',
    instances: 'max',
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    }
  }]
};
```

## 监控

### 健康检查

```bash
curl http://localhost:3000/api/health
```

### 日志

日志文件位置：
- 错误日志：`logs/error.log`
- 综合日志：`logs/combined.log`

### 性能监控

```bash
# 查看进程状态
pm2 status

# 查看日志
pm2 logs khy-backend

# 监控资源
pm2 monit
```

## 相关文档

- [项目规范化总纲](../../docs/03_DESIGN_设计/[DESIGN-ARCH-072]%20项目规范化总纲.md)
- [MCP 工具接入快速上手](../../docs/07_OPS_运维/[OPS-MAN-173]%20MCP工具接入快速上手.md)
- [记忆系统标准规范](../../docs/03_DESIGN_设计/[DESIGN-MEM-001]%20记忆系统标准规范.md)

## 许可证

MIT License

---

*本项目由 khy-os 团队维护*