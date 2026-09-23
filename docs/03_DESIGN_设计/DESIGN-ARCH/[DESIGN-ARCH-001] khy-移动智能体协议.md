<!-- 文档分类: DESIGN-ARCH-001 | 阶段: 设计 | 原路径: docs/指南/khy-移动智能体协议.md -->
# KHY 移动智能体协议 (v1.0)

本指南定义了 KHY-OS 在“本地超级管理员 + 远程 SSH 操作员 + 移动端安全转译器”愿景下面向移动端的协议。

## 1. 设计目标

- 本地数据主权：绝不向移动端发送完整源文件或明文凭证。
- 风险分级授权：高风险操作必须生成审批工单。
- 移动优先的流式传输：为卡片式渲染提供简洁、结构化的负载。
- 三端连续性：本地桌面、移动端与远程 SSH 会话必须共享同一套脱敏与审批管线。

## 2. 规范化 Schema

Schema 文件：
- `backend/src/contracts/mobile/approval-ticket.schema.json`
- `backend/src/contracts/mobile/mobile-stream-event.schema.json`
- `backend/src/contracts/mobile/device-handover-snapshot.schema.json`

## 3. 出站流式信封

所有移动端推送事件必须符合 `mobile-stream-event.schema.json`。

必填的顶层字段：
- `version`、`event_id`、`trace_id`、`sequence`、`ts`
- `stream`、`kind`、`severity`、`title`、`payload`
- `redaction_applied`

支持的 `kind`：
- `status`
- `batch_step`
- `approval_ticket`
- `diff_preview`
- `test_result`
- `handover_snapshot`
- `task_state`
- `final_summary`

## 4. 审批工单契约

对高风险操作使用 `approval-ticket.schema.json`。

最小必填字段：
- `ticket_id`
- `risk_level`
- `requested_action`
- `target`
- `reason`
- `impact_summary`
- `command_preview`
- `expires_at`
- `choices`（`approve`、`reject`、`edit_then_approve`）

## 5. 跨设备交接契约

当用户在移动端、本地终端与远程 SSH 环境之间切换时，使用 `device-handover-snapshot.schema.json`。

快照必须包含：
- 最近的关键操作（最多 3 条）
- 正在运行的后台任务
- 待处理的审批
- 剩余的待办事项

推荐的远程元数据（适用时）：
- 活动的 SSH 主机别名
- 远程工作区路径
- 远程会话健康状态（`connected` / `reconnecting` / `disconnected`）

## 6. 脱敏规则（强制）

在向移动端发送任何负载之前：
- 将疑似密钥的值（`password`、`token`、`secret`、私钥）替换为掩码形式。
- 对于代码变更，仅发送 diff 摘录。
- 对于日志，仅发送末尾摘要（建议最多：最后 10 行）。

## 7. 最小示例

### 7.1 `approval_ticket` 流式事件

```json
{
  "version": "1.0",
  "event_id": "ev_6jk4m9p2r1",
  "trace_id": "tr_20260516_6e9a3f21",
  "sequence": 25,
  "ts": "2026-05-16T10:31:12Z",
  "stream": "ops",
  "kind": "approval_ticket",
  "severity": "warn",
  "title": "High-risk operation approval",
  "payload": {
    "ticket_id": "ap_h8k2m9q1v4",
    "risk_level": "high",
    "requested_action": "Kill high-memory process",
    "target": "chromium-render (PID 892)",
    "reason": "Memory usage remains above threshold for 120s.",
    "impact_summary": "Process termination may lose unsaved renderer state.",
    "command_preview": ["kill -9 892"],
    "expires_at": "2026-05-16T10:35:00Z",
    "choices": ["approve", "reject", "edit_then_approve"]
  },
  "redaction_applied": true
}
```

### 7.2 `handover_snapshot` 流式事件

```json
{
  "version": "1.0",
  "event_id": "ev_91dzk2q4m6",
  "trace_id": "tr_20260516_6e9a3f21",
  "sequence": 42,
  "ts": "2026-05-16T11:00:00Z",
  "stream": "sync",
  "kind": "handover_snapshot",
  "severity": "info",
  "title": "Session handover snapshot",
  "payload": {
    "recent_actions": [
      "Killed stuck python training process (PID 882).",
      "Switched model to claude-3.5-sonnet and reran tests.",
      "Auth patch applied; git commit still pending."
    ],
    "background_tasks": [
      "npm run dev (PID 1024, port 8080)"
    ],
    "pending_approvals": [],
    "todos": [
      "Commit auth patch"
    ]
  },
  "redaction_applied": true
}
```
