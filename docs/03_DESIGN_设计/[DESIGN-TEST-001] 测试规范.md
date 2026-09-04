# [DESIGN-TEST-001] 测试规范

> 本文档定义 khy-os 项目的测试标准，包括测试策略、覆盖率要求、命名规范等。

---

## 1. 测试概述

### 1.1 测试原则

1. **测试驱动**：优先编写测试
2. **自动化**：尽可能自动化测试
3. **独立性**：测试之间相互独立
4. **可重复**：测试结果可重复

### 1.2 测试类型

| 类型 | 说明 | 工具 |
|------|------|------|
| 单元测试 | 测试单个函数/模块 | Jest, Vitest |
| 集成测试 | 测试模块间交互 | Jest, Vitest |
| 端到端测试 | 测试完整流程 | Playwright |
| 性能测试 | 测试性能基准 | k6, Artillery |
| 安全测试 | 测试安全漏洞 | CodeQL, npm audit |

---

## 2. 测试文件组织

### 2.1 后端测试

```
services/backend/tests/
├── unit/                    # 单元测试
│   ├── services/
│   └── utils/
├── integration/             # 集成测试
│   ├── api/
│   └── database/
└── __fixtures__/            # 测试数据
```

### 2.2 前端测试

```
apps/ai-frontend/src/__tests__/     # 单元测试
apps/ai-frontend/tests/e2e/         # 端到端测试
software/khyquant/frontend/src/__tests__/
```

### 2.3 测试文件命名

**格式**：`{module}.test.js` 或 `{module}.spec.js`

**示例**：
```
auth.test.js
user.service.test.js
button.component.spec.js
```

---

## 3. 测试命名规范

### 3.1 describe 块

```javascript
describe('UserService', () => {
  describe('createUser', () => {
    // ...
  });
});
```

### 3.2 it 块

```javascript
it('should create a user with valid data', () => {
  // ...
});

it('should throw error with invalid email', () => {
  // ...
});
```

### 3.3 命名规则

- describe：模块名或功能名
- it：描述预期行为
- 使用 should + 动词开头

---

## 4. 测试结构

### 4.1 AAA 模式

```javascript
it('should calculate total price', () => {
  // Arrange（准备）
  const items = [
    { price: 10, quantity: 2 },
    { price: 20, quantity: 1 }
  ];
  
  // Act（执行）
  const total = calculateTotal(items);
  
  // Assert（断言）
  expect(total).toBe(40);
});
```

### 4.2 Given-When-Then

```javascript
it('should login with valid credentials', () => {
  // Given
  const user = { email: 'test@example.com', password: 'password123' };
  
  // When
  const result = await login(user.email, user.password);
  
  // Then
  expect(result.success).toBe(true);
  expect(result.token).toBeDefined();
});
```

---

## 5. 覆盖率要求

### 5.1 最低覆盖率

| 类型 | 最低覆盖率 |
|------|-----------|
| 行覆盖率 | 80% |
| 分支覆盖率 | 80% |
| 函数覆盖率 | 80% |
| 语句覆盖率 | 80% |

### 5.2 关键模块覆盖率

| 模块 | 最低覆盖率 |
|------|-----------|
| 认证模块 | 90% |
| 支付模块 | 95% |
| 安全模块 | 90% |

### 5.3 覆盖率检查

```bash
# 生成覆盖率报告
npm run test:coverage

# 查看覆盖率
cat coverage/lcov-report/index.html
```

---

## 6. 单元测试规范

### 6.1 测试范围

- 公共方法
- 边界条件
- 错误处理
- 复杂逻辑

### 6.2 Mock 和 Stub

```javascript
// Mock 外部依赖
jest.mock('../services/emailService', () => ({
  sendEmail: jest.fn().mockResolvedValue(true)
}));

// Stub 方法
const stub = jest.spyOn(service, 'getData').mockResolvedValue(mockData);
```

### 6.3 测试数据

```javascript
// 使用工厂函数创建测试数据
const createUser = (overrides = {}) => ({
  id: 1,
  username: 'testuser',
  email: 'test@example.com',
  ...overrides
});

// 使用
const user = createUser({ email: 'other@example.com' });
```

---

## 7. 集成测试规范

### 7.1 测试范围

- API 端点
- 数据库操作
- 外部服务集成

### 7.2 测试数据库

```javascript
// 使用测试数据库
beforeAll(async () => {
  await sequelize.sync({ force: true });
});

afterEach(async () => {
  await User.destroy({ where: {}, truncate: true });
});

afterAll(async () => {
  await sequelize.close();
});
```

### 7.3 API 测试

```javascript
const request = require('supertest');
const app = require('../app');

describe('POST /api/users', () => {
  it('should create a new user', async () => {
    const response = await request(app)
      .post('/api/users')
      .send({
        username: 'testuser',
        email: 'test@example.com',
        password: 'password123'
      })
      .expect(201);
    
    expect(response.body.success).toBe(true);
    expect(response.body.data.username).toBe('testuser');
  });
});
```

---

## 8. 端到端测试规范

### 8.1 测试场景

- 用户注册流程
- 用户登录流程
- 核心业务流程

### 8.2 Playwright 配置

```javascript
// playwright.config.js
module.exports = {
  testDir: './tests/e2e',
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:3000',
    headless: true
  }
};
```

### 8.3 E2E 测试示例

```javascript
test('user can login', async ({ page }) => {
  await page.goto('/login');
  await page.fill('[data-testid="email"]', 'user@example.com');
  await page.fill('[data-testid="password"]', 'password123');
  await page.click('[data-testid="submit"]');
  
  await expect(page).toHaveURL('/dashboard');
  await expect(page.locator('[data-testid="user-name"]')).toHaveText('John Doe');
});
```

---

## 9. 测试数据管理

### 9.1 测试数据原则

- 使用独立的测试数据
- 测试后清理数据
- 不依赖生产数据

### 9.2 Fixtures

```javascript
// tests/__fixtures__/users.js
module.exports = {
  validUser: {
    username: 'testuser',
    email: 'test@example.com',
    password: 'password123'
  },
  invalidUser: {
    username: '',
    email: 'invalid-email',
    password: '123'
  }
};
```

### 9.3 Seeders

```javascript
// 测试数据种子
const seedUsers = async () => {
  await User.bulkCreate([
    { username: 'user1', email: 'user1@example.com' },
    { username: 'user2', email: 'user2@example.com' }
  ]);
};
```

---

## 10. 性能测试规范

### 10.1 性能指标

| 指标 | 目标值 |
|------|--------|
| API 响应时间 P95 | < 500ms |
| 首字节时间（TTFB） | < 200ms |
| 页面加载时间 | < 3s |

### 10.2 性能测试工具

| 工具 | 用途 |
|------|------|
| k6 | 负载测试 |
| Artillery | 性能测试 |
| Lighthouse | 前端性能 |

### 10.3 性能测试示例

```javascript
// k6 负载测试
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '1m', target: 20 },
    { duration: '3m', target: 50 },
    { duration: '1m', target: 0 }
  ]
};

export default function () {
  const res = http.get('https://api.example.com/users');
  check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 500ms': (r) => r.timings.duration < 500
  });
  sleep(1);
};
```

---

## 11. 安全测试规范

### 11.1 安全扫描

```bash
# 依赖漏洞扫描
npm audit --audit-level=high

# 静态代码扫描
# CodeQL 集成在 CI 中
```

### 11.2 安全测试场景

- SQL 注入
- XSS 攻击
- CSRF 攻击
- 认证绕过
- 权限提升

---

## 12. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本，定义测试规范 |

---

*本规范由 khy-os 质量团队维护*