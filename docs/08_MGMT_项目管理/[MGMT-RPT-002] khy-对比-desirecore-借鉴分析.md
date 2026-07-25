<!-- 文档分类: MGMT-RPT-002 | 阶段: 项目管理 | 原路径: docs/khy-对比-desirecore-借鉴分析.md -->
# KHY OS vs DesireCore — 委派式 Agent OS 借鉴分析

> 分析日期：2026-06-09
> 对标对象：DesireCore 文档站（Docusaurus 3.9，i18n zh-Hans 默认；产品定位「委派式交互的 Agent 操作系统」）
> 目的：从 DesireCore 的产品架构中提取 KHY OS 可借鉴的设计，按**对 KHY 的价值从高到低**排序，并标注 KHY 现状与真正的增量

---

## 0. DesireCore 是什么

一个定位「Agent OS / 委派式交互的智能体操作系统」的桌面竞品。核心叙事：**让 AI 从「没记忆的临时工」进化为「可培养、可托管、可治理的智能体」**，交互范式由 `人问 AI 答 → 人教 AI 做事`、`Interaction → Delegation`。

本分析仅基于其公开文档（11 篇核心概念 + 教学/记忆/自动化/安全功能文档），属只读对标，未改动 KHY 任何代码。

---

## 第一梯队 · 架构级，能改变 KHY 形态

### 1. AgentFS — 文件驱动的智能体存储，每个 agent 一个 git 仓库 ⭐最高价值 ✅ 已落地

布局（受 Linux FS 启发）：

```
~/.desirecore/
  users/<user>/...              # 用户间隔离
  agents/<id>/
    agent.json                  # 元数据
    persona.md                  # 人格
    principles.md               # 原则/红线
    memory/                     # 记忆账本
    skills/                     # 技能
    workflows/                  # 流程
    tools/                      # 可调用工具与权限
    heartbeat/HEARTBEAT.md      # 巡检清单
```

- **每个 agent 本身就是一个 git 仓库**，并用 **L0/L1/L2 分层加载**省 token。
- **为什么高价值**：把「智能体的人格/规则/记忆/技能」从数据库行变成**可版本化、可 diff、可回滚、可导出的文件资产**。KHY 已有 owner 密钥治理、receipts、rewind，但 agent 状态多半还在 DB 里。一旦落成文件 + git，KHY 刚完成的「加密源码快照 + `khy restore`」机制可天然复用到「智能体资产的备份与还原」。
- **KHY 增量**：引入「每个 agent = git repo」+ L0/L1/L2 分层加载，直接缓解长记忆膨胀与上下文成本。

### 2. 五类核心资产模型 ✅ 已落地

把一个智能体明确拆成五份独立可治理的资产：

| 资产 | 含义 |
|------|------|
| Persona（人格档案） | 智能体是谁——风格、语气、价值取向 |
| Playbook（行为手册） | 怎么做事——SOP、规则、边界 |
| Memory（记忆账本） | 记住什么——事实、偏好、上下文 |
| Tool Body（工具身体） | 能做什么——可调用工具与权限 |
| Receipts（行动回执） | 做过什么——证据链与可回滚点 |

- **为什么高价值**：极清晰的心智模型与目录契约。KHY 散落的「系统提示/规则/记忆/工具权限/审计」可借这个五分法收敛成统一 schema。Receipts KHY 已有，缺的是把前四类同样资产化。

### 3. 三层可控性 = 可见 / 可控 / 可逆（信任阶梯）

- **L1 可见**：实时状态 + 决策依据 + 文件 diff + 工具调用全透明。
- **L2 可控**：`allow / ask / deny` 权限分级 + 实时中断 + 人闸门。
- **L3 可逆**：Patch 级 / Turn 级 / Session 级三级回滚 + 版本快照。
- 三层缺一不可（只可见不可控=被迫旁观；只可控不可逆=犯错代价大；只可逆不可见=不知何时该救）。
- **为什么高价值**：可直接当**产品验收标准**。KHY 已有 rewind/undo（对应 L3），值得对标补齐的是**决策来源追溯**（「为什么做这步」→追溯到你哪条指令）和 **Patch/Turn/Session 三级回滚粒度**。

---

## 第二梯队 · 可控性/委派模型，直接可落地

### 4. 固化 / 灵活 / 人闸门 三类步骤 ✅ 已落地

每个执行步骤打标签：**固化**（规则确定、像程序执行）/ **灵活**（需 AI 判断）/ **人闸门**（必须人确认才继续）。在计划阶段就标注（如合同审查：`[固化]检查违约金比例` … `[人闸门]生成报告等确认`）。

- **为什么高价值**：用极轻的三态标签同时表达「自动化程度」与「卡点位置」，让同一条 workflow 里高危步骤自动暂停。KHY 任务编排可直接引入这个枚举。

### 5. 六原语：教 / 演 / 问 / 立 / 做 / 复 ✅ 已落地（教学分流）

| 原语 | 发起方 | 含义 |
|------|--------|------|
| 教 Teach | 人 | 告诉怎么做、为什么、例外 |
| 演 Demonstrate | 人 | 给示例/反例，让其模仿归纳 |
| 问 Clarify | agent | 主动追问缺失信息 |
| 立 Plan | agent | 给计划、拆步骤、标风险点 |
| 做 Execute | agent | 在权限边界内执行 |
| 复 Reflect | agent | 提交回执、复盘、写回手册 |

- 关键是**教学意图 vs 委派意图的自动识别**：「以后邮件都用正式语气」→写规则不执行；「帮我写周报」→直接委派。
- **为什么高价值**：把「对话」升级成「培养 + 委派」的方法论骨架。最实用的是**意图自动分流**（教学 / 单任务 / 复杂编排三通道），KHY 入口路由可借鉴。

> **落地（2026-06）**：`intentGate.detectTeaching()` 在 chat() 入口（紧接问候极速路径后）识别教学意图并分流——人格（「你是…」）→ `persona.md`、红线（「绝不…」）→ `principles.md`、偏好（「以后…」）→ `memory/MEMORY.md`，写入**当前激活同伴**的 AgentFS 资产并由 git 自动快照；任务动词（「帮我写…」「run…」）优先判定为委派，照常进入工具链。`teachingService.captureTeaching()` 负责追加；无激活同伴时不静默丢弃，提示先 `companion use <id>`。开关 `KHY_TEACH_GATE=off` 可关闭，plan-step 跟进（`_isFollowUp`）与 study 模式豁免。测试：`intentGate.teaching.test.js`、`teachingService.test.js`。

### 6. 四级风险分级 + 「允许并记住」+ AI 自主审批 ✅ 已落地（学习型自动审批）

- 风险四级：低（只读，自动）/ 中（改数据，弹确认）/ 高（Shell、批量改、Git，详细确认 + 来源追溯）/ 关键（不可逆，醒目警告，部分预设直接阻止如改 `.env`、`rm -rf`）。
- **来源追溯**：确认框含「为什么 agent 要执行这个操作（追溯到你哪条指令）」。
- **「允许并记住」**沉淀为权限规则；**AI 自主审批**从历史审批习惯学习、自动放行低风险常规操作（类比垃圾邮件过滤），高/关键风险永不可自动化；可按风险等级 / 操作类别 / 按 agent 三维配置。
- **为什么高价值**：KHY 已有 owner 密钥与危险操作拦截，可借鉴的是这套**渐进式审批 UX**——从用户行为学习、逐步减少打扰，同时守住高危卡点。

> **落地（2026-06）**：四级分级（`riskGate`）、「允许并记住」（`permissionStore` forever 规则）、关键红线不可覆盖（`toolCalling` `criticalGate`，yolo/dangerous/历史 remember 都拦不住）此前已有。本次新增 **AI 自主审批** = `approvalLedger.js` 学习账本：记录每个工具 key 的历史批准/拒绝；`permissionStore.check()` 在会话授权之后加一层 `shouldAutoApprove`。**安全护栏（硬编码）**：默认关闭（需 `KHY_AUTO_APPROVE=on` 显式 opt-in）；仅 safe/低风险且**非破坏性**可学习；批准 ≥ 阈值（默认 3，`KHY_AUTO_APPROVE_THRESHOLD` 可配）且**零拒绝**才放行；**一次拒绝即清零信任**；关键红线仍由 `criticalGate` 兜底，学习层的 allow 在 critical 时被忽略；账本写盘 best-effort，不可用即降级为照常 ask。CLI：`security approvals`（查看 / `reset` 清空）。来源追溯（确认框追溯到用户指令）散落多处，**留作后续**。测试：`approvalLedger.test.js`、`permissionStore.learned.test.js`。

---

## 第三梯队 · 记忆与自动化机制，中等价值

### 7. 三域记忆：核心 / 关系 / 共享

- **核心记忆**：出厂人格，全用户共享、交互不改。
- **关系记忆**：你与某 agent 的私密「日记」，带类型标签 `preference / fact / decision / commitment / milestone / lesson`。
- **共享记忆**：跨 agent，写入需明确同意。
- **价值**：记忆**带类型标签 + 按「域」分权限**比单一记忆池精细。KHY 已有记忆系统，可借鉴这套**类型枚举**与**关系域私密 / 共享域需授权**的边界。

### 8. Auto Dream 无损遗忘

后台周期性「做梦」：扫描 → 关联 → 提炼 → 重组，把 20 条零散记忆合并成 1 份结构化画像，**原始记忆保留在版本历史可回溯**（不是删除，是整理书架）。生命周期 `活跃 → 近期 → 归档 → 💤Dream → 压缩 → 清理`，可 Pin 保护。

- **价值**：解决长期记忆膨胀的优雅方案；若引入 AgentFS（第 1 点），Dream 可作为其记忆压缩层。关键设计点是「无损 + 可回溯来源」。

### 9. 心跳监控（Heartbeat）✅ 已落地

`HEARTBEAT.md` 定义巡检清单，支持清单模式与带 `interval` 的任务模式；agent 定期主动看邮箱/CI/日历，无变化静默（绿色 pill），有事才通知；24h 去重；**通知只提醒，真要执行操作仍走审批卡片**（心跳不绕过确认）。

- **价值**：把「被动等指令」变「主动巡检」的轻量实现，纯文件配置。KHY 已有 node-cron，可借鉴**`.md` 声明式巡检 + 静默/通知二态 + 不绕过审批**的产品约定。

> **落地（2026-06）**：调度引擎（`heartbeatRunner` 相位对齐 + 洪泛保护、`heartbeatCooldown` intent 矩阵）与 AgentFS `heartbeat/HEARTBEAT.md` 资产/种子模板此前已移植但**从未接线**。本次新增**巡检主干** `heartbeatService.js`：`parseChecklist()` 解析当前激活同伴的 `HEARTBEAT.md`（活动条目 = 非注释的 `- …`；种子全为 `# - …` 注释 → 未启用）→ `## 数据源` / `## 判断标准` 两段；`patrol()` 产出**静默/通知二态**，事件经 **24h 去重账本**（`getDataDir('heartbeat')/events.json`，仿 `approvalLedger`）过滤。**安全不变量**：静默优先（无清单/全注释/无 findings → silent）；同一事件 key 24h 内只提醒一次；**心跳绝不绕过审批**——本服务只返回提醒数据、**无任何 execute/run-tool 能力**（测试断言导出面不含此类），任何操作仍走 #6 的 `permissionStore`/`criticalGate`；去重写盘 best-effort，失败 fail-open（至多重复提醒，无害）。**不伪造邮箱/CI 集成**——真实数据源探针留可插拔接缝（caller 传 `findings`）。开关 `KHY_HEARTBEAT=off` 整体关闭。CLI：`companion heartbeat [status|run|reset]`（`run` 为 dry-run 演示静默态）。测试：`heartbeatService.test.js`（11 例）。

### 10. 智能任务编排引擎

「项目经理」模型：意图识别 → 任务拆解（分析依赖、自动判定并行/串行）→ 能力自动匹配（技能标签 + 历史表现 + 当前负载）→ 全程状态追踪（超时/失败自动重分配）→ 汇总回执。固化模式（SOP）与灵活模式（AI 动态规划）可混用。

- **价值**：多 agent 协作的完整心智模型。KHY 多为单 agent 场景，可单独摘取**自动并行/串行依赖判定**与**汇总回执**。

---

## 第四梯队 · 理念/叙事，低直接价值

### 11. 命名与定位叙事

DesireCore = Desire（沉淀用户长期意愿）+ Core（核心运行时）。叙事：临时工 → 可培养/可托管/可治理的智能体；「数字同伴 vs 工具」对比 ChatGPT/Zapier/LangChain/UiPath。仅作产品叙事参考。

### 12. BYOK 算力模型

不产模型、只连接管理 20+ 供应商；自带 Key、供应商直接结算、随时切换、不锁定；default 映射 `chat/fast/reasoning/vision/embedding/tts/asr` 按服务类型选模型。

- **说明**：KHY 已有 AccountPool/Gateway/账号池，**基本已具备**，价值最低，仅 default 服务类型映射表可参考。

---

## 结论（决策建议）

> **优先投入前三点**：AgentFS（文件 + git 化的智能体资产）、五类核心资产模型、三层可控性框架——能改变 KHY 的存储与治理形态，且可复用刚做完的「加密快照 + `khy restore`」机制。
>
> **第二梯队**（三态步骤、六原语意图分流、渐进式审批）是低成本高回报的 UX 借鉴。
>
> 其余多数概念 KHY 已有雏形（receipts、rewind、记忆、账号池），抄具体设计点即可，不必照搬整套。

---

## 相关文档

- [竞品情报图谱](%5BMGMT-RPT-016%5D%20竞品情报图谱.md)
- [KHY OS vs Hermes Agent — 成长型架构](%5BMGMT-RPT-003%5D%20khy-对比-hermes-成长架构.md)
- [KHY OS vs OpenAgent — 交付差距](%5BMGMT-RPT-004%5D%20khy-对比-openagent-交付差距.md)
- [KHY OS vs Qwen Code — 差距分析](%5BMGMT-RPT-005%5D%20khy-对比-qwen-code-差距分析.md)
- [智能体操作系统路线图](%5BMGMT-PLAN-006%5D%20智能体-操作系统-路线图.md)
