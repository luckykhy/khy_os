# [DESIGN-DLQ-001] Dead Letter Queue 死信队列规范

<!-- RULES-REGISTRY: DLQ-001 -->

> **用途**：定义 khy-os 异步任务处理中 Dead Letter Queue（死信队列）标准。
> 当前无统一死信处理机制。

---

## 1. 原则

1. **不丢失**：失败任务不丢弃，进入 DLQ
2. **可重试**：DLQ 中的任务可手动/自动重试
3. **可观察**：DLQ 状态可见，有告警
4. **有上限**：DLQ 大小有上限，防止无限堆积

---

## 2. 适用场景

| 场景 | 示例 |
|------|------|
| AI 请求失败 | 适配器超时、API 限流 |
| 异步任务 | 训练任务、回测任务 |
| 消息处理 | WebSocket 消息处理失败 |
| 邮件/通知发送 | SMTP 失败 |

---

## 3. 重试策略

### 3.1 指数退避

```javascript
const RETRY_POLICY = {
  maxRetries: 3,
  baseDelay: 1000,      // 1s
  maxDelay: 30000,      // 30s
  backoffFactor: 2,
  jitter: true
};

function getRetryDelay(attempt) {
  const delay = Math.min(
    RETRY_POLICY.baseDelay * Math.pow(RETRY_POLICY.backoffFactor, attempt),
    RETRY_POLICY.maxDelay
  );
  
  if (RETRY_POLICY.jitter) {
    return delay * (0.5 + Math.random() * 0.5);
  }
  
  return delay;
}
```

### 3.2 重试触发

| 错误类型 | 是否重试 | 说明 |
|---------|---------|------|
| 网络超时 | ✅ | 临时故障 |
| 5xx 错误 | ✅ | 服务端临时故障 |
| 429 限流 | ✅ | 等待后重试 |
| 4xx 错误 | ❌ | 客户端错误，重试无意义 |
| 认证失败 | ❌ | 需要人工介入 |

---

## 4. DLQ 结构

```javascript
{
  "id": "dlq-uuid",
  "originalTask": {
    "type": "ai.chat",
    "params": { "message": "Hello" },
    "userId": "user-123"
  },
  "failureReason": "AI_ADAPTER_TIMEOUT",
  "retryCount": 3,
  "maxRetries": 3,
  "firstFailedAt": "2026-09-10T12:00:00.000Z",
  "lastRetryAt": "2026-09-10T12:05:00.000Z",
  "status": "exhausted",  // pending / retrying / exhausted / dead
  "metadata": {
    "requestId": "req-uuid",
    "traceId": "trace-uuid"
  }
}
```

---

## 5. 处理流程

```
任务提交 → 执行（失败） → 重试（最多 3 次）
                              ↓ 仍然失败
                         进入 DLQ（status: exhausted）
                              ↓
                      人工/自动重试 → 成功 → 删除
                              ↓ 仍然失败
                      永久失败（status: dead）→ 通知 + 清理
```

---

## 6. DLQ 管理

### 6.1 查看

```javascript
// 查询 DLQ
GET /api/v1/admin/dlq?status=exhausted&limit=50

// 单个任务详情
GET /api/v1/admin/dlq/:id
```

### 6.2 重试

```javascript
// 手动重试
POST /api/v1/admin/dlq/:id/retry

// 批量重试
POST /api/v1/admin/dlq/retry-all?status=exhausted
```

### 6.3 清理

```javascript
// 永久删除（需确认）
DELETE /api/v1/admin/dlq/:id

// 自动清理（7 天前的 dead 任务）
// cron job
```

---

## 7. 监控告警

| 指标 | 阈值 | 严重度 |
|------|------|--------|
| DLQ 堆积 > 100 | 持续 5 分钟 | P1 |
| 同一任务重试 > 3 次 | — | P2 |
| DLQ 增长速率 > 10/min | — | P2 |

---

## 8. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-10 | 初始版本，定义 Dead Letter Queue 规范 |

---

*本规范由 khy-os 平台团队维护*
