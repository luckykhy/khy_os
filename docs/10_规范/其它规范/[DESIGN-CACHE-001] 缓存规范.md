# [DESIGN-CACHE-001] 缓存规范

> 本文档定义 khy-os 项目的缓存标准，包括缓存策略、失效机制、键命名等。

---

## 1. 缓存概述

### 1.1 设计原则

1. **性能优先**：提升系统响应速度
2. **一致性**：缓存与数据源保持一致
3. **可用性**：缓存失败不影响主流程
4. **可监控**：缓存状态可监控

### 1.2 缓存层次

| 层次 | 位置 | 用途 |
|------|------|------|
| L1 | 浏览器缓存 | 静态资源 |
| L2 | CDN 缓存 | 全球分发 |
| L3 | 反向代理缓存 | 负载均衡 |
| L4 | 应用缓存 | 业务数据 |
| L5 | 数据库缓存 | 查询结果 |

---

## 2. 缓存策略

### 2.1 缓存模式

| 模式 | 说明 | 适用场景 |
|------|------|---------|
| Cache-Aside | 应用管理缓存 | 大多数场景 |
| Read-Through | 缓存层自动加载 | 读多写少 |
| Write-Through | 同步写入缓存和数据库 | 强一致性 |
| Write-Behind | 异步写入数据库 | 高写入性能 |

### 2.2 推荐策略

- **默认**：Cache-Aside
- **读多写少**：Read-Through
- **高一致性**：Write-Through
- **高写入**：Write-Behind

---

## 3. 缓存键命名

### 3.1 命名规范

**格式**：`{prefix}:{entity}:{id}:{field}`

**示例**：
```
user:123:profile
user:123:orders
product:466:details
config:app:settings
```

### 3.2 命名规则

| 规则 | 说明 | 示例 |
|------|------|------|
| 小写 | 使用小写字母 | `user:123` |
| 冒号分隔 | 使用冒号分隔层级 | `user:123:profile` |
| 简洁 | 键名简洁 | `u:123:p`（不推荐） |
| 可读 | 键名可读 | `user:123:profile`（推荐） |

### 3.3 键名前缀

| 前缀 | 用途 |
|------|------|
| user: | 用户数据 |
| order: | 订单数据 |
| product: | 产品数据 |
| config: | 配置数据 |
| session: | 会话数据 |
| rate: | 速率限制 |

---

## 4. 缓存时间

### 4.1 过期策略

| 数据类型 | TTL | 说明 |
|---------|-----|------|
| 用户会话 | 7 天 | 长期有效 |
| 用户配置 | 1 小时 | 可能变更 |
| 产品详情 | 15 分钟 | 可能变更 |
| 统计数据 | 5 分钟 | 频繁变更 |
| 配置数据 | 1 小时 | 较少变更 |

### 4.2 过期策略类型

| 策略 | 说明 |
|------|------|
| TTL | 固定过期时间 |
| LRU | 最近最少使用 |
| LFU | 最不经常使用 |
| FIFO | 先进先出 |

---

## 5. 缓存实现

### 5.1 Redis 缓存

```javascript
// utils/cache.js
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);

class Cache {
  static async get(key) {
    try {
      const data = await redis.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('Cache get error:', error);
      return null; // 缓存失败返回 null，不影响主流程
    }
  }
  
  static async set(key, value, ttl = 3600) {
    try {
      await redis.setex(key, ttl, JSON.stringify(value));
    } catch (error) {
      console.error('Cache set error:', error);
    }
  }
  
  static async del(key) {
    try {
      await redis.del(key);
    } catch (error) {
      console.error('Cache delete error:', error);
    }
  }
  
  static async delPattern(pattern) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }
}

module.exports = Cache;
```

### 5.2 缓存装饰器

```javascript
// utils/cacheDecorator.js
const Cache = require('./cache');

const cacheable = (keyGenerator, ttl = 3600) => {
  return (target, propertyKey, descriptor) => {
    const originalMethod = descriptor.value;
    
    descriptor.value = async function (...args) {
      const key = keyGenerator(...args);
      
      // 尝试从缓存获取
      const cached = await Cache.get(key);
      if (cached) {
        return cached;
      }
      
      // 缓存未命中，执行原方法
      const result = await originalMethod.apply(this, args);
      
      // 写入缓存
      await Cache.set(key, result, ttl);
      
      return result;
    };
    
    return descriptor;
  };
};

// 使用
class UserService {
  @cacheable((userId) => `user:${userId}:profile`, 3600)
  async getUserProfile(userId) {
    return User.findByPk(userId);
  }
}
```

### 5.3 缓存穿透防护

```javascript
// 使用布隆过滤器或空值缓存
const getWithCache = async (key, fetchFn, ttl = 3600) => {
  const cached = await Cache.get(key);
  
  // 缓存命中
  if (cached !== null) {
    return cached;
  }
  
  // 缓存未命中，查询数据源
  const data = await fetchFn();
  
  // 数据不存在，缓存空值（防止穿透）
  if (!data) {
    await Cache.set(key, { __null: true }, 300); // 5 分钟
    return null;
  }
  
  // 写入缓存
  await Cache.set(key, data, ttl);
  return data;
};
```

### 5.4 缓存击穿防护

```javascript
// 使用互斥锁
const getWithLock = async (key, fetchFn, ttl = 3600) => {
  const cached = await Cache.get(key);
  if (cached) {
    return cached;
  }
  
  // 获取锁
  const lockKey = `lock:${key}`;
  const locked = await redis.set(lockKey, '1', 'EX', 10, 'NX');
  
  if (locked) {
    try {
      // 获取锁成功，查询数据
      const data = await fetchFn();
      await Cache.set(key, data, ttl);
      return data;
    } finally {
      // 释放锁
      await redis.del(lockKey);
    }
  } else {
    // 获取锁失败，等待后重试
    await new Promise(resolve => setTimeout(resolve, 100));
    return getWithLock(key, fetchFn, ttl);
  }
};
```

### 5.5 缓存雪崩防护

```javascript
// 使用随机 TTL
const setWithJitter = async (key, value, baseTtl = 3600) => {
  const jitter = Math.floor(Math.random() * 600); // 0-10 分钟随机
  await Cache.set(key, value, baseTtl + jitter);
};
```

---

## 6. 缓存失效

### 6.1 失效策略

| 策略 | 说明 | 适用场景 |
|------|------|---------|
| 主动失效 | 数据更新时删除缓存 | 强一致性 |
| 被动失效 | 等待缓存过期 | 最终一致性 |
| 定时失效 | 定期清理过期缓存 | 批量清理 |

### 6.2 主动失效实现

```javascript
class UserService {
  async updateUser(userId, data) {
    // 更新数据库
    await User.update(data, { where: { id: userId } });
    
    // 删除相关缓存
    await Cache.del(`user:${userId}:profile`);
    await Cache.delPattern(`user:${userId}:*`);
  }
}
```

### 6.3 缓存失效事件

```javascript
// 使用消息队列广播缓存失效
const invalidateCache = async (pattern) => {
  // 发送失效事件
  await redis.publish('cache:invalidate', pattern);
  
  // 本地失效
  await Cache.delPattern(pattern);
};

// 订阅失效事件
redis.subscribe('cache:invalidate', (pattern) => {
  Cache.delPattern(pattern);
});
```

---

## 7. 浏览器缓存

### 7.1 HTTP 缓存头

```nginx
# 静态资源缓存 1 年
location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
  expires 1y;
  add_header Cache-Control "public, immutable";
}

# HTML 不缓存
location ~* \.html$ {
  expires -1;
  add_header Cache-Control "no-cache, no-store, must-revalidate";
}

# API 响应缓存
location /api/ {
  add_header Cache-Control "no-cache";
}
```

### 7.2 Service Worker 缓存

```javascript
// sw.js
const CACHE_NAME = 'khyos-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/assets/index.js',
  '/assets/index.css'
];

// 安装时缓存静态资源
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
});

// 请求拦截
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});
```

---

## 8. 缓存监控

### 8.1 监控指标

| 指标 | 说明 |
|------|------|
| hit_rate | 缓存命中率 |
| miss_rate | 缓存未命中率 |
| eviction_rate | 缓存淘汰率 |
| memory_usage | 内存使用率 |

### 8.2 监控实现

```javascript
// 缓存统计
const cacheStats = {
  hits: 0,
  misses: 0,
  
  recordHit() {
    this.hits++;
  },
  
  recordMiss() {
    this.misses++;
  },
  
  getHitRate() {
    const total = this.hits + this.misses;
    return total > 0 ? (this.hits / total * 100).toFixed(2) : 0;
  }
};

// 上报监控
setInterval(() => {
  metrics.gauge('cache_hit_rate', cacheStats.getHitRate());
  metrics.gauge('cache_hits', cacheStats.hits);
  metrics.gauge('cache_misses', cacheStats.misses);
}, 60000);
```

---

## 9. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本，定义缓存规范 |

---

*本规范由 khy-os 性能团队维护*