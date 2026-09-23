# [DESIGN-ARCH-036] 万物结构化熔炉引擎

| 项 | 值 |
| --- | --- |
| 文档类型 | 架构设计（ARCH） |
| 适用范围 | `services/backend/src/services/structuredFurnace/` |
| 强制级别 | 设计基线（实现须符合本文「防呆符合性」一节） |
| 上位治理 | [DESIGN-ARCH-034]（动态自适应约束求解）、[DESIGN-ARCH-025]（元规划协议与动态约束注入）、[MGMT-STD-001]（文档结构铁律） |
| 状态 | 定稿 |

---

## 1. 目标

把无序/模糊/异构的自然语言，在触达 Khyos 核心推理与业务逻辑**之前**，强制坍缩为高维、严谨、机器**零损解析**的结构化指令。终结系统处理非结构化数据时的算力浪费与歧义脑补：未经熔炉坍缩的原始自然语言字符串，永远不应出现在业务代码里（违者视为致命级架构违规）。

## 2. 与既有地基的关系（零重复造轮子）

熔炉**不新增约束代数、不复制锁级枚举**，只新增「NL → 结构」的坍缩与铸造层，并把锁级桥接到现成单一真源：

- 约束阶梯单一真源：`metaplan/constraintStrategy.js`（`Prompt_Soft ⊏ Code_Hard ⊏ System_Block` 单调格 + `escalate` 取上确界）。降级与高风险动作的锁级一律经 `escalate` 单调加严，绝不自定义枚举（沿用 [DESIGN-ARCH-034] 桥接先例）。
- 前置拦截接缝：`toolUseLoop.js` 在 `applyIntentGate` 之后挂载 `maybeForgeStructuredIntent`（默认关闭、fail-soft）。

## 3. 三级坍缩协议（§3.2）

输入熵由 `entropyAssessor.assess` 评估，路由到三级坍缩器之一：

| 级 | 触发特征 | 坍缩器 | 产出物 |
| --- | --- | --- | --- |
| **L0 降维打击** | 简单单任务、无依赖（「帮我建个文件」） | `dimensionReducer.reduce` | `ActionIntent`（动作原语 + 目标实体指针 + 原子参数） |
| **L1 意图织网** | 复合、多条件、逻辑依赖（「如果 A 就 B，否则等 C」） | `intentWeaver.weave` | `TaskGraph`（节点 + 有向边 + 条件，DAG） |
| **L2 骨相重构** | 混乱、长文、自相矛盾 | `skeletonReconstructor.reconstruct` | `StateMachine`（状态集 + 转移矩阵 + 矛盾标记） |

动作只能映射到 `forgeSchema.ACTION_PRIMITIVES` 固定表（`CREATE/READ/UPDATE/DELETE/…/UNKNOWN`），映射不中即 `UNKNOWN`，绝不把自然语言动词原样塞进结构、绝不脑补一个动作。

## 4. 晶格铸造规范（§3.3，`forgeSchema.js` 单一真源）

| 铁律 | 校验 |
| --- | --- |
| **原子性** | 每个节点/字段只表达一个不可再分语义；值里残留并列/条件连接词（`并且/然后/如果/and then/…`）即判非原子 ⇒ 本该拆成边或多属性 |
| **无歧义性** | 绝不允许「可能/大概/也许/maybe/probably」等模糊词；抽取阶段 `coerceVagueness` 先把「模糊」这一事实量化为 `confidence`（0.6）并剥离模糊词，校验阶段对残留模糊词一律拒收 |
| **可索引性** | 每个核心实体由 `EntityRegistry` 铸造**全局 UID**（内容寻址 `sha1(归一描述)`，带类别前缀 `file_/proc_/…`）；同一实体多处指代去重为单一拓扑节点，引用只走 UID 指针，绝不重复自然语言描述 |

## 5. 拒损与降级机制（§3.4，`anomalyHandler.js`）

坍缩产出存在死锁/矛盾/缺要素时，`adjudicate` 二选一裁决，**绝不允许模型自行脑补调和**：

| 裁决 | 触发 | 行为 |
| --- | --- | --- |
| **拒损 REJECT** | 硬要素缺失 / DAG 成环（死锁）/ 多处不可调和矛盾 | 抛 `FurnaceRejection`（结构化异常，附 `missing[]`/`conflicts[]` 枚举），强制上层向人类回问澄清 |
| **降级 DEGRADE** | 低置信（`confidence < 0.65`）/ 单处可隔离矛盾 | 不阻断，但标记 `degraded/sandbox/writeLocked`，锁级 `escalate` 至 `Code_Hard` 起步，降级为「沙箱试探执行」并锁定后续写权限 |

## 6. 绝对前置拦截与封印（§3.1，`chaosInterceptor.js`）

`intercept(raw)` 串联全管线（fail-closed）：`assess → 路由坍缩 → forgeSchema 校验 → adjudicate 裁决 → 盖封印`。坍缩器内部任何意外都转为结构化拒损，**绝不把原文泄回业务层**。

产出 `ForgeEnvelope` 带**进程私有 HMAC 封印**（`seal`）。业务侧消费前必须 `assertForged(envelope)` 验封：裸 payload / 缺封 / 篡改一律 fail-closed 抛错——把「只能消费熔炉产物」从约定升级为可校验的硬边界。

## 7. 防呆符合性（§5）

| 防呆 | 落点 |
| --- | --- |
| ① 核心业务逻辑禁碰裸 NL | `assertForged` 拒绝一切未封印输入；`intercept` 是唯一入口 |
| ② 时序/因果必成 DAG 非扁平 | `validateTaskGraph(opts.hadDependency=true)`：含依赖却零边即拒收（`missing:['edges']`） |
| ③ 禁保留定语从句 | `hasRelativeClause` 识别 `的…的`/`which/that` 从句，校验拒收，强制拆为实体属性/关系边 |
| ④ 矛盾不脑补 | 成环 → `DEADLOCK_CYCLE` 拒损；多重矛盾 → `CONTRADICTION` 拒损；`StateMachine` 只**标记**矛盾不调和 |
| ⑤ 实体必带全局 UID | `EntityRegistry.mint` 强制铸造 UID，供跨轮上下文压缩做指针化替换 |

## 8. 交付物

```
services/backend/src/services/structuredFurnace/
  entropyAssessor.js        熵评估与 L0/L1/L2 路由（§3.2）
  entityRegistry.js         实体抽离 / UID 铸造 / 指针去重（§3.3 可索引性）
  taskGraph.js              DAG 数据结构 + Kahn 拓扑排序（死锁检测）
  stateMachine.js           状态机数据结构 + 转移矩阵 + 矛盾标记
  forgeSchema.js            晶格铸造规范与手写校验器（§3.3）
  dimensionReducer.js       L0 降维器：NL → ActionIntent
  intentWeaver.js           L1 织网器：NL → TaskGraph（DAG）
  skeletonReconstructor.js  L2 重构器：NL → StateMachine
  anomalyHandler.js         拒损 / 降级裁决器（§3.4）
  chaosInterceptor.js       绝对前置拦截 + 封印守卫（§3.1，fail-closed）
  index.js                  Coordinator 单一导入面
services/backend/tests/services/structuredFurnace/structuredFurnace.test.js   25 用例
```

接线：`toolUseLoop.maybeForgeStructuredIntent`（默认关闭，`options.structuredFurnace.enabled` 或 `KHY_STRUCTURED_FURNACE=1` 开启；`observe` 仅挂信封/观测，`enforce` 才上抛拒损）。**零侵入既有交互流**，侵入式接管 `executeTool` 留后续 PR。

## 9. 场景验证表（§4.4，高熵输入：传统 vs 熔炉模式）

| 输入 | 传统模式 | 熔炉模式 |
| --- | --- | --- |
| 「如果构建成功就部署，否则回滚并通知运维」 | 一坨字符串进业务逻辑，0 可枚举单元，条件靠模型每轮重读 | `TaskGraph`：节点可枚举、条件边显式（`cond`），实体 UID 指针化 |
| 「先拉取代码，然后构建，接着测试，最后部署」 | 顺序靠 NL 语序隐含，无机器可校验依赖 | `TaskGraph`：`seq` 边链，拓扑可排，依赖机器可校验 |
| 「这个需求挺乱…可能要部署但又先别…你看着办」 | 歧义被静默吞下，模型脑补意图 | 不确定性量化为 `confidence`，单矛盾 → 降级锁写；多矛盾 → 拒损带枚举 |

可管理性核心差异：传统模式 Token 随每轮重读 NL 线性累积、准确率受歧义侵蚀；熔炉模式产出**可枚举执行单元 + UID 指针 + 量化不确定性**，后续轮次只引用结构与指针，杜绝重复解析。

## 10. 验收

`node --test tests/services/structuredFurnace/structuredFurnace.test.js` → **25 用例绿**：前置拦截+封印 4 + L0 3 + L1 3 + L2 1 + 晶格规范 5 + 拒损降级 4 + 防呆汇总 2 + 场景验证表 3。邻近子系统回归（metaplan + resilience + dependency **99/99 绿**；toolUseLoop 邻接 jest **57/57 绿**）**零回归**。

## 11. 跨分类关联指引

- 同源治理脉络：动态约束求解 `[DESIGN-ARCH-034]`、元规划约束注入 `[DESIGN-ARCH-025]`、有限窗口降级与强制兜底 `[DESIGN-ARCH-029]`（拒损/降级同构思想）。
- 实现代码：`services/backend/src/services/structuredFurnace/`；锁级复用 `metaplan/constraintStrategy.js`。
- 文档结构与索引铁律：`docs/08_MGMT_项目管理/[MGMT-STD-001]`。
