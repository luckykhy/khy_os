---
name: 零硬编码
id: RUNTIME-001
domain: RUNTIME
nature: 约束为主，兼权力与福利
scope: "services/**, apps/**, platform/**, software/**, kernel/**, tools/**, scripts/**（非测试文件）"
priority: P1
trigger: 源码中出现网络端点 / 文件系统路径 / 第一方生产域名的字面量时
constraint: "禁止硬编码 IP、端口、绝对路径、第一方生产域名（清单即守卫 check-agent-rules.js 的 PRODUCTION_HOST_PATTERN）；端点必须从 constants/serviceDefaults.js 导入或由 env 覆盖；dev server 端口冲突必须自动探测下一个可用端口，不得以 EADDRINUSE 崩溃。"
grants: 授权从 serviceDefaults 或 env 动态读取端点（合法配置来源资格）。
benefit: "不必猜测端口/域名；切换部署目标只改 env 不改代码，降低联调与自托管部署成本。"
exception: "测试文件、serviceDefaults.js 本身、纯注释/品牌/示例、含 ${} 插值、new URL() 解析、纯主机探测比较、纯邮件地址、localhost+变量拼接。"
version: "1.0.0 (2026-09-15)"
status: active
ssot: "AGENTS.md#工程规则-规则1"
formerly: 规则1/零硬编码
owner: backend-team
enforcement: "scripts/ci/check-agent-rules.js"
---

# [RUNTIME-001] 零硬编码

<!-- RULES-REGISTRY: RUNTIME-001 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：AGENTS.md#工程规则-规则1。

## 约束

禁止硬编码 IP、端口、绝对路径、第一方生产域名（清单即守卫 check-agent-rules.js 的 PRODUCTION_HOST_PATTERN）；端点必须从 constants/serviceDefaults.js 导入或由 env 覆盖；dev server 端口冲突必须自动探测下一个可用端口，不得以 EADDRINUSE 崩溃。

## 授予权力

授权从 serviceDefaults 或 env 动态读取端点（合法配置来源资格）。

## 提供福利

不必猜测端口/域名；切换部署目标只改 env 不改代码，降低联调与自托管部署成本。

## 反例

❌ 业务代码里写死后端端点 `fetch("http://<host>:<port>/api")` → ✅ 从 `VITE_BACKEND_HOST` / `VITE_BACKEND_PORT` 读取

## 校验方式

`node scripts/ci/check-agent-rules.js --changed`；`grep -rn "localhost:[0-9]" --include="*.js" --include="*.vue" --include="*.ts"`

## 例外

测试文件、serviceDefaults.js 本身、纯注释/品牌/示例、含 ${} 插值、new URL() 解析、纯主机探测比较、纯邮件地址、localhost+变量拼接。

## 版本记录

- 1.0.0 (2026-09-15) 初版 / 迁移自 规则1/零硬编码
