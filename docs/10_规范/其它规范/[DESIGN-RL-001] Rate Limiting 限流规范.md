# [DESIGN-RL-001] Rate Limiting 限流规范

> **用途**：定义 khy-os 项目的请求限流标准，防止滥用和资源耗尽。
> SEC-001 §6 已有基础限流配置，本文档补全策略细节。

---

## 1. 限流原则

1. **分层限流**：网关层（全局）+ 端点层（局部）+ 用户层（个性化）
2. **可预测**：限流阈值公开，客户端可提前感知
3. **友好拒绝**：429 响应包含 `retryAfter`，不直接断开
4. ** exempt 机制**：内部服务、健康检查豁免限流

---

## 2. 限流维度

### 2.1 多维度组合

| 维度 | 键 | 说明 |
|------|-----|------|
| IP | `req.ip` | 匿名用户限流 |
| 用户 | `req.user?.sub` | 登录用户限流 |
| 端点 | `req.path` | 不同端点不同阈值 |
| 组合 | `ip:endpoint` | IP + 端点联合限流 |

### 2.2 限流算法

| 算法 | 适用场景 | 实现 |
|------|---------|------|
| **滑动窗口** | API 限流（推荐） | 精确、平滑 |
| 令牌桶 | 突发流量容忍 | 允许短时突发 |
| 固定窗口 | 简单场景 | 边界问题，不推荐 |

---

## 3. 限流阈值

### 3.1 全局阈值

| 端点类别 | 窗口 | 匿名 (IP) | 登录 (用户) |
|---------|------|-----------|-------------|
| 公开端点（`/public/*`） | 1 分钟 | 60 | — |
| 认证端点（`/auth/*`） | 15 分钟 | 5 | 10 |
| 普通 API（`/api/v1/*`） | 1 分钟 | 30 | 100 |
| 管理 API（`/admin/*`） | 1 分钟 | — | 30 |
| AI 生成（`/api/v1/ai/*`） | 1 分钟 | — | 20 |
| 文件上传 | 1 分钟 | 5 | 10 |

### 3.2 成本加权

AI 生成端点按 token 消耗加权：

```javascript
const AI_COST_WEIGHTS = {
  '/api/v1/ai/chat': 1,        // 1 次请求 = 1 次配额
  '/api/v1/ai/stream': 2,      // 流式消耗更多
  '/api/v1/ai/image': 10       // 图像生成权重高
};

function calculateCost(req) {
  const weight = AI_COST_WEIGHTS[req.path] || 1;
  const tokenUsage = req.body?.maxTokens || 1000;
  return weight * Math.ceil(tokenUsage / 1000);
}
```

---

## 4. 响应格式

### 4.1 限流响应

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Retry-After: 60
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1693833660
```

```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "type": "RATE_ERROR",
    "message": "请求过于频繁，请 {retryAfter} 秒后重试",
    "retryAfter": 60,
    "limit": 100,
    "window": "1m"
  }
}
```

### 4.2 响应头

| Header | 说明 |
|--------|------|
| `X-RateLimit-Limit` | 当前窗口总配额 |
| `X-RateLimit-Remaining` | 剩余配额 |
| `X-RateLimit-Reset` | 窗口重置时间（Unix timestamp） |
| `Retry-After` | 建议等待秒数（仅 429 时） |

---

## 5. 实现

### 5.1 滑动窗口（推荐）

```javascript
const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis');

const createLimiter = (options) => rateLimit({
  windowMs: options.window,
  max: options.max,
  message: {
    success: false,
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      type: 'RATE_ERROR',
      message: `请求过于频繁，请 ${Math.ceil(options.window / 1000)} 秒后重试`,
      retryAfter: Math.ceil(options.window / 1000),
      limit: options.max,
      window: formatWindow(options.window)
    }
  },
  standardHeaders: true,   // X-RateLimit-* 头
  legacyHeaders: false,
  keyGenerator: (req) => {
    // 登录用户用 user ID，否则用 IP
    return req.user?.sub || req.ip;
  },
  store: new RedisStore({ client: redisClient }),  // 分布式共享
  skip: (req) => isExempt(req)  // 豁免检查
});
```

### 5.2 豁免规则

```javascript
function isExempt(req) {
  // 健康检查豁免
  if (req.path === '/health' || req.path === '/ready') return true;
  
  // 内部服务豁免（mTLS 或 secret header）
  if (req.headers['x-internal-service'] === INTERNAL_SECRET) return true;
  
  // 管理员豁免（可选）
  if (req.user?.role === 'superadmin') return false;  // 管理员也限流，更安全
  
  return false;
}
```

### 5.3 端点级应用

```javascript
// 全局 API 限流
app.use('/api/v1/', createLimiter({
  window: 60_000,
  max: 100,
  keyGenerator: (req) => req.user?.sub || req.ip
}));

// 认证端点（更严格）
app.use('/api/v1/auth/', createLimiter({
  window: 15 * 60_000,
  max: 5,
  keyGenerator: (req) => req.ip  // 登录前只有 IP
}));

// AI 端点（成本加权）
app.use('/api/v1/ai/', createCostLimiter({
  window: 60_000,
  baseMax: 20
}));
```

---

## 6. 分布式限流

### 6.1 多实例一致性

| 方案 | 说明 |
|------|------|
| **Redis 共享** | 推荐：所有实例共享 Redis 计数器 |
| 粘性会话 | nginx `ip_hash`，单用户固定实例（不推荐） |
| 网关层限流 | 在反向代理层统一限流（第一道防线） |

### 6.2 Redis 存储

```javascript
const RedisStore = require('rate-limit-redis');

app.use('/api/', createLimiter({
  store: new RedisStore({
    client: redisClient,
    prefix: 'rl:'  // Redis key 前缀
  })
}));
```

---

## 7. 限流与缓存

### 7.1 限流结果缓存

```javascript
// 被限流的请求不走缓存
app.use('/api/', (req, res, next) => {
  if (req.rateLimit?.remaining === 0) {
    res.set('Cache-Control', 'no-store');
  }
  next();
});
```

### 7.2 预热缓存

高频端点（如 `/api/v1/strategies`）即使限流也返回缓存数据：

```javascript
app.get('/api/v1/strategies',
  createLimiter({ window: 60_000, max: 100 }),
  async (req, res) => {
    const data = await getCachedStrategies(req.user.id);
    res.json({ success: true, data, cached: true });
  }
);
```

---

## 8. 监控与告警

### 8.1 限流指标

| 指标 | 阈值 | 告警级别 |
|------|------|---------|
| 429 响应率 | > 5% | Warning |
| 单一 IP 429 > 100/min | 持续 5 分钟 | Warning |
| 429 响应率 > 20% | 持续 1 分钟 | Critical |

### 8.2 日志

```javascript
// 每次限流记录
logger.warn('Rate limited', {
  ip: req.ip,
  userId: req.user?.sub,
  path: req.path,
  limit: req.rateLimit?.limit,
  remaining: req.rateLimit?.remaining
});
```

---

## 9. 客户端规范

### 9.1 客户端应做的事

| 行为 | 说明 |
|------|------|
| 读取 `X-RateLimit-Remaining` | 主动降低请求频率 |
| 遇到 429 时等待 `Retry-After` | 指数退避 |
| 批量请求时分散间隔 | 避免集中触发限流 |

### 9.2 客户端退避

```javascript
async function apiRequest(url, options = {}) {
  const response = await fetch(url, options);
  
  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get('Retry-After') || '60');
    logger.warn(`Rate limited, retrying after ${retryAfter}s`);
    await sleep(retryAfter * 1000);
    return apiRequest(url, options);  // 重试一次
  }
  
  return response;
}
```

---

## 10. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-10 | 初始版本，定义 Rate Limiting 规范 |

---

*本规范由 khy-os 平台团队维护*
