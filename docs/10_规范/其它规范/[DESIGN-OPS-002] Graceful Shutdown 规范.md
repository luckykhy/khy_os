# [DESIGN-OPS-002] Graceful Shutdown 规范

<!-- RULES-REGISTRY: OPS-002 -->

> **用途**：定义 khy-os 服务优雅关闭标准，确保连接 drain、数据持久化、资源释放的有序完成。
> 当前无此规范，服务重启时可能导致请求丢失和数据不一致。

---

## 1. 关闭原则

1. **信号优先**：响应 `SIGTERM` → 有序关闭；`SIGKILL` → 强制终止（不做清理）
2. **停止接受新请求**：关闭前先关闭监听端口
3. **Drain 存量连接**：等待活跃请求完成，设置超时
4. **数据持久化优先**：内存数据先落盘，再释放连接
5. **关闭顺序**：子进程 → 工作线程 → 数据库连接 → 定时器

---

## 2. 信号处理

### 2.1 信号映射

| 信号 | 来源 | 行为 |
|------|------|------|
| `SIGTERM` | `docker stop`、`kill`、`systemctl stop` | 有序关闭（推荐） |
| `SIGINT` | `Ctrl+C` | 有序关闭（开发环境） |
| `SIGQUIT` | `kill -QUIT` | 有序关闭 + core dump（调试用） |
| `SIGKILL` | `kill -9` | 强制终止（跳过清理） |
| `SIGHUP` | 终端关闭 | 热重载（不关闭，仅重载配置） |

### 2.2 信号处理代码

```javascript
const SHUTDOWN_TIMEOUT = 30_000;  // 30 秒
let isShuttingDown = false;

function setupGracefulShutdown(server, cleanupFn) {
  const signals = ['SIGTERM', 'SIGINT'];
  
  for (const signal of signals) {
    process.once(signal, async () => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      
      logger.info(`Received ${signal}, starting graceful shutdown...`);
      
      try {
        await performShutdown(server, cleanupFn);
      } catch (error) {
        logger.error('Error during shutdown', { error: error.message });
        process.exit(1);
      }
    });
  }
}

async function performShutdown(server, cleanupFn) {
  // 1. 停止接受新连接
  logger.info('Step 1: Stopping new connections...');
  server.close();
  
  // 2. 等待活跃连接 drain（带超时）
  const drainPromise = waitForActiveConnections(server);
  const timeoutPromise = sleep(SHUTDOWN_TIMEOUT).then(() => {
    throw new Error('Shutdown timeout exceeded');
  });
  
  try {
    await Promise.race([drainPromise, timeoutPromise]);
    logger.info('Step 2: All connections drained');
  } catch (error) {
    logger.warn(`Step 2: ${error.message}, forcing close`);
    forceCloseConnections(server);
  }
  
  // 3. 持久化内存数据
  logger.info('Step 3: Persisting in-memory state...');
  await cleanupFn();
  
  // 4. 关闭数据库连接
  logger.info('Step 4: Closing database connections...');
  await sequelize.close();
  
  // 5. 关闭其他资源
  await closeRemainingResources();
  
  logger.info('Graceful shutdown complete');
  process.exit(0);
}
```

---

## 3. 连接 Drain

### 3.1 HTTP 连接跟踪

```javascript
// 跟踪活跃连接
const activeConnections = new Set();

function trackConnection(socket) {
  socket.on('finish', () => activeConnections.delete(socket));
  socket.on('close', () => activeConnections.delete(socket));
  activeConnections.add(socket);
}

async function waitForActiveConnections(server) {
  return new Promise((resolve) => {
    if (activeConnections.size === 0) {
      return resolve();
    }
    
    const checkInterval = setInterval(() => {
      logger.info(`Waiting for ${activeConnections.size} active connections...`);
      if (activeConnections.size === 0) {
        clearInterval(checkInterval);
        resolve();
      }
    }, 500);
  });
}

function forceCloseConnections(server) {
  for (const socket of activeConnections) {
    socket.destroy();
  }
  activeConnections.clear();
}
```

### 3.2 Express 集成

```javascript
// 在连接建立时跟踪
server.on('connection', (socket) => {
  trackConnection(socket);
});

// WebSocket 连接也需要跟踪
wss.on('connection', (ws) => {
  activeConnections.add(ws);
  ws.on('close', () => activeConnections.delete(ws));
});
```

---

## 4. 数据持久化

### 4.1 需要持久化的数据

| 数据类型 | 持久化目标 | 时机 |
|---------|-----------|------|
| Token 用量统计 | `~/.khyquant/token_usage.json` | 每次写入或关闭前 |
| 对话记录 | `~/.khyquant/conversations/` | 流式对话结束时 |
| 训练数据 | 已持久化，无需额外操作 | — |
| 策略配置 | DB（已持久化） | — |
| 内存缓存 | 无（可重建） | — |

### 4.2 持久化代码

```javascript
async function persistInMemoryData() {
  const tasks = [];
  
  // 1. Token 用量
  if (tokenUsageService.hasUnsaved()) {
    tasks.push(tokenUsageService.flushToDisk());
  }
  
  // 2. 对话记录（已通过流式写盘，检查遗漏）
  if (conversationStore.hasDirty()) {
    tasks.push(conversationStore.flush());
  }
  
  // 3. 运行状态文件
  tasks.push(writeRuntimeState());
  
  await Promise.allSettled(tasks);
}
```

---

## 5. 关闭顺序

### 5.1 标准关闭序列

```
┌─────────────────────────────────────────┐
│  SIGTERM 收到                            │
│           ↓                              │
│  1. 停止监听端口（server.close()）         │
│           ↓                              │
│  2. Drain 活跃连接（30s 超时）              │
│           ↓                              │
│  3. 持久化内存数据                         │
│           ↓                              │
│  4. 停止子进程（worker / daemon）           │
│           ↓                              │
│  5. 关闭数据库连接池                       │
│           ↓                              │
│  6. 关闭 Redis / 缓存连接                  │
│           ↓                              │
│  7. 清理定时器 / 清理中间件                 │
│           ↓                              │
│  process.exit(0)                         │
└─────────────────────────────────────────┘
```

### 5.2 khy-os 特有资源

```javascript
async function closeKhyResources() {
  // Worker 子进程
  if (workerPool) {
    logger.info('Terminating worker pool...');
    await workerPool.terminate(5000);
  }
  
  // Daemon 进程
  if (daemonProcess) {
    logger.info('Stopping daemon...');
    await daemonProcess.stop();
  }
  
  // CLI REPL（如果活跃）
  if (replServer) {
    logger.info('Closing REPL...');
    replServer.close();
  }
  
  // TUI 实例
  if (tuiInstance) {
    logger.info('Cleaning up TUI...');
    tuiInstance.cleanup();
  }
}
```

---

## 6. Docker / 容器化部署

### 6.1 Dockerfile 配置

```dockerfile
# 明确终止信号
STOPSIGNAL SIGTERM

# 健康检查（供编排系统使用）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node health-check.js || exit 1
```

### 6.2 Docker Compose

```yaml
services:
  backend:
    stop_grace_period: 30s  # 给足 30 秒完成优雅关闭
    healthcheck:
      test: ["CMD", "node", "health-check.js"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
```

### 6.3 Kubernetes

```yaml
spec:
  terminationGracePeriodSeconds: 30
  containers:
    - name: backend
      lifecycle:
        preStop:
          exec:
            command: ["/bin/sh", "-c", "sleep 5"]
```

---

## 7. 热重载（开发环境）

### 7.1 nodemon 配置

```json
{
  "scripts": {
    "dev": "nodemon --signal SIGTERM --exitcrash bin/khy.js"
  },
  "nodemonConfig": {
    "signal": "SIGTERM",
    "events": {
      "exit": "echo 'Process exited gracefully'"
    }
  }
}
```

### 7.2 进程管理器（PM2）

```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'khy-backend',
    script: 'bin/khy.js',
    kill_timeout: 30000,      // 等待 30s 再 SIGKILL
    wait_ready: true,
    listen_timeout: 10000
  }]
};
```

---

## 8. 关闭验证

### 8.1 关闭检查清单

```javascript
async function verifyShutdown() {
  // 验证所有连接已关闭
  if (activeConnections.size > 0) {
    logger.warn(`Shutdown with ${activeConnections.size} active connections`);
  }
  
  // 验证数据已持久化
  const pendingWrites = await checkPendingWrites();
  if (pendingWrites > 0) {
    logger.error(`Shutdown with ${pendingWrites} pending writes`);
  }
  
  // 验证子进程已停止
  const runningWorkers = await workerPool.getActiveCount();
  if (runningWorkers > 0) {
    logger.warn(`Shutdown with ${runningWorkers} active workers`);
  }
}
```

### 8.2 日志输出

```javascript
// 关闭日志必须包含以下信息
logger.info('Graceful shutdown complete', {
  activeConnections: activeConnections.size,
  pendingWrites: pendingWriteCount,
  workerPoolSize: workerPool.getActiveCount(),
  shutdownDuration: Date.now() - shutdownStartTime,
  exitCode: 0
});
```

---

## 9. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-10 | 初始版本，定义 Graceful Shutdown 规范 |

---

*本规范由 khy-os 平台团队维护*
