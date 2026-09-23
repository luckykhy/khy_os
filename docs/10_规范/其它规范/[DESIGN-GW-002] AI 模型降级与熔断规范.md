# [DESIGN-GW-002] AI 模型降级与熔断规范

<!-- RULES-REGISTRY: GW-002 -->

> **用途**：定义 khy-os AI 网关的模型降级（Fallback）和熔断（Circuit Breaker）策略。
> 当前 AI 网关有适配器机制但缺少降级/熔断标准。

---

## 1. 降级原则

1. **可用性优先**：主模型不可用时自动切换到备选模型
2. **成本可控**：降级模型按成本排序，自动选择最低可用成本模型
3. **透明告知**：前端显示「正在使用备选模型」提示
4. **可配置**：降级策略可通过配置调整

---

## 2. 模型分级

### 2.1 模型级别

| 级别 | 示例 | 成本/1K tokens | 优先级 |
|------|------|---------------|--------|
| P0（主力） | `gpt-4o`、`claude-sonnet-4` | 高 | 首选 |
| P1（备选） | `gpt-4o-mini`、`claude-haiku` | 中 | 自动切换 |
| P2（兜底） | `gpt-3.5-turbo`、本地模型 | 低 | 最后手段 |
| P3（极简） | 规则引擎 / 模板回复 | 零 | 全部不可用时 |

### 2.2 降级链

```
P0 主力模型
  ↓ 超时 / 错误率 > 阈值
P1 备选模型
  ↓ 同样失败
P2 兜底模型
  ↓ 全部不可用
P3 规则回复（非 AI，保证服务可用）
```

---

## 3. 熔断器

### 3.1 熔断状态机

```
┌──────────┐
│  CLOSED  │ ← 正常，请求通过
│          │
│  错误率 > 阈值  │
│  （如 50% / 60s）│
└────┬─────┘
     │
     ▼
┌──────────┐
│  OPEN    │ ← 熔断中，直接拒绝
│          │
│  等待冷却期  │
│  （如 30s）  │
└────┬─────┘
     │
     ▼
┌──────────┐
│HALF-OPEN │ ← 试探性放行
│          │
│  成功 → CLOSED │
│  失败 → OPEN   │
└──────────┘
```

### 3.2 配置

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `failureThreshold` | 50% | 错误率阈值（60s 窗口） |
| `minSampleSize` | 10 | 最小样本数 |
| `openDuration` | 30_000 | 熔断持续时间（ms） |
| `halfOpenMaxCalls` | 5 | 半开最大试探次数 |

### 3.3 实现

```javascript
class CircuitBreaker {
  constructor(options) {
    this.failureThreshold = options.failureThreshold || 0.5;
    this.minSampleSize = options.minSampleSize || 10;
    this.openDuration = options.openDuration || 30_000;
    this.halfOpenMaxCalls = options.halfOpenMaxCalls || 5;
    
    this.state = 'CLOSED';  // CLOSED / OPEN / HALF_OPEN
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = null;
    this.halfOpenCalls = 0;
  }
  
  async execute(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.openDuration) {
        this.state = 'HALF_OPEN';
        this.halfOpenCalls = 0;
      } else {
        throw new CircuitOpenError(`Circuit breaker open for ${this.openDuration}ms`);
      }
    }
    
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
  
  onSuccess() {
    this.failures = 0;
    if (this.state === 'HALF_OPEN') {
      this.halfOpenCalls++;
      if (this.halfOpenCalls >= this.halfOpenMaxCalls) {
        this.state = 'CLOSED';
      }
    }
  }
  
  onFailure() {
    const total = this.failures + this.successes;
    this.failures++;
    
    if (total >= this.minSampleSize && (this.failures / total) >= this.failureThreshold) {
      this.state = 'OPEN';
      this.lastFailureTime = Date.now();
    }
  }
}
```

---

## 4. 降级策略

### 4.1 触发条件

| 场景 | 降级动作 |
|------|---------|
| 主模型连续 3 次超时 | 切换到 P1 模型 |
| P1 模型错误率 > 50% | 熔断，切换到 P2 |
| P2 也失败 | 触发 P3 规则回复 |
| 熔断器 OPEN | 直接降级到下一级 |

### 4.2 降级执行

```javascript
async function callWithFallback(adapterChain, params) {
  for (const [adapter, breaker] of adapterChain) {
    try {
      return await breaker.execute(() => adapter.generate(params));
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        logger.warn(`Circuit open for ${adapter.name}, falling back`);
        continue;
      }
      
      // 可重试错误
      if (isRetryable(error) && breaker.state === 'CLOSED') {
        return await retry(() => adapter.generate(params), { maxRetries: 1 });
      }
      
      // 不可重试 → 下一个
      logger.error(`Adapter ${adapter.name} failed`, { error: error.message });
    }
  }
  
  // 全部失败 → 兜底
  return fallbackResponse(params);
}
```

---

## 5. 超时与重试

### 5.1 超时

| 模型级别 | 超时 | 说明 |
|---------|------|------|
| P0 | 30s | 主力模型允许较长响应 |
| P1 | 15s | 备选模型较快 |
| P2 | 10s | 兜底模型限时 |

### 5.2 重试策略

```javascript
const retry = require('promise-retry');

const retryOptions = {
  retries: 2,
  factor: 2,           // 指数退避
  minTimeout: 1000,    // 1s
  maxTimeout: 5000,    // 5s
  randomize: true      // 加抖动
};

await retry(async (retry) => {
  const result = await adapter.generate(params);
  if (result.retryable) throw retry(result.error);
  return result;
}, retryOptions);
```

---

## 6. 成本控制

### 6.1 成本追踪

```javascript
// 每次调用记录成本
const costMap = {
  'gpt-4o': { input: 5, output: 15 },      // $/1M tokens
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 }
};

function calculateCost(model, inputTokens, outputTokens) {
  const pricing = costMap[model];
  if (!pricing) return 0;
  
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}
```

### 6.2 成本熔断

| 条件 | 动作 |
|------|------|
| 单次请求成本 > $1 | 降级到更便宜模型 |
| 日累计成本 > $50 | 切换到 P2 模型 |
| 月累计成本 > $500 | 触发 P3 规则回复 + 告警 |

---

## 7. 前端显示

### 7.1 降级提示

```javascript
// AI 响应中包含降级标记
{
  "success": true,
  "data": {
    "text": "Hello",
    "model": "gpt-4o-mini",  // 实际使用的模型
    "degraded": true,         // 是否降级
    "degradedReason": "primary model timeout"
  }
}
```

### 7.2 前端展示

```vue
<template>
  <div class="ai-response">
    <div v-if="degraded" class="degraded-banner">
      <Icon name="warning" />
      正在使用 {{ model }}（备选模型），响应质量可能受影响
    </div>
    <div class="response-text">{{ text }}</div>
  </div>
</template>
```

---

## 8. 监控

### 8.1 关键指标

| 指标 | 告警阈值 |
|------|---------|
| 降级事件数 | > 10/min → Warning |
| 熔断触发次数 | > 3/min → Critical |
| 模型错误率 | P0 > 10% → Warning |
| P3 触发次数 | > 1/min → Critical（说明全链故障） |

---

## 9. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-10 | 初始版本，定义 AI 模型降级与熔断规范 |

---

*本规范由 khy-os 平台团队维护*
