# [DESIGN-COMP-001] 代码复杂度规范

<!-- RULES-REGISTRY: COMP-001 -->

> **用途**：定义 khy-os 项目的代码复杂度上限，防止技术债务积累。
> khy-os 后端现存 3417 个 lint 问题，其中大量源于缺少明确的复杂度上限约束。

---

## 1. 复杂度原则

1. **函数做一件事**：一个函数只做一件事，并做好它
2. **浅层优先**：嵌套越少越好，max 2 层
3. **短函数**：长的函数必然做多件事
4. **少参数**：超过 3 个参数的函数应提取为配置对象
5. **门禁渐进收紧**：存量代码不强制清理，但新增/修改代码必须达标

---

## 2. 圈复杂度（Cyclomatic Complexity）

### 2.1 定义

圈复杂度 = 独立执行路径数量 = `if/else if/for/while/switch/catch/?:/&&/||` 的决策点数量 + 1

### 2.2 上限

| 对象 | 上限 | 级别 | 处理 |
|------|------|------|------|
| 单个函数 | **15** | error | PR 阻断 |
| 单个函数 | 10–14 | warning | PR 报告 |
| 单个函数 | ≤ 10 | ✅ | 通过 |

### 2.3 降低复杂度的策略

| 模式 | 说明 |
|------|------|
| Guard clauses（卫语句） | 用 `if (!condition) return early` 替代深层嵌套 |
| 提取子函数 | 将独立逻辑块提取为具名函数 |
| 策略对象 | 用对象映射替代 `switch/case` |
| 提前返回 | 减少 `else` 分支 |
| 短路运算 | 用 `&&` / `||` 简化条件 |
| 错误集中化 | 统一错误处理中间件，不在每个函数内判断 |

### 2.4 示例

```javascript
// ❌ 复杂度 12
async function processRequest(req, res) {
  if (req.method === 'POST') {
    if (req.body.type === 'chat') {
      if (req.user.role === 'admin') {
        // ...
      } else if (req.user.role === 'user') {
        // ...
      } else {
        res.status(403).json({ error: 'Forbidden' });
      }
    } else if (req.body.type === 'image') {
      // ...
    }
  } else if (req.method === 'GET') {
    // ...
  }
}

// ✅ 复杂度 4 — 卫语句 + 提取子函数
async function processRequest(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (req.method === 'POST') {
    return handlePost(req, res);
  }
  return handleGet(req, res);
}

async function handlePost(req, res) { /* ... */ }
async function handleGet(req, res) { /* ... */ }
```

---

## 3. 函数长度

### 3.1 上限

| 类型 | 上限（行数） | 级别 |
|------|-------------|------|
| 异步函数 | **50 行** | error |
| 同步函数 | **40 行** | error |
| 回调函数 | **30 行** | error |
| 警告区 | 25–49 行 | warning |

> 行数 = 函数体 `{ ... }` 之间的实际代码行，不含注释和空行

### 3.2 拆分策略

```javascript
// ❌ 80 行的 handleCommand
async function handleCommand(input) {
  // 解析（20 行）
  // 验证（15 行）
  // 执行（30 行）
  // 格式化输出（15 行）
}

// ✅ 拆分为 4 个函数，每个 < 30 行
async function handleCommand(input) {
  const parsed = parseInput(input);
  validateInput(parsed);
  const result = await executeCommand(parsed);
  return formatOutput(result);
}
```

---

## 4. 参数数量

### 4.1 上限

| 类型 | 上限 | 处理 |
|------|------|------|
| 普通函数 | **3 个** | error |
| 4–5 个 | warning | 建议重构 |
| ≤ 3 个 | ✅ | 通过 |

### 4.2 超过上限的解决方案

```javascript
// ❌ 5 个参数
function createStrategy(name, broker, stopLoss, takeProfit, atrPeriod) { }

// ✅ 配置对象（超过 3 个时使用）
function createStrategy({ name, broker, stopLoss, takeProfit, atrPeriod }) {
  // destructure at call site
}

// ✅ 构建器模式（复杂场景）
const strategy = StrategyBuilder
  .name('mean-reversion')
  .broker('binance')
  .risk(stopLoss, takeProfit)
  .indicator('atr', { period: 14 })
  .build();
```

---

## 5. 嵌套深度

### 5.1 上限

| 类型 | 上限 | 级别 |
|------|------|------|
| 任何嵌套 | **3 层** | error |
| 2–3 层 | warning | 建议重构 |
| ≤ 2 层 | ✅ | 通过 |

### 5.2 降低嵌套

```javascript
// ❌ 4 层嵌套
async function handle(req, res) {
  if (req.user) {
    if (req.user.role === 'admin') {
      if (req.body.strategy) {
        if (req.body.strategy.active) {
          // do something
        }
      }
    }
  }
}

// ✅ 卫语句降到 1 层
async function handle(req, res) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  if (!req.body.strategy) return res.status(400).json({ error: 'Missing strategy' });
  if (!req.body.strategy.active) return res.status(400).json({ error: 'Strategy inactive' });
  // do something
}
```

---

## 6. 文件大小

### 6.1 上限

| 类型 | 上限（行数） | 级别 |
|------|-------------|------|
| JS 源文件 | **400 行** | error |
| 400–600 行 | warning | 建议拆分 |
| < 400 行 | ✅ | 通过 |

### 6.2 拆分策略

| 触发条件 | 拆分方向 |
|---------|---------|
| 单一文件 > 400 行 | 按功能域拆分子目录 |
| 大 switch/case | 提取为策略对象或 handler map |
| 大量相似方法 | 提取为独立模块或 composable |
| 巨型模型定义 | 拆为 migration + model 文件 |

---

## 7. ESLint 门禁配置

### 7.1 新增规则（建议）

在 `services/backend/eslint.config.js` 中增加：

```javascript
{
  rules: {
    'complexity': ['error', { max: 15 }],        // 圈复杂度
    'max-lines-per-function': ['error', { max: 50, skipComments: true }],  // 函数长度
    'max-lines': ['warn', { max: 500 }],         // 文件总行数
    'max-depth': ['error', 3],                    // 嵌套深度
    'max-params': ['error', 3],                   // 参数数量
  }
}
```

### 7.2 存量文件豁免

存量文件（3400+ 个文件）的复杂度超标不阻断合并，但**新增文件和修改文件**必须满足：
- 新增文件：零复杂度违规
- 修改文件：修改的函数必须达标

---

## 8. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-10 | 初始版本，定义代码复杂度上限与门禁策略 |

---

*本规范由 khy-os 平台团队维护*
