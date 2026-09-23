<!-- 文档分类: OPS-MAN-019 | 阶段: 运维 | 原路径: docs/指南/khy-远程ssh-实施清单.md -->
# KHY 远程 SSH 上线实施清单（Phase 0.7）

> ⚠️ **状态：未交付 / CLI 当前不可用。** 本文是实施清单与设计蓝图，**不是**成品操作手册。
> 文中 `khy remote …` 子命令在当前发行版尚未接通：CLI handler（`services/backend/src/cli/handlers/remote.js`）引用的 `remote.sshConfig` / `connectionManager` / `execService` 与服务层实际导出名 `sshConfigService` / `sshConnectionManager` / `remoteExecService`（`services/backend/src/services/remote/index.js`）不匹配，且 router 未向 handler 转发 host / 命令参数，因此每个子命令都会抛错。服务层已存在真实的 SSH 执行引擎，但尚未对接 CLI。
> 请勿据此预期可直接运行的功能；本文用于指导后续实现。

本清单将远程 SSH 愿景转化为可直接落地的任务，并适配当前 KHY-OS 架构。

## 0. 范围

目标：
- 通过 SSH 将 KHY-OS 连接到团队托管的远程开发环境。
- 复用同一套安全中继、脱敏网关、审批流程与跨设备交接。

不在本阶段（Phase 0.7）范围内：
- Kubernetes 级别的多节点编排。
- 持久化的远程 Agent 市场。

## 1. 服务拆分（后端）

在 `backend/src/services/remote/` 下新增以下服务：

1. `sshConfigService.js`
- 解析并监听 `~/.ssh/config`。
- 暴露规范化的主机条目（alias、host、port、user、identityFile、proxyJump）。

2. `sshCredentialGuard.js`
- 校验密钥路径的可读性与文件权限模式。
- 按策略拦截不安全的密钥文件与不安全的 agent-forward 默认配置。

3. `sshConnectionManager.js`
- 管理 SSH 连接的生命周期。
- 维护 `connection_id`、健康状态、重连退避与空闲关闭。

4. `remoteWorkspaceResolver.js`
- 按主机配置解析远程 cwd/工作区。
- 校验允许的工作区前缀。

5. `remoteExecService.js`
- 通过流式回调执行远程命令。
- 发出结构化执行事件（`step_start`、`stdout_chunk`、`step_end`）。

6. `remoteApprovalBridge.js`
- 将高风险远程操作路由进同一套审批工单流程。
- 确保远程操作无法绕过审批。

7. `remoteStateSyncService.js`
- 将远程任务状态接入跨设备快照构建器。
- 包含待处理审批与活跃的远程会话。

## 2. API / 接口契约

建议在 `backend/src/routes/remoteSsh.js` 下设置以下路由：

1. `GET /api/remote/ssh/hosts`
- 返回从 `~/.ssh/config` 发现的 SSH 主机。

2. `POST /api/remote/ssh/connect`
- 输入：
  - `hostAlias`（必填）
  - `workspace`（可选）
  - `purpose`（可选，默认 `development`）
- 输出：
  - `connection_id`
  - `status`（`connected|reconnecting|failed`）
  - `host`、`user`、`workspace`、`trace_id`

3. `POST /api/remote/ssh/disconnect`
- 输入：`connection_id`
- 输出：`status`

4. `POST /api/remote/ssh/exec`
- 输入：
  - `connection_id`
  - `commands[]`
  - `risk_context`（可选）
  - `dry_run`（默认 `true`）
- 行为：
  - 对每条命令进行风险分级。
  - 若为高风险且未预先审批，返回 `approval_required`。
  - 若已审批，则执行并流式推送事件。

5. `GET /api/remote/ssh/sessions`
- 返回活跃连接与健康状态汇总。

## 3. 事件字段（流式 + 追踪）

所有远程事件均应包含：
- `trace_id`
- `connection_id`
- `host_alias`
- `remote_user`
- `remote_workspace`
- `sequence`
- `ts`
- `kind`
- `severity`
- `redaction_applied`

建议的 `kind`：
- `remote_connection_state`
- `remote_exec_step`
- `remote_exec_stdout`
- `remote_exec_stderr`
- `remote_approval_required`
- `remote_exec_summary`

## 4. 安全与策略强制

1. 命令风险策略：
- 复用现有的命令分级路径（`safe/moderate/dangerous/critical`）。
- 应用与本地执行相同的审批规则。

2. 数据出口策略：
- 绝不将完整源文件内容推送到移动端。
- 推送到移动端的远程输出须先经过脱敏网关。

3. SSH 加固默认项：
- 在命令模板中禁用不安全的 shell 插值。
- 拒绝对未知主机别名执行远程操作，除非显式允许。
- 为主机别名保留可选的白名单（`KHY_REMOTE_SSH_ALLOWLIST`）。

4. 审计：
- 以 `trace_id` 持久化 connect/disconnect/exec/approval 事件。

## 5. 跨设备连续性要求

在本地终端、移动端与远程 SSH 之间切换时：
- 将活跃的远程会话纳入交接快照。
- 将待处理的远程审批纳入同一审批队列。
- 保留进行中的远程任务状态（`running`、`retry_wait`、`paused`）。

## 6. 最小测试矩阵

在 `backend/tests/remote/` 下新增测试：

1. `sshConfigService.test.js`
- 解析多主机的 `~/.ssh/config`。
- 处理 `Host *` 默认项与主机级覆盖。

2. `sshConnectionManager.test.js`
- 成功连接/断开。
- 网络中断后以指数退避重连。

3. `remoteExecService.test.js`
- 按序流式推送 stdout/stderr，保证 sequence 单调递增。
- 处理命令超时与取消。

4. `remoteApprovalBridge.test.js`
- 高风险命令在执行前返回审批工单。
- 已审批的工单恰好执行一次。

5. `remoteStateSyncService.test.js`
- 快照包含远程会话与待处理审批。

6. `remoteRedactionPipeline.test.js`
- 远程输出中的密钥在推送移动端事件前被脱敏遮罩。

7. `remoteSsh.route.test.js`
- 对 connect/exec/disconnect 进行路由级校验。
- 拒绝未授权与格式错误的载荷。

## 7. 上线计划（建议）

第 1 周：
- 实现主机发现、连接管理器、connect/disconnect API。

第 2 周：
- 实现远程 exec 流式推送 + 审批桥接 + 脱敏管线。

第 3 周：
- 集成跨设备快照，并补齐完整的远程测试矩阵。

## 8. 阶段退出标准

- `~/.ssh/config` 中的主机能够被可靠地发现与连接。
- 高风险远程命令在未经审批时无法运行。
- 远程执行流在移动端与桌面端均可见，且已脱敏。
- 设备切换能保留远程任务与审批的连续性。
