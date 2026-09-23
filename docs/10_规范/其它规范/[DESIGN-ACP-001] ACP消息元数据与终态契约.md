# [DESIGN-ACP-001] ACP 消息元数据与终态契约

<!-- RULES-REGISTRY: COMMS-001, COMMS-002, COMMS-003, COMMS-004 -->


> **定位**：`[DESIGN-GOV-001]` GOV-ACP-001/003/004 的契约冻结真源 + UC-004 裁决。
> 冻结对象：ACP（`services/backend/src/contracts/acp/`）的**信封三态拆分**、**`meta` 元数据块**、**协议级终态错误码表**。
> 现状 schema v1（`acp-message.schema.json`：顶层 `required: ["jsonrpc","method"]`、无 `meta`）与运行时的偏差以本文为准；落地按 §5，落地前 070 台账登记待工具化。

## 1. 信封三态（UC-004 裁决）

ACP 是 JSON-RPC 2.0 兼容信封，**必须**按三形态校验，禁止一种 schema 管全部：

| 形态 | 必含 | 禁止 | 例 |
|---|---|---|---|
| 请求（有应答） | `jsonrpc`、`method`、`id`、`params?`、`meta?` | `result`、`error` | `task.submit`、`tool.invoke` |
| 通知（无应答） | `jsonrpc`、`method`、`params?`、`meta?` | `id`、`result`、`error` | `heartbeat`、`task.progress` |
| 响应 | `jsonrpc`、`id`（同请求）、`result` 与 `error` **恰一** | `method`、`params` | v1「response 带 `method`」宽松接受**废止** |

**裁决**：schema v2 把 `method` 移出顶层 `required`，用三形态子 schema（`oneOf`）表达上表；response 携带 `method` 即校验失败。
方法枚举保持 v1 的 12 个不变；新增方法先过 §2/§3 登记（GOV-ACP-002：`validate-json-schemas.js` + ACP 测试）。

## 2. `meta` 元数据块（GOV-ACP-003 冻结）

信封级可选块；**跨边界消息必须携带**（同进程内可省）：

| 字段 | 必填条件 | 规则 |
|---|---|---|
| `traceId` | 跨进程/跨 transport | 全链路同值可传播；生成方 = 链首调用者 |
| `correlationId` | 请求↔响应配对 | v1 散落在 `task.submit`/`message.send` 的 `correlationId` 提升到信封级；响应原样回带 |
| `callId` | 一切 `tool.invoke` | **并发**工具调用靠它回配 `tool.result`（v1 仅按 `tool` 名回配，同名并发会串线——GOV-ACP-003 反例） |
| `deadline` | 有超时语义的请求 | unix ms；传输层/被调方必须在 deadline 前产出 §3 终态，不得静默挂过 |
| `idempotencyKey` | 可重试请求（`task.submit`） | 被调方对同 key 重放只执行一次，后续返回首次结果 |
| `version` | 必填 | schema 大版本（当前冻结 `2`）；不兼容变更 +1，新旧并存一个发布周期 |

`context.share` 的 `scope`（session/persistent）判定与记录格式按 `[DESIGN-MEM-006]` §1/§2，本文不重复。

## 3. 协议级终态与错误码（GOV-ACP-004 冻结）

超时/取消/重试耗尽/连接关闭**必须**产出可观察终态；transport 不得把协议级失败包装成成功
（v1 反例：WS 发送失败被吞、调用方仍收到成功）。

| 终态 | `error.code` | 语义 | 调用方动作 |
|---|---|---|---|
| 超时 | `-32001` | deadline 到达无结果 | 视为未完成；带同 `idempotencyKey` 重试或放弃 |
| 取消 | `-32002` | 调用方主动取消 | 链路归档 |
| 传输失败 | `-32003` | 连接断/发送失败，结果未知 | 按 `idempotencyKey` 语义决定重放 |
| 关闭 | `-32004` | 被调 agent 已停止（`agent.kill` 后） | 改投新 agent |

- `error.message` = 人话一句话（遵循 `AGENTS.md` 规则 2.2「问题+识别码+修复建议」）；`error.data` 可带 `{ traceId, deadlineExceeded, attempts }`。
- 四终态**互斥**：一条请求最终只落 `result` 或一个 `error`；重试是调用方行为，被调方不替调用方重发。

## 4. 兼容策略

- 并存期：发送方可带 `meta`（旧接收方忽略未知字段，`additionalProperties` 需对 `meta` 一个键放开）；接收方按 `version` 判别；
- `version` 缺省按 `1`；v2 接收方对 v1 消息**降级**处理（无 `callId` 时回退按 `tool` 名回配 + 日志一行告警），不得报错丢弃。

## 5. 落地排期（登记，不阻塞冻结）

1. schema v2：`acp-message.schema.json` 按 §1/§2 改写（`$id` 加版本后缀），`validate-json-schemas.js` 同步；
2. `acpTransport.js`：response 发送去 `method`、补 `meta` 透传、§3 四码接线；
3. 测试：ACP transport 测试 + JSON schema 检查双守卫，同步 `scripts/tests/` 用例（070 §7 条款）。

落地后 070 §4 的 GOV-ACP 校验方式列改指本文 + 上述守卫，UC-004 关闭。
