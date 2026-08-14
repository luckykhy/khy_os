<!-- 文档分类: MGMT-RPT-001 | 阶段: 项目管理 | 原路径: docs/deepseek-tui-对标.md -->
# DeepSeek-TUI 对齐 — khy 对齐清单

> 来源: `DeepSeek-TUI-main.zip` (Rust, ratatui TUI)
> 日期: 2026-05-18
> 状态: **12/13 完成** (C11 延后)

---

## 概述

DeepSeek-TUI 是一个 Rust 实现的终端 AI 编程助手，其引擎层在任务完成率、上下文管理和安全解包方面有成熟设计。本文档记录 khy 逐项对齐的 13 个学习项。

| 优先级 | ID | 项目 | khy 状态 | 目标 |
|----------|----|------|------------|--------|
| **P0** | A1 | 3 检查点容量流程 | **完成** | 三点分级 |
| **P0** | B6 | 接缝管理器（前缀缓存） | **完成** | 4 级仅追加 |
| P1 | A2 | 循环守卫规范化哈希 | **完成** | 键排序 + 警告/中止 |
| P1 | A3 | 一致性状态机 | **完成** | 5 状态 UX 阶梯 |
| P1 | B7 | 周期边界 | **完成** | Token 触发的周期 |
| P1 | B8 | 压缩固定策略 | **完成** | 工作集感知 |
| P1 | C10 | 安全解包工具 | **完成** | 带安全校验的两遍处理 |
| P1 | D12 | 规范化状态快照 | **完成** | 6 维度 schema |
| P2 | A4 | 并行/串行批处理 | **完成**（已有） | 自动分类批次 |
| P2 | A5 | 子代理完成排空 | **完成**（已有） | 父级等待语义 |
| P2 | B9 | 自动推理力度 | **完成** | 关键词驱动，支持中日韩 |
| P2 | C11 | 技能安装管线 | 延后 | URL → 校验 → 安装 |
| P2 | D13 | 智能工具截断 | **完成** | 按工具的噪声分类 |

---

## A1 — 3 检查点容量流程 [P0]

### DeepSeek 方案
在轮次循环中设置三个检查点，进行分级干预：

| 检查点 | 时机 | 动作 |
|-----------|--------|--------|
| Pre-request | API 调用前 | `TargetedContextRefresh` — 裁剪最旧的消息 |
| Post-tool | 工具执行后 | `VerifyWithToolReplay` 或 `VerifyAndReplan` |
| Error-escalation | 连续失败时 | `VerifyAndReplan` — 重置到规范化状态 |

关键点：每个检查点观察上下文压力并返回一个 `CapacityDecision` 枚举。

### khy 当前状态
- `contextWindowGuard.js`（164 行）：单点检查，含两级阈值（10%/20%）
- 无工具后检查点
- 无错误升级检查点
- 无分级干预动作

### 差距
- 缺失 3 个检查点中的 2 个（工具后、错误升级）
- 无干预动作系统（仅 prune/warn）
- 无驱动状态的容量决策枚举

### 实现
- **新文件**: `backend/src/services/capacityFlow.js`
  - `preRequestCheckpoint(ctx)` → 观察压力，返回决策
  - `postToolCheckpoint(ctx)` → 工具执行后，检测高风险
  - `errorEscalationCheckpoint(ctx)` → 连续错误时升级
  - `CapacityDecision` 枚举: `None | TargetedRefresh | VerifyReplay | VerifyReplan`
- **修改**: `backend/src/services/toolUseLoop.js`
  - 在主循环的 3 个位置插入检查点调用

### 验证
- 单元测试：在模拟压力下，每个检查点返回正确决策
- 集成测试：capacityFlow 在 toolUseLoop 中触发且无回归

---

## B6 — 接缝管理器 [P0] — 新增

### DeepSeek 方案
仅追加的上下文归档，以保护前缀缓存（128-token 粒度，90% 折扣）：

| 级别 | Token 阈值 | 摘要密度 | 模型 |
|-------|----------------|----------------|--------|
| L1 | 192K | ~2,500 tokens | Flash |
| L2 | 384K | ~1,800 tokens | Flash |
| L3 | 576K | ~1,200 tokens | Flash |
| Cycle | 768K | ≤3K（简报） | Main |

规则：
- **绝不重写**已有消息（仅追加 `<archived_context>` 块）
- **逐字窗口**：最近 16 个轮次永不摘要
- 更高级别的接缝将先前摘要合并为更密集的块

### khy 当前状态
- `promptCacheService.js`（445 行）：用于子代理的共享提示缓存（LRU，基于 TTL）
- 无接缝概念，无仅追加归档，无前缀缓存保护

### 差距
- 完全缺失接缝级上下文管理
- 无前缀缓存粒度意识
- 无多级渐进式摘要

### 实现
- **新文件**: `backend/src/services/seamManager.js`
  - 阈值按 khy 典型模型缩放（48K/96K/144K/192K）
  - `checkSeam(activeTokens)` → 返回级别 + 待归档的消息范围
  - `archiveMessages(messages, level, summarizeFn)` → 追加 `<archived_context>` 块
  - 逐字窗口：保护最近 8 个轮次
  - 与 `promptCacheService.js` 的集成钩子

### 验证
- 单元测试：接缝在正确的阈值处触发
- 手动测试：注入消息，验证归档块出现

---

## A2 — 循环守卫规范化哈希 [P1]

### DeepSeek 方案
- 规范化 JSON 哈希：哈希前递归排序对象键
- 相同调用检测：第 3 次相同调用时阻断
- 失败计数器：3 次时警告，8 次时中止

### khy 当前状态
- `toolLoopDetector.js`（527 行）：8 检测器系统，FNV-1a 哈希
- `genericRepeat`: warn@5, critical@8
- 未记录规范化键排序

### 差距
- 哈希可能不是键序无关的（需验证）
- 阈值比 DeepSeek 更宽松（5/8 对比 3/8）

### 实现
- 添加 `_canonicalHash(params)`，在 FNV-1a 之前递归排序键
- 将 `genericRepeat` 警告阈值从 5 降至 3（针对相同调用）
- 保持 critical 阈值为 8（与 DeepSeek 一致）

### 验证
- 单元测试：`{a:1,b:2}` 与 `{b:2,a:1}` 产生相同哈希

---

## A3 — 一致性状态机 [P1]

### DeepSeek 方案
反映会话健康度的 5 状态 UX 阶梯：
```
Healthy → GettingCrowded → RefreshingContext → VerifyingRecentWork → ResettingPlan
```
转换由容量检查点驱动。

### khy 当前状态
- 无一致性状态概念
- 无会话健康度可视化

### 实现
- **新文件**: `backend/src/services/coherenceState.js`
  - 枚举: `HEALTHY | GETTING_CROWDED | REFRESHING | VERIFYING | RESETTING`
  - `transition(event)` — 容量事件驱动状态变更
  - `getState()` → 当前状态，供 UI 渲染
- **修改**: `backend/src/cli/aiRenderer.js` — 在状态行显示一致性

### 验证
- 状态转换与容量流程事件匹配

---

## B7 — 周期边界 [P1]

### DeepSeek 方案
在 768K 活跃 token 时 → 周期边界：
1. 自动保留层：系统提示、工作区、待办、工作集
2. 模型整理的简报：≤3K tokens 的决策/约束/假设
3. 归档：上一周期消息保存为 JSONL

### khy 当前状态
- `contextCompressor.js`（502 行）：在 70% 使用率时进行 4 阶段压缩
- 无显式周期边界概念

### 实现
- 在 `contextCompressor.js` 中添加 `triggerCycleBoundary(messages, opts)`
- Token 阈值：192K（khy 典型）— 可通过 `KHY_CYCLE_THRESHOLD_TOKENS` 配置
- 3 层结转协议
- 将上一周期归档到 `~/.khyquant/cycles/`

### 验证
- 模拟 token 数超过阈值 → 周期触发

---

## B8 — 压缩固定策略增强 [P1]

### DeepSeek 方案
固定策略：
- 最近 N 条消息（默认 4）
- 提及工作集路径的消息（src/..., Cargo.toml）
- 错误/补丁消息（error:, panic, diff --git）
- 强制工具调用配对（不动点循环）
- 去重：保留最新的完整结果，将较早的替换为单行摘要

### khy 当前状态
- 保护最近 2 个工具轮次、系统消息、最近消息
- 无工作集感知固定
- 无错误消息固定
- 无去重

### 实现
- 在 `findCompressSplitPoint` 中添加 `_isWorkingSetMention(message, workingSet)` 检查
- 添加 `_isErrorMessage(message)` 检查（匹配 error, panic, FAIL, diff --git 模式）
- 添加 `_deduplicateToolResults(messages)` — 保留最新，将先前的替换为摘要

### 验证
- 单元测试：含文件路径和错误模式的消息在压缩后保留

---

## C10 — 安全解包工具 [P1]

### DeepSeek 方案
`skills/install.rs` 中的两遍归档解压：
- **第 1 遍（扫描）**：校验结构、定位 manifest、检查大小、拒绝符号链接/路径穿越
- **第 2 遍（解压）**：安全写入临时目录，原子重命名

安全：`is_safe_path()` 拒绝 `..`、绝对路径、符号链接。5 MiB 限制。

### khy 当前状态
- `backend/src/tools/unpackTool.js` 存在（未跟踪）— 需检查内容
- 否则依赖 shell 命令

### 实现
- **新建/更新文件**: `backend/src/tools/unpackTool.js`
  - `scanArchive(buffer, type)` → 校验结构，返回 manifest
  - `extractArchive(buffer, destDir, opts)` → 安全解压
  - 路径安全：拒绝 `..`、绝对路径、符号链接
  - 大小限制：10 MiB（可配置）
  - 支持：.zip, .tar.gz, .tar
  - 分阶段：先解压到临时目录，成功后原子重命名

### 验证
- 单元测试：阻断路径穿越尝试
- 单元测试：拒绝超大归档

---

## D12 — 规范化状态快照增强 [P1]

### DeepSeek 方案
6 维度规范化状态：
1. **Goal**：最近用户消息摘要
2. **Constraints**：模型、工作区、笔记
3. **Confirmed facts**：最近 4 个成功的工具结果
4. **Open loops**：失败的工具调用（最近 4 个）
5. **Pending actions**：后续步骤
6. **Critical refs**：前 8 个文件路径 + 最近工具 ID

持久化到磁盘，崩溃时可恢复。

### khy 当前状态
- `checkpointService.js` 存在 — 需验证 schema

### 实现
- 定义含 6 维度的 `CanonicalState` schema
- 在周期边界和崩溃恢复时构建快照
- 持久化到 `~/.khyquant/canonical_state.json`

### 验证
- 快照捕获全部 6 个维度
- 崩溃恢复还原最近一次有效快照

---

## P2 项目（延后）

### A4 — 并行/串行工具批处理
按只读 + 无需审批分类工具 → 自动并行分块。

### A5 — 子代理完成排空
父级轮次保持开启，直到所有子级完成。

### B9 — 自动推理力度选择
关键词驱动的层级（low/high/max），支持中日韩。

### C11 — 技能安装管线
下载 → 扫描 → 解压 → 注册流程。

### D13 — 智能工具截断
按工具的噪声分类，含硬/软双重限制。

---

## 变更日志

| 日期 | 项目 | 状态 |
|------|------|--------|
| 2026-05-18 | 文档创建 | 完成 |
| 2026-05-18 | A1 capacityFlow.js | 完成 |
| 2026-05-18 | B6 seamManager.js | 完成 |
| 2026-05-18 | A2 toolLoopDetector warn@3 | 完成 |
| 2026-05-18 | A3 coherenceState.js | 完成 |
| 2026-05-18 | B7 contextCompressor 中的周期边界 | 完成 |
| 2026-05-18 | B8 contextCompressor 中的工作集固定 + 去重 | 完成 |
| 2026-05-18 | C10 unpackTool.js 安全守卫 | 完成 |
| 2026-05-18 | D12 canonicalState.js | 完成 |
| 2026-05-18 | A4 并行批处理（已在 concurrencyLimiter 中） | 完成（已有） |
| 2026-05-18 | A5 子代理排空（已在 workerAgent 中） | 完成（已有） |
| 2026-05-18 | B9 autoReasoning.js | 完成 |
| 2026-05-18 | C11 技能安装管线 | 延后 |
| 2026-05-18 | D13 smartTruncation.js + toolUseLoop 集成 | 完成 |
