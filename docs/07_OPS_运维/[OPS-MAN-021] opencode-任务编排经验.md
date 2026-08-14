<!-- 文档分类: OPS-MAN-021 | 阶段: 运维 | 原路径: docs/指南/opencode-任务编排经验.md -->
# OpenCode 任务编排机制学习记录

**日期：** 2026-05-19  
**来源：** `/home/kodehu03/Downloads/opencode-dev.zip`

## OpenCode 在任务处理上的优点

1. `plan` 与 `build` 是两个独立主代理，分析与执行不混用。
2. `task()` 会创建真实子会话，不是简单提示词封装。
3. 后台任务是一等能力：`background=true`、`task_status`、轮询、等待、取消都完整支持。
4. 任务状态可持久化，并可通过 `task_id` 恢复与续跑。
5. 会话状态显式建模（`idle` / `busy` / `retry`），编排更可控。
6. 返回格式可机读（`<task_result>` / `<task_error>`），便于 UI 与自动化处理。
7. 子任务结果会在主线程空闲时再回注，避免输出交错与上下文冲突。

## 关键参考文件

- [agent.ts](/tmp/opencode-dev/opencode-dev/packages/opencode/src/agent/agent.ts)
- [task.ts](/tmp/opencode-dev/opencode-dev/packages/opencode/src/tool/task.ts)
- [task_status.ts](/tmp/opencode-dev/opencode-dev/packages/opencode/src/tool/task_status.ts)
- [background/job.ts](/tmp/opencode-dev/opencode-dev/packages/opencode/src/background/job.ts)
- [session/run-state.ts](/tmp/opencode-dev/opencode-dev/packages/opencode/src/session/run-state.ts)
- [session/status.ts](/tmp/opencode-dev/opencode-dev/packages/opencode/src/session/status.ts)
- [session/processor.ts](/tmp/opencode-dev/opencode-dev/packages/opencode/src/session/processor.ts)
- [session/retry.ts](/tmp/opencode-dev/opencode-dev/packages/opencode/src/session/retry.ts)
- [plan.ts](/tmp/opencode-dev/opencode-dev/packages/opencode/src/tool/plan.ts)

## 对 KHY 的迁移建议

### 1. 把“任务”做成真实对象

对于长任务，统一抽象为可追踪实体，至少包含：

- task id
- state
- progress
- output
- cancel
- resume

### 2. 严格分离规划与执行

OpenCode 的 `plan` 默认只读，审批后再切回 `build` 执行。  
KHY 应保持同样边界，避免计划阶段误改代码。

### 3. 显式状态流转

把 `busy` / `idle` / `retry` 作为会话级状态，并在 CLI 与页面可视化展示。

### 4. 空闲时回注结果

后台任务完成后，不应立即抢占主会话输出；应在主会话空闲时回注，减少“半截回复”和上下文错位。

### 5. 结果保持结构化

任务结果应始终提供结构化字段，而不是只返回自然语言，便于后续自动编排和前端渲染。

### 6. 强化持久化与恢复

计划、后台任务、多步骤流程都应支持跨会话恢复，避免中断后全量重来。

### 7. 重试策略统一化

重试应记录原因、下一次时间点、可执行动作，不应散落在各处做临时处理。

## KHY 落地优先级

1. 任务注册表 + task id + 状态查询 API
2. 后台任务执行与 `task_status` 轮询/等待
3. 会话级 `busy/idle/retry` 状态机
4. `plan/build` 审批边界
5. 主线程空闲后回注机制
6. 任务持久化与断点恢复
7. 统一重试策略与元数据

## 结论

如果 KHY 的目标是“让系统自己把复杂问题做完”，核心不是继续堆提示词，而是：

**把每一个长任务都变成可跟踪、可恢复、可取消、可重试的会话化执行单元。**

## 团队执行任务拆解（P0 / P1 / P2）

### P0（必须先完成，1-2 周）

| 优先级 | 任务 | 负责人（建议） | 交付物 | 验收标准 |
|---|---|---|---|---|
| P0 | 任务注册表与状态 API（task id / state / progress / output） | Backend Owner | `taskStore` + 查询接口 + CLI 展示 | 可创建任务、查询任务、状态可追踪 |
| P0 | 后台任务执行与 `task_status`（轮询 + wait + timeout） | Backend Owner | 后台执行器 + `task_status` 命令 | 后台任务可启动、轮询、超时返回清晰 |
| P0 | 会话状态机（`busy/idle/retry`） | Runtime Owner | 会话运行态服务 + 状态事件 | 并发冲突可阻止，状态可观察 |
| P0 | `plan/build` 审批边界固化 | CLI Owner | plan-only 只读约束 + 审批切换逻辑 | plan 阶段无法写入非计划文件 |

### P1（稳定性与体验增强，2-4 周）

| 优先级 | 任务 | 负责人（建议） | 交付物 | 验收标准 |
|---|---|---|---|---|
| P1 | 主线程空闲后回注（resume-on-idle） | Runtime Owner | 回注调度器 + 状态监听 | 无“半截回复”、无输出重叠 |
| P1 | 任务持久化与断点恢复 | Backend Owner | 任务快照存储 + 恢复入口 | 进程重启后可继续任务 |
| P1 | 结构化任务输出协议 | Backend + Frontend | 统一输出 schema（result/error/progress） | CLI 与前端可稳定渲染同一数据 |
| P1 | 取消链路（父任务取消联动子任务） | Runtime Owner | 取消传播机制 | 取消父任务时子任务全部终止 |

### P2（可运营与可扩展，4 周+）

| 优先级 | 任务 | 负责人（建议） | 交付物 | 验收标准 |
|---|---|---|---|---|
| P2 | 统一重试策略中心（原因、next、action） | Gateway Owner | retry policy 模块 + 指标 | 重试行为一致、可观测 |
| P2 | 子代理权限继承与隔离强化 | Security Owner | 权限推导器 + 白名单策略 | 子任务不越权，误用率下降 |
| P2 | 任务质量看板（成功率、时延、失败原因） | SRE/Observability Owner | 监控报表 + 趋势图 | 能按任务类型定位瓶颈 |
| P2 | 任务模板库（常见任务标准化） | Product + AI Owner | 任务模板配置 + 引导文案 | 新任务接入成本下降 |

## 里程碑建议

1. M1：完成 P0，打通“可追踪后台任务”闭环。  
2. M2：完成 P1，解决并发输出混乱与中断恢复问题。  
3. M3：完成 P2，形成可运营、可治理的任务系统。

## 分工提示

- Backend Owner：任务数据结构、持久化、状态 API。  
- Runtime Owner：执行循环、状态机、取消与回注。  
- CLI Owner：命令入口、状态展示、交互文案。  
- Frontend Owner：任务可视化面板与状态追踪。  
- Security Owner：权限模型、越权防护。  
- SRE Owner：可观测性、告警与容量指标。  
