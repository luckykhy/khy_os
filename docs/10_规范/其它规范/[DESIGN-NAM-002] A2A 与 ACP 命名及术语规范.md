# [DESIGN-NAM-002] A2A 与 ACP 命名及术语规范

<!-- RULES-REGISTRY: NAM-002 -->

<!-- naming-guard: exempt 本文是本规则的规范真源，必须引用错误命名才能定义「什么算违规」 -->

> **状态**：生效中
> **适用范围**：全仓（代码 / 文档 / 环境变量 / 任务入口命名）
> **解决的问题**：仓库里有两个都被称为「A2A」的东西 —— 标准 Agent2Agent 协议，
> 与 khy-os 自有的**进程内 ACP 方言**。文档把后者逐字写成了「A2A 协议规范」，
> 连方法名都是实现中**根本不存在**的虚构集合，外部读者据此对接必然失败。
> **强制手段**：`npm run check:protocol-naming`（`scripts/ci/check-protocol-naming.js`）
> **相关文档**：`[DESIGN-A2A-001]`（私有方言，更名中）、`[DESIGN-A2A-002]`（标准 A2A 适配）、
> `[DESIGN-COMM-001]` 通信协议规范、`[DESIGN-NAM-001]` 统一命名规范

---

## 1. 术语表（唯一真源）

本表是全仓**唯一**允许用来称呼这两套协议的词汇。任何文档/注释/提交信息使用其它
说法（尤其是裸用「A2A」指代私有方言）都视为违规。

| 规范术语 | 定义 | 协议版本 | 传输 | 作用域 |
|----------|------|----------|------|--------|
| **标准 A2A**<br>（Standard A2A / Agent2Agent） | Linux Foundation 的 Agent2Agent Protocol，代表实现为 `services/a2a/**` | `0.3.0`<br>（`agentCardSpec.A2A_PROTOCOL_VERSION`） | JSON-RPC 2.0 over HTTP + **SSE**（REST 绑定路径 `/v1/message:send` 等） | **跨厂商、跨网络** |
| **私有 ACP**<br>（Private ACP dialect） | khy-os 自有的进程内 agent 编排方言，代表实现为 `acpTransport.js` + `a2a*` 模块群 | `1.0`<br>（`ACP_PROTOCOL_VERSION`） | 进程内 / 自建 ipc·ws·http | **单进程内** |

### 1.1 关键区分点（对外解释时用这张表）

| 维度 | 标准 A2A | 私有 ACP |
|------|----------|----------|
| 方法名 | `message/send`、`message/stream`、`tasks/get`、`tasks/cancel`、`tasks/pushNotificationConfig/*` | `agent.spawn`、`agent.kill`、`agent.status`、`task.submit`、`task.result`、`task.progress`、`context.share`、`tool.invoke`、`tool.result`、`message.send`、`message.broadcast`、`heartbeat` |
| 方法名形状 | 斜杠分隔（`域/动作`） | 点号分隔（`域.动作`） |
| 任务状态集 | `submitted` / `working` / `input-required` / `completed` / `canceled` / `failed` / `rejected` / `auth-required` / `unknown`（封闭枚举） | `pending` / `spawning` / `running` / `waiting` / `completing` / `completed` / `failed` / `killing` / `killed` / `timed_out`（私有） |
| 发现机制 | `GET /.well-known/agent-card.json`（公开） | 自建内存注册表（`a2aRegistry`），无对外端点 |
| 流式 | SSE（`message/stream`） | 无 |
| 持久化 | 任务需可持久（`tasks/get` 跨请求） | 全内存，进程重启即清零 |

> **方法名的权威真源**：标准 A2A 见 `contracts/a2a/*.schema.json`；私有 ACP 见
> `contracts/acp/acp-message.schema.json` 的 `method` enum 与 `acpTransport.ACP_METHODS`。
> **两处必须一致**，由 `check-protocol-conformance.js` 与本节守卫共同锁定。

---

## 2. 命名规则（强制）

### NAM-A2A-1 —— 禁止 `a2a.` 前缀方法名

全仓（代码 + 文档）**禁止**出现 `a2a.<域>.<动作>` 形式的方法名。

**理由**：`a2a.discovery.register` / `a2a.task.create` / `a2a.capability.invoke` /
`a2a.status.*` 这一整套名字**在实现中零存在** —— 实测全仓只出现在文档里
（`[DESIGN-A2A-001]`、`[DESIGN-ARCH-073]`）。它们是设计草案遗留，从未落地。
保留它们只会让外部读者以为有这样一套 API。

**唯一豁免方式**：文件顶部（前 40 行内）放置显式豁免标记：

```html
<!-- naming-guard: exempt 理由（≤60 字） -->
```

豁免标记必须带**理由**，且只允许用于「记录历史错误命名」的场合 ——
不允许用它来继续描述一套不存在的 API。

### NAM-A2A-2 —— 环境变量前缀

| 前缀 | 归属 | 规则 |
|------|------|------|
| `KHY_A2A_*` | **标准 A2A** | 新增需登记进 `scripts/ci/protocol-naming.json` 的 `a2aEnvAllowlist`。当前白名单：`KHY_A2A_ENABLED`、`KHY_A2A_PUBLIC_URL`、`KHY_A2A_API_KEY`、`KHY_A2A_AGENT_VERSION`、`KHY_A2A_TIMEOUT_MS`、`KHY_A2A_LEGACY_AGENT_JSON` |
| `KHY_ACP_*` | **私有 ACP** | 私有方言的**新增**环境变量一律用此前缀 |

**已知遗留冲突（登记在案，P2 修复）**：`KHY_A2A_ENABLED` 目前被**两个子系统**
同时读取 —— `agentCardSpec.isPublishEnabled()`（标准 A2A 发现端点）
与 `a2aConfig.isEnabled()`（私有 ACP 总闸）。二者默认均为 `on`，故当前无行为差异；
但关掉这一个变量会**同时**关掉两个子系统，语义含糊。修复随 P2 重命名一并完成
（私有侧改为 `KHY_ACP_ENABLED`，过渡期回退读 `KHY_A2A_ENABLED`）。

### NAM-A2A-3 —— 文档标题与首段

描述私有 ACP 的文档，其标题与首段**必须**至少出现一次「私有」或「进程内」限定词。

**反例**（现状，已加更正横幅）：`# [DESIGN-A2A-001] A2A 协议规范`
**正例**：`# [DESIGN-ACP-002] 私有 ACP 方言协议规范（进程内 agent 编排）`

### NAM-A2A-4 —— 标准 A2A 的能力声明必须诚实

标准 A2A 侧声明的任何能力，必须在代码中确有其事，真源为
`agentCardSpec.IMPLEMENTED_CAPABILITIES`，由 `check-protocol-conformance.js` 的
`capability-honesty:*` 断言实测。**禁止**先改卡片再补实现。

### NAM-A2A-5 —— 私有方言不得出现在对外契约中

私有 ACP 的方法名、状态集、传输方式**禁止**出现在：
- Agent Card 的 `skills` / `capabilities` / `description`；
- `contracts/a2a/**` 的任何 schema；
- 任何面向外部 integrator 的文档（`docs/10_规范/` 中以标准 A2A 为主题的文档）。

---

## 3. 重命名映射表（P2 阶段执行）

当前私有方言的**文件名**仍是 A2A 前缀（内部标识符早已是 ACP），构成持续混淆源。

| 现名 | 目标名 | 直接引用方（实测） | 备注 |
|------|--------|-------------------|------|
| `src/services/a2aRegistry.js` | `src/services/acp/acpRegistry.js` | 5 个 | — |
| `src/services/a2aMessageRouter.js` | `src/services/acp/acpMessageRouter.js` | 5 个 | — |
| `src/services/a2aAgentLifecycle.js` | `src/services/acp/acpAgentLifecycle.js` | 5 个 | — |
| `src/services/a2aFacade.js` | `src/services/acp/acpFacade.js` | 5 个 | — |
| `src/services/a2aConfig.js` | `src/services/acp/acpConfig.js` | — | 含 `KHY_A2A_*` 私有 env |
| `src/services/a2aInit.js` | **直接删除** | 0 个 | 死代码（`initializeA2A` 全仓无调用方） |
| `docs/10_规范/[DESIGN-A2A-001] …` | `docs/10_规范/[DESIGN-ACP-002] 私有 ACP 方言协议规范.md` | 2 份文档引用 | 旧文件名保留为跳转桩 |

**5 个直接引用方**（实测）：`tools/teammateBus.js`、`services/a2aFacade.js`、
`services/a2aMessageRouter.js`、`services/agentCommunicationService.js`、
`services/externalAgentDirective.js`。

**过渡策略**（三步，每步可独立回滚）：
1. **别名层**：新路径建 re-export 壳，旧路径保留为 `module.exports = require('../acp/xxx')`。
   跑全量测试，确认零回归。
2. **切换引用**：把 5 个引用方改为新路径；旧壳加 `@deprecated` JSDoc + 一行 `console.warn`（仅 `KHY_ACP_DEPRECATION_WARN=1` 时输出）。
3. **移除旧壳**：下一个 minor 版本删除；同时在 `CHANGELOG` 标注破坏性变更。

> **为什么不在本次整改里直接做**：改名牵动 5 个引用方 + 14 处 agent 注册路径 +
> 既有测试，属独立破坏性批次。且**命名纪律本身已由 NAM-A2A-1~5 覆盖** ——
> 文档层混淆（真正的危害源）已经消除。改名是「消除剩余的命名噪音」，优先级低于它。

---

## 4. 文档纠正清单

| 文件 | 问题 | 处置 | 状态 |
|------|------|------|------|
| `docs/10_规范/[DESIGN-A2A-001] A2A 协议规范.md` | 把私有方言写成「A2A 协议规范」；§4 方法名（`a2a.discovery.register` 等）实现中零存在；§5 传输写 WebSocket/gRPC | 加定位更正横幅（已做）；新增 §0 术语与方法集更正表（权威 ACP 方法集 + 历史错误命名对照）；§4 前插入更正警示 | ✅ 本次 |
| `docs/03_DESIGN_设计/[DESIGN-ARCH-073] 规范快速参考卡.md` | `## A2A 协议速查` 把虚构方法族（`a2a.discovery.*` / `a2a.capability.*` / `a2a.task.*` / `a2a.status.*`）当作真实 API 速查 | 改为真实 ACP 方法集，并拆成「私有 ACP（进程内）」与「标准 A2A（对外互操作）」两节 | ✅ 本次 |
| `docs/10_规范/[DESIGN-A2A-002] A2A 标准协议适配规范.md` | 文中引用历史错误命名作为对照 | 已带豁免标记，保留为反例 | ✅ 本次 |
| 代码注释 | `a2aRegistry.js` 等文件头自述「A2A Registry」 | P2 随改名同步修正为「ACP Registry」 | ⬜ P2 |

---

## 5. 守卫

```bash
npm run check:protocol-naming            # 全仓
node scripts/ci/check-protocol-naming.js --json
```

守卫检查项：

| 规则 | 检查 | 严重度 |
|------|------|--------|
| NAM-A2A-1 | `a2a.<域>.<动作>` 方法名出现在无豁免标记的文件中 | error |
| NAM-A2A-2 | 出现 `a2aEnvAllowlist` 之外的新 `KHY_A2A_*` 环境变量 | error |
| NAM-A2A-5 | `contracts/a2a/**` 中出现私有 ACP 方法名或私有状态名 | error |
| NAM-A2A-3 | 描述私有方言的文档标题/首段缺「私有」「进程内」限定词 | warning |
| 一致性 | `acpTransport.ACP_METHODS` 与 `contracts/acp/acp-message.schema.json` 的 enum 不一致 | error |

**豁免标记格式**（必须带理由）：

```html
<!-- naming-guard: exempt 记录历史错误命名，实现中不存在 -->
```

---

## 6. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-15 | 首版：术语表、五条命名规则、重命名映射表与三步过渡策略、文档纠正清单、守卫 |
