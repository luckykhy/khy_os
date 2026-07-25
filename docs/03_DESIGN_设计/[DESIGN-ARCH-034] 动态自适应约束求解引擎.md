# [DESIGN-ARCH-034] 动态自适应约束求解引擎

| 项 | 值 |
| --- | --- |
| 文档类型 | 架构设计（ARCH） |
| 适用范围 | `services/backend/src/services/metaConstraint/` |
| 强制级别 | 设计基线（实现须符合本文「防呆符合性」一节） |
| 上位治理 | [DESIGN-ARCH-025]（元规划协议与动态约束注入）、[DESIGN-ARCH-024]（元帅双模式）、[MGMT-STD-001]（文档结构铁律） |
| 状态 | 定稿 |

---

## 1. 目标

在**单一模型调用链路**中废弃「按最低智商全局加锁」的静态约束，改为按模型**实时智力边界**（能力向量）动态配发约束锁具：对强模型执行**宾客原则**（释放最大自由度、校验损耗趋零），对弱模型实施**高压电笼**（重点关押、代码级物理阻断越权）。一句话——约束随能力毫秒级求解，执行前动态挂载，绝不提前加锁也绝不漏锁。

## 2. 与既有地基的关系（零重复造轮子）

本引擎**不新增任何模型知识，不复制约束代数**，而是把两套现成单一真源桥接起来：

- 能力分级单一真源：`marshal/capabilityVector.js`（由 `modelTier` 投影出 `{reasoning,planning,instruction,jsonStrict}` 向量与分数）。
- 约束阶梯单一真源：`metaplan/constraintStrategy.js`（`Prompt_Soft ⊏ Code_Hard ⊏ System_Block` 单调格 + `escalate` 取上确界）与 `metaplan/constraintInjection.js`（按级挂载拦截器）。

**填补的真实缺口**：[DESIGN-ARCH-025] 元规划的约束级别由**模型自评风险**驱动，其覆盖层只有「信任熔断 + 宪法红线」，**没有任何一层用能力向量配发约束**。本引擎补上这条「能力 → 约束地板」的求解层。

## 3. 三段能力探测（§3.1）

`capabilityProbe.js` 把能力向量的 `reasoning` 维度投影为三段裁决：

| 段 | 含义 | 默认归属 | reasoning 线（env 可调） |
| --- | --- | --- | --- |
| `guest` 宾客 | 释放最大自由度 | T0 / T1 | `≥ KHY_METACONSTRAINT_GUEST_REASONING`（默认 75） |
| `standard` 标准 | 按风险常规管控 | T2 | 介于两线之间 |
| `cage` 电笼 | 重点关押 | T3 | `< KHY_METACONSTRAINT_CAGE_REASONING`（默认 50，且恒 < guest 线） |

## 4. 求解矩阵（§3 核心，`constraintMatrix.js`）

`band × riskClass → 约束地板`（地板，非天花板）：

| band＼risk | creative | logic | irreversible |
| --- | --- | --- | --- |
| guest | Prompt_Soft | Prompt_Soft | **Code_Hard** |
| standard | Prompt_Soft | Code_Hard | System_Block |
| cage | **Code_Hard** | Code_Hard | System_Block |

- 宾客原则：强模型 creative/logic 均零校验损耗；不可逆操作仍至少挂代码校验（轻于电笼）。
- 高压电笼：弱模型**连改注释都过代码级拦截器**，越权由代码层物理阻断而非软提示。

风险分级 `riskClassifier.js`：`creative`（注释/Markdown/只读）/ `logic`（源码、非只读 shell）/ `irreversible`（删除、drop/truncate、强推、依赖清单/锁文件、机密）。fail-safe：无法识别 → `logic`，绝不下探到 `creative`。

## 5. 复合进既有阶梯（毫秒级，`index.js`）

`MetaConstraintSolver`：

- `solve({modelId, selfReport, action})` → `{band, riskClass, floor, rationale}`，纯计算。
- `reconcile(floor, declaredStrategy)` → 与模型自选策略求上确界（`escalate`），取更严者。
- `applyToTicket(ticket, {modelId})` → **零侵入**地把能力地板叠加进 metaplan 票据：抬升 `effectiveStrategy`、重解析 `injection`，返回**新票据**（不改原票据）。

### 5.1 接管 `executeTool` 漏斗（`toolFunnelGuard.js`）

`applyToTicket` 是纯计算接缝，本身不执行。`toolFunnelGuard.enforce()` 把它接到唯一的工具调度漏斗 `executeTool`（位于系统调用网关之后、`requestPermission` 之前），按**执行该动作的模型**求出地板并对**这一次具体调用**真正挂锁：

| 地板 | 漏斗动作 |
| --- | --- |
| `Prompt_Soft` | 直接放行（宾客原则，零校验损耗） |
| `Code_Hard` | 对候选 `content` 跑 `injection.runHardValidation`（AST/语法），不过即 fail-closed 拦截；无 content/无可识别语言 → 无可校验内容 → 放行 |
| `System_Block` | 极危/不可逆要求显式确认；网关已盖 `EXEC_APPROVED` 戳者免二次打断；无确认通道 → fail-closed |

铁律：`KHY_METACONSTRAINT=off` 整体旁路；能力层任何**异常**一律 fail-open 落回既有管线（既有权限/网关/锁仍把关），唯独「已判 System_Block 却拿不到确认通道」走 fail-closed（安全方向）。执行模型由 `toolUseLoop` 经 `traceContext.model` 穿入，缺省回落 `GATEWAY_PREFERRED_MODEL`。

完整有效约束栈（全部经 `escalate` 单调上确界，只升不降）：

```
能力地板(本引擎) ⊔ 模型自选 ⊔ 防偷懒升级 ⊔ 信任熔断 ⊔ 宪法红线
```

## 6. 防呆符合性

| 防呆 | 落点 |
| --- | --- |
| ① 未知模型 fail-safe | 未知/空模型经 `modelTier` 落 T2 ⇒ `standard`，绝不当作 `guest` |
| ② 自评只能加锁不能减锁 | `selfReport` 仅单调收紧 band；模型自称更强一律忽略，自承置信偏低则收紧 |
| ③ 能力地板进同一单调格 | 经 `escalate` 上确界叠加，只能加锁；红线/熔断已锁的更严级绝不被放松 |
| ④ 零侵入 | 复合 marshal/metaplan，自身不持有副本；`applyToTicket` 不改原票据；接管 `executeTool` 经独立守卫 `toolFunnelGuard.js`，不改调度器/tool-use loop |
| ⑤ 宾客 ≠ 无防护 | guest 的不可逆操作仍至少 Code_Hard，宪法红线仍是顶层不可覆盖地板 |

## 7. 交付物

```
services/backend/src/services/metaConstraint/
  capabilityProbe.js     能力向量探测与三段分级（§3.1）
  riskClassifier.js      动作风险分级（creative/logic/irreversible）
  constraintMatrix.js    能力×风险 求解矩阵（§3 核心）
  index.js               MetaConstraintSolver 门面（solve/reconcile/applyToTicket）
  toolFunnelGuard.js     接管 executeTool 漏斗的能力地板守卫（§5.1）
services/backend/tests/services/metaConstraint/metaConstraint.test.js   24 用例
services/backend/tests/services/metaConstraint/toolFunnelGuard.test.js  13 用例
```

## 8. 验收

`node --test tests/services/metaConstraint/metaConstraint.test.js` → **24 用例绿**：三段分级 5 + 风险分级 4 + 求解矩阵 5 + 同动作能力差异 3 + reconcile LUB 3 + applyToTicket 零侵入 4。邻近子系统回归（metaplan 38 + marshal 28）**66/66 绿，零回归**。

## 9. 跨分类关联指引

- 同源治理脉络：元规划约束注入 `[DESIGN-ARCH-025]`、元帅双模式能力向量 `[DESIGN-ARCH-024]`、弱模型兼容 `[DESIGN-ARCH-013]`。
- 实现代码：`services/backend/src/services/metaConstraint/`；复用 `marshal/capabilityVector.js`、`metaplan/`。
- 文档结构与索引铁律：`docs/08_MGMT_项目管理/[MGMT-STD-001]`。
