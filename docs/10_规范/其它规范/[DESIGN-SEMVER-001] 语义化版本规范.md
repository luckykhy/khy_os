# [DESIGN-SEMVER-001] 语义化版本规范

> **用途**：定义 khy-os 项目的语义化版本（SemVer）标准。
> GIT-001 §5 提到了 SemVer，本文档补全完整规则。

---

## 1. 版本格式

```
MAJOR.MINOR.PATCH[-PRERELEASE][+BUILDMETA]
```

| 部分 | 说明 | 示例 |
|------|------|------|
| MAJOR | 不兼容变更 | `2.0.0` |
| MINOR | 向下兼容新功能 | `1.2.0` |
| PATCH | 向下兼容修复 | `1.2.3` |
| PRERELEASE | 预发布标识 | `1.3.0-beta.1` |
| BUILDMETA | 构建元数据 | `1.2.3+build.20260910` |

---

## 2. 版本递增规则

### 2.1 MAJOR

| 触发条件 | 示例 |
|---------|------|
| API 破坏性变更 | `1.x` → `2.0.0` |
| 删除已废弃功能 | `1.5.0` → `2.0.0` |
| 最低依赖版本提升 | Node 18 → Node 20 |

### 2.2 MINOR

| 触发条件 | 示例 |
|---------|------|
| 新增 API 端点 | `1.2.0` → `1.3.0` |
| 新增 CLI 命令 | `1.2.0` → `1.3.0` |
| 新增规范（不影响现有代码） | — |

### 2.3 PATCH

| 触发条件 | 示例 |
|---------|------|
| Bug 修复 | `1.2.0` → `1.2.1` |
| 安全修复 | `1.2.0` → `1.2.1` |
| 文档修正 | `1.2.0` → `1.2.1` |
| 性能优化（无 API 变更） | `1.2.0` → `1.2.1` |

---

## 3. 预发布版本

| 标识 | 用途 | 示例 |
|------|------|------|
| `alpha` | 内部测试 | `2.0.0-alpha.1` |
| `beta` | 公开测试 | `2.0.0-beta.2` |
| `rc` | 候选发布 | `2.0.0-rc.1` |

**规则**：
- `alpha` < `beta` < `rc` < 正式版
- 同一预发布系列递增：`beta.1` → `beta.2`
- 预发布版本优先级低于正式版：`1.0.0-beta.1` < `1.0.0`

---

## 4. 废弃周期

### 4.1 废弃流程

```
公告废弃 → 保留至少 1 个 MINOR 版本 → 移除
```

| 步骤 | 动作 | 时间 |
|------|------|------|
| 1. 废弃公告 | 代码加 `@deprecated`，文档标注 | 当前版本 |
| 2. 警告期 | 运行时输出 deprecation warning | ≥ 1 个 MINOR 版本 |
| 3. 移除 | 删除废弃代码 | 下一个 MAJOR 版本 |

### 4.2 示例

```javascript
// v1.3.0: 废弃
/** @deprecated Use validateStrategyV2() instead. Will be removed in v2.0. */
function validateStrategy(config) { }

// v1.4.0, v1.5.0: 警告
if (validateStrategy.deprecated) {
  console.warn('[DEPRECATED] validateStrategy() will be removed in v2.0. Use validateStrategyV2()');
}

// v2.0.0: 移除
// validateStrategy() 完全删除
```

---

## 5. 双轨道版本

khy-os 有两条独立版本轨道（AGENTS.md 定义）：

| 轨道 | 包含 | 版本号示例 |
|------|------|----------|
| 主轨道 | khy-os pip/npm 包、backend、packaging | `1.1.x` |
| ai-backend 轨道 | ai-backend、@khy/shared | `1.6.x` |

**规则**：
- 两轨道独立递增，互不影响
- 同一轨道内 4 个真源必须完全一致
- `check-version-sync.js` 在 CI 中强制校验

---

## 6. 版本同步

### 6.1 真源清单

**轨道 1**（4 源，必须一致）：
1. `pyproject.toml` → `[project] version`
2. `packaging/npm/package.json` → `version`
3. `services/backend/package.json` → `version`
4. `packaging/modules/modules.json` → `version`

**轨道 2**（2 源，必须一致）：
1. `services/ai-backend/package.json` → `version`
2. `platform/packages/shared/package.json` → `version`

### 6.2 发布脚本

```bash
# 同步主轨道
node scripts/release/publish-dual.sh --version 1.2.0

# 自动更新 4 个真源
# 最后由 check-version-sync.js 验证
```

---

## 7. API 版本与包版本的关系

| 类型 | 版本 | 示例 | 关系 |
|------|------|------|------|
| 包版本 | SemVer | `1.2.0` | 发布节奏 |
| API 版本 | URL 路径 | `/api/v1` | 独立于包版本 |
| 协议版本 | 内部 | ACP-001 v1 | 独立演进 |

**规则**：包版本 MINOR 递增不必然导致 API 版本递增；API 版本只在破坏性变更时递增。

---

## 8. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-10 | 初始版本，定义语义化版本规范 |

---

*本规范由 khy-os 平台团队维护*
