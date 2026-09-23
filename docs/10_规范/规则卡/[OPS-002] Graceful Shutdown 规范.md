---
name: Graceful Shutdown 规范
id: OPS-002
domain: RUNTIME
nature: 约束
scope: "services/backend/src/**, services/ai-backend/**"
priority: P2
trigger: "新增或修改服务进程启动、信号处理、连接管理逻辑时"
constraint: "五原则：信号优先（SIGTERM 有序关闭、SIGKILL 强制终止不做清理）、停止接受新请求（先关监听端口）、Drain 存量连接（带超时）、数据持久化优先（内存数据先落盘再释放连接）、关闭顺序（子进程 → 工作线程 → 数据库连接 → 定时器）。信号映射：SIGTERM（docker stop/kill/systemctl stop）有序关闭；SIGINT（Ctrl+C）有序关闭；SIGQUIT 有序关闭 + core dump；SIGKILL 强制终止跳过清理；SIGHUP 热重载不关闭。SHUTDOWN_TIMEOUT = 30_000。标准序列：1 停止监听端口（server.close()）→ 2 Drain 活跃连接（30s 超时）→ 3 持久化内存数据 → 4 停止子进程 → 5 关闭数据库连接池 → 6 关闭 Redis/缓存连接 → 7 清理定时器 → process.exit(0)。验证：活跃连接为 0、无待写数据、无运行中 worker。"
grants: "无新增权力：仅约束具体做法，不授予任何新权限。"
benefit: 重启不再丢请求或半写数据，关闭顺序可核对，超时时长有确定上限而非无限等待。
exception: "SIGKILL（kill -9）强制终止跳过清理；SIGHUP 终端关闭仅热重载不关闭。"
version: "1.0.0 (2026-09-16)"
status: active
ssot: "docs/10_规范/其它规范/[DESIGN-OPS-002] Graceful Shutdown 规范.md"
formerly: 无
owner: ops-team
---

# [OPS-002] Graceful Shutdown 规范

<!-- RULES-REGISTRY: OPS-002 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/其它规范/[DESIGN-OPS-002] Graceful Shutdown 规范.md。

## 约束

五原则：信号优先（SIGTERM 有序关闭、SIGKILL 强制终止不做清理）、停止接受新请求（先关监听端口）、Drain 存量连接（带超时）、数据持久化优先（内存数据先落盘再释放连接）、关闭顺序（子进程 → 工作线程 → 数据库连接 → 定时器）。信号映射：SIGTERM（docker stop/kill/systemctl stop）有序关闭；SIGINT（Ctrl+C）有序关闭；SIGQUIT 有序关闭 + core dump；SIGKILL 强制终止跳过清理；SIGHUP 热重载不关闭。SHUTDOWN_TIMEOUT = 30_000。标准序列：1 停止监听端口（server.close()）→ 2 Drain 活跃连接（30s 超时）→ 3 持久化内存数据 → 4 停止子进程 → 5 关闭数据库连接池 → 6 关闭 Redis/缓存连接 → 7 清理定时器 → process.exit(0)。验证：活跃连接为 0、无待写数据、无运行中 worker。

## 授予权力

无新增权力：仅约束具体做法，不授予任何新权限。

## 提供福利

重启不再丢请求或半写数据，关闭顺序可核对，超时时长有确定上限而非无限等待。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

SIGKILL（kill -9）强制终止跳过清理；SIGHUP 终端关闭仅热重载不关闭。

## 版本记录

- 1.0.0 (2026-09-16) 初版 / 迁移自 无
