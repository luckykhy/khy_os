# [DESIGN-PERF-001] 性能规范

> 本文档定义 khy-os 项目的性能标准，包括性能预算、优化策略等。

---

## 1. 性能概述

### 1.1 设计原则

1. **用户体验优先**：性能指标以用户体验为中心
2. **可衡量**：所有性能指标可量化、可监控
3. **持续优化**：持续关注和优化性能

### 1.2 性能指标

| 指标 | 说明 | 目标值 |
|------|------|--------|
| FCP | 首次内容绘制 | < 1.5s |
| LCP | 最大内容绘制 | < 2.5s |
| FID | 首次输入延迟 | < 100ms |
| CLS | 累积布局偏移 | < 0.1 |
| TTFB | 首字节时间 | < 200ms |
| TTI | 可交互时间 | < 3.5s |

---

## 2. 前端性能

### 2.1 资源加载

**Bundle 大小预算**：
| 类型 | 预算 | 说明 |
|------|------|------|
| 主包 | < 200KB | gzip 后 |
| 总资源 | < 500KB | gzip 后 |
| 图片 | < 200KB | 首屏图片 |

**加载策略**：
- 关键资源预加载
- 非关键资源懒加载
- 图片使用 WebP 格式
- 使用 CDN 加速

### 2.2 代码分割

**路由级别分割**：
```javascript
// 使用动态导入
const routes = [
  {
    path: '/dashboard',
    component: () => import('@/views/Dashboard.vue')
  },
  {
    path: '/settings',
    component: () => import('@/views/Settings.vue')
  }
];
```

**组件级别分割**：
```javascript
// 异步组件
import { defineAsyncComponent } from 'vue';

const HeavyComponent = defineAsyncComponent(() =>
  import('@/components/HeavyComponent.vue')
);
```

### 3.3 缓存策略

**HTTP 缓存**：
```nginx
# 静态资源缓存 1 年
location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
  expires 1y;
  add_header Cache-Control "public, immutable";
}

# HTML 不缓存
location ~* \.html$ {
  expires -1;
  add_header Cache-Control "no-cache";
}
```

**Service Worker 缓存**：
```javascript
// 缓存策略
workbox.routing.registerRoute(
  /\.(?:js|css|png|jpg|jpeg|gif|svg)$/,
  new workbox.strategies.CacheFirst({
    cacheName: 'static-resources',
    plugins: [
      new workbox.expiration.ExpirationPlugin({
        maxEntries: 60,
        maxAgeSeconds: 30 * 24 * 60 * 60 // 30 天
      })
    ]
  })
);
```

---

## 3. 后端性能

### 3.1 API 响应时间

| 接口类型 | 目标响应时间 | 最大响应时间 |
|---------|-------------|-------------|
| 简单查询 | < 100ms | 500ms |
| 复杂查询 | < 500ms | 2s |
| 写入操作 | < 200ms | 1s |
| 批量操作 | < 1s | 5s |

### 3.2 数据库优化

**索引优化**：
- 所有外键必须有索引
- 频繁查询的列创建索引
- 避免过度索引

**查询优化**：
```javascript
// ✅ 正确：只查询需要的字段
const users = await User.findAll({
  attributes: ['id', 'username', 'email'],
  where: { status: 'active' },
  limit: 20
});

// ❌ 错误：查询所有字段
const users = await User.findAll({
  where: { status: 'active' }
});
```

**N+1 查询优化**：
```javascript
// ✅ 正确：使用关联查询
const users = await User.findAll({
  include: [{
    model: Profile,
    as: 'profile'
  }]
});

// ❌ 错误：N+1 查询
const users = await User.findAll();
for (const user of users) {
  user.profile = await Profile.findOne({ where: { userId: user.id } });
}
```

### 3.3 缓存策略

**Redis 缓存**：
```javascript
const cacheOrFetch = async (key, fetchFn, ttl = 3600) => {
  // 尝试从缓存获取
  const cached = await redis.get(key);
  if (cached) {
    return JSON.parse(cached);
  }
  
  // 缓存未命中，执行查询
  const data = await fetchFn();
  
  // 写入缓存
  await redis.setex(key, ttl, JSON.stringify(data));
  
  return data;
};

// 使用示例
const users = await cacheOrFetch(
  'users:active',
  () => User.findAll({ where: { status: 'active' } }),
  300  // 5 分钟缓存
);
```

**缓存失效策略**：
- 数据更新时主动失效
- 设置合理的过期时间
- 使用版本号管理缓存

---

## 4. 性能监控

### 4.1 前端监控

**Core Web Vitals 监控**：
```javascript
import { getCLS, getFID, getLCP, getFCP, getTTFB } from 'web-vitals';

// 发送性能数据
const sendToAnalytics = (metric) => {
  fetch('/api/metrics/performance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: metric.name,
      value: metric.value,
      delta: metric.delta,
      id: metric.id
    })
  });
};

getCLS(sendToAnalytics);
getFID(sendToAnalytics);
getLCP(sendToAnalytics);
getFCP(sendToAnalytics);
getTTFB(sendToAnalytics);
```

### 4.2 后端监控

**API 性能监控**：
```javascript
const performanceMonitor = (req, res, next) => {
  const start = process.hrtime();
  
  res.on('finish', () => {
    const [seconds, nanoseconds] = process.hrtime(start);
    const duration = seconds * 1000 + nanoseconds / 1000000;
    
    // 记录慢请求
    if (duration > 1000) {
      logger.warn('Slow request detected', {
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        duration: `${duration.toFixed(2)}ms`
      });
    }
    
    // 上报指标
    metrics.histogram('api_response_time', duration, {
      method: req.method,
      path: req.path,
      status: res.statusCode
    });
  });
  
  next();
};
```

---

## 5. 性能优化清单

### 5.1 前端优化

- [ ] 启用 gzip/brotli 压缩
- [ ] 使用 CDN 分发静态资源
- [ ] 图片使用 WebP 格式
- [ ] 实现懒加载
- [ ] 代码分割
- [ ] 预加载关键资源
- [ ] 使用 Service Worker 缓存

### 5.2 后端优化

- [ ] 数据库查询优化
- [ ] 添加必要索引
- [ ] 使用缓存
- [ ] 连接池配置
- [ ] 异步处理耗时任务
- [ ] API 响应压缩

### 5.3 基础设施优化

- [ ] 使用 CDN
- [ ] 配置负载均衡
- [ ] 自动扩缩容
- [ ] 数据库读写分离
- [ ] 分布式缓存

---

## 6. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本，定义性能规范 |

---

*本规范由 khy-os 性能团队维护*