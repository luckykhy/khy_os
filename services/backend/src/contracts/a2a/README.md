# A2A 协议契约（JSON Schema）

> 本目录是 khy-os 对接 **Agent2Agent (A2A) Protocol v0.3.0**（Linux Foundation）
> 的机器可读契约。与 `../acp/` 和 `../mobile/` 同级、同约定：schema 即代码，
> 由守卫 `scripts/ci/check-protocol-conformance.js` 加载并做实测。

## 文件

| 文件 | 对应 A2A 对象 | 用途 |
|------|---------------|------|
| `agent-card.schema.json` | `AgentCard` | `/.well-known/agent-card.json` 的发布体 |
| `message.schema.json` | `Message` / `Part`（TextPart / FilePart / DataPart） | `message/send` 与 `message/stream` 的消息体 |
| `task.schema.json` | `Task` / `TaskStatus` / `TaskState` / `Artifact` | `tasks/get`、`tasks/cancel` 的返回体 |

## 为什么单独建一套（而不是复用 `[DESIGN-A2A-001]`）

`docs/10_规范/[DESIGN-A2A-001] A2A 协议规范.md` 描述的是 khy-os 自有的**进程内 ACP
方言**（方法名为点分形式，传输 WS/HTTP/gRPC，状态集为私有集合）。它与标准 A2A
**只在命名上撞车**，二者方法集无一重合。

本目录承载的是**标准 A2A** 的对象模型。两者的术语区分见
`docs/10_规范/其它规范/[DESIGN-NAM-002] A2A 与 ACP 命名及术语规范.md`，关系与迁移路线见
`docs/10_规范/[DESIGN-A2A-002] A2A 标准协议适配规范.md`。

## 关键约束（这些是历史上踩过的坑）

1. **`capabilities` 必须诚实。** `streaming: true` 就意味着 `message/stream` 真的
   存在。khy-os 目前**没有** SSE 流式实现，因此该字段必须为 `false`。声明了却
   做不到，会让每一个合规客户端在能力协商后必然失败（比不声明更糟）。
2. **`TaskState` 是封闭枚举。** 内部生命周期状态必须**映射**到规范状态，
   不允许把私有状态直接透出到协议边界。
3. **`Part` 是 `kind` 判别联合。** 只写 `{ "text": "..." }` 而缺 `kind` 不是合法
   Part —— 这是本仓库 `services/a2a/index.js` 早期的真实缺陷。
4. **`url` 不带尾斜杠**，且必须来自单一真源（`constants/serviceDefaults.js` 或
   环境变量），符合 `AGENTS.md` 工程规则 1「零硬编码」。

## 校验

```bash
node scripts/ci/check-protocol-conformance.js --a2a
```

守卫会用 fixture 逐条断言：AgentCard 通过 `agent-card.schema.json`、
`message/send` 请求体通过 `message.schema.json`、`tasks/get` 返回体通过
`task.schema.json`，并断言 khy-os 声明的能力与实现一致（禁绝 A3/A6 类虚报）。
