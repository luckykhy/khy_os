# [DESIGN-DEPLOY-001] 部署规范

> 本文档定义 khy-os 项目的部署标准，包括环境配置、部署流程、回滚等。

---

## 1. 部署概述

### 1.1 设计原则

1. **自动化**：部署流程自动化，减少人为错误
2. **可重复**：部署过程可重复，结果一致
3. **可回滚**：支持快速回滚到之前的版本
4. **零停机**：支持零停机部署

### 1.2 环境定义

| 环境 | 用途 | 域名 | 数据库 |
|------|------|------|--------|
| 开发 | 本地开发 | localhost:3000 | SQLite |
| 测试 | 功能测试 | test.khyquant.top | SQLite |
| 预发 | 预发布验证 | staging.khyquant.top | PostgreSQL |
| 生产 | 正式环境 | khyquant.top | PostgreSQL |

---

## 2. 环境配置

### 2.1 环境变量

**必需变量**：
```bash
# 应用配置
NODE_ENV=production
PORT=3000
HOST=0.0.0.0

# 数据库配置
DATABASE_URL=postgresql://user:pass@host:5432/dbname
# 或 SQLite
DATABASE_STORAGE=./data/production.db

# JWT 配置
JWT_SECRET=your-secret-key
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d

# 日志配置
LOG_LEVEL=info
LOG_DIR=./logs

# CORS 配置
CORS_ORIGIN=https://khyquant.top,https://*.khyquant.top
```

**可选变量**：
```bash
# Redis 配置
REDIS_URL=redis://localhost:6379

# 邮件配置
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=user@example.com
SMTP_PASS=password

# 监控配置
SENTRY_DSN=https://sentry.io/xxx
```

### 2.2 配置文件

**.env 文件结构**：
```bash
# .env.production
NODE_ENV=production
PORT=3000
DATABASE_URL=postgresql://...
JWT_SECRET=...
LOG_LEVEL=info

# .env.staging
NODE_ENV=staging
PORT=3000
DATABASE_URL=postgresql://...
JWT_SECRET=...
LOG_LEVEL=debug
```

---

## 3. Docker 部署

### 3.1 Dockerfile

```dockerfile
# 构建阶段
FROM node:18-alpine AS builder

WORKDIR /app

# 复制依赖文件
COPY package*.json ./

# 安装依赖
RUN npm ci --only=production

# 复制源代码
COPY . .

# 构建应用
RUN npm run build

# 运行阶段
FROM node:18-alpine AS runner

WORKDIR /app

# 创建非 root 用户
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 khyos

# 复制构建产物
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# 创建数据目录
RUN mkdir -p data logs
RUN chown -R khyos:nodejs data logs

# 切换到非 root 用户
USER khyos

# 暴露端口
EXPOSE 3000

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# 启动应用
CMD ["node", "dist/index.js"]
```

### 3.2 Docker Compose

```yaml
version: '3.8'

services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: khyos-app
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - DATABASE_URL=postgresql://khyos:password@db:5432/khyos
      - JWT_SECRET=${JWT_SECRET}
      - REDIS_URL=redis://redis:6379
    volumes:
      - ./data:/app/data
      - ./logs:/app/logs
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
    networks:
      - khyos-network

  db:
    image: postgres:15-alpine
    container_name: khyos-db
    restart: unless-stopped
    environment:
      - POSTGRES_USER=khyos
      - POSTGRES_PASSWORD=password
      - POSTGRES_DB=khyos
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U khyos"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - khyos-network

  redis:
    image: redis:7-alpine
    container_name: khyos-redis
    restart: unless-stopped
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - khyos-network

  nginx:
    image: nginx:alpine
    container_name: khyos-nginx
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
      - ./ssl:/etc/nginx/ssl
    depends_on:
      - app
    networks:
      - khyos-network

volumes:
  postgres-data:
  redis-data:

networks:
  khyos-network:
    driver: bridge
```

---

## 4. 部署流程

### 4.1 部署前检查

- [ ] 所有测试通过
- [ ] 代码已合并到主分支
- [ ] 版本号已更新
- [ ] 变更日志已更新
- [ ] 数据库迁移已准备（如有）

### 4.2 部署步骤

```bash
# 1. 拉取最新代码
git pull origin main

# 2. 安装依赖
npm ci

# 3. 运行测试
npm test

# 4. 构建应用
npm run build

# 5. 构建 Docker 镜像
docker build -t khyos:latest .

# 6. 推送镜像到仓库
docker push registry.example.com/khyos:latest

# 7. 部署到服务器
docker-compose -f docker-compose.prod.yml up -d

# 8. 运行数据库迁移
docker exec khyos-app npm run migrate

# 9. 验证部署
curl https://khyquant.top/api/health
```

### 4.3 自动化部署

**GitHub Actions 示例**：
```yaml
name: Deploy to Production

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run tests
        run: npm test
      
      - name: Build application
        run: npm run build
      
      - name: Build Docker image
        run: docker build -t khyos:${{ github.sha }} .
      
      - name: Deploy to server
        run: |
          ssh user@server "cd /opt/khyos && \
            docker pull khyos:${{ github.sha }} && \
            docker-compose up -d"
```

---

## 5. 健康检查

### 5.1 健康检查端点

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
  try {
    await redis.ping();
    checks.redis = 'ok';
  } catch (error) {
    checks.redis = 'error';
  }
  
  // 判断整体状态
  const isHealthy = Object.values(checks).every(v => v !== 'error');
  
  res.status(isHealthy ? 200 : 503).json({
    success: isHealthy,
    data: checks
  });
});
```

### 5.2 健康检查响应

**健康**（200）：
```json
{
  "success": true,
  "data": {
    "timestamp": "2026-09-04T12:00:00.000Z",
    "uptime": 3600,
    "version": "1.0.0",
    "environment": "production",
    "database": "ok",
    "redis": "ok"
  }
}
```

**不健康**（503）：
```json
{
  "success": false,
  "data": {
    "timestamp": "2026-09-04T12:00:00.000Z",
    "database": "error",
    "redis": "ok"
  }
}
```

---

## 6. 回滚流程

### 6.1 回滚策略

**自动回滚触发条件**：
- 健康检查失败
- 错误率超过阈值
- 响应时间超过阈值

**手动回滚**：
```bash
# 回滚到上一个版本
docker-compose -f docker-compose.prod.yml down
docker pull khyos:previous-version
docker-compose -f docker-compose.prod.yml up -d
```

### 6.2 回滚步骤

```bash
# 1. 停止当前版本
docker-compose down

# 2. 拉取之前的版本
docker pull khyos:previous-version

# 3. 更新 docker-compose 镜像标签
sed -i 's/khyos:latest/khyos:previous-version/' docker-compose.yml

# 4. 启动之前的版本
docker-compose up -d

# 5. 验证回滚
curl https://khyquant.top/api/health
```

---

## 7. 监控与告警

### 7.1 监控指标

| 指标 | 说明 | 阈值 |
|------|------|------|
| cpu_usage | CPU 使用率 | > 80% |
| memory_usage | 内存使用率 | > 80% |
| disk_usage | 磁盘使用率 | > 85% |
| response_time | 响应时间 | > 2s |
| error_rate | 错误率 | > 5% |

### 7.2 告警配置

```yaml
# prometheus 告警规则
groups:
  - name: khyos-alerts
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
```

---

## 8. 备份与恢复

### 8.1 备份策略

| 类型 | 频率 | 保留时间 |
|------|------|---------|
| 全量备份 | 每日 | 30 天 |
| 增量备份 | 每小时 | 7 天 |

### 8.2 备份脚本

```bash
#!/bin/bash
# backup.sh

BACKUP_DIR="/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# PostgreSQL 备份
pg_dump -U khyos khyos | gzip > "$BACKUP_DIR/db_$TIMESTAMP.sql.gz"

# 文件备份
tar -czf "$BACKUP_DIR/files_$TIMESTAMP.tar.gz" /opt/khyos/data

# 清理旧备份
find $BACKUP_DIR -type f -mtime +30 -delete
```

### 8.3 恢复脚本

```bash
#!/bin/bash
# restore.sh

BACKUP_FILE=$1

# 恢复数据库
gunzip -c $BACKUP_FILE | psql -U khyos khyos
```

---

## 9. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本，定义部署规范 |

---

*本规范由 khy-os 运维团队维护*