# [IMPL-RPT-045] 工具注册表自愈层规范

> 状态: ACTIVE | 创建: 2026-09-05 | 作者: AI Assist

---

## 1. 概述

工具注册表自愈层（Tool Registry Self-Healing Layer）是一个**纯叶子系统**，负责在工具定义加载过程中检测并自动修复常见错误，确保单个工具的错误不会中断整个注册表的加载。

### 设计原则

| 原则 | 说明 |
|------|------|
| **纯叶子** | 零 IO（除 E1 文件修复外）、确定性、不抛异常 |
| **幂等** | 二次运行 = no-op，不会产生级联修复 |
| **环境门控** | `KHY_TOOL_HEAL` / `KHY_TOOL_SYNTAX_HEAL` 默认开 |
| **fail-soft** | 修复失败回退安全默认值，记录日志供审计 |
| **从错误中映射出类** | 不只修具体错误，而是建立覆盖所有同类错误的修复层 |
| **开闭原则** | 新增错误类通过扩展实现，不修改已有修复逻辑 |

---

## 2. 错误类 taxonomy

每个错误都有**根因**、**检测点**、**自愈策略**三要素。

| 错误类 | 名称 | 根因 | 检测点 | 自愈策略 |
|--------|------|------|--------|----------|
| **E1** | static-field-colon | JS 类字段用 `:` 不用 `=` | `SyntaxError` at load time | 文件级 regex 修复 + require 重试 |
| **E2** | invalid-category | 分类不在 CATEGORIES 中 | `defineTool()` 入口 | Levenshtein fuzzy-match → 最近有效分类 |
| **E3** | invalid-risk | 风险级不在 RISK_LEVELS 中 | `defineTool()` 入口 | Levenshtein fuzzy-match → 最近有效风险级 |
| **E4** | invalid-enum | 枚举值不在 VALID_INTERRUPT_BEHAVIORS 中 | `defineTool()` 入口 | Levenshtein fuzzy-match → 最近有效枚举值 |
| **E5** | type-mismatch | 字符串/数字/布尔类型不匹配 | `defineTool()` 入口 | 字面量强制类型转换 |
| **E6** | invalid-array | 单字符串代替数组 | `defineTool()` 入口 | 单字符串包装为数组 |

### 错误类详细说明

#### E1: static-field-colon

```javascript
// ❌ 错误
static searchHint: 'fine-tuning model training';

// ✅ 修复后
static searchHint = 'fine-tuning model training';
```

**检测**: `require()` 抛出 `SyntaxError: Unexpected strict mode reserved word`

**修复**: `_toolSyntaxHealer.js` 的 `healFile()` 读取文件 → regex 替换 → 写回 → 清除 require 缓存 → 重试

---

#### E2: invalid-category

```javascript
// ❌ 错误
static category = 'protocol';  // 拼写错误

// ✅ 修复后（模糊匹配）
static category = 'mcp';  // 或 fallback 到 'custom'
```

**检测**: `category` 不在 `VALID_CATEGORIES` 数组中

**修复**: Levenshtein 距离 ≤ 2 或前缀匹配 → 最近有效值；否则 fallback 到 `'custom'`

---

#### E3: invalid-risk

```javascript
// ❌ 错误
static risk = 'mdeium';  // 拼写错误

// ✅ 修复后
static risk = 'medium';
```

**检测**: `risk` 不在 `VALID_RISK_LEVELS` 数组中

**修复**: Levenshtein fuzzy-match → 最近有效风险级；否则 fallback 到 `'medium'`

---

#### E4: invalid-enum

```javascript
// ❌ 错误
static interruptBehavior = 'cancle';  // 拼写错误

// ✅ 修复后
static interruptBehavior = 'cancel';
```

**检测**: 枚举值不在 `VALID_INTERRUPT_BEHAVIORS` 数组中

**修复**: Levenshtein fuzzy-match → 最近有效枚举值；否则 fallback 到 `'cancel'`

---

#### E5: type-mismatch

```javascript
// ❌ 错误
static shouldDefer = 'true';  // 字符串代替布尔

// ✅ 修复后
static shouldDefer = true;
```

**检测**: 值的类型与目标类型不匹配（如 `typeof val === 'string'` 但期望 `'boolean'`）

**修复**:
- `'true'/'1'/'yes'/'on'` → `true`
- `'false'/'0'/'no'/'off'` → `false`
- `'42'` → `42`（字符串→数字）
- `true` → `'true'`（布尔→字符串）

---

#### E6: invalid-array

```javascript
// ❌ 错误
static aliases = 'single-alias';  // 字符串代替数组

// ✅ 修复后
static aliases = ['single-alias'];
```

**检测**: 期望数组但收到字符串

**修复**: 单字符串包装为 `[str]`

---

## 3. 架构

```
┌─────────────────────────────────────────────────────────────┐
│                     loadTools()                             │
│                   (tools/index.js)                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│               _requireWithHeal(indexPath)                   │
│                   (tools/index.js)                          │
│                                                             │
│   require(indexPath) ──→ SyntaxError?                       │
│        │                        │                           │
│        │ 正常                   │ 是                        │
│        ▼                        ▼                           │
│   返回 exported          healFile(indexPath)                │
│        │                   (E1 修复)                        │
│        │                        │                           │
│        │                   healed?                          │
│        │                   │      │                         │
│        │                   │ 是   │ 否                      │
│        │                   ▼      ▼                         │
│        │              重试 require  记录警告                │
│        │                   │                               │
│        ▼───────────────────┘                               │
│   返回 exported                                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│               defineTool(config)                            │
│               (tools/_baseTool.js)                          │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │ E2: healCategory(rawCategory)                       │   │
│   │ E3: healRisk(rawRisk)                               │   │
│   │ E4: healEnum(rawInterrupt, valid, fallback)         │   │
│   │ E5: healType(val, targetType)                        │   │
│   │ E6: _healArray(val, field)                           │   │
│   └─────────────────────────────────────────────────────┘   │
│                              │                              │
│                              ▼                              │
│                     _logRepair(...)                         │
│                   (审计日志 + console.warn)                 │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. 模块清单

### 4.1 `_toolHealer.js` — 统一修复叶子

**路径**: `services/backend/src/tools/_toolHealer.js`

**契约**:
- 零 IO（不碰 fs/网络/子进程/process.exit）
- 确定性（同输入同输出）
- 不抛异常
- 环境门控: `KHY_TOOL_HEAL`（默认开）

**导出**:

| 函数 | 用途 | 入参 | 出参 |
|------|------|------|------|
| `heal(healClass, value, options)` | 统一入口 | `class: 'category'\|'risk'\|'enum'\|'type'`, `value: *`, `options: {validOptions, targetType, fallback}` | `{ repaired, value, confidence? }` |
| `healCategory(raw)` | E2 修复 | `raw: string` | `{ repaired, value, confidence }` |
| `healRisk(raw)` | E3 修复 | `raw: string` | `{ repaired, value, confidence }` |
| `healEnum(raw, validOptions, fallback)` | E4 修复 | `raw: string`, `validOptions: string[]`, `fallback: string` | `{ repaired, value, confidence }` |
| `healType(value, targetType)` | E5 修复 | `value: *`, `targetType: string` | `{ repaired, value }` |
| `isEnabled()` | 门控检查 | — | `boolean` |
| `VALID_CATEGORIES` | 有效分类列表 | — | `string[]` |
| `VALID_RISK_LEVELS` | 有效风险级列表 | — | `string[]` |
| `VALID_INTERRUPT_BEHAVIORS` | 有效中断行为列表 | — | `string[]` |

**内部函数**:
- `_levenshtein(a, b)`: Levenshtein 距离计算
- `_closestOption(value, validOptions)`: 模糊匹配核心

---

### 4.2 `_toolSyntaxHealer.js` — 语法修复叶子

**路径**: `services/backend/src/tools/_toolSyntaxHealer.js`

**契约**:
- 仅 E1 涉及文件 IO（读/写目标文件）
- 确定性、幂等、不抛异常
- 环境门控: `KHY_TOOL_SYNTAX_HEAL`（默认开）

**导出**:

| 函数 | 用途 | 入参 | 出参 |
|------|------|------|------|
| `healSource(source)` | 纯函数修复（无 IO） | `source: string` | `{ source: string, changes: Array<{line, pattern, before, after}> }` |
| `healFile(filePath)` | 文件级修复 | `filePath: string` | `{ healed: boolean, changes: Array, error?: string }` |
| `HEAL_PATTERNS` | 修复模式列表 | — | `Array<{name, regex, replacement}>` |
| `_isEnabled()` | 门控检查 | — | `boolean` |

**修复模式**:

```javascript
// 模式名: static-field-colon-instead-of-equals
// 匹配: static <prop>: <string|number|boolean|null|template|identifier>
// 不匹配: static <prop>: { ... } 或 [ ... ]（对象/数组字面量，风险高不自动修）
{
  name: 'static-field-colon-instead-of-equals',
  regex: /^(\s*)(static\s+\w+)\s*:\s*('[^']*'|"[^"]*"|`[^`]*`|\d+\.?\d*|true|false|null|[a-zA-Z_$]\w*)(.*)$/gm,
  replacement: '$1$2 = $3$4',
}
```

---

### 4.3 集成点

#### `tools/index.js` — `loadTools()` Phase 1

```javascript
function _requireWithHeal(indexPath, dirName) {
  try {
    return require(indexPath);
  } catch (err) {
    if (!(err instanceof SyntaxError)) {
      throw err;  // 非语法错误不处理
    }
    const healResult = healFile(indexPath);
    if (healResult.healed) {
      // 清除缓存 + 重试
      delete require.cache[require.resolve(indexPath)];
      return require(indexPath);
    }
    throw err;  // 修复失败，抛出原始错误
  }
}
```

#### `tools/_baseTool.js` — `defineTool()`

```javascript
// E2/E3/E4/E5/E6 全部自愈，不 throw
const rawCategory = config.category || 'custom';
let category = rawCategory;
const catHeal = healCategory(rawCategory);
if (catHeal.repaired) {
  category = catHeal.value;
  _logRepair(config.name, 'category', rawCategory, catHeal.value, catHeal.confidence);
}
// ... E3/E4/E5/E6 同理
```

---

## 5. 修复结果格式

所有修复函数返回统一的结果格式：

```typescript
interface HealResult {
  repaired: boolean;    // true = 发生了修复
  value: any;           // 修复后的值（或原始值）
  confidence?: string   // 'exact' | 'fuzzy' | 'fallback' | 'type-coerce'
}
```

### confidence 含义

| confidence | 含义 | 示例 |
|------------|------|------|
| `exact` | 值本身有效，无需修复 | `category = 'data'` |
| `fuzzy` | 模糊匹配成功 | `risk = 'mdeium'` → `'medium'` |
| `fallback` | 无法匹配，使用安全默认值 | `category = 'xyz'` → `'custom'` |
| `type-coerce` | 类型强制转换成功 | `shouldDefer = 'true'` → `true` |

---

## 6. 审计日志

所有修复都会记录到 `_repairLog`（Map），并提供查询接口：

```javascript
// 获取所有修复记录
const repairs = reg.getCategoryRepairs();
// → [{ tool: 'A2ATool', field: 'category', original: 'protocol', repaired: 'coordinator', confidence: 'fuzzy', at: '...' }]

// 清除记录
reg.clearCategoryRepairs();
```

同时输出 `console.warn`:
```
[ToolRegistry] Self-healed tool "A2ATool": category "protocol" → "coordinator" (fuzzy)
```

---

## 7. 扩展规范

### 7.1 新增错误类

当发现新的错误类时：

1. **分类**: 确定是新类还是已有类的变体
2. **编号**: 分配下一个可用的 `E{n}` 编号
3. **实现**: 在 `_toolHealer.js` 中新增 `healXxx()` 函数
4. **注册**: 在 `heal()` switch 中新增 case
5. **测试**: 在 `tests/tools/toolHealer.test.js` 中新增测试
6. **文档**: 更新本文档的 taxonomy 表格

### 7.2 改进已有修复方法

当发现更好的修复策略时：

1. **向后兼容**: 新策略必须对所有已有测试用例产出相同或更优结果
2. **原子更新**: 修改 + 测试 + 文档在一次提交中完成
3. **回归验证**: 运行全部 81+ 个测试确保无回归

### 7.3 更正错误方法

当发现修复逻辑有 bug 时：

1. **先写失败测试**: 复现 bug
2. **再修代码**: 让测试通过
3. **检查依赖**: 确认没有其他代码依赖错误行为
4. **更新文档**: 如果错误行为已被文档记录

### 7.4 添加新的修复模式（E1 语法修复）

当需要修复新的语法错误模式时：

1. 在 `_toolSyntaxHealer.js` 的 `HEAL_PATTERNS` 数组中新增条目
2. 确保 regex 有 `^` 锚点（行首）和 `gm` 标志
3. 在 `tests/tools/toolSyntaxHealer.test.js` 中新增测试
4. **不匹配对象/数组字面量**（`{...}` / `[...]`），除非有充分的上下文分析

### 7.5 修复学习（手动修复后自动记录）

当自愈层无法自动修复某个错误时（`confidence: 'fallback'`），需要人工介入修复。**修复完成后必须注册模式**，使下次同类错误能自动修复。

#### 学习机制

- **Key**: `${healClass}:${invalidValue}` → **Value**: `correctValue`
- 支持 context 区分（如 `enum:interruptBehavior:cancle` → `cancel`）
- Learned pattern 优先级高于 fuzzy match

#### API

| 函数 | 用途 |
|------|------|
| `learnPattern(healClass, invalidValue, correctValue, context?)` | 注册一个手动修复模式 |
| `getLearnedPattern(healClass, invalidValue, context?)` | 查询已学习的模式 |
| `hasLearnedPattern(healClass, invalidValue, context?)` | 检查模式是否存在 |
| `getAllLearnedPatterns()` | 获取所有学习模式（用于审计） |
| `clearLearnedPatterns()` | 清除所有学习模式 |

#### 学习流程

```
自愈层返回 fallback（无法自动修复）
   │
   ▼
人工修复错误
   │
   ▼
调用 learnPattern(healClass, invalidValue, correctValue)
   │
   ▼
下次同类错误 → confidence: 'learned'（直接命中，不再 fallback）
```

#### 修复后必须 learnPattern 的场景

| 场景 | 示例 |
|------|------|
| 新增分类 | `learnPattern('category', 'newcat', 'custom')` |
| 新增风险级 | `learnPattern('risk', 'extreme', 'critical')` |
| 枚举值映射 | `learnPattern('enum', 'terminate', 'cancel', 'interruptBehavior')` |
| 特殊业务值 | `learnPattern('category', 'protocel', 'mcp')` |

### 7.6 更新时机与自愈纪律

自愈层不是"自动修复一切"的银弹。khyos 自我触发时必须把握以下原则：

#### 更新时机（何时该更新自愈层）

| 触发条件 | 动作 |
|----------|------|
| 发现新错误类 | 按 §7.1 扩展 |
| 修复逻辑有 bug | 按 §7.3 更正 |
| 更好的修复策略 | 按 §7.2 改进 |
| 工具定义规范变更 | 同步更新 `VALID_CATEGORIES` 等注册表 |
| 新增工具字段 | 在 `defineTool()` 中添加对应的修复逻辑 |

#### 自愈纪律（khyos 自我触发时的红线）

| 规则 | 说明 |
|------|------|
| **先诊断后修复** | 先确认错误根因，再决定修复策略。不要"头痛医头" |
| **最小改动** | 只修复出错的字段，不顺手重构周边代码 |
| **不扩大范围** | 修复 A 问题时，不改动无关的 B 字段 |
| **验证再提交** | 修复后必须跑全部测试，不能"看起来对了就提交" |
| **保留审计** | 所有修复必须通过 `_logRepair()` 记录，不能静默修复 |
| **回滚准备** | 重大修复前备份原文件（E1 文件修复前 `cp` 一份） |
| **不破坏运行中系统** | 如果修复可能导致正在运行的工具行为变化，先降级观察 |

#### 自愈触发流程

```
发现错误
   │
   ▼
分类 → 已有错误类？ ──→ 是 ──→ 检查现有修复是否足够
   │                         │
   否                        │ 否
   │                         ▼
   ▼                    按 §7.2/7.3 改进/更正
按 §7.1 新增错误类
   │
   ▼
编写测试（先失败）
   │
   ▼
实现修复
   │
   ▼
跑全部测试 → 通过？
   │              │
   否             是
   │              │
   ▼              ▼
回退修复       更新文档（本文档）
   │              │
   ▼              ▼
重新诊断       提交
```

---

## 8. 自愈触发防护

### 8.1 频率限制

自愈层不是"自动修复一切"的银弹。khyos 自我触发时必须把握以下原则：

| 规则 | 说明 |
|------|------|
| **先诊断后修复** | 先确认错误根因，再决定修复策略。不要"头痛医头" |
| **最小改动** | 只修复出错的字段，不顺手重构周边代码 |
| **不扩大范围** | 修复 A 问题时，不改动无关的 B 字段 |
| **验证再提交** | 修复后必须跑全部测试，不能"看起来对了就提交" |
| **保留审计** | 所有修复必须通过 `_logRepair()` 记录，不能静默修复 |
| **回滚准备** | 重大修复前备份原文件（E1 文件修复前 `cp` 一份） |
| **不破坏运行中系统** | 如果修复可能导致正在运行的工具行为变化，先降级观察 |

### 8.2 自愈触发流程

```
发现错误
   │
   ▼
分类 → 已有错误类？ ──→ 是 ──→ 检查现有修复是否足够
   │                         │
   否                        │ 否
   │                         ▼
   ▼                    按 §7.2/7.3 改进/更正
按 §7.1 新增错误类
   │
   ▼
编写测试（先失败）
   │
   ▼
实现修复
   │
   ▼
跑全部测试 → 通过？
   │              │
   否             是
   │              │
   ▼              ▼
回退修复       更新文档（本文档）
   │              │
   ▼              ▼
重新诊断       提交
```

### 8.3 监控告警

当自愈频率超过阈值时，需要人工介入：

| 指标 | 阈值 | 动作 |
|------|------|------|
| 单工具修复次数 | > 3 次/小时 | 告警：该工具可能有系统性问题 |
| 同类错误修复次数 | > 10 次/天 | 告警：可能需要改进修复策略 |
| 修复失败率 | > 20% | 告警：修复逻辑可能有 bug |
| 新增错误类 | 每周 > 2 个 | 告警：工具定义规范可能需要收紧 |

监控数据通过 `getCategoryRepairs()` 接口暴露，可由外部监控系统消费。

---

## 9. 测试规范

### 8.1 单元测试（纯函数）

每个 `healXxx()` 函数必须有：
- 有效值 → `repaired: false`
- 空值 → `repaired: true, confidence: 'fallback'`
- 边界值（如 `null`, `undefined`, `0`, `''`）
- 模糊匹配成功案例
- 模糊匹配失败案例 → fallback

### 8.2 文件级测试（E1）

- 单文件修复
- 多文件修复
- 已正确文件 → `healed: false`
- 不存在文件 → `error` 字段
- 禁用环境门控 → `healed: false`

### 8.3 集成测试

- `defineTool()` 中每个错误类单独测试
- `defineTool()` 中多个错误同时存在 → 全部修复
- 端到端 `loadTools()` → 186 个工具全部加载，零警告

### 8.4 测试文件命名

| 文件 | 覆盖 |
|------|------|
| `tests/tools/toolHealer.test.js` | E2/E3/E4/E5/E6 修复逻辑 |
| `tests/tools/toolSyntaxHealer.test.js` | E1 语法修复 |
| `tests/tools/toolSyntaxHealer.integration.test.js` | E1 + require 重试 |

---

## 9. 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `KHY_TOOL_HEAL` | `1`（开） | 统一修复层总开关。`0/false/off/no` 关闭 |
| `KHY_TOOL_SYNTAX_HEAL` | `1`（开） | 语法修复开关。`0/false/off/no` 关闭 |

---

## 10. 已知限制

| 限制 | 说明 | 未来改进 |
|------|------|----------|
| E1 不修复对象/数组字面量 | `static inputSchema: {...}` 过于复杂，自动修复风险高 | 未来可引入 AST 分析 |
| E5 不修复嵌套对象 | `{ a: '1' }` 中的字符串数字不递归修复 | 未来可引入深度遍历 |
| E2/E3/E4 仅支持字符串 | 如果 risk 是数字或对象，无法修复 | 可先 `String()` 强制转换再匹配 |
| 修复不写回源码文件（除 E1） | E2-E6 仅内存中修复，不修改 .js 文件 | 未来可提供 `--fix` 模式写回 |

---

## 11. 变更历史

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-09-05 | 1.0.0 | 初始版本：建立 E1-E6 错误类 taxonomy，实现完整自愈层 |
| 2026-09-05 | 1.1.0 | 新增 §7.5 更新时机与自愈纪律、§8 自愈触发防护（频率限制、监控告警） |
| 2026-09-05 | 1.1.1 | `_repairLog` 改为存储数组（支持同一工具多次修复），新增 `getRepairStats()` 监控接口 |
| 2026-09-05 | 1.2.0 | 新增 §7.5 修复学习机制（`learnPattern` API），手动修复后自动记录模式 |

---

*最后更新: 2026-09-05*
