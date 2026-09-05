# [DESIGN-CICD-001] CI/CD 规范

> 本文档定义 khy-os 项目的 CI/CD 标准，包括流水线配置、部署自动化、回滚等。

---

## 1. CI/CD 概述

### 1.1 设计原则

1. **自动化**：全流程自动化，减少人为错误
2. **快速反馈**：快速发现问题
3. **可重复**：构建结果可重复
4. **安全性**：构建过程安全

### 1.2 流水线阶段

```
代码提交 → 构建 → 测试 → 安全检查 → 部署 → 验证
```

---

## 2. GitHub Actions 配置

### 2.1 工作流文件

```
.github/workflows/
├── pr-gate.yml           # PR 门禁检查
├── deploy-staging.yml    # 预发部署
├── deploy-production.yml # 生产部署
├── docker.yml            # Docker 构建
├── frontend-ci.yml       # 前端 CI
├── codeql-analysis.yml   # 安全分析
└── release.yml           # 发布流程
```

### 2.2 PR 门禁配置

```yaml
# .github/workflows/pr-gate.yml
name: PR Gate

on:
  pull_request:
    branches: [main]

jobs:
  contract-checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Check version sync
        run: node scripts/ci/check-version-sync.js
      
      - name: Check agent rules
        run: node scripts/ci/check-agent-rules.js --changed
      
      - name: Check leaf contracts
        run: node scripts/ci/check-leaf-contract.js --changed

  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Run ESLint
        run: npm run lint

  test:
    runs-on: ubuntu-latest
    continue-on-error: true  # 测试不阻塞 PR
    steps:
      - uses: actions/checkout@v4
      
      - name: Run tests
        run: npm test

  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Run security scan
        run: npm audit --audit-level=high
```

---

## 3. 构建流程

### 3.1 前端构建

```yaml
# .github/workflows/frontend-ci.yml
name: Frontend CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '18'
          cache: 'pnpm'
      
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      
      - name: Lint
        run: npm run lint
      
      - name: Build
        run: npm run build
      
      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: frontend-dist
          path: apps/ai-frontend/dist
```

### 3.2 后端构建

```yaml
# .github/workflows/backend-ci.yml
name: Backend CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Lint
        run: npm run lint
      
      - name: Test
        run: npm test
      
      - name: Build
        run: npm run build
```

---

## 4. 部署流程

### 4.1 预发环境部署

```yaml
# .github/workflows/deploy-staging.yml
name: Deploy to Staging

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@v4
      
      - name: Build Docker image
        run: docker build -t khyos:${{ github.sha }} .
      
      - name: Push to registry
        run: |
          docker tag khyos:${{ github.sha }} registry.example.com/khyos:${{ github.sha }}
          docker push registry.example.com/khyos:${{ github.sha }}
      
      - name: Deploy to staging
        run: |
          ssh user@staging-server "cd /opt/khyos && \
            docker pull registry.example.com/khyos:${{ github.sha }} && \
            docker-compose up -d"
      
      - name: Run smoke tests
        run: |
          curl -f https://staging.khyquant.top/api/health
```

### 4.2 生产环境部署

```yaml
# .github/workflows/deploy-production.yml
name: Deploy to Production

on:
  release:
    types: [published]

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      
      - name: Deploy to production
        run: |
          ssh user@production-server "cd /opt/khyos && \
            docker pull registry.example.com/khyos:${{ github.ref_name }} && \
            docker-compose up -d"
      
      - name: Verify deployment
        run: |
          curl -f https://khyquant.top/api/health
```

---

## 5. Docker 配置

### 5.1 Dockerfile

```dockerfile
# 构建阶段
FROM node:18-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

# 运行阶段
FROM node:18-alpine AS runner

WORKDIR /app

# 创建非 root 用户
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 khyos

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

RUN mkdir -p data logs
RUN chown -R khyos:nodejs data logs

USER khyos

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["node", "dist/index.js"]
```

### 5.2 Docker Compose

```yaml
# docker-compose.yml
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

volumes:
  postgres-data:
  redis-data:

networks:
  khyos-network:
    driver: bridge
```

---

## 6. 回滚流程

### 6.1 自动回滚

```yaml
# deploy-production.yml 中的回滚步骤
- name: Verify deployment
  run: |
    for i in {1..5}; do
      if curl -f https://khyquant.top/api/health; then
        echo "Deployment successful"
        exit 0
      fi
      sleep 10
    done
    
    echo "Deployment failed, rolling back..."
    ssh user@production-server "cd /opt/khyos && docker-compose down && docker-compose up -d --rollback"
    exit 1
```

### 6.2 手动回滚

```bash
# 回滚到上一个版本
docker-compose -f docker-compose.prod.yml down
docker pull registry.example.com/khyos:previous-version
docker-compose -f docker-compose.prod.yml up -d
```

---

## 7. 发布流程

### 7.1 版本号管理

遵循语义化版本（SemVer）：
- MAJOR：不兼容的 API 变更
- MINOR：向下兼容的功能性新增
- PATCH：向下兼容的问题修正

### 7.2 发布步骤

1. 更新版本号：`npm version patch|minor|major`
2. 更新 CHANGELOG
3. 创建 Git Tag：`git tag v1.2.3`
4. 推送 Tag：`git push origin v1.2.3`
5. 创建 Release
6. 自动部署到生产环境

### 7.3 发布检查清单

- [ ] 所有测试通过
- [ ] 文档已更新
- [ ] CHANGELOG 已更新
- [ ] 版本号已更新
- [ ] 无未提交的变更

---

## 8. 监控和告警

### 8.1 部署监控

- 健康检查端点：`/api/health`
- 错误率监控
- 响应时间监控

### 8.2 告警规则

| 指标 | 阈值 | 级别 |
|------|------|------|
| 错误率 | > 5% | P1 |
| 响应时间 | > 2s | P2 |
| 服务不可用 | 任何时间 | P0 |

---

## 9. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本，定义 CI/CD 规范 |

---

*本规范由 khy-os 平台团队维护*