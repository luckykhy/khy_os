# [DESIGN-OPS-003] Health Check 规范

<!-- RULES-REGISTRY: OPS-003 -->

> **用途**：定义 khy-os 服务的健康检查端点标准，供负载均衡、容器编排、监控系统使用。
> 当前无统一健康检查机制。

---

## 1. 健康检查原则

1. **三端点分离**：`/health`（存活）/ `/ready`（就绪）/ `/live`（依赖检查）
2. **轻量快速**：健康检查本身不应拖慢启动或增加依赖压力
3. **状态精确**：不返回 "OK" 掩盖实际故障
4. **分级返回**：返回各依赖的独立状态，便于定位

---

## 2. 三个端点

### 2.1 `/health` — 存活检查（Liveness）

| 属性 | 值 |
|------|-----|
| 用途 | 进程是否存活（Kubernetes liveness probe） |
| 检查内容 | 进程是否在运行、内存是否可用 |
| 超时 | < 100ms |
| 响应码 | 200 始终（存活不代表就绪） |

```javascript
app.get('/health', (req, res) => {
  const memUsage = process.memoryUsage();
  const heapOk = memUsage.heapUsed / memUsage.heapTotal < 0.9;
  
  res.status(200).json({
    status: heapOk ? 'ok' : 'degraded',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});
```

### 2.2 `/ready` — 就绪检查（Readiness）

| 属性 | 值 |
|------|-----|
| 用途 | 服务是否准备好接收流量（Kubernetes readiness probe） |
| 检查内容 | 所有依赖是否可达、数据连接是否正常 |
| 超时 | < 5s |
| 响应码 | 200（就绪）/ 503（未就绪） |

```javascript
app.get('/ready', async (req, res) => {
  const checks = await runDependencyChecks();
  const allHealthy = checks.every(c => c.status === 'healthy');
  
  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'ready' : 'not_ready',
    checks
  });
});
```

### 2.3 `/live` — 依赖健康检查

| 属性 | 值 |
|------|-----|
| 用途 | 各依赖的详细状态（供监控/告警） |
| 检查内容 | 数据库、Redis、外部 API、文件系统 |
| 超时 | < 10s |
| 缓存 | 结果缓存 30s（避免频繁探测） |

```javascript
app.get('/live', async (req, res) => {
  res.json({
    status: 'ok',
    checks: await getDetailedHealth()
  });
});
```

---

## 3. 依赖检查

### 3.1 检查项

| 依赖 | 检查方式 | 超时 | 降级策略 |
|------|---------|------|---------|
| SQLite / PostgreSQL | `SELECT 1` | 2s | 服务降级（缓存模式） |
| Redis（如有） | `PING` | 1s | 跳过缓存，直连 DB |
| 文件系统 | `access(dataDir, R_OK)` | 500ms | 报错 |
| 外部 AI API | 轻量 ping | 3s | 标记为 degraded |
| 磁盘空间 | `statvfs` | 500ms | 标记为 degraded |

### 3.2 检查实现

```javascript
async function runDependencyChecks() {
  const checks = [];
  const startTime = Date.now();
  
  // 1. 数据库
  checks.push(await checkDatabase());
  
  // 2. 磁盘空间
  checks.push(await checkDiskSpace());
  
  // 3. 外部服务
  checks.push(await checkExternalServices());
  
  return checks;
}

async function checkDatabase() {
  const start = Date.now();
  try {
    await sequelize.query('SELECT 1', { type: QueryTypes.RAW });
    return {
      name: 'database',
      status: 'healthy',
      responseTime: Date.now() - start
    };
  } catch (error) {
    return {
      name: 'database',
      status: 'unhealthy',
      responseTime: Date.now() - start,
      error: error.message
    };
  }
}

async function checkDiskSpace() {
  const stats = await fs.promises.stat(process.env.KHY_DATA_HOME || dataDir);
  // 检查可用空间 > 100MB
  // ...
}
```

### 3.3 缓存策略

```javascript
let healthCache = { data: null, cachedAt: 0 };
const HEALTH_CACHE_TTL = 30_000;  // 30 秒

async function getDetailedHealth() {
  const now = Date.now();
  if (healthCache.data && now - healthCache.cachedAt < HEALTH_CACHE_TTL) {
    return healthCache.data;
  }
  
  const data = await runDependencyChecks();
  healthCache = { data, cachedAt: now };
  return data;
}
```

---

## 4. 响应格式

### 4.1 标准响应

```json
{
  "status": "ready",
  "timestamp": "2026-09-10T12:00:00.000Z",
  "uptime": 3600,
  "checks": [
    {
      "name": "database",
      "status": "healthy",
      "responseTime": 2,
      "details": { "dialect": "sqlite", "version": "3.45.0" }
    },
    {
      "name": "disk",
      "status": "healthy",
      "responseTime": 1,
      "details": { "freeMB": 2048 }
    },
    {
      "name": "external_api",
      "status": "degraded",
      "responseTime": 3500,
      "details": { "reason": "timeout" }
    }
  ]
}
```

### 4.2 状态枚举

| status | 含义 | HTTP 码 |
|--------|------|---------|
| `ok` | 完全健康 | 200 |
| `degraded` | 部分功能降级，核心可用 | 200 |
| `ready` | 就绪可接收流量 | 200 |
| `not_ready` | 未就绪（依赖不可用） | 503 |
| `unhealthy` | 严重故障 | 503 |

---

## 5. Kubernetes 集成

### 5.1 Probe 配置

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 30
  timeoutSeconds: 5
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /ready
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 3
```

### 5.2 启动就绪

```javascript
// 启动序列中，等所有依赖就绪后再标记 ready
async function waitForStartup() {
  logger.info('Waiting for dependencies...');
  
  // 轮询 /ready 直到依赖全部就绪
  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
    const ready = await checkReady();
    if (ready) {
      logger.info('All dependencies ready');
      return;
    }
    await sleep(1000);
  }
  
  throw new Error('Startup timeout: dependencies not ready within 30s');
}
```

---

## 6. 容器化健康检查

### 6.1 Dockerfile

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1) })"
```

### 6.2 Docker Compose

```yaml
healthcheck:
  test: ["CMD", "node", "-e", "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"]
  interval: 30s
  timeout: 5s
  retries: 3
  start_period: 15s
```

---

## 7. 监控集成

### 7.1 告警规则

| 条件 | 严重度 | 说明 |
|------|--------|------|
| `/ready` 返回 503 > 30s | P0 | 服务不可用 |
| `/health` 返回 `degraded` > 60s | P1 | 内存或磁盘异常 |
| 依赖检查 `responseTime` > 5000ms | P1 | 依赖响应过慢 |
| `/ready` 间歇性 503 | P2 | 不稳定，需排查 |

### 7.2 日志

```javascript
// 健康检查请求必须记录
app.get('/health', (req, res) => {
  logger.info('Health check', {
    method: req.method,
    path: req.path,
    responseTime: Date.now() - startTime,
    result: 'ok'
  });
  res.json({ status: 'ok' });
});
```

---

## 8. 安全考虑

| 考虑 | 要求 |
|------|------|
| 端点公开性 | 健康检查端点**不需要认证**（负载均衡器需访问） |
| 信息泄露 | 不返回内部 IP、端口、版本号等敏感信息 |
| 限流 | 健康检查端点单独限流（免于常规限流） |
| DDoS 防护 | 健康检查路径在 CDN/网关层白名单 |

---

## 9. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-10 | 初始版本，定义 Health Check 规范 |

---

*本规范由 khy-os 平台团队维护*
