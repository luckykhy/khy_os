---
name: Health Check 规范
id: OPS-003
domain: API
nature: 约束
scope: "services/backend/src/routes/**, services/ai-backend/src/routes/**"
priority: P2
trigger: "新增或修改健康检查端点、依赖探测逻辑时"
constraint: "四原则：三端点分离（/health 存活、/ready 就绪、/live 依赖检查）、轻量快速、状态精确（不返回 \"OK\" 掩盖实际故障）、分级返回。/health 检查进程是否存活、内存是否可用，超时 <100ms，响应码 200 始终（存活不代表就绪）；/ready 检查所有依赖是否可达、数据连接是否正常，超时 <5s，200 就绪 / 503 未就绪；/live 检查数据库、Redis、外部 API、文件系统，超时 <10s，结果缓存 30s。状态枚举：ok 200、degraded 200、ready 200、not_ready 503、unhealthy 503。依赖探测：SQLite/PostgreSQL SELECT 1 超时 2s 降级为缓存模式、Redis PING 超时 1s 跳过缓存直连 DB、文件系统 access(dataDir, R_OK) 超时 500ms 报错、外部 AI API 轻量 ping 超时 3s 标记 degraded、磁盘空间 statvfs 超时 500ms 标记 degraded。告警：/ready 返回 503 >30s 为 P0、/health degraded >60s 为 P1、依赖 responseTime >5000ms 为 P1、/ready 间歇性 503 为 P2。"
grants: "无新增权力：仅约束具体做法，不授予任何新权限。"
benefit: 存活/就绪/依赖三种信号分离，负载均衡器与监控各有明确依据，不靠单一 OK 掩盖部分故障。
exception: "健康检查端点不需要认证（负载均衡器需访问）；端点单独限流，免于常规限流。"
version: "1.0.0 (2026-09-16)"
status: active
ssot: "docs/_规范/[DESIGN-OPS-003] Health Check 规范.md"
formerly: 无
owner: ops-team
---

# [OPS-003] Health Check 规范

<!-- RULES-REGISTRY: OPS-003 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/_规范/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/_规范/[DESIGN-OPS-003] Health Check 规范.md。

## 约束

四原则：三端点分离（/health 存活、/ready 就绪、/live 依赖检查）、轻量快速、状态精确（不返回 "OK" 掩盖实际故障）、分级返回。/health 检查进程是否存活、内存是否可用，超时 <100ms，响应码 200 始终（存活不代表就绪）；/ready 检查所有依赖是否可达、数据连接是否正常，超时 <5s，200 就绪 / 503 未就绪；/live 检查数据库、Redis、外部 API、文件系统，超时 <10s，结果缓存 30s。状态枚举：ok 200、degraded 200、ready 200、not_ready 503、unhealthy 503。依赖探测：SQLite/PostgreSQL SELECT 1 超时 2s 降级为缓存模式、Redis PING 超时 1s 跳过缓存直连 DB、文件系统 access(dataDir, R_OK) 超时 500ms 报错、外部 AI API 轻量 ping 超时 3s 标记 degraded、磁盘空间 statvfs 超时 500ms 标记 degraded。告警：/ready 返回 503 >30s 为 P0、/health degraded >60s 为 P1、依赖 responseTime >5000ms 为 P1、/ready 间歇性 503 为 P2。

## 授予权力

无新增权力：仅约束具体做法，不授予任何新权限。

## 提供福利

存活/就绪/依赖三种信号分离，负载均衡器与监控各有明确依据，不靠单一 OK 掩盖部分故障。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

健康检查端点不需要认证（负载均衡器需访问）；端点单独限流，免于常规限流。

## 版本记录

- 1.0.0 (2026-09-16) 初版 / 迁移自 无
