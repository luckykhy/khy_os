<!-- 文档分类: DESIGN-ARCH-005 | 阶段: 设计 | 原路径: docs/架构/agentfs-智能体文件系统.md -->
# AgentFS — 智能体文件系统

> 借鉴自 DesireCore AgentFS（见 [KHY 对比 DesireCore 借鉴分析](../08_MGMT_项目管理/%5BMGMT-RPT-002%5D%20khy-对比-desirecore-借鉴分析.md) 第 1 点）
> 状态：Phase 1（存储层 + git 版本化 + 分层加载 + `khy companion` CLI）+ Phase 2（接入系统提示词）+ 五类资产模型（借鉴 #2：`assets`/`receipts` 视图 + receipts 关联 companion）均已落地。

## 是什么

AgentFS 把**一个智能体**收敛成**一个目录**，并让该目录成为**它自己的 git 仓库**。智能体的人格、红线、记忆、技能、工具权限、心跳清单都是这个目录里的文件，可 diff、可回溯、可独立备份/还原。

Khy-OS 此前已是「文件即真相」（persona/memory/skills/agents 都是文件），但分散且全局：无每-agent 分组、无 git 版本化、无分层加载。AgentFS 补上这三点。数据库里没有任何 agent 表，所以这是纯新增的文件子系统，不涉及 DB 迁移。

## 目录布局

存储根：`<dataHome>/agents/<id>/`（默认 `~/.khy/agents/<id>/`）。

```
~/.khy/agents/<id>/
  agent.json          # 元数据 {id,name,description,model,schema,version,createdAt}
  persona.md          # 他是谁（复用 personaService 的默认模板作初值）
  principles.md       # 红线 / 不可逾越（永不被自动学习或自我进化覆写）
  memory/MEMORY.md    # 记忆索引（沿用 memdir 的 MEMORY.md 约定）
  skills/             # 每-agent 技能（manifest.json + prompt.md 约定）
  workflows/          # SOP 占位
  tools/permissions.json  # 每-agent allow/ask/deny 占位（暂不强制执行）
  heartbeat/HEARTBEAT.md  # 心跳巡检清单模板
  .git/               # 每个 agent 独立 git 仓库
```

`id` 校验：`^[a-z0-9][a-z0-9_-]{0,63}$`，并在解析后断言路径未逃出 agents 根（双重防穿越）。非 ASCII（如中文）名称需用 `--id` 显式指定英文 id。

## 分层加载 L0 / L1 / L2（核心）

记忆/技能会随时间膨胀，全量塞进上下文很费 token。`loadLayered(id, level)` 返回**累积式**视图，让调用方按 token 预算选层：

| 层 | 内容 | 何时用 |
|----|------|--------|
| **L0 身份**（永远） | agent.json 摘要 + persona 首个标题块 + principles 红线 | 始终注入，最小 |
| **L1 摘要** | L0 + memory 索引 + 技能目录与描述 + heartbeat 是否启用 | 需要概览时 |
| **L2 全量** | L1 + 完整 persona + 全部 memory 文件 + 技能 prompt + workflows | 真正深入时 |

返回 `{level, text, bytes}`。实测：一个新建 agent L0≈400 bytes，加一条记忆后 L2≈1650 bytes —— 层级越低体积越小。

## git 版本化

- 每个 agent 目录 `createAgent` 时 `git init` 并提交首个快照；之后每次 `writeAsset` 自动 `git add -A && commit` —— 天然 per-agent 可回溯。
- 提交身份固定为 `khy <khy@local>`，不依赖、不污染用户全局 git 配置；关闭 gpgsign。
- `history(id)` 解析 `git log`；`revertTo(id, commit)` 用 `git restore` 回到历史版本再提交。
- **优雅降级**：git 不存在时（ENOENT）仍可正常读写文件，只跳过版本化并告警一次。

## CLI

命令 `companion`（中文别名 `同伴` / `数字同伴` / `智能体仓库`）。**故意不复用 `agent`** —— 后者已是交易预测统计 + 子代理 runner，语义会打架。

```
khy companion create <name> [--id <id>] [--desc <文本>] [--model <id>]
khy companion list
khy companion show <id> [--level L0|L1|L2]   # 默认 L0，演示分层
khy companion history <id> [--limit <n>]
khy companion path <id>                       # 打印目录，便于手动编辑
khy companion assets <id>                     # 五类资产视图（见下）
khy companion receipts <id> [--limit <n>]     # 该同伴的行动回执
khy companion use <id>                        # 设为当前激活同伴
khy companion unuse                           # 取消激活
khy companion active                          # 查看当前激活同伴
```

## 五类核心资产模型（借鉴分析 #2）

借鉴 DesireCore，把一个同伴拆成五类**可独立治理**的资产。`ASSET_MODEL`（`agentFsService.js`）是单一事实源，`describeAssets(id)` 返回每类的存在性 / 文件数 / 字节数（纯只读，缺文件不抛）。

| 资产 | AgentFS 落点 | 说明 |
|------|------|------|
| Persona（人格） | `persona.md` + `principles.md` | 他是谁 + 红线 |
| Playbook（行为手册） | `workflows/` | SOP / 边界（scaffold 时为空目录） |
| Memory（记忆账本） | `memory/` | 记忆索引与明细 |
| Tool Body（工具身体） | `tools/permissions.json` + `skills/` | 能做什么 + 权限 |
| Receipts（行动回执） | receiptService（按 `companionId`） | 做过什么——证据链 |

Receipts 是**外部资产**：不落在 agent 目录，而是 `receiptService` 的回执按 `companionId` 关联。`startReceipt(ctx)` 默认取当前激活同伴（`getActiveAgentId()`），`listReceipts({companionId})` 过滤。`companion receipts <id>` 即基于此。回执 JSON 顶层新增 `companionId` 字段，向后兼容（旧回执为 null）。

## 接入系统提示词（Phase 2）

「激活态」由一个指针文件 `<dataHome>/agents/.active.json`（`{"id":"<id>"}`）记录。

- `khy companion use <id>` 写指针；`unuse` 删指针；`active`/`list`(● 标记) 查看。
- 当有激活同伴时，系统提示词新增一个 **`# Active Companion`** 段，注入该同伴的 **L1** 分层上下文（身份 + persona 首块 + 红线 + 记忆索引 + 技能目录）。明确声明：项目指令与用户显式请求优先，红线不可逾越。
- **无激活时该段为 `null`，提示词与改动前逐字节一致 —— 零回归。**
- 缓存失效：段的 cacheKey = `activeStamp()`，绑定「激活 id + 其身份文件的 mtime/size」，切换同伴或编辑其 persona/红线/记忆时自动刷新。
- 代码：`agentFsService.companionPromptSection()` / `activeStamp()`；`prompts.js` 的 `getCompanionSection()` 与 `systemPromptSection('companion', …)`（紧随 `persona` 段之后）。

> 注：现有全局 `persona.md` / `memory/` 段保持不变，与激活同伴段**并存**。这是附加式接入，不改写既有 builder。

## 代码位置

- 服务：`services/backend/src/services/agentFs/agentFsService.js`
- CLI handler：`services/backend/src/cli/handlers/companion.js`
- 接线：`router.js`（`case 'companion'`）、`commandSchema.js`、`aliases.js`
- 系统提示词：`src/constants/prompts.js`（`getCompanionSection` + `companion` 段）
- 测试：`services/backend/tests/agentFsService.test.js`

## 非目标（留待后续）

- 不把现有全局 `persona.md` / `memory/` / `permissions.json` 迁入 AgentFS（两者并存）。
- `tools/permissions.json` 仅 scaffold，不做每-agent 权限强制执行。
- 激活同伴的 `model` 字段尚未自动切换实际调用模型（仅作元数据/提示词展示）。
