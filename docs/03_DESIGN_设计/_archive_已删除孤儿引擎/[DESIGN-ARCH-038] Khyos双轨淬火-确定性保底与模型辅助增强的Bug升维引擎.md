> ⚠️ **已归档（孤儿设计稿）· 请勿据此实现** ⚠️
>
> 本规范描述的治理引擎 `dualTrackForge（与已在产 evoEngine/painPointScanner 真重叠）` 经 2026-06-14「接线或删除」证据级核实为 **ORPHAN**
> （零消费者、从 `executeTool`/`toolUseLoop`/`aiManagementServer` 三入口均不可达），
> 已按 `.ai/GOVERNANCE-LEDGER.md` §B.0 **删除其实现代码**（基线 `0437b6b`，删除提交
> `a76785e` + `99ea828`）。本文件仅作**历史可追溯**留存，**非在产、不得作为实现依据**。
> 判「在产」唯一标准见 `.ai/GUARDS-AI.md` §0。
>
> ——归档于 2026-06-14
# [DESIGN-ARCH-038] Khyos 双轨淬火——确定性保底 + 模型辅助增强的 Bug 升维引擎

> 架构与设计规范 · 遵循 [MGMT-STD-001] · 关联 [DESIGN-ARCH-037] 自举创世闭环自愈、[DESIGN-ARCH-044] 自愈微循环、[DESIGN-ARCH-028] 通信防御零静默、[DESIGN-ARCH-025] 元规划约束注入

## 1. 目标与定位

把「一切 Bug 皆需求」从口号落成**双轨**工程：一次执行现场被淬火成进化需求，两条轨各司其职、主干永远保底。

- **主干（确定性保底轨）**：纯代码物理断言判出硬伤 → 查表确定性升维 → 保底需求。**零模型依赖、永远可产出**。模型宕机，系统仍能持续把 Bug 转化为需求。
- **旁路（模型辅助增益轨）**：模型对软性逻辑异常做深度自省，产出带置信度的增益假设。**绝不允许成为需求生成的阻塞点或唯一依赖**——超时/抛错/低置信一律静默丢弃，降级为纯确定性输出。

这是 [DESIGN-ARCH-037] 自举创世引擎「需求生成核心」的双轨升级：复用其 `evoRequirement`/`evoLevels`/`evoLedger` 单源，落为零侵入纯子系统 `src/services/dualTrackForge/`。模型 brain 为注入式，引擎模型无关、可确定性单测。

### 1.1 三方对比（自调查）

| 维度 | 纯静态拦截 | 纯模型自省 | 双轨淬火（本架构） |
|---|---|---|---|
| 错误感知 | 仅物理异常 | 试图理解语义但常放过 | 物理断言必捕硬伤 + 模型尝试捕软伤 |
| 归因深度 | 浅层（缺校验器） | 深但不可靠（可能幻觉根因） | 确定性映射保底 + 模型推演增益（带置信度） |
| 需求产出 | 稳定但颗粒粗（L0/L1） | 不稳定，模型犯错则无需求 | 永远有保底，偶尔增益出 L2 架构需求 |
| 系统鲁棒性 | 极高 | 极低（模型波动即进化能力波动） | 极高，模型宕机仍持续将 Bug 转化为需求 |

## 2. Meta-Plan（扫栈自决）

| 决策 | 选择 | 复用既有真源 |
|---|---|---|
| 物理网关部署位置 | 包裹模型执行器（`gate.wrap(fn)`），对结果/抛错断言 | 新建 `PhysicalAssertionGate` |
| 逻辑网关部署位置 | 模型输出后置处理（执行后自评），软异常静默旁路 | 新建 `LogicalSelfAssessor`（注入 brain） |
| 需求级别格 | 复用 L0⊏L1⊏L2 升级格 + planL2 强制降级闸门 | `evoEngine/evoLevels` |
| 需求规格真源 | 复用七要素 EvoRequirement + forge/validate | `evoEngine/evoRequirement` |
| 需求池持久化 | 复用 append-only 哈希链（分支 `dualtrack_pool`） | `evoEngine/evoLedger` |
| 归因起点 | 物理码 → 校准 why（锁 classify 落 L0/L1） | 新建 `physicalCodes` 单源 |

## 3. 架构蓝图（双轨流转）

```
                         执行尝试 / 失败现场 observation
                                     │
                 ┌───────────────────┴────────────────────┐
                 │ 主干（同步·最先·零模型）               │ 旁路（异步·可失败·静默）
                 ▼                                         ▼
        PhysicalAssertionGate.assert            LogicalSelfAssessor.assess
        ├─ ERR_SCHEMA_VIOLATION                  ├─ brain(snapshot) + 超时 race
        ├─ ERR_TOOL_HALLUCINATION                ├─ 解析 {root_cause, suggestion, confidence}
        ├─ ERR_BEHAVIOR_FORBIDDEN                ├─ 置信度阈值 0.6 过滤
        └─ ERR_RESOURCE_OVERFLOW                 └─ 超时/抛错/坏格式/低置信 → null（静默）
                 │ 命中                                     │
                 ▼ [防呆③ 先发保底]                        │
        DeterministicElevator.elevate                      │
        → 保底 EvoRequirement（L0/L1）                      │
        → 立即落需求池（source=deterministic）              │
                 │                                         │
                 └────────────┬────────────────────────────┘
                              ▼
              DualTrackRequirementMerger.merge
              ├─ 仅保底 → source_track=Deterministic
              ├─ 保底+合格增益 → Dual-Track（merged_action 双段）
              ├─ 增益带合规 l2Plan → 建议升 L2 → planL2 强制降级 L0+3步（防呆②）
              └─ 无保底·仅软增益 → fromAssisted → Assisted
                              ▼
                  需求池（不可变哈希链，防呆⑤）
```

## 4. 骨架实现（核心模块）

| 模块 | 职责 |
|---|---|
| `physicalCodes.js` | 4 物理码 + 确定性升维映射单源（signal/why/proposedModules/action/intendedLevel/priority）；why 校准避开 classify 的 L2 触发词 |
| `physicalAssertionGate.js` | `PhysicalAssertionGate`：显式信号检测 + 错误签名兜底 + `wrap(fn)` 包裹执行器；`PhysicalException`。确定性、不抛（返回值或 null，把发序攥在门面）|
| `deterministicElevator.js` | `DeterministicElevator`：物理异常 → 保底 EvoRequirement（经 forge），零模型必成功，级别锁 L0/L1 |
| `logicalSelfAssessor.js` | `LogicalSelfAssessor`：注入 brain + 超时 race + 解析 + 置信度过滤；`assess` 契约「合格增益或 null，永不抛」；`LogicalException` |
| `dualTrackMerger.js` | `DualTrackRequirementMerger`：合并标 `source_track`（Deterministic/Assisted/Dual-Track）；`fromAssisted` 纯辅助轨；l2Plan 合规才升 L2 |
| `index.js` | `DualTrackForge` 门面：物理断言→确定性升维（先落盘）+逻辑评估（可失败）→合并→需求池 |

### 4.1 §3.2 确定性升维映射（保底，零模型）

| 物理异常码 | 保底需求处方 |
|---|---|
| `ERR_SCHEMA_VIOLATION` | 增加/强化输出格式校验拦截器与自动重试解析器 |
| `ERR_TOOL_HALLUCINATION` | 增加工具路由白名单校验与降级兜底工具 |
| `ERR_BEHAVIOR_FORBIDDEN` | 增加细粒度权限沙箱与行为前置审批网关 |
| `ERR_RESOURCE_OVERFLOW` | 增加上下文预算硬限网关与异步快照执行器 |

### 4.2 最终 EvoRequirement 双轨特征（§3.4）

```json
{
  "requirementId": "evo_…",
  "title": "增加工具路由白名单校验与降级兜底工具（+模型增益）",
  "source_track": "Dual-Track",
  "deterministic_finding": "ERR_TOOL_HALLUCINATION: 调用了不存在的工具 tool_x",
  "assisted_hypothesis": "指令中的\"查询\"被误映射为不存在的 tool_x (置信度: 0.8)",
  "merged_action": ["[保底] 增加工具路由白名单校验与降级兜底工具", "[增益] 优化指令到工具名的映射 Prompt，增加 Few-shot 示例"],
  "priority": "High"
}
```

## 5. 场景验证（§4）

| 场景 | 纯模型方案 | 双轨方案 |
|---|---|---|
| A 模型严重幻觉/宕机 | 唯一依赖崩塌 → **无任何需求产出**（报错失败） | 物理断言保底 → **成功产出 Deterministic 需求** |
| B 复杂逻辑死锁 | 时好时坏 | 保底（ERR_RESOURCE_OVERFLOW）+ 模型增益架构根因 + 合规 l2Plan → **Dual-Track，增益出 L2 架构需求**，经 planL2 强制降级 L0 + 3 步验证 |
| B 反证 | — | 模型给 L2 根因但**无 l2Plan** → 增益并入但**绝不擅自升 L2**（防呆②） |

## 6. 防呆规则与硬边界（§5）

| # | 铁律 | 落实点 |
|---|---|---|
| ① | 模型辅助轨绝不阻塞主干；超时/异常静默丢弃降级 | `assess` 自带超时 race + 全程 try/catch → null；保底需求在 await 模型前已铸成落盘 |
| ② | 增益需求置信度阈值（默认 0.6）无情过滤；l2Plan 不合规绝不升 L2 | `LogicalSelfAssessor.evaluate` 阈值门 + `merger` 经 `evoLevels.planL2` 强制降级 |
| ③ | 物理异常被拦截时绝不跳过确定性映射等模型 | 门面 `forge`：`physical → elevate → _log` 无条件先于 `assessor.assess` |
| ④ | EvoRequirement 必标 source_track | `merger.merge`/`fromAssisted` 恒置 `source_track` |
| ⑤ | 进化历史不可篡改 | 复用 `evoLedger` append-only 哈希链，`verifyPool` 定位篡改 |

## 7. 验证

`tests/services/dualTrackForge/dualTrackForge.test.js` 31 绿：物理网关 4 码确定性判别 + 多命中优先级 + 干净现场；确定性升维 4 码级别锁定；模型轨置信度过滤 + fail-soft（超时/抛错/坏格式/低置信/无 brain）；合并器 source_track 四态；门面四防呆；两场景对比 + L2 反证；需求池哈希链。邻近 evoEngine/frictionBridge/metaplan/selfHeal 91 绿零回归。

零侵入：自成纯子系统，不接管 `executeTool`；可由 [DESIGN-ARCH-037] `frictionBridge`/`evolve` 后续路由消费其需求池（后续 PR）。
