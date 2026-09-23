# [DESIGN-COM-001] 代码注释规范

<!-- RULES-REGISTRY: COM-001 -->

> **用途**：定义 khy-os 项目的代码注释标准，包括格式、位置、类型、版权头等。
> AGENTS.md 只给了一句 "代码注释：英文"，本文档补全全量细节。

---

## 1. 注释原则

1. **解释 WHY，不是 WHAT**：代码本身要自解释（好的命名），注释补充意图和约束
2. **过时注释比没有更糟**：代码变了注释没变，删除它
3. **面向维护者**：注释写给未来可能读这段代码的人（包括 3 个月后的你）
4. **英文**：所有注释用英文，与 AGENTS.md 一致
5. **JSDoc / docstring**：公共 API 必须有类型签名注释

---

## 2. 注释类型与格式

### 2.1 块注释（Block Comment）

用于文件头部、函数说明、复杂逻辑分段：

```javascript
/**
 * Validates that a trading strategy configuration is complete and consistent.
 *
 * Checks performed:
 *   1. Required fields presence (name, broker, instruments)
 *   2. Parameter bounds (stopLoss must be < takeProfit)
 *   3. Indicator compatibility (ATR period must match bar count)
 *
 * @param {Object} strategy - Strategy configuration object
 * @param {string} strategy.name - Strategy identifier (unique)
 * @param {string} strategy.broker - Broker name from whitelist
 * @param {Object} strategy.params - Indicator parameters
 * @returns {Object} ValidationResult with { valid, errors[] }
 * @throws {ValidationError} If strategy is null/undefined
 *
 * @example
 * const result = validateStrategy({
 *   name: 'mean-reversion',
 *   broker: 'binance',
 *   params: { atrPeriod: 14, stopLoss: 0.02 }
 * });
 */
function validateStrategy(strategy) {
  // ...
}
```

### 2.2 行内注释（Inline Comment）

用于单行补充说明，与代码同行：

```javascript
const timeout = parseInt(env.AI_HTTP_TIMEOUT_MS) || 30000; // fallback to 30s
```

**行内注释规范**：
- 注释前留 2 空格
- 注释本身不解释代码在做什么（那该由命名表达）
- 注释解释为什么这样写、约束来源、历史原因

### 2.3 Python docstring

```python
def validate_strategy(config: dict) -> ValidationResult:
    """Validate trading strategy configuration completeness.

    Checks required fields, parameter bounds, and indicator
    compatibility per DESIGN-ARCH-082 §4.2.

    Args:
        config: Strategy configuration dict with keys:
            - name (str): Unique strategy identifier
            - broker (str): Broker name from WHITELIST_BROKERS
            - params (dict): Indicator parameters

    Returns:
        ValidationResult with .valid (bool) and .errors (list)

    Raises:
        TypeError: If config is not a dict

    Example:
        >>> result = validate_strategy({
        ...     'name': 'mean-reversion',
        ...     'broker': 'binance',
        ...     'params': {'atr_period': 14}
        ... })
        >>> result.valid
        True
    """
    ...
```

---

## 3. 何时需要注释

### 3.1 必须加注释的场景

| 场景 | 要求 |
|------|------|
| 公共 API（export / module.exports） | JSDoc / docstring 完整签名 |
| 算法/数学公式 | 注释来源/推导过程 |
| 非显式约束 | 解释为什么这样写（如：`// RS256 而非 HS256：服务间共享公钥`） |
| 性能敏感区 | 说明时间复杂度或内存特征 |
| 安全关键 | 解释防护意图（如：`// Prevent prototype pollution`） |
| 兼容性 hack | 解释浏览器/运行时差异原因 |
| TODO / FIXME / HACK | 必须标注，见 §4 |

### 3.2 不需要注释的场景

| 场景 | 原因 |
|------|------|
| 自解释的 getter/setter | 命名已说明一切 |
| 标准模式（`try/catch`、`forEach`） | 常识性结构 |
| 一行逻辑 | 超过注释本身 |

---

## 4. TODO / FIXME / HACK 标注

### 4.1 格式

```
{TAG}({scope}): {description} [@{owner}|{date}]
```

| 标签 | 含义 | 使用场景 |
|------|------|---------|
| `TODO` | 计划做的事 | 功能待实现、待优化 |
| `FIXME` | 已知 bug，需修复 | 临时代码、已知问题 |
| `HACK` | 临时 workaround | 快速绕过，需后续重构 |
| `OPTIMIZE` | 性能可优化 | 已知性能瓶颈 |
| `DEPRECATED` | 已废弃，待移除 | 引用旧 API |

### 4.2 示例

```javascript
// TODO(DESIGN-NAM-001): Migrate to PascalCase once ARCH-082 is approved
// FIXME(@luckykhy 2026-09-10): Race condition when concurrent requests
// HACK: Workaround for Node 18 ESM interop issue, remove after v2.0
// DEPRECATED(2026-09-01): Use validateStrategyV2() instead, remove in v3.0
```

### 4.3 生命周期规则

- `TODO` 最长存活 1 个 sprint（2 周），过期自动升级为 `FIXME`
- `FIXME` / `HACK` 必须在 PR 描述中说明修复计划或保留理由
- `DEPRECATED` 必须标注移除版本，移除前须走 TOOL-001 废弃流程

---

## 5. 文件头部注释

### 5.1 JavaScript 文件头

```javascript
/**
 * @file aiGateway.js
 * @description AI Gateway — unified multi-provider AI invocation adapter.
 * @module services/gateway
 * @see DESIGN-ACP-001 for message envelope contract
 * @see DESIGN-API-002 for error envelope format
 *
 * @author khy-os platform team
 * @since 1.0.0
 * @license MIT
 */
```

### 5.2 Python 文件头

```python
"""
cli_parser.py — CLI argument parser and command dispatcher.

Parses user input, resolves aliases (DESIGN-GIT-001 §1),
and routes to handler modules.

Modules: cli.router, cli.aliases
Standards: DESIGN-ACP-001, DESIGN-COMM-001
"""

# Single-line copyright notice (optional for internal files)
# Copyright (c) 2026 khy-os platform team
```

### 5.3 版权头（外部可分发文件）

仅在打算开源分发的文件中添加（如 `packaging/` 下的打包脚本）：

```javascript
/**
 * Copyright (c) 2026 khy-os platform team
 * SPDX-License-Identifier: MIT
 */
```

仓库主体代码（`services/`、`platform/`、`apps/`）是 `LicenseRef-Source-Available`，不批量加版权头。

---

## 6. 注释纪律

### 6.1 正确示例

```javascript
// ✅ 解释 WHY
// Use exponential backoff with jitter to avoid thundering herd
// when multiple clients retry simultaneously (see DESIGN-COMM-001 §4.3)
const delay = Math.min(baseDelay * 2 ** attempt + Math.random() * jitter, MAX_DELAY);

// ✅ 标注 FIXME 带上下文
// FIXME(DESIGN-ARCH-081): Current spinner doesn't support streaming output
// Replace with stream-aware spinner once TUI v2 is merged
showSpinner('Thinking...');

// ✅ 解释约束
// RS256 (asymmetric) required because the verification key
// is shared across services; HS256 would expose the secret
const algorithm = 'RS256';
```

### 6.2 错误示例

```javascript
// ❌ 重复代码（命名好就不需要注释）
// Set user ID
const userId = user.id;

// ❌ 过时的注释
// Get user by email — actually this fetches by username now
const user = await getUserByName(query);

// ❌ 无意义标签
// TODO: fix this  ← 没有 scope 和 owner，等于没有写
const x = hackyFix();

// ❌ 大段注释遮蔽代码
/* ============================================
   SECTION 1: DO STUFF
   ============================================ */
```

---

## 7. 不同语言的注释约定

| 语言 | 文档注释格式 | 工具 |
|------|-------------|------|
| JavaScript | JSDoc (`/** ... */`) | ESLint `require-jsdoc` |
| Python | Google 风格 docstring (`"""`) | 无强制检查（可后续加） |
| Vue SFC | JSDoc on `<script setup>` | — |
| Markdown | 自解释文本 | — |
| JSON | 无注释（JSON 规范不允许） | — |
| YAML | `#` 行注释 | — |
| SQL | `--` 行注释 | — |

---

## 8. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-10 | 初始版本，定义代码注释规范 |

---

*本规范由 khy-os 平台团队维护*
