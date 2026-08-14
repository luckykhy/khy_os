<!-- 文档分类: MGMT-PLAN-003 | 阶段: 项目管理 | 原路径: docs/指南/khy-大任务框架蓝图.md -->
# KHY 最小化大任务框架蓝图

本文档定义了一个实用的最小化框架蓝图，用于处理 KHY-OS 中长时运行、依赖繁重、易于失败的任务。

## 0. 目标与范围

目标：
- 为大任务构建一个可控、可恢复、可观测的运行时。
- 避免彻底重写；在现有 KHY 组件的基础上演进。

非目标：
- 第 1 阶段不追求分布式执行。
- 第 1 阶段不解决全局的精确一次（exactly-once）语义。

## 1. 执行语义（必须最先确定）

采用以下基线：
- 投递语义：`at-least-once`
- 重试策略：瞬时错误可重试，并采用带上限的指数退避
- 超时策略：基于活跃度的空闲超时（而非硬性的墙钟时间强杀）

隐含含义：
- 按设计，重复投递是可能发生的。
- 所有产生副作用的操作都必须在业务边界处具备幂等性。

## 2. 架构（控制面 + 数据面）

```text
API/CLI -> Task Controller -> Queue/Scheduler -> Worker Pool
                     |                |
                     v                v
                Task DB <---- Checkpoint Store
                     |
                     v
             Metrics + Logs + Traces
```

控制面职责：
- 任务生命周期管理
- 租约/认领/心跳/取消/暂停/恢复（Lease/claim/heartbeat/cancel/pause/resume）
- 重试调度与死信路由

数据面职责：
- 执行具体的任务步骤
- 发出进度事件
- 持久化检查点

## 3. 规范状态机

允许的状态：
- `queued`
- `claimed`
- `running`
- `retry_wait`
- `pausing`
- `paused`
- `cancelling`
- `succeeded`
- `failed`
- `cancelled`
- `dead_letter`

关键转换：
- `queued -> claimed -> running -> succeeded`
- `running -> retry_wait -> claimed`
- `running -> pausing -> paused -> running`
- `running|paused -> cancelling -> cancelled`
- `retry_wait -> dead_letter`（超出重试预算）

规则：
- 所有转换都必须经过集中式校验。
- 终态不可变。

## 4. 最小持久化模型

### 4.1 `tasks`

核心字段：
- `id` (pk)
- `type`
- `status`
- `payload_json`
- `priority`
- `attempt_count`
- `max_attempts`
- `next_run_at`
- `lease_owner`
- `lease_until`
- `heartbeat_at`
- `progress_pct`
- `idempotency_key`（可空，存在时唯一）
- `trace_id`
- `created_at`
- `updated_at`

### 4.2 `task_attempts`

核心字段：
- `task_id`
- `attempt_no`
- `worker_id`
- `started_at`
- `ended_at`
- `result_status`
- `error_type`
- `error_message`
- `retry_delay_ms`

### 4.3 `task_checkpoints`

核心字段：
- `task_id`
- `step_no`
- `progress_pct`
- `state_blob_json`
- `schema_version`
- `created_at`

检查点规则：
- 在稳定边界处保存（步骤完成、批次完成、偏移量提交）。
- 从最新的兼容检查点恢复。

## 5. 副作用治理（默认安全模式）

大任务运行时必须强制执行“默认无副作用”原则：

1. `plan()` 阶段：
- 只读
- 计算并校验执行计划
- 不进行任何外部写入

2. `commit()` 阶段：
- 仅在显式提交意图下才允许副作用
- 所有副作用都通过同一个执行器边界

必需模式：
- 默认 `dry_run=true`
- 执行副作用必须 `commit=true`

## 6. 幂等性与精确一次边界

`idempotency_key` 并不会消除副作用本身。
它保证的是在重试场景下“相同意图至多执行一次副作用”。

服务端要求：
- 唯一键约束（`scope + idempotency_key`）
- 业务写入与键记录在同一事务中完成
- 使用相同键的重复调用返回原始结果（响应回放）

## 7. 韧性护栏

必备项：
- 带抖动且有上限的指数退避
- 针对不稳定下游的熔断器
- 截止时间与空闲超时分离
- 重试预算与死信队列
- 取消令牌（cancellation token）传播

加分项（第 2 阶段）：
- 自适应并发槽位
- 动态优先级老化（priority aging）

## 8. 可观测性基线

每个任务事件都应包含：
- `trace_id`
- `task_id`
- `attempt_no`
- `state_from`、`state_to`
- `latency_ms`
- `error_type`（如有）

指标基线：
- 队列深度
- 认领延迟
- 成功率
- 重试率
- 死信率
- 端到端 P95/P99 延迟

## 9. KHY-OS 映射（当前代码库）

现有的可用组件：
- `backend/src/services/retryWithBackoff.js`
- `backend/src/services/circuitBreaker.js`
- `backend/src/utils/spawnWithIdleTimeout.js`
- `backend/src/services/backgroundTaskManager.js`
- `backend/src/tasks/taskStore.js`
- `backend/src/tasks/diskOutput.js`

当前差距：
- 存在多个任务存储（`tasks/taskStore`、`backgroundTaskManager`、`tools/_taskStore`）
- 需要一个由持久化存储支撑的、唯一的事实来源（single source of truth）

## 10. 7 天实施计划

第 1-2 天：
- 引入持久化任务表
- 实现集中式状态转换校验器

第 3-4 天：
- 实现认领/租约/心跳/重试/死信流程
- 通过租约过期实现 worker 崩溃恢复

第 5 天：
- 增加检查点的保存/加载/恢复
- 增加检查点 schema 版本兼容性检查

第 6 天：
- 增加结构化日志 + trace_id 传播
- 增加看板级别的指标聚合

第 7 天：
- 故障演练：杀死 worker、注入网络故障、重复投递、慢速下游
- 验证无数据损坏且可从检查点恢复

## 11. 第 1 阶段验收标准

- 长任务在进程崩溃后能从检查点恢复。
- 重复投递不会重复执行关键副作用。
- 空闲超时绝不会杀死有活跃进度的任务。
- 任务状态可端到端查询与审计。
- 死信任务包含可操作的失败元数据。

## 12. 实施状态（2026-05-16）

代码库中已实现：
- 规范的持久化运行时存储：
  - `backend/src/tasks/largeTaskRuntimeStore.js`
  - 集中式状态转换、重试、死信、检查点、幂等记录、事件流、指标
  - 重试分类策略（可重试 vs 不可重试），永久性错误立即进入终态失败
  - 可配置的重试策略（`getRetryPolicy`/`setRetryPolicy`），用于：
    - 不可重试的错误类型/状态码/错误种类
    - 可重试的错误种类
    - 默认的未知错误行为（`default_retryable`）
  - 重试策略持久化 + 审计轨迹：
    - 持久化的 `retry_policy` 快照
    - 持久化的 `retry_policy_events` 事件流，带元数据（`trace_id`、`actor`、`source`、`reason`、`before_policy`、`after_policy`）
    - 通过 `after_id` 和 `trace_id` 进行事件分页/过滤
  - 重试策略高风险审批工作流：
    - 持久化的 `retry_policy_approval_tickets`
    - 补丁哈希绑定，防止审批票据在不同补丁上被重放
    - 审批生命周期：`pending -> approved/rejected -> consumed/expired`
    - 对终态审批票据/事件进行保留压缩（按年龄 + 数量限界，保留 pending 票据）
- 带 plan/commit 副作用闸门的编排器：
  - `backend/src/tasks/largeTaskOrchestrator.js`
  - 副作用提交受按 scope 的熔断器保护（熔断打开时快速失败）
  - 执行期间感知控制面的暂停/取消（`task_paused` / `task_cancelled`）
  - 基于活跃度的滑动空闲超时（`idle_timeout_ms`），带进度感知重置（`markActivity`、`reportProgress`、`saveCheckpoint`、`commit`）
- 持续运行的 worker 循环服务：
  - `backend/src/tasks/largeTaskWorkerService.js`
  - start/stop/status/runTick
  - 租约重新入队 + 每个 tick 的运行预算 + 队列深度/最近一次运行摘要
  - 将 `idle_timeout_ms` 传播到每次任务运行
  - 将 `retry_policy` 传播到每次任务运行
  - 控制面 HTTP 路由：
  - `backend/src/routes/largeTasks.js`
  - 任务 API + 指标/事件/SSE + worker API：
    - `GET /api/large-tasks/worker/status`
    - `POST /api/large-tasks/worker/start`
    - `POST /api/large-tasks/worker/stop`
    - `GET /api/large-tasks/circuit/commit?scope=...`（提交熔断器可观测性）
    - `POST /api/large-tasks/:taskId/run` 接受 `idle_timeout_ms`
    - `POST /api/large-tasks/run-next` 接受 `idle_timeout_ms`
    - 任务运行选项接受 `retry_policy` 覆盖
    - `GET /api/large-tasks/retry-policy`（可选包含审计事件）
    - `GET /api/large-tasks/retry-policy/events`（审计事件流查询）
    - `POST /api/large-tasks/retry-policy`（带审计记录的策略更新）
    - `GET /api/large-tasks/retry-policy/approvals/pending`
    - `GET /api/large-tasks/retry-policy/approvals/retention`
    - `POST /api/large-tasks/retry-policy/approvals/retention`（在线调整审批票据/事件保留策略，带审计事件）
    - `GET /api/large-tasks/retry-policy/approvals/retention/events`（保留策略审计事件查询）
    - `GET /api/large-tasks/retry-policy/approvals/retention/stream`（保留策略审计 SSE 回放 + 监听 + Last-Event-ID 续传）
    - `GET /api/large-tasks/retry-policy/approvals/events`（历史审批事件查询，带 `after_id`/过滤分页）
    - `POST /api/large-tasks/retry-policy/approvals/decision`
    - 高风险更新路径返回 `202 approval_required`，最终应用需要 `approval_ticket_id`
    - `GET /api/large-tasks/retry-policy/approvals/stream`（SSE 回放 + 监听 + Last-Event-ID 续传）
    - `POST /api/large-tasks/:taskId/pause`
    - `POST /api/large-tasks/:taskId/resume`
    - `POST /api/large-tasks/:taskId/cancel`
  - 重试策略更新安全校验：
    - 严格的允许键集合
    - token 格式/长度检查
    - 状态码范围检查
    - 数组基数上限
    - 护栏底线规则阻止危险组合（例如 `default_retryable=false` 且没有任何瞬时重试信号）
  - 审计/事件重试元数据契约：
    - attempts/events 暴露 `retryable`、`retry_classification`、`error_kind`、`status_code`
    - 重试策略结果可从 `GET /api/large-tasks/:taskId/audit` 和 `GET /api/large-tasks/events` 查询
  - 跨设备交接快照 API：
    - `GET /api/large-tasks/handover/snapshot`
    - 面向移动端渲染的紧凑模式：`GET /api/large-tasks/handover/snapshot?format=mobile`
    - 返回最近的关键操作 + 保留策略变更摘要 + 活跃任务摘要 + 待处理审批/待办

验证：
- 路由/服务/运行时/编排器测试通过：
  - `backend/tests/services/largeTaskRuntimeStore.test.js`
  - `backend/tests/services/largeTaskOrchestrator.test.js`
  - `backend/tests/services/largeTaskWorkerService.test.js`
  - `backend/tests/routes/largeTasks.route.test.js`
