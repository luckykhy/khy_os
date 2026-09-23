# [DESIGN-DEP-001] 依赖管理规范

> 本文档定义 khy-os 项目的依赖管理标准，包括依赖选择、更新、安全审计等。

---

## 1. 依赖管理概述

### 1.1 管理原则

1. **最小化**：只添加必需的依赖
2. **安全性**：定期审计依赖安全
3. **稳定性**：优先选择稳定的版本
4. **可维护性**：避免过度依赖

### 1.2 依赖分类

| 分类 | 说明 | 位置 |
|------|------|------|
| dependencies | 运行时依赖 | package.json |
| devDependencies | 开发依赖 | package.json |
| peerDependencies | 对等依赖 | package.json |
| optionalDependencies | 可选依赖 | package.json |

---

## 2. 依赖选择标准

### 2.1 选择原则

| 标准 | 说明 |
|------|------|
| 活跃度 | 近期有更新，社区活跃 |
| 文档完善 | 有完整的文档和示例 |
| 许可证 | 使用兼容的开源许可证 |
| 体积 | 体积适中，无过度依赖 |
| 安全性 | 无已知安全漏洞 |

### 2.2 推荐依赖

| 类别 | 推荐依赖 |
|------|---------|
| 框架 | Vue 3, Express |
| 状态管理 | Pinia |
| UI 组件库 | Element Plus |
| HTTP 客户端 | Axios |
| 测试框架 | Jest, Vitest |
| 构建工具 | Vite, esbuild |

### 2.3 避免的依赖

- 已停止维护的依赖
- 体积过大的依赖
- 功能重复的依赖
- 安全记录差的依赖

---

## 3. 版本管理

### 3.1 版本锁定

**package-lock.json / pnpm-lock.yaml**：
- 提交到版本控制
- 确保团队成员使用相同版本
- CI/CD 使用锁定文件安装依赖

### 3.2 版本范围

| 范围 | 说明 | 示例 |
|------|------|------|
| 精确版本 | 锁定到特定版本 | `1.2.3` |
| 补丁范围 | 允许补丁更新 | `~1.2.3` |
| 次版本范围 | 允许次版本更新 | `^1.2.3` |

### 3.3 版本选择规则

| 依赖类型 | 版本范围 |
|---------|---------|
| 核心框架 | 精确版本或补丁范围 |
| UI 库 | 次版本范围 |
| 工具库 | 次版本范围 |
| 开发工具 | 次版本范围 |

---

## 4. 依赖更新

### 4.1 更新策略

| 类型 | 频率 | 说明 |
|------|------|------|
| 安全更新 | 立即 | 发现安全漏洞立即更新 |
| 补丁更新 | 每周 | bug 修复更新 |
| 次版本更新 | 每月 | 向后兼容的功能更新 |
| 主版本更新 | 按需 | 需要评估兼容性 |

### 4.2 Dependabot 配置

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 10
    labels:
      - "dependencies"
    reviewers:
      - "kodehu03"
```

### 4.3 更新流程

1. Dependabot 自动创建 PR
2. 审查变更内容
3. 运行测试验证
4. 合并更新
5. 监控部署状态

---

## 5. 安全审计

### 5.1 审计频率

| 类型 | 频率 |
|------|------|
| 自动扫描 | 每次 CI 运行 |
| 手动审计 | 每月 |
| 全面审计 | 每季度 |

### 5.2 审计命令

```bash
# 基本审计
npm audit

# 高级别漏洞
npm audit --audit-level=high

# 修复可自动修复的漏洞
npm audit fix

# 强制修复（可能包含破坏性变更）
npm audit fix --force
```

### 5.3 漏洞处理

| 严重级别 | 处理方式 |
|---------|---------|
| Critical | 立即修复 |
| High | 24 小时内修复 |
| Medium | 1 周内修复 |
| Low | 1 个月内修复 |

---

## 6. 体积控制

### 6.1 体积预算

| 项目 | 预算 |
|------|------|
| 前端主包 | < 200KB（gzip） |
| 前端总资源 | < 500KB（gzip） |
| 后端依赖 | < 100MB |

### 6.2 体积检查

```bash
# 检查依赖体积
npx cost-of-modules

# 分析 bundle 体积
npx vite-bundle-analyzer
```

### 6.3 体积优化

- 使用 tree-shaking
- 按需导入
- 移除未使用的依赖
- 使用更小的替代库

---

## 7. 许可证合规

### 7.1 允许的许可证

| 许可证 | 说明 |
|--------|------|
| MIT | ✅ 允许 |
| Apache-2.0 | ✅ 允许 |
| BSD-2/3-Clause | ✅ 允许 |
| ISC | ✅ 允许 |

### 7.2 禁止的许可证

| 许可证 | 说明 |
|--------|------|
| GPL-2.0/3.0 | ❌ 禁止（传染性） |
| AGPL-3.0 | ❌ 禁止（传染性） |
| 商业许可证 | ❌ 禁止（需购买） |

### 7.3 许可证检查

```bash
# 检查依赖许可证
npx license-checker --summary

# 生成许可证报告
npx license-checker --csv > licenses.csv
```

---

## 8. 工作区管理

### 8.1 pnpm workspace

```yaml
# pnpm-workspace.yaml
packages:
  - 'platform/packages/shared'
  - 'platform/packages/ui-shared'
  - 'services/backend'
  - 'services/ai-backend'
  - 'apps/ai-frontend'
  - 'software/khyquant/frontend'
```

### 8.2 共享依赖

| 依赖 | 版本 | 说明 |
|------|------|------|
| vue | ^3.4.0 | 所有前端项目共享 |
| pinia | ^2.1.0 | 所有前端项目共享 |
| axios | ^1.6.0 | 所有前端项目共享 |

### 8.3 依赖提升

```json
// .npmrc
hoist-pattern[]=*eslint*
hoist-pattern[]=*prettier*
hoist-pattern[]=typescript
```

---

## 9. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本，定义依赖管理规范 |

---

*本规范由 khy-os 平台团队维护*