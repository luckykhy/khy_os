# [DESIGN-MEM-007] 记忆规则系统总纲：触发、方式、类型、层级与回忆

> **状态**：提案（待评审拍板）
> **范围**：khy-os 记忆系统的行为规则总纲 —— 写入触发、记录方式、类型判定、层级与过期、回忆触发与冲突优先级
> **真源关系**：本文**不推翻**任何既有真源，只做三件事：① 给 000–006 画覆盖面地图（指针化）；② 补齐唯一真缺口「回忆触发与冲突优先级」；③ 把散在四处的判据收敛成互相不重叠的可执行规则（MR-\*）。
> **上游依赖**：`[DESIGN-MEM-001]`（格式/生命周期）、`[DESIGN-MEM-002]`（时机）、`[DESIGN-MEM-006]`（治理真源，MEMORY-001~004）、`MEMORY-RECORD-SCHEMA.json`、`services/backend/src/services/memoryTrigger.js`、`services/backend/src/memdir/memdir.js`

---

## 0. 一句话结论

仓库的记忆体系**地基已齐、缺的是屋顶**：捕获触发（`memoryTrigger.js`）、格式（001 §2）、层级（001 §1.2 三层）、治理五字段（006 §2）都已存在且各有守卫，但「**什么时候该想起来去查记忆**」和「**两条记忆打架听谁的**」没有任何文档定义 —— 这两块是本提案的主体；其余四块以收敛和判据化为主，不新建并行真源。

### 覆盖面矩阵（用户五问 vs 现状）

| 需求 | 现有覆盖 | 缺口 | 本文处理 |
|---|---|---|---|
| 1. 写入触发时机 | 002 §2 八时机（示例式）；`memoryTrigger.js` explicit/proactive/none 三态（已接线） | 缺「不写」门控的硬规则与判定顺序 | §3.A（W 系列，收敛+补门控） |
| 2. 记忆方式 | 001 §2 frontmatter 格式；006 §2 五字段；memdir 写入单点 | 两套格式各自适用边界没人写；写入流程四步没串起来 | §3.B（F 系列） |
| 3. 记忆类型判断依据 | 001 §1.1 四语义类型；`memoryTrigger.js` INSTRUCTION 分支 | 「用户四类诉求 → 类型/落点」的路由表不存在；工作标准误入记忆无判据 | §3.C（T 系列） |
| 4. 记忆层级与过期 | 001 §1.2 三层 + 保鲜天数 + 蒸馏；006 §1/§4 session/persistent 治理二分 | 两个轴（持久化 × 治理）正交关系没说清；「五层级」诉求的映射没有 | §3.D（L 系列，映射不扩枚举） |
| 5. 回忆触发与冲突优先级 | env 门存在（`KHY_PROACTIVE_MEMORY` / `KHY_MEMORY_SESSION_PRIME`）但**无任何规则文档** | **完全缺失** —— 本文主要增量 | §3.E（R 系列，全量新增） |

---

## 1. 现状实证（file:line 可复核）

| # | 事实 | 证据 |
|---|---|---|
| 1 | 捕获侧分类器已存在且是纯叶子单一真源：explicit（必须捕获）/ proactive（高精度白名单）/ none 三态；层级推断 permanent/short_term/cross_session；同 topic key 走 `decideUpdate` 原地 supersede | `services/backend/src/services/memoryTrigger.js:1-31`（文件头自述契约） |
| 2 | 项目级约定已单独分支路由到**指令文件**而非个人记忆库 | `memoryTrigger.js:89-101`（`INSTRUCTION_RE` 白名单与注释） |
| 3 | 捕获侧三道 env 门默认开：`KHY_MEMORY_TRIGGER` / `KHY_PROACTIVE_CAPTURE` / `KHY_INSTRUCTION_CANDIDATE` | `memoryTrigger.js:38-66` |
| 4 | 记忆写入单点 seam 存在：`saveMemory` / `deleteMemory` / `updateMemoryIndex`，原子写走 `memoryWriteSafety` | `services/backend/src/memdir/memdir.js:344,414,440`；`MEMORY-RECORD-SCHEMA.json` `observed.canonicalWriteSeam` |
| 5 | 存在**实测绕过 seam 的裸写**（AI 直接产出整个 MEMORY.md） | `MEMORY-RECORD-SCHEMA.json` `observed.bypassWrites`：`assistant/autoDream.js:214,248,256`、`memoryEngine/distiller.js:293,309,443` |
| 6 | 治理侧五字段 + 指定入口 + 禁止清单已是登记规则，两条 enforced、一条人工兜底 | `[DESIGN-MEM-006]` §1–§4；`MEMORY-RECORD-SCHEMA.json` `enforcementPlan.items[0].status="enforced"`、`items[2].status="not-enforced"` |
| 7 | 回忆侧 env 门被消费（会话 prime / 主动回忆层） | `services/backend/src/cli/aiChatCore.js` 中 `KHY_PROACTIVE_MEMORY` / `KHY_MEMORY_SESSION_PRIME` 引用（Grep 实测命中） |
| 8 | 「重启后 session 残留禁升格」判定无检查器，靠人工评审 | `MEMORY-RECORD-SCHEMA.json` `enforcementPlan.items[2].reason` |
| 9 | **执行面现状：`saveMemory` 只校验 type 枚举（throw）；tier 非法被 `_normalizeTierOption` 静默丢弃；无凭据检查、无正文最小长度校验、无 MR-W0 类门控** | `services/backend/src/memdir/memdir.js:344-348`（type throw）、`:366-367`（tier 归一化注释「仅在显式提供且合法时写入，否则留空」） |
| 10 | **`deleteMemory` 是裸 `fs.unlinkSync` 硬删，无归档动作** —— 与本文 MR-F4「忘记=归档」在实现层矛盾 | `memdir.js:414-432`（`:422` unlink） |
| 11 | **记忆捕获侧测试基线（实测 2026-09-23）**：7 文件 `node --test` 共 **56 条，54 绿 / 2 红**；红 = `tests/services/memoryTier.test.js:20` 与 `tests/services/memoryTrigger.test.js:17` 裸 `beforeEach`（jest 风格落进 node --test 全量扫描，B 类历史欠账，非本提案引入） | 实测输出 `# tests 56 / # pass 54 / # fail 2`；失败栈 `ReferenceError: beforeEach is not defined` |

**由 #9–#11 得出的核心判断（本节是 §3.F 的立论）**：MR-W~R 是写给「调用方/模型」的行为规则，但**行为规则不可能靠自觉遵守** —— 现状除 type 枚举一处 throw 外，规则在执行面上零依托；连捕获侧单一真源都没有一套全绿的测试。遵守方法必须分层设置，见 §3.F。

---

## 2. 借鉴提案（B-P2 七字段）

**不适用。** 依据：本提案是对本仓既有能力域（`memoryTrigger.js` / `memdir.js` / DESIGN-MEM-000–006）的规则收敛与缺口补全，**不借鉴任何外部项目**，无上游 commit、无许可证问题，走 `[SOURCING-001]` B-P1「已登记能力域内的行为修正/规则化」路径，无需填七字段。

---

## 3. 规则正文（MR-\*）

> 规则编号空间：`MR-W`（写入触发）、`MR-F`（记录方式）、`MR-T`（类型与落点）、`MR-L`（层级与过期）、`MR-R`（回忆与冲突）。
> 每条规则 = 陈述 + 判据 + 动作。规则间引用一律指编号，语义不重复。

### A. 写入触发（何时写）

**MR-W0（禁写门控，先于一切触发判定）**
一条信息命中以下任一情形，**禁止**进入任何持久记忆（含 `.khy/memory/` 与 `.ai/`）：
- 一次性命令输出、临时 diff、调试过程细节（真源：`[DESIGN-MEM-006]` §1 禁止行 + `MEMORY-RECORD-SCHEMA.json` `prohibitedWrites`）；
- 含凭据**值**（key/密码/token —— 只允许引用存放位置，真源：006 §2 凭据条款）；
- 无可溯来源（给不出 source：文档编号 / 文件路径 / 命令输出引用，同 006 §2 五字段要求）；
- 仅对当前任务有意义的中间状态（→ 属 session，见 MR-L1）。
判定顺序上 MR-W0 是**第一闸**：先判不写，再判写往哪。

**MR-W1（用户显式要求 → 必须写，权威不打折）**
用户消息命中显式记忆意图（「记住 / 别忘 / remember this」等，与 `memoryTrigger.js` `EXPLICIT_RE` 同口径）⇒ 必须捕获，type/tier 按用户措辞推断（「永久/永远」→ permanent；「这次/临时」→ short_term；其余 → cross_session，与 `memoryTrigger.js:19-22` 层级推断一致）。用户说「忘掉 X」⇒ 对 X 执行归档（不是硬删，见 MR-F4）。

**MR-W2（用户纠正行为 → 泛化才写）**
用户纠正 AI 的行为（「不要用英文注释」）⇒ 若纠正可泛化为稳定偏好（含「以后/别再/from now on」语气，对齐 `FEEDBACK_RE`）⇒ 写 feedback 类；若只针对本次输出（「这句改一下」）⇒ 只改当次，不写。

**MR-W3（重复模式 → 三次成文）**
同一偏好、同一问题模式、同一纠正**出现 ≥3 次**而未被前两条捕获 ⇒ 写入，description 里注明「依据 N 次重复归纳」。不足 3 次不写（保守偏向，对齐 `memoryTrigger.js` proactive 层的零假阳性纪律）。

**MR-W4（关键进度节点 → 不进个人记忆）**
任务完成、方案拍板、版本定名、决策变更等进度节点 ⇒ **路由规则见 MR-T3**：落 `.ai/hq/PROGRESS.json` 或决策文档，不落 `.khy/memory/`。触发判定属于本条，落点判定属于 MR-T。

**MR-W5（工作标准/项目约定 → 指令文件或规范，不进个人记忆）**
内容属于「项目级长期约定 / 规范 / 构建/提交/测试命令 / 协作方式」（对齐 `memoryTrigger.js:89-101` `INSTRUCTION_RE` 白名单）⇒ 写入指令文件（khy.md / agent.md）或 `docs/10_规范/`，让它们注入系统提示或被守卫执行；个人记忆文件最多存**指针**（MR-T2）。

**判定顺序（A 系列总流程）**：`MR-W0 门控 → W1（显式）→ W2（纠正）→ W3（重复）→ W4/W5（进度/约定，交 T 系列路由）→ 都不命中 = 不写`。此顺序与 `memoryTrigger.js` 的 explicit → proactive → none 求值方向一致，不引入第二套触发器。

### B. 记忆方式（格式、组织、写入流程）

**MR-F1（两套格式的适用边界，互斥）**
- 记录给 **AI 日常回忆**用、存 `.khy/memory/` ⇒ 用 001 §2 frontmatter 五项（`name` / `description` / `type` / `tier` / `updated`）；
- 记录是**治理/协作事实凭证**、落 `.ai/` 或跨机共享存储 ⇒ 用 006 §2 治理五字段（`subject` / `source` / `writtenAt` / `scope` / `cleanup`）。
判据一句话：**「回忆用 frontmatter，凭证用五字段」**。一份记录不得同时只带半套字段；两边都不是的（纯过程数据）回 MR-W0 拒绝。

**MR-F2（写入必经指定入口，禁止裸写）**
- `.khy/memory/` 读写删：一律经 `memdir.js` seam（`saveMemory:344` / `deleteMemory:414` / `updateMemoryIndex:440`），享受原子写（`memoryWriteSafety`）；
- `.ai/` 机器文件：一律经 `khy metadata gen / refresh / link`（006 §3 指定入口表）；
- 新增记忆持久化模块：先在 `MEMORY-RECORD-SCHEMA.json` `designatedEntries` 加行登记，再动码（006 §3 登记规则）。
已知违例 `autoDream.js` / `distiller.js` 裸写为**存量债**，处置见 §4 分期 S3，不因存量违例放松本条。

**MR-F3（写入四步，顺序固定）**
① 查重：与既有记录比 token Jaccard，≥0.82 视为重复 → 归并到较强者（001 §2.3/§3.3 同阈值）；
② 定型定层：按 MR-T 定 type、按 MR-L 定 tier；
③ 经 MR-F2 入口写入；
④ 经 `updateMemoryIndex` 更新索引。跳步不得写。

**MR-F4（「忘记」= 归档，不是删除）**
任何清理/遗忘动作都走归档（`.khy/memory/.archive/`），persistent 治理记录的删除另留一行台账（006 §4「禁止静默删」）。恢复用既有 `npm run memory:restore`。

### C. 记忆类型与落点路由

**MR-T1（类型判定依据 = 谁消费 + 多久失效）**

| 内容形态 | type | 依据（消费方 × 保鲜） |
|---|---|---|
| 用户身份、核心习惯（「我叫 X」「我习惯先写测试」） | `user` | 个人交互消费；保鲜 3650 天 |
| 交互风格、纠偏、**用户明确要求**（带出处） | `feedback` | 个人交互消费；保鲜 540 天 |
| 项目背景、架构、技术栈 | `project` | 项目上下文消费；保鲜 180 天 |
| 外部链接、文档、API 参考 | `reference` | 按需检索消费；保鲜 365 天 |

与 001 §1.1 四类型一一对应，**不新增类型枚举**。

**MR-T2（用户明确要求的特殊标记）**
「用户明确要求」在类型上归 `feedback`（或身份事实归 `user`），但必须满足：正文含**用户原话或出处**（哪次会话/哪条消息）；未指定 tier 时**默认 permanent** —— 用户亲口要求的事不应被保鲜期自动忘掉。这是它区别于普通 feedback（AI 归纳的、540 天）的唯一判据。

**MR-T3（落点路由表 —— W4/W5 的权威落点）**

| 内容 | 落点 | 为什么不是记忆文件 |
|---|---|---|
| 任务进度、里程碑 | `.ai/hq/PROGRESS.json`（多机共享真源，AGENTS.md「多机协作自举」节） | 进度要跨机器同步，个人记忆目录不在 `.ai/` 共享面内 |
| 决策、方案拍板 | `docs/03_DESIGN_设计/` 提案文档（先提案后编码惯例） | 决策要可评审可追溯，散文记忆守卫管不了 |
| 工作标准、项目约定 | 指令文件（khy.md/agent.md）或 `docs/10_规范/` + RULES-REGISTRY | 标准要被守卫执行；记忆里的规则**没有任何门能执行**（并行真源，见 §6 反模式 2） |
| 用户偏好、明确要求 | `.khy/memory/`（MR-T1/T2） | 只服务于个人交互回忆 |
| 一次性/临时 | 不落任何持久位（MR-W0/MR-L1） | — |

### D. 记忆层级（映射，不扩枚举）

**MR-L1（会话内 = short_term，禁落盘）**
只对当前会话有意义的记忆 = Layer 1 `short_term`：不落盘、会话结束即清除；重启后残留的临时上下文**不得自动升格**为 persistent（006 §4，schema `items[2]` 人工兜底）。「短期记忆」一词即指本层，不另设层级名。

**MR-L2（短期/长期 = cross_session，用保鲜天数表达长短，不造第五层）**
跨会话记忆统一为 Layer 2 `cross_session`，其内部「短期 vs 长期」**用类型保鲜天数区分**（180/365/540 天，001 §1.1），**不新增 tier 枚举值** —— `tier` 字段是 schema 闭合集，加值会同时撞 001 §1.2 与蒸馏阈值体系。

**MR-L3（永久 = permanent，进出都要有出处）**
Layer 3 `permanent` 只收两类：① 用户显式要求（MR-W1/MR-T2）；② 稳定身份事实（`IDENTITY_RE` 同口径）。它**不是**「重要内容停车场」——进入需出处，退出需显式 `cleanup` 触发（006 §4），蒸馏对它几乎不自动过期（001 §3.3）。

**MR-L4（治理轴与持久化轴正交）**
006 的 session/persistent 二分管「是否是协作凭证」，001 的三层管「是否落盘、活多久」。两条轴独立判定，先 MR-L1–L3 定持久化层，再按 MR-F1 决定要不要带治理五字段。典型组合：`.ai/hq` 进度 = persistent + 治理五字段；`.khy/memory` 偏好 = cross_session + frontmatter；会话内草稿 = short_term + 什么都不落。

**过期与清理（D 系列汇总）**：short_term 会话末清除 → cross_session 超保鲜天数经蒸馏归档（001 §3 三阶段做梦/蒸馏）→ permanent 仅显式 cleanup。全程归档不硬删（MR-F4）。

### E. 回忆触发与冲突优先级（全量新增，本文主体增量）

**MR-R1（回忆触发时机 —— 何时必须去查）**

| 触发点 | 动作 | 门 |
|---|---|---|
| 会话启动 | prime 注入 `user`/`permanent` 全量 + 最近 N 条 `cross_session` | `KHY_MEMORY_SESSION_PRIME`（默认开） |
| 回答涉及用户偏好/身份 | 按 description 主题匹配检索，命中即注入候选 | `KHY_PROACTIVE_MEMORY` |
| 执行写操作前 | 检索目标模块相关记忆与约定（防重复犯错、防违反既有决策） | — |
| 用户问「之前/上次/记得吗」 | 显式检索 | — |
| **MR-W0/W2/W3 判定写入前** | **必查**：新信息与已有记忆是否冲突/重复（冲突走 MR-R3，重复走 MR-F3①） | — |

最后一行是新增的**写前必读**义务：现在捕获与回忆两条链路互不知道对方，冲突记忆就是这么堆出来的。

**MR-R2（检索排序 —— 多条命中时先看谁）**
四键排序，依次比较：① scope 匹配度（模块级 > 板块级 > 仓库级，粒度细者先）② type 权重（`user`/permanent > `feedback` > `project` > `reference`）③ `updated` 新鲜度（新者先）④ 相似度（Jaccard 高者先）。前三键平手才比后一键。

**MR-R3（冲突优先级 —— 打架时听谁的）**

| 优先级 | 来源 | 说明 |
|---|---|---|
| P0 | 用户**当前会话**的明确指令 | 最高权威；且应**反写**：若与记忆冲突，更新记忆（MR-R4） |
| P1 | 规范/指令文件（`docs/10_规范/`、khy.md、RULES-REGISTRY） | 文档是真源，记忆是缓存 —— **记忆与文档冲突，文档赢**，防并行真源 |
| P1′ | `.ai/hq` 状态文件 | 多机共享真源，同理压过个人记忆 |
| P2 | 用户显式要求记住的记录（MR-T2，带出处） | |
| P3 | permanent 层记录 | |
| P4 | cross_session：`updated` 新者胜 | 同级冲突新者赢 |
| P5 | 旧 cross_session | 被推翻者归档（MR-R4），不参与后续回忆 |

同优先级且 updated 无法分新旧 ⇒ 保守取「不确定」并向用户求证，**不猜**。

**MR-R4（冲突处置动作 —— 三步，禁止静默）**
① 胜者保留：同 topic key 原地 supersede（对齐 `memoryTrigger.js` `decideUpdate` 既有行为）；
② 败者归档：进 `.archive/`，persistent 记录留一行台账（006 §4）；
③ 反写与提示：P0 反写更新记忆；P1 冲突时提示用户「记忆与规范 X 冲突，已按规范执行，建议修正/归档该记忆」。

### F. 遵守保障（MR-E 系列 —— 规则凭什么被执行）

> 立论：§1 #9–#11。W/T/R 系列里「时机判断」类规则（W2/W3/R1 的语义判断）无法被机器穷尽校验，
> 但**每一条规则都必须至少落进下面四层依托之一，否则从本文删除或降级为「建议」** —— 不允许存在无依托的规则条文。

**四层依托模型（强度递减、成本递增）**：

| 层 | 依托 | 机制 | 覆盖的规则 |
|---|---|---|---|
| E1 | **写入口 fail-closed（最终防线，唯一机械保证）** | 不守规则的写入**落不了盘**：`memdir.saveMemory` 在 seam 处校验，非法即拒 | W0（机械子集）、F1、T1、L2/L3 |
| E2 | **CI 静态守卫** | 检查器扫绕过 seam 的调用点，进 PR gate | F2 |
| E3 | **测试钉住行为** | 分类/层级/排序/优先级语义全部 node:test 断言，CI 全量扫 | W1、L1–L4、R2、R3、R4 |
| E4 | **注入 + 事后清洗（概率性依托，诚实声明）** | 规则注入系统提示/指令文件引导「时机判断」；蒸馏/做梦事后清漏网 | W2/W3、R1（写前必查）、T2/T3 的语义部分 |

**MR-E1（saveMemory 校验闸 —— E1）**
在 `memdir.js` seam 内增加对齐本文规则的写入校验，校验失败**返回 `rejected: true, reason` 并落日志**（S2 期只记录不阻断，对齐 PROCESS-008「S1S2 只记录、S3 才阻断」的阶段纪律），S3 期翻转默认为 fail-closed（throw / 拒写）。校验项（全部机械可判）：
- `type` ∈ 四枚举（已有，`memdir.js:345-348`，保持 throw）；
- `tier` 非法从「静默丢弃」改为记入 reject（对齐 L2：枚举闭合，静默丢弃会让「永久」要求悄悄降级成可过期记录）；
- 正文 ≥ `KHY_MEMORY_MIN_BODY_CHARS`（复用 001 §2.3 既有口径，不新增 env）；
- 凭据 token 命中 → reject（同 `MEMORY-RECORD-SCHEMA.json` `credentialPolicy`，只允许「存放位置」式引用）；
- `description` 为空时回退 name 的现状保留，但 description 与 name 同文且正文超长 → 记 warning（召回质量，非阻断）。
回滚纪律：校验走可选参数 `options.validate`（缺省 = 现行为逐字节相同），**不新增 env 门**（§6.1 棘轮）；翻转默认值前用 `strictEqual(旧行为, 新函数旧参)` 钉住。

**MR-E2（deleteMemory 归档化 —— E1 + R4 的实现修正）**
现状裸 unlink（§1 #10）与 MR-F4 矛盾，以实现为准改实现：`deleteMemory` 先将文件移入 `.khy/memory/.archive/` 再删索引条目；确需硬删由调用方显式传 `options.hardDelete`。归档文件名带时间戳防碰撞。本条是**修实现向规则对齐**，不是改规则迁就实现。

**MR-E3（绕过 seam 检测进 CI —— E2）**
新增 `scripts/ci/check-memory-rules.js`（或并入 `check-memory-schema.js`）：扫 `services/backend/src/**` 中对 `.khy/memory` 路径的 `writeFileSync/unlinkSync` 调用点，必须落在 memdir seam carrier 内 —— 与 `enforcementPlan.items[1]`（`.ai/` 保护路径检测）同构，把 schema `observed.bypassWrites`（autoDream/distiller）从「人工观测记录」升级为「CI 报红」。登记进 RULES-REGISTRY 时按 `[DESIGN-ARCH-111]` 绑定层模式挂 gate，不入 `&&` 硬链。

**MR-E4（测试基线归绿并钉住语义 —— E3）**
- 先还债：将 `tests/services/memoryTier.test.js` 与 `tests/services/memoryTrigger.test.js` 整文件改写为 `require('node:test')` 风格（裸 `beforeEach` → `t.before`/局部装配），消除落地即红；**不得**在 jest 风格文件里追加 node:test 用例（两套 runner 双扫）。
- 基线：改写后 7 文件 ≥ **56 绿 / 0 红**（54 条既有绿不改语义，2 个红文件改写后其断言全部保留）。
- 新增断言：W1 层级推断三例（永久词/临时词/默认）、R2 排序四键各自打破平手、R3 优先级表逐行一例、E1 各 reject 项一例。全部 node:test，前置条件不满足显式 skip。

**MR-E5（LLM 行为规则的注入依托 —— E4，诚实边界）**
W2/W3/R1/T2/T3 的语义判断属「模型判断」，依托 = ①本文 MR 摘要注入系统提示/指令文件（`memoryTrigger.js:89-101` INSTRUCTION 分支同思路：约定类内容进指令文件才有每回合注入）；②E1 fail-closed 兜底 —— 模型时机判断再错，非法写入在 seam 被机械拦截；③蒸馏（001 §3）事后清洗漏网。**明写限制：E4 是概率性依托，不是机械保证；任何一条规则的唯一依托若是 E4，必须在本文 §5 诚实边界里点名。** 现状盘点：W2/W3/R1 的唯一依托即为 E4 —— 接受，但因此它们不进入任何 ERROR 级守卫断言。

### 各系列边界（防重叠声明）

W 系列**只回答「写不写」**；T 系列**只回答「落到哪、什么类型」**；F 系列**只回答「怎么落」**；L 系列**只回答「活多久」**；R 系列**只回答「何时读、谁让路」**；E 系列**只回答「凭什么守」**（执行绑定，不含任何新行为语义 —— E1 校验项全部来自 W/F/T/L 的既有定义，E4 只钉既有行为）。跨系列只引用编号（如 W4→T3、E1→W0），不重复语义。既有真源分工：001 管格式与蒸馏算法、002 管时机示例、006 管治理五字段与指定入口、`memoryTrigger.js` 是捕获侧实现真源 —— 本文对它们全部指针化，未改写任何一条既有语义（唯一例外：MR-E2 修 `deleteMemory` 实现向 MR-F4 对齐，属「实现欠账」而非语义改写）。

---

## 4. 实施分期（每期独立可回滚）

| 期 | 内容 | 验收 |
|---|---|---|
| S1 | 本文评审拍板；登记 `MEMORY-005`（= MR-E1 写入口校验 + MR-E3 seam 绑定，可执行器）/ `MEMORY-006`（= MR-R1 写前必查 + MR-R3 冲突优先级，`gate=manual`，唯一依托 E4 按 MR-E5 点名）；生成规则卡；`MEMORY-RECORD-SCHEMA.json` 补登 `memdir.js` seam 进 `designatedEntries`（原 S4 内容提前，因 E3 检查器依赖该登记） | `npm run check:rules` / `rules:coverage` 通过，无死指针；`check-memory-schema.js` 行为不回退 |
| S2 | 测试归绿：`memoryTier.test.js` / `memoryTrigger.test.js` 整文件改写 node:test（MR-E4 还债）；E1 校验闸落地为**只记录**（`rejected/reason` 返回 + 日志，`options.validate` 可选参数）；E2 `deleteMemory` 归档化 | 7 文件 **≥56 绿 / 0 红**（实测基线 54/56，见 §1#11）；改写前后各跑一次对照零语义漂移；E1 校验项逐条一例断言 |
| S3 | E1 翻转 fail-closed（缺省拒写）；清偿 §1#5 存量债：`autoDream.js` / `distiller.js` 裸写改走 memdir seam；`scripts/ci/check-memory-rules.js` 绕过检测进 gate | 蒸馏/做梦既有测试零回归；`bypassWrites` 观测清零；检查器对 seam 外写点报红 |
| S4 | 回忆接线核对：确认 `aiChatCore.js` 的 prime/proactive 消费点行为与 MR-R1/R2 一致；写路径加「写前检索」钩子；R2/R3 排序与优先级断言补齐（MR-E4 后半） | 手工复现：写入一条与旧记忆矛盾的偏好，观察 supersede 而非堆叠；R3 优先级表逐行测试通过 |

---

## 5. 诚实边界（刻意不纳入）

- **不做语义向量检索**：MR-R2 用 Jaccard + 结构化字段排序，因为现有检索就是词面匹配；上 embedding 是 000 §9.3 的长期计划，本文不抢。
- **不定义记忆的 UI/展示**：只管行为规则。
- **不动 `MEMORY-001~004` 任何语义**：本文是它们的下游消费者。
- **不解决跨设备同步**：000 §9.2 中期计划，与冲突优先级正交。
- **W2/W3/R1 的唯一依托是 E4（概率性）**：按 MR-E5 的盘点如实点名 —— 这三条是模型判断类规则，不接受它们进入任何 ERROR 级守卫断言，也不假装有机械保证；它们的兜底是 E1（非法写入落不了盘）+ 蒸馏事后清洗。

## 6. 反模式（这条路别走）

1. **为「五层级」诉求新增 tier 枚举**（如加 `long_term`）—— `tier` 是闭合集，加值撞 001 §1.2 + 蒸馏阈值 + schema closedSet 三处；「短期/长期」用保鲜天数表达已足够。
2. **把工作标准写成记忆散文** —— 记忆里的规则没有任何守卫能执行；标准进规范/指令文件才有门管（MR-T3），否则就是第二真源，改一处漂一处。
3. **冲突时静默删旧记忆** —— 败者必须归档留台账（MR-R4/006 §4），否则误杀无法恢复（既有 `memory:restore` 是按归档设计的）。
4. **把 permanent 当荣誉勋章乱发** —— 只收显式要求与身份事实（MR-L3）；permanent 垃圾场比没有 permanent 更糟，因为它永不自动过期。
5. **在 `memoryTrigger.js` 之外写第二套触发判定** —— 捕获侧三态分类已是单一真源（§1#1）；本文的 W 系列是它的**规则化表述**，不是新实现。

## 7. 验收方式

- 编号唯一：`DESIGN-MEM-007` 未与既有文档撞号（已枚举 DESIGN-MEM 目录 000–006）。
- 语义零冲突：本文引用 001/002/006 处全部为指针 + 章节号，未复制改写其规则正文；人工对照 006 §1–§4 逐条过。
- 守卫现状：`node scripts/ci/check-memory-schema.js` 在本文落地前后行为不变（本文不改任何被它消费的文件）。
- 测试基线（实测 2026-09-23）：7 文件 `node --test` = **56 条 / 54 绿 / 2 红**（红因 §1#11，B 类欠账）；S2 后 **≥56 绿 / 0 红**，54 条既有绿断言逐条保留。
- E 系列覆盖完备性：§3 各系列每条规则在 §3.F 四层依托表中至少出现一层；唯一依托为 E4 的规则已逐条在 §5 点名。
- S1 落地后：`npm run check:rules` 校验新登记的 MEMORY-005/006 双向可达。

## 8. 待核实项

| # | 项 | 状态 |
|---|---|---|
| 1 | `KHY_MEMORY_*` env 是否全部实际接线 | 已核：`memoryTrigger.js:38-66` 三道捕获门、`aiChatCore.js` 消费 prime/proactive（§1#3/#7）✅ |
| 2 | memdir seam 的行号 | 已核：`memdir.js:344/414/440` ✅ |
| 3 | prime 注入的 N（最近 cross_session 条数）现有实现取值多少、是否可配 | **未核** —— 不阻断 S1/S2 设计，S2 接线核对时确认 |
| 4 | `memoryEngine.addStructuredMemory` 的 `decideUpdate` supersede 行为是否与 MR-R4① 完全一致 | **未核** —— memoryTrigger.js 文件头自述如此（:24-26），S2 时对实现逐行确认 |

## 9. 变更日志

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-09-23 | 0.1 | 初稿：覆盖面矩阵 + MR-W/F/T/L/R 五组规则 + 四期实施计划 |
| 2026-09-23 | 0.2 | 新增 §3.F 遵守保障（MR-E1–E5 四层依托模型）+ §1 实证 #9–#11（saveMemory 仅 type 校验 / deleteMemory 裸删矛盾 / 测试基线 56 条 54 绿 2 红）；分期重排（seam 登记提前至 S1，E1 先记录后阻断）；诚实边界点名 W2/W3/R1 唯一依托 E4 |
