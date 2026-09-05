# [DESIGN-MS-001] 微服务通信规范

> 本文档定义 khy-os 项目的微服务/模块通信标准，包括服务发现、消息队列、事件驱动等。

---

## 1. 通信概述

### 1.1 设计原则

1. **松耦合**：服务之间松散耦合
2. **高内聚**：服务内部高度内聚
3. **可独立部署**：服务可独立部署
4. **容错性**：服务故障不影响整体

### 1.2 通信模式

| 模式 | 说明 | 适用场景 |
|------|------|---------|
| 同步 | 请求-响应 | 实时查询 |
| 异步 | 消息队列 | 后台任务 |
| 事件驱动 | 发布-订阅 | 状态变更通知 |

---

## 2. 服务发现

### 2.1 服务注册

```javascript
// services/registry.js
const services = new Map();

const registerService = (name, endpoint, metadata = {}) => {
  services.set(name, {
    endpoint,
    metadata,
    registeredAt: new Date(),
    lastHeartbeat: new Date()
  });
};

const getService = (name) => {
  return services.get(name);
};

const getAllServices = () => {
  return Array.from(services.entries()).map(([name, info]) => ({
    name,
    ...info
  }));
};
```

### 2.2 健康检查

```javascript
// 心跳检测
const heartbeat = async (serviceName) => {
  const service = services.get(serviceName);
  if (service) {
    service.lastHeartbeat = new Date();
  }
};

// 健康检查
const healthCheck = async (serviceName) => {
  const service = services.get(serviceName);
  if (!service) {
    return false;
  }
  
  const now = new Date();
  const diff = now - service.lastHeartbeat;
  
  // 超过 30 秒无心跳视为不健康
  return diff < 30000;
};
```

---

## 3. 消息队列

### 3.1 消息格式

```json
{
  "id": "msg-uuid",
  "type": "order.created",
  "timestamp": "2026-09-04T12:00:00.000Z",
  "source": "order-service",
  "payload": {
    "orderId": 123,
    "userId": 456,
    "total": 100.00
  },
  "metadata": {
    "correlationId": "corr-uuid",
    "retryCount": 0
  }
}
```

### 3.2 消息队列实现

```javascript
// utils/messageQueue.js
const Queue = require('bull');

const orderQueue = new Queue('order processing', {
  redis: {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT
  }
});

// 生产者
const publishMessage = async (queueName, message) => {
  const queue = new Queue(queueName);
  await queue.add(message, {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000
    }
  });
};

// 消费者
const consumeMessages = async (queueName, handler) => {
  const queue = new Queue(queueName);
  
  queue.process(async (job) => {
    try {
      await handler(job.data);
    } catch (error) {
      console.error('Message processing failed:', error);
      throw error;
    }
  });
};
```

### 3.3 消息确认

```javascript
// 消息确认机制
const processWithAck = async (message) => {
  try {
    // 处理消息
    await handleMessage(message);
    
    // 确认消息
    await acknowledgeMessage(message.id);
  } catch (error) {
    // 拒绝消息，重新入队
    await rejectMessage(message.id, true);
  }
};
```

---

## 4. 事件驱动架构

### 4.1 事件定义

```javascript
// events/types.js
const Events = {
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  USER_DELETED: 'user.deleted',
  
  ORDER_CREATED: 'order.created',
  ORDER_PAID: 'order.paid',
  ORDER_SHIPPED: 'order.shipped',
  ORDER_DELIVERED: 'order.delivered',
  
  PAYMENT_SUCCESS: 'payment.success',
  PAYMENT_FAILED: 'payment.failed'
};
```

### 4.2 事件发布/订阅

```javascript
// utils/eventEmitter.js
const EventEmitter = require('events');
const emitter = new EventEmitter();

// 发布事件
const emitEvent = (eventType, payload) => {
  emitter.emit(eventType, {
    type: eventType,
    timestamp: new Date().toISOString(),
    payload
  });
};

// 订阅事件
const onEvent = (eventType, handler) => {
  emitter.on(eventType, handler);
};

// 使用示例
onEvent(Events.ORDER_CREATED, async (event) => {
  // 发送通知
  await sendNotification(event.payload.userId, '订单已创建');
  
  // 更新统计
  await updateStatistics(event.payload);
});

// 发布事件
emitEvent(Events.ORDER_CREATED, {
  orderId: 123,
  userId: 456,
  total: 100.00
});
```

### 4.3 事件溯源

```javascript
// 事件存储
const saveEvent = async (event) => {
  await EventStore.create({
    id: event.id,
    type: event.type,
    timestamp: event.timestamp,
    payload: event.payload,
    metadata: event.metadata
  });
};

// 重放事件
const replayEvents = async (aggregateId) => {
  const events = await EventStore.findAll({
    where: { aggregateId },
    order: [['timestamp', 'ASC']]
  });
  
  let state = {};
  for (const event of events) {
    state = applyEvent(state, event);
  }
  
  return state;
};
```

---

## 5. 同步通信

### 5.1 HTTP 通信

```javascript
// utils/httpClient.js
const axios = require('axios');

const httpClient = axios.create({
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json'
  }
});

// 请求拦截器
httpClient.interceptors.request.use((config) => {
  config.headers['X-Request-ID'] = generateRequestId();
  config.headers['X-Correlation-ID'] = getCorrelationId();
  return config;
});

// 响应拦截器
httpClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 503) {
      // 服务不可用，重试
      return retryRequest(error.config);
    }
    return Promise.reject(error);
  }
);

module.exports = httpClient;
```

### 5.2 服务间认证

```javascript
// 使用 JWT 进行服务间认证
const getServiceToken = () => {
  return jwt.sign(
    {
      service: 'order-service',
      target: 'user-service'
    },
    process.env.SERVICE_JWT_SECRET,
    { expiresIn: '5m' }
  );
};

// 验证服务令牌
const verifyServiceToken = (token) => {
  try {
    return jwt.verify(token, process.env.SERVICE_JWT_SECRET);
  } catch (error) {
    throw new Error('Invalid service token');
  }
};
```

---

## 6. 容错机制

### 6.1 重试机制

```javascript
// utils/retry.js
const retry = async (fn, options = {}) => {
  const {
    maxRetries = 3,
    delay = 1000,
    backoff = 2,
    onRetry = null
  } = options;
  
  let lastError;
  
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      if (i < maxRetries) {
        const waitTime = delay * Math.pow(backoff, i);
        
        if (onRetry) {
          onRetry(error, i + 1, waitTime);
        }
        
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  throw lastError;
};

// 使用
const result = await retry(
  () => callExternalService(),
  {
    maxRetries: 3,
    delay: 1000,
    backoff: 2,
    onRetry: (error, attempt, delay) => {
      console.warn(`Retry ${attempt} after ${delay}ms: ${error.message}`);
    }
  }
);
```

### 6.2 断路器模式

```javascript
// utils/circuitBreaker.js
class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeout = options.resetTimeout || 30000;
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.failureCount = 0;
    this.lastFailureTime = null;
  }
  
  async execute(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.resetTimeout) {
        this.state = 'HALF_OPEN';
      } else {
        throw new Error('Circuit breaker is OPEN');
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
    this.failureCount = 0;
    this.state = 'CLOSED';
  }
  
  onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
    }
  }
}

// 使用
const breaker = new CircuitBreaker({
  failureThreshold: 5,
  resetTimeout: 30000
});

const result = await breaker.execute(() => callExternalService());
```

### 6.3 降级策略

```javascript
// 降级策略
const callWithFallback = async (primaryFn, fallbackFn) => {
  try {
    return await primaryFn();
  } catch (error) {
    console.warn('Primary service failed, using fallback:', error.message);
    return fallbackFn();
  }
};

// 使用
const userData = await callWithFallback(
  () => userService.getUser(userId),
  () => cacheService.get(`user:${userId}`)
);
```

---

## 7. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本，定义微服务通信规范 |

---

*本规范由 khy-os 架构团队维护*