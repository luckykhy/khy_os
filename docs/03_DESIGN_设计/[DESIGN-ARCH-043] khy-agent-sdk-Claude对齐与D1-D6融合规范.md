<!-- 文档分类: DESIGN-ARCH-043 | 阶段: 设计 | 主题: khy-agent-sdk Claude对齐与D1-D6融合 -->
# khy-agent-sdk — Claude Agent SDK 对齐与 D1–D6 治理融合规范

> 文档编号：DESIGN-ARCH-043
> 日期：2026-06-12
> 状态：已落地（最小可运行骨架 + 13 测试绿）
> 落点：`platform/packages/agent-sdk/`（`@khy/agent-sdk` v0.1.0）
> 详细设计随包：[差异图谱](../../platform/packages/agent-sdk/docs/差异图谱.md)、
> [融合架构](../../platform/packages/agent-sdk/docs/融合架构.md)、
> [llms.txt](../../platform/packages/agent-sdk/docs/llms.txt)、
> [README](../../platform/packages/agent-sdk/README.md)、类型 `src/types.d.ts`

---

## 1. 目标与定位

把 Claude Agent SDK 的 §1–§10 开发者表面与 khy 的 D1–D6 决策**深度融合**：
**Claude 形态在外**（命名/签名 1:1 可移植）、**khy 治理在内**（D1–D6 扩展字段，全部可选）。

关键工程决策：**不重造轮子**。`platform/packages/sdk`（`@khy/sdk` v1.0.0）已提供
`createQuery`/`Query.execute()` 异步流、`tool`/`createMcpServer`、`Conversation` 多轮、
`onPermission` 回调、三 transport。故 `khy-agent-sdk` **构建于 `@khy/sdk` 原语之上**，
仅以**依赖注入**叠加 D1–D6 治理层（单一真源）。省略 `options.khy.*` 即退化为纯 Claude 形态
（"开关可关=行为同今天"）。

## 2. 融合脊柱（权限链路）

Claude §4 顺序 `Hooks → deny → ask → permissionMode → allowedTools → canUseTool`，
khy 把 D6 网关与 D4 元约束嵌入：

```
Hooks(PreToolUse, D3 硬拦截) → deny → D6网关(宪法红线→L0/L1/L2)
  → D4元约束(写类工具: Prompt_Soft⊏Code_Hard⊏System_Block)
  → permissionMode(六态) → allowedTools → canUseTool
```

- 每 stage 只能收紧；宪法红线优先于 `bypassPermissions`；System_Block 非 bypass 一律 `ask`（生产绑 `rollbackService` 快照）。
- fail-safe：任一协调器抛错降 `ask`，绝不静默 allow。
- 状态透明：返回 `{decision, stage, strategy?, redLine?, level?, reason?}`。
- 落点：`src/permissionChain.js` `evaluatePermission()`；缺省 `src/defaults.js`，生产注入后端真协调器。

## 3. 逐模块映射（§ × D）

| § | 融合点 | 落点 |
|---|---|---|
| §1 query | 对齐 Claude 消息类型 + `khy_governance` 流消息 | `src/index.js` |
| §2 Options | permissionMode 六态 + `khy.*` 注入块 | `src/types.d.ts` |
| §4 权限 | D6 网关 + D4 元约束嵌入链路 | `src/permissionChain.js` |
| §5 Hooks | PreToolUse=D3 硬拦截；PostToolUse=D1 能力向量更新 | `src/index.js` runHooks |
| §6 MCP | `mcp__{server}__{tool}` + D4 强制元规划 | `src/mcp.js` |
| §7 子代理 | D1 能力地板匹配 + D2 元帅弱主收紧 | `src/subagents.js` |
| §8 会话 | D-state（D1向量/D6审批/D4元规划）随会话持久化 | `src/sessionStore.js` |
| §9/§10 托管/安全 | D5 宾客安装 + D6 红线叠加（P2 接口预留） | `融合架构.md` |

## 4. 验收

- 最小可运行骨架实现全部 6 个目标示例：`query()`、权限评估链路、PreToolUse Hook、MCP 配置、会话恢复、子代理调用。
- `test/agentSdk.test.js` **13/13 绿**（node:test，hermetic 无需守护进程）。
- 全部 6 个源模块 `node -c` 语法通过；零侵入 `@khy/sdk` 与后端核心。

## 5. 后续（差异图谱 P1/P2）

- P1：§3 工具暴露面对齐、§5 Hook 事件补全、§6 MCP 真接执行器、§7 子代理接 `subAgentOrchestrator`+`marshal`。
- P2：§9 托管形态抽象、§10 成体系安全部署清单。
- 生产接线以 `options.khy.*` 注入后端 `metaplan`/`marshal`/`guardApproval` 等真协调器。
