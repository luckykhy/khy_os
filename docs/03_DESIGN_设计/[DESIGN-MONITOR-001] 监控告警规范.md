# [DESIGN-MONITOR-001] 监控告警规范

> 本文档定义 khy-os 项目的监控告警标准，包括指标收集、告警规则、事件响应等。

---

## 1. 监控概述

### 1.1 监控原则

1. **全面性**：覆盖所有关键组件
2. **实时性**：实时监控，及时发现问题
3. **可观测性**：提供足够的上下文信息
4. **自动化**：自动化告警和响应

### 1.2 监控层次

| 层次 | 说明 |
|------|------|
| 基础设施 | CPU、内存、磁盘、网络 |
| 应用 | 响应时间、错误率、吞吐量 |
| 业务 | 用户活跃度、核心业务流程 |

---

## 2. 指标收集

### 2.1 基础设施指标

| 指标 | 说明 | 收集频率 |
|------|------|---------|
| cpu_usage | CPU 使用率 | 15s |
| memory_usage | 内存使用率 | 15s |
| disk_usage | 磁盘使用率 | 60s |
| network_in | 网络入流量 | 15s |
| network_out | 网络出流量 | 15s |

### 2.2 应用指标

| 指标 | 说明 | 收集频率 |
|------|------|---------|
| request_count | 请求数量 | 每次请求 |
| response_time | 响应时间 | 每次请求 |
| error_count | 错误数量 | 每次错误 |
| active_connections | 活跃连接数 | 15s |

### 2.3 业务指标

| 指标 | 说明 | 收集频率 |
|------|------|---------|
| user_login_count | 用户登录数 | 每次登录 |
| order_count | 订单数量 | 每次下单 |
| api_key_usage | API Key 使用量 | 每次调用 |

---

## 3. 指标格式

### 3.1 Prometheus 格式

```
# HELP http_requests_total Total HTTP requests
# TYPE http_requests_total counter
http_requests_total{method="GET",path="/api/users",status="200"} 1027

# HELP http_request_duration_seconds HTTP request duration
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds_bucket{le="0.1"} 850
http_request_duration_seconds_bucket{le="0.5"} 1000
http_request_duration_seconds_bucket{le="1"} 1020
http_request_duration_seconds_bucket{le="+Inf"} 1027
```

### 3.2 自定义指标

```javascript
const promClient = require('prom-client');

// 计数器
const requestCounter = new promClient.Counter({
  name: 'khyos_requests_total',
  help: 'Total requests',
  labelNames: ['method', 'path', 'status']
});

// 直方图
const responseTimeHistogram = new promClient.Histogram({
  name: 'khyos_response_duration_seconds',
  help: 'Response duration in seconds',
  labelNames: ['method', 'path'],
  buckets: [0.1, 0.5, 1, 2, 5]
});

// 仪表表
const activeConnectionsGauge = new promClient.Gauge({
  name: 'khyos_active_connections',
  help: 'Active connections'
});
```

---

## 4. 告警规则

### 4.1 告警级别

| 级别 | 说明 | 响应时间 |
|------|------|---------|
| P0 | 严重 | 立即 |
| P1 | 高 | 15 分钟 |
| P2 | 中 | 1 小时 |
| P3 | 低 | 4 小时 |

### 4.2 基础设施告警

```yaml
# prometheus/alerts/infrastructure.yml
groups:
  - name: infrastructure
    rules:
      - alert: HighCPUUsage
        expr: cpu_usage > 80
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High CPU usage detected"
          description: "CPU usage is above 80% for 5 minutes"
          
      - alert: HighMemoryUsage
        expr: memory_usage > 85
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High memory usage detected"
          
      - alert: DiskSpaceLow
        expr: disk_usage > 90
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Disk space is running low"
```

### 4.3 应用告警

```yaml
# prometheus/alerts/application.yml
groups:
  - name: application
    rules:
      - alert: HighErrorRate
        expr: rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m]) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High error rate detected"
          
      - alert: SlowResponseTime
        expr: histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m])) > 2
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Slow response time detected"
          
      - alert: HighRequestRate
        expr: rate(http_requests_total[1m]) > 1000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High request rate detected"
```

### 4.4 业务告警

```yaml
# prometheus/alerts/business.yml
groups:
  - name: business
    rules:
      - alert: HighLoginFailureRate
        expr: rate(login_failures_total[5m]) / rate(login_attempts_total[5m]) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High login failure rate"
```

---

## 5. 告警通知

### 5.1 通知渠道

| 渠道 | 说明 | 使用级别 |
|------|------|---------|
| 邮件 | 邮件通知 | P2, P3 |
| 短信 | 短信通知 | P0, P1 |
| 钉钉 | 即时通讯 | P0, P1 |
| Webhook | 自定义集成 | 所有级别 |

### 5.2 通知配置

```yaml
# alertmanager/config.yml
route:
  group_by: ['alertname']
  group_wait: 10s
  group_interval: 10s
  repeat_interval: 1h
  receiver: 'default'
  routes:
    - match:
        severity: critical
      receiver: 'critical'
      repeat_interval: 5m
    - match:
        severity: warning
      receiver: 'warning'

receivers:
  - name: 'default'
    email_configs:
      - to: 'ops@example.com'
  - name: 'critical'
    email_configs:
      - to: 'ops@example.com'
    sms_configs:
      - to: '+86138xxxx'
    webhook_configs:
      - url: 'https://oapi.dingtalk.com/robot/send?access_token=xxx'
  - name: 'warning'
    email_configs:
      - to: 'ops@example.com'
```

---

## 6. 事件响应

### 6.1 响应流程

1. **检测**：监控系统检测到异常
2. **告警**：发送告警通知
3. **确认**：值班人员确认告警
4. **处理**：定位并处理问题
5. **恢复**：确认服务恢复正常
6. **复盘**：事后复盘总结

### 6.2 值班制度

| 角色 | 职责 |
|------|------|
| 值班工程师 | 接收告警，初步处理 |
| 技术负责人 | 重大事件决策 |
| 运维负责人 | 基础设施问题处理 |

### 6.3 事件记录

```markdown
# 事件报告

## 事件概述
- **时间**：2026-09-04 12:00:00
- **级别**：P1
- **影响**：用户无法登录

## 事件时间线
- 12:00:00 监控系统检测到登录失败率上升
- 12:05:00 发送告警通知
- 12:10:00 值班工程师确认告警
- 12:30:00 定位问题：数据库连接失败
- 12:45:00 切换备用数据库
- 13:00:00 服务恢复正常

## 根因分析
数据库主节点故障，导致连接失败。

## 改进措施
1. 增加数据库健康检查
2. 优化自动切换流程
```

---

## 7. 健康检查

### 7.1 健康检查端点

```javascript
// GET /api/health
app.get('/api/health', async (req, res) => {
  const checks = {
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version,
    environment: process.env.NODE_ENV
  };
  
  // 检查数据库
  try {
    await sequelize.authenticate();
    checks.database = 'ok';
  } catch (error) {
    checks.database = 'error';
  }
  
  // 检查 Redis
  if (redis) {
    try {
      await redis.ping();
      checks.redis = 'ok';
    } catch (error) {
      checks.redis = 'error';
    }
  }
  
  // 判断整体状态
  const isHealthy = Object.values(checks).every(v => v !== 'error');
  
  res.status(isHealthy ? 200 : 503).json({
    success: isHealthy,
    data: checks
  });
});
```

### 7.2 就绪检查端点

```javascript
// GET /api/ready
app.get('/api/ready', async (req, res) => {
  // 检查应用是否准备好接收流量
  const isReady = await checkReadiness();
  
  res.status(isReady ? 200 : 503).json({
    success: isReady,
    message: isReady ? 'Ready' : 'Not ready'
  });
});
```

---

## 8. 日志聚合

### 8.1 日志收集

```yaml
# filebeat.yml
filebeat.inputs:
  - type: log
    enabled: true
    paths:
      - /var/log/khyos/*.log
    json.keys_under_root: true
    json.add_error_key: true

output.elasticsearch:
  hosts: ['localhost:9200']
  index: 'khyos-%{+yyyy.MM.dd}'
```

### 8.2 日志查询

```json
// Kibana 查询
{
  "query": {
    "bool": {
      "must": [
        { "match": { "level": "error" } },
        { "range": { "timestamp": { "gte": "now-1h" } } }
      ]
    }
  }
}
```

---

## 9. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本，定义监控告警规范 |

---

*本规范由 khy-os 运维团队维护*