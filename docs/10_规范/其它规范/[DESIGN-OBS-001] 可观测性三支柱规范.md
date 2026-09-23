# [DESIGN-OBS-001] 可观测性三支柱规范

> **用途**：定义 khy-os 项目的可观测性标准，覆盖 Logs（日志）、Metrics（指标）、Traces（链路追踪）三支柱。
> LOG-001 已覆盖日志，本文档补全 Metrics 和 Traces。

---

## 1. 可观测性原则

1. **三支柱统一**：Logs + Metrics + Traces 共享 `requestId` 关联
2. **结构化优先**：全部 JSON 格式，禁止裸文本
3. **采样合理**：Trace 按比例采样，错误场景 100% 采样
4. **保留策略**：热数据 7 天，温数据 30 天，冷数据归档

---

## 2. Metrics（指标）

### 2.1 指标分类

| 类别 | 前缀 | 说明 | 示例 |
|------|------|------|------|
| Counter | `*_total` | 单调递增 | `http_requests_total` |
| Gauge | `*_current` | 瞬时值 | `active_connections_current` |
| Histogram | `*_duration_seconds` | 分布 | `http_request_duration_seconds` |
| Summary | `*_quantile` | 分位数 | `http_response_size_bytes` |

### 2.2 RED 方法

| 指标 | 说明 | 目标值 |
|------|------|--------|
| **Rate** | 请求速率 | 基线监控 |
| **Errors** | 错误率 | < 1% |
| **Duration** | 响应时间 P99 | < 500ms |

### 2.3 USE 方法（资源）

| 指标 | 说明 |
|------|------|
| **Utilization** | CPU / 内存使用率 |
| **Saturation** | 队列深度、连接池耗尽 |
| **Errors** | 资源错误（DB 连接失败） |

### 2.4 命名规范（Prometheus）

```
{khy_service="backend", khy_endpoint="/api/v1/strategies", khy_method="GET"}
```

**指标名格式**：
```
{khy_domain}_{what}_{unit}
```

| 指标名 | 类型 | 说明 |
|--------|------|------|
| `khy_http_requests_total` | Counter | HTTP 请求总数 |
| `khy_http_request_duration_seconds` | Histogram | HTTP 请求耗时 |
| `khy_http_responses_total{status="200"}` | Counter | 按状态码统计 |
| `khy_active_connections_current` | Gauge | 当前活跃连接 |
| `khy_db_query_duration_seconds` | Histogram | DB 查询耗时 |
| `khy_ai_adapter_calls_total{provider="openai"}` | Counter | AI 适配器调用次数 |
| `khy_ai_token_usage_total` | Counter | Token 消耗总量 |
| `khy_cache_hits_total` / `khy_cache_misses_total` | Counter | 缓存命中/未命中 |

### 2.5 实现（prom-client）

```javascript
const client = require('prom-client');

// Counter
const httpRequestsTotal = new client.Counter({
  name: 'khy_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['service', 'endpoint', 'method', 'status'],
  registers: [register]
});

// Histogram
const httpRequestDuration = new client.Histogram({
  name: 'khy_http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['service', 'endpoint', 'method'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register]
});

// 中间件集成
app.use((req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    httpRequestsTotal.inc({ service: 'backend', endpoint: req.path, method: req.method, status: res.statusCode });
    httpRequestDuration.observe({ service: 'backend', endpoint: req.path, method: req.method }, duration);
  });
  
  next();
});

// 暴露端点
app.get('/metrics', (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(register.metrics());
});
```

---

## 3. Traces（链路追踪）

### 3.1 规范

| 属性 | 值 |
|------|-----|
| 协议 | OpenTelemetry（OTLP） |
| 采样策略 | 错误 100%，正常 1% |
| Trace ID 格式 | 128-bit hex（32 字符） |
| Span 属性 | `service.name`、`http.method`、`http.route`、`error` |

### 3.2 传播

**所有跨服务调用必须传播 `traceparent`**：

```
traceparent: 00-{trace-id}-{span-id}-01
```

```javascript
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');

const provider = new NodeTracerProvider({
  sampler: new CompositeSampler([
    new AlwaysOnSampler(),  // 默认全采
    new TraceIdRatioBased(0.01)  // 1% 采样
  ])
});

provider.register();
```

### 3.3 手动 Span

```javascript
const { trace } = require('@opentelemetry/api');
const tracer = trace.getTracer('khy-backend');

async function handleAIRequest(req, res) {
  return tracer.startActiveSpan('ai.request', async (span) => {
    span.setAttribute('http.method', req.method);
    span.setAttribute('http.route', '/api/v1/ai/chat');
    span.setAttribute('user.id', req.user.sub);
    
    try {
      const result = await callAIProvider(req.body);
      span.setStatus({ code: SpanStatusCode.OK });
      res.json({ success: true, data: result });
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      next(error);
    } finally {
      span.end();
    }
  });
}
```

### 3.4 与 Logs 关联

每条日志必须携带 `traceId`，可通过 `requestId`（HTTP 层面）关联：

```javascript
// 中间件注入 traceId
app.use((req, res, next) => {
  const traceId = req.headers['x-request-id'] || uuidv4();
  res.setHeader('X-Request-ID', traceId);
  req.traceId = traceId;
  next();
});

// 日志自动携带
logger.info('Request started', {
  requestId: req.traceId,
  traceId: getCurrentTraceId()  // OpenTelemetry span context
});
```

---

## 4. 三支柱关联

### 4.1 关联模型

```
┌──────────┐     requestId      ┌──────────┐
│   Logs   │ ←────────────────→ │  Traces  │
│ (LOG-001)│                     │ (OBS-001)│
└────┬─────┘                     └────┬─────┘
     │                               │
     └─────────── Metrics ───────────┘
                (共享标签)
```

### 4.2 统一标签

| 标签 | 出现在 | 说明 |
|------|--------|------|
| `requestId` | Logs + Traces | HTTP 请求唯一标识 |
| `traceId` | Logs + Traces | OpenTelemetry Trace ID |
| `spanId` | Logs | 当前 Span ID |
| `service` | Metrics + Traces | 服务名（`backend`、`ai-gateway`） |
| `endpoint` | Metrics + Logs | 路由路径 |
| `userId` | Logs + Metrics | 用户 ID（匿名为 null） |

---

## 5. 告警规则

### 5.1 基于 Metrics

| 规则 | 条件 | 严重度 |
|------|------|--------|
| 错误率突增 | `rate(khy_http_responses_total{status=~"5.."}[5m]) / rate(khy_http_requests_total[5m]) > 0.05` | P0 |
| 响应时间 P99 过高 | `histogram_quantile(0.99, khy_http_request_duration_seconds) > 2` | P1 |
| 活跃连接过高 | `khy_active_connections_current > 800` | P1 |
| DB 连接池耗尽 | `khy_db_pool_active / khy_db_pool_max > 0.9` | P1 |
| AI 适配器错误率 | `rate(khy_ai_adapter_errors_total[5m]) > 0.1` | P1 |

### 5.2 基于 Traces

| 规则 | 条件 | 严重度 |
|------|------|--------|
| 慢 Trace | P99 > 2s | P2 |
| 错误 Trace | `span.status.code == ERROR` 占比 > 5% | P1 |

---

## 6. 保留策略

### 6.1 热/温/冷分层

| 类型 | 存储 | 保留 | 查询延迟 |
|------|------|------|---------|
| 热（实时） | Loki / Prometheus | 7 天 | < 1s |
| 温（分析） | ClickHouse / S3 | 30 天 | < 5s |
| 冷（归档） | S3 Glacier | 1 年 | 分钟级 |

### 6.2 采样策略

| 场景 | 采样率 |
|------|--------|
| 正常流量 | 1% |
| 4xx 错误 | 10% |
| 5xx 错误 | 100% |
| 健康检查 | 0%（不计入） |

---

## 7. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-10 | 初始版本，定义可观测性三支柱规范 |

---

*本规范由 khy-os 平台团队维护*
