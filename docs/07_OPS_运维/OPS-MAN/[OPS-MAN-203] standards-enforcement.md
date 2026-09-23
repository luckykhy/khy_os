# 规范代码 Enforcement 指南

> **用途**：将 P0/P1/P2 规范从"文档约束"落实到"代码门禁"。
> 本目录下的 `scripts/ci/check-*-standards.js` 脚本是可机械判定的守卫，
> 在 CI 和 `npm run check:all-standards` 中自动执行。

---

## 1. 架构总览

```
docs/10_规范/           ← 规范文档（人类可读的契约）
        ↓ 实现
scripts/ci/           ← 代码守卫脚本（机械判定的执行层）
        ↓ 注册
package.json          ← npm scripts（check:*）
        ↓ 编排
scripts/quality-gate/ ← 质量门禁编排（pr / release 模式）
        ↓ 执行
CI / 本地开发         ← 每次提交 / PR / 发版前自动检查
```

---

## 2. 守卫脚本清单

### P0 规范守卫（阻断级）

| 脚本 | 对应规范 | 检查内容 | 严重度 |
|------|---------|---------|--------|
| `check-code-standards.js` | NAM-001, COM-001, COMP-001 | 命名 camelCase/snake_case/BEM；console.log → logger；函数 ≤50 行 | HIGH/MEDIUM |
| `check-security-headers.js` | SEC-001 | helmet() 使用；dangerouslySetInnerHTML 防护；SQL 注入检测；敏感数据日志 | CRITICAL/HIGH |
| `check-auth-session.js` | AUTH-002, CORS-001 | JWT 算法（禁 HS256）；httpOnly/SameSite cookie；CORS 通配符检测 | CRITICAL/HIGH |
| `check-api-contracts.js` | API-001, API-002, API-003 | 响应信封格式；幂等键；弃用头 | HIGH/MEDIUM |
| `check-upload-safety.js` | UPLOAD-001 | 32-hex ID 校验；路径遍历防护；可执行文件阻止 | CRITICAL/HIGH |

### P1 规范守卫（警告级）

| 脚本 | 对应规范 | 检查内容 | 严重度 |
|------|---------|---------|--------|
| `check-ai-gateway.js` | GW-002, PROMPT-001, FF-001 | 降级链；Circuit Breaker 阈值；Prompt 版本化；Feature Flag 默认关闭 | MEDIUM/LOW |
| `check-data-lifecycle.js` | AUD-001, MIG-001, DLQ-001 | 审计日志五字段；迁移 up/down 配对；DLQ 重试配置 | HIGH/MEDIUM |
| `check-ops-health.js` | OPS-002, OPS-003 | SIGTERM 优雅关闭；/health /ready /live 三端点 | MEDIUM/LOW |
| `check-frontend-design-tokens.js` | FE-004, A11Y-001 | CSS 变量；BEM 命名；alt 文本；ARIA 标签 | MEDIUM/LOW |

### P2 规范守卫（文档级）

| 脚本 | 对应规范 | 检查内容 | 严重度 |
|------|---------|---------|--------|
| `check-notify-webhook.js` | NOTIFY-001 | HMAC 签名；List-Unsubscribe 头 | HIGH/LOW |
| `check-incident-dr.js` | IR-001, DR-001 | 事件响应文档；灾备 Runbook | MEDIUM |

---

## 3. 使用方式

### 本地开发

```bash
# 检查所有标准（完整扫描）
npm run check:all-standards

# 检查单个标准
npm run check:code-standards
npm run check:security-headers
npm run check:auth-session
npm run check:api-contracts
npm run check:ai-gateway
npm run check:data-lifecycle
npm run check:ops-health
npm run check:notify-webhook
npm run check:incident-dr
npm run check:upload-safety
npm run check:frontend-design-tokens
```

### CI/CD

```bash
# PR 模式（运行核心守卫）
npm run quality:pr

# 发版模式（运行全部守卫 + 版本同步 + 脚本测试）
npm run quality:gate
```

### 增量检查（仅检查改动文件）

```bash
# 对本次改动运行标准守卫
npm run check:changed
```

---

## 4. 严重度说明

| 严重度 | 行为 | 示例 |
|--------|------|------|
| **CRITICAL** | CI 阻断 | 路径遍历风险；JWT "none" 算法；CORS 通配符 + credentials |
| **HIGH** | CI 阻断 | 无文件大小限制；HS256 JWT；httpOnly 缺失；可执行文件上传 |
| **MEDIUM** | CI 警告 | 文件过大；嵌套过深；缺少健康端点 |
| **LOW** | CI 信息 | 建议使用 logger；模板版本化；ARIA 标签 |
| **INFO** | 纯信息 | helmet() 已检测到 |

---

## 5. 新增标准守卫流程

1. 在 `docs/10_规范/` 创建规范文档（含 定位+红线+反例+守卫）
2. 在 `scripts/ci/` 创建 `check-<domain>.js`
3. 在 `package.json` 注册 `check:<domain>` script
4. 在 `scripts/quality-gate/lib/qualityGateStages.js` 添加到对应 mode
5. 更新本文件

---

## 6. 技术债务管理

某些守卫（如 COMP-001 函数长度）会扫描整个代码库，发现大量历史债务。
处理方式：

- **立即修复**：CRITICAL/HIGH（安全相关）
- **渐进修复**：MEDIUM/LOW（在后续迭代中逐步清理）
- **基线化**：对大量 LOW 发现，可在脚本中添加 baseline 文件（如 `check-frontend-tokens.js` 的 `.baseline.json`）

---

## 7. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-10 | 初始版本，创建 11 个守卫脚本，注册到 CI |

---

*本指南由 khy-os 平台团队维护*
