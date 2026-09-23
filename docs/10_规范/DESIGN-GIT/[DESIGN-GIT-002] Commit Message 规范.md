# [DESIGN-GIT-002] Commit Message 规范

> **用途**：定义 khy-os 项目的 Commit Message 详细格式规范。
> CONTRIBUTING.md §2 和 DESIGN-GIT-001 §2 已给出基本格式，本文档补全完整细节。

---

## 1. 格式总览

```
<type>(<scope>): <subject>

<body>

<footer>
```

| 部分 | 必选 | 说明 |
|------|------|------|
| `type` | ✅ | 变更类型 |
| `scope` | ❌ | 变更范围 |
| `subject` | ✅ | 变更简述 |
| `body` | ❌ | 变更详情 |
| `footer` | ❌ | Issue 引用 + 破坏性变更 |

---

## 2. Type 完整枚举

| type | 说明 | 使用场景 |
|------|------|---------|
| `feat` | 新功能 | 新增功能、新增端点、新组件 |
| `fix` | 修复 bug | 修复错误、修复异常行为 |
| `docs` | 文档变更 | README、规范、注释（非代码） |
| `refactor` | 重构 | 代码结构变更，无功能变化 |
| `perf` | 性能优化 | 性能提升、内存优化 |
| `test` | 测试 | 新增/修改测试用例 |
| `build` | 构建系统 | webpack、vite、esbuild 配置 |
| `ci` | CI 配置 | GitHub Actions、脚本变更 |
| `chore` | 维护任务 | 依赖更新、工具变更 |
| `style` | 代码格式 | 不影响代码逻辑的格式变更（prettier） |
| `revert` | 回滚 | 撤销之前的 commit |

---

## 3. Scope 约定

### 3.1 使用场景

Scope 描述变更的**模块/区域**，帮助定位变更影响面。

### 3.2 推荐 Scope

| Scope | 对应目录/模块 |
|-------|--------------|
| `auth` | 认证、授权、JWT、Session |
| `api` | API 路由、请求/响应格式 |
| `cli` | CLI 命令、别名、REPL |
| `gateway` | AI 网关、适配器 |
| `models` | Sequelize 模型 |
| `migrations` | 数据库迁移 |
| `services` | 业务逻辑层 |
| `middleware` | Express 中间件 |
| `frontend` | 前端页面/组件 |
| `styles` | CSS/主题/令牌 |
| `docs` | 文档 |
| `ci` | CI/CD 配置 |
| `deps` | 依赖更新 |
| `AGENTS.md` | AGENTS.md 规则变更 |

### 3.3 示例

```
feat(auth): add refresh token rotation
fix(services/gateway): handle timeout in adapter pool
refactor(cli): extract daemon handler from main router
docs(AGENTS.md): clarify port self-healing mechanism
```

---

## 4. Subject 规则

### 4.1 格式要求

| 规则 | 说明 | 示例 |
|------|------|------|
| **≤ 50 字符** | 第一行（标题行）不超过 50 字符 | `feat(auth): add refresh token` ✅ |
| **祈使句** | 用动词原形开头 | `add` 而非 `added` / `adds` |
| **首字母小写** | 不句首大写 | `add` 而非 `Add` |
| **不以句号结尾** | 标题不加句号 | `add feature` ✅ |
| **不换行** | subject 不换行 | — |

### 4.2 动词选择

| 场景 | 推荐动词 |
|------|---------|
| 新增 | `add`、`implement`、`introduce` |
| 修复 | `fix`、`patch`、`resolve` |
| 删除 | `remove`、`drop`、`delete` |
| 修改 | `update`、`change`、`modify` |
| 优化 | `optimize`、`improve`、`refactor` |
| 替换 | `replace`、`migrate`、`rename` |
| 支持 | `support`、`handle`、`allow` |

---

## 5. Body 格式

### 5.1 何时写 Body

| 场景 | Body 建议 |
|------|---------|
| 涉及 2+ 模块 | 必写 |
| 有 trade-off | 必写 |
| 修复非显式 bug | 必写 |
| 单模块简单变更 | 可选 |
| 依赖更新 | 可选 |

### 5.2 Body 格式要求

| 规则 | 说明 |
|------|------|
| **祈使句** | 与 subject 一致 |
| **≤ 72 字符/行** | 终端友好 |
| **说明 WHY** | 不重复 WHAT（WHAT 在 subject 中已说明） |
| **空行分隔** | Subject → 空行 → Body |

### 5.3 示例

```
feat(auth): implement refresh token rotation

Previous refresh tokens were reusable, allowing session hijacking
if the token was leaked. This change rotates the refresh token on
each use and invalidates the previous one.

Trade-off: increases DB writes on each refresh. Mitigated by
caching the session hash in Redis (TTL 7d).
```

---

## 6. Footer 格式

### 6.1 Issue 引用

```
Closes #123
Fixes #456
Refs #789
```

| 关键字 | 行为 |
|--------|------|
| `Closes #123` | PR 合并后自动关闭 Issue 123 |
| `Fixes #456` | 同上 |
| `Refs #789` | 关联但不关闭 |

### 6.2 破坏性变更（BREAKING CHANGE）

```
feat(api)!: change error response format

BREAKING CHANGE: Error response format changed from
{ message, error } to { success, error: { code, message } }

Clients must update error handling to match new format.
Migration guide: docs/04_IMPL_实现/IMPL-RPT-050-error-format-migration.md

Closes #234
```

**规则**：
- `BREAKING CHANGE:` 必须大写，后跟冒号
- 在 Footer 中，Body 之后，Issue 引用之前
- 必须描述变更内容 + 影响范围 + 迁移方法

---

## 7. 完整示例

### 7.1 功能提交

```
feat(services/gateway): add circuit breaker for AI adapters

Implement circuit breaker pattern to prevent cascade failures
when an AI provider becomes unavailable. Uses half-open state
to test recovery before fully reopening.

Closes #182
```

### 7.2 修复提交

```
fix(cli): prevent crash on empty input in REPL

Empty lines in REPL mode caused TypeError when accessing
input.trim().split(). Guard against empty input before parsing.

Fixes #198
```

### 7.3 重构提交

```
refactor(services): extract token counting from aiGateway

Move token counting logic into dedicated tokenUsageService.
aiGateway now delegates to the service, reducing handler
complexity from 18 to 8.
```

### 7.4 破坏性变更

```
feat(api)!: bump API version to v2

BREAKING CHANGE: API base path changed from /api/v1 to /api/v2.
All clients must update endpoint URLs. Old /api/v1 endpoints
are deprecated and will be removed in v3.0.

Migration: update VITE_AI_API_BASE_URL to /api/v2
Deprecation sunset: 2026-12-01

Closes #300
```

### 7.5 回滚提交

```
revert: revert "feat(auth): add refresh token rotation"

This reverts commit abc1234.

Reason: rotation caused session loss for users with multiple
tabs open. Will re-implement with tab-aware session tracking.
```

---

## 8. Commit 质量规则

### 8.1 一个 Commit 一件事

| 原则 | 说明 |
|------|------|
| **一个功能点 = 一个 commit** | 不要混多个变更 |
| **可独立回滚** | 每个 commit 可单独 revert |
| **原子性** | 不出现 "part 1 of 3" |

### 8.2 禁用

| 禁止 | 原因 |
|------|------|
| `Update` / `Fix` / `WIP` | 无信息量 |
| `Merge pull request #123` | squash merge 时自动生成，手动 commit 禁止 |
| `temp` / `tmp` / `debug` | 不应进入历史 |
| 50 字符以上的 subject | 超出终端显示 |

---

## 9. 工具集成

### 9.1 commitlint（建议后续添加）

```json
// package.json
{
  "commitlint": {
    "rules": {
      "type-enum": [2, "always", [
        "feat", "fix", "docs", "style", "refactor",
        "perf", "test", "build", "ci", "chore", "revert"
      ]],
      "type-case": [2, "always", "lower-case"],
      "subject-case": [2, "never", ["upper-case"]],
      "subject-max-length": [2, "always", 50],
      "header-max-length": [2, "always", 72]
    }
  }
}
```

> 当前仓库**没有** commitlint（CONTRIBUTING.md 注明了原因：钩子拖慢提交）。本文档作为约定规范存在，未来可工具化。

### 9.2 交互式提交

```bash
# 使用 git commit 的交互式模式
git commit -m "$(cat <<'EOF'
feat(scope): subject

body text here

BREAKING CHANGE: description
Closes #123
EOF
)"
```

---

## 10. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-10 | 初始版本，定义 Commit Message 规范 |

---

*本规范由 khy-os 平台团队维护*
