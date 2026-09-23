> ⚠️ **已归档（孤儿设计稿）· 请勿据此实现** ⚠️
>
> 本规范描述的治理引擎 `dataSovereignty` 经 2026-06-14「接线或删除」证据级核实为 **ORPHAN**
> （零消费者、从 `executeTool`/`toolUseLoop`/`aiManagementServer` 三入口均不可达），
> 已按 `.ai/GOVERNANCE-LEDGER.md` §B.0 **删除其实现代码**（基线 `0437b6b`，删除提交
> `a76785e` + `99ea828`）。本文件仅作**历史可追溯**留存，**非在产、不得作为实现依据**。
> 判「在产」唯一标准见 `.ai/GUARDS-AI.md` §0。
>
> ——归档于 2026-06-14
# [DESIGN-ARCH-040] Khyos 数据主权与极权路由——数据主权绝对论与单一权威注入网关

> 架构与设计规范 · 遵循 [MGMT-STD-001] · 关联 [DESIGN-ARCH-039] 环境共生、[DESIGN-ARCH-038] 双轨淬火 Bug 升维、[DESIGN-ARCH-037] 自举创世闭环自愈、[DESIGN-ARCH-025] 元规划约束注入

## 1. 目标与定位

消灭多源数据「精神分裂」：同一参数被全局变量、环境、配置、模型推理、工具返回值各处取值，
互相覆盖、各执一词，导致系统行为漂移不可复现。Khyos 立「**数据主权绝对论**」——每一份数据
按其**来源出身**钉死在一个不可僭越的主权阶层；低阶层数据**永远**无权覆盖高阶层。一切参数
必经**单一权威注入网关**裁出唯一值后极权注入，业务函数**绝不**自行读多源。

落为零侵入纯子系统 `src/services/dataSovereignty/`，复用 [DESIGN-ARCH-038]/[DESIGN-ARCH-037]
的 `evoRequirement`/`evoLedger` 需求真源（不改其定形），新增主权维度。

## 2. Meta-Plan（参数注入流程控制架构）

| 层 | 职责 | 模块 | 铁律 |
|---|---|---|---|
| 阶层宪法 | 来源 → P0-P4 阶层单源映射 | `sovereigntyTiers.js` | 来源决定阶层，调用方不得自报（防呆①真源） |
| 主权裁决 | 多源 argmin(rank) 取唯一权威值 | `DataSovereigntyGateway` | 低阶层永不覆盖高阶层；同阶层异值即熔断（防呆③） |
| 幽灵降维 | 落败 P3+ 数据 → 只读 `ghost_value` | `GhostValueAnnotator` | 物理隔离，绝不入执行流（防呆②） |
| 冲突淬火 | 打架/震荡 → 带 `conflict_sources` 的 EvoRequirement | `ConflictQuencher` | 「打架即需求」，L1 器官新生（防呆④） |
| 极权注入门面 | 编排 + 落账本 + 纯度审计 | `DataSovereignty` | 冲突 fail-closed，绝不放行任何参数 |

## 3. 数据主权阶层（§3.1）

| 阶层 | rank | 出身 | 可被谁压制 |
|---|---|---|---|
| **P0 绝对铁律** | 0 | 硬编码安全边界 / 防呆规则 / 物理极限 | 无（含用户、含模型皆不可） |
| **P1 意志注入** | 1 | 用户显式指令 / 任务目标 | 仅 P0 |
| **P2 环境语境** | 2 | OS 原生特权 / 网络 / 电量 | P0-P1 |
| **P3 推理演算** | 3 | 模型推理 / 记忆召回 / 工具返回值 | P0-P2 |
| **P4 默认基座** | 4 | 配置默认值 | 人人 |

未知来源 fail-safe 降 P4（最低权威），杜绝「伪装高权威」提权面。「P3 及以上阶层」（rank ≤ 3）
的落败数据须留幽灵；P4 落败属噪音静默丢弃。

## 4. 架构蓝图（主权裁决闭环）

```
        多源声明 claims [{param, source, value}]   （业务侧只声明来源+值，严禁直读——防呆①）
                          │
                          ▼  来源 → 阶层（SOURCE_TIER 真源，调用方不得自报）
        DataSovereigntyGateway.adjudicate(param, claims)
                          │
              ① argmin(rank) 取最高权威阶层
                          │
          ┌───────────────┴────────────────┐
          ▼                                ▼
   最高阶层单值                      最高阶层 ≥2 异值
          │                                │  [防呆③ 绝不随机/先后覆盖]
          ▼                                ▼
   ③ 落败 P3+ → GhostValueAnnotator   熔断 throw SovereigntyConflictError
      只读 ghost_value 独立通道          (ERR_SOVEREIGNTY_CONFLICT)
      （防呆② 绝不入逻辑）                │
          │                          ConflictQuencher.quenchSameTier
   ④ 震荡 A→B→A → quenchOscillation   → L1 器官新生需求 [conflict_sources]（防呆④）
      → 状态锁/裁决器需求                │
          │                                │
          ▼                                ▼
   极权注入：函数只收单一权威字典     需求池（evoLedger 不可变哈希链）
   sanitizeForExecution 断言无幽灵渗入   冲突 fail-closed，绝不放行任何参数
```

## 5. 骨架实现（三命名类）

| 类 | 职责 |
|---|---|
| `DataSovereigntyGateway` | 拦截多源 → 按 P0-P4 绝对覆盖裁唯一注入值；同阶层异值熔断抛 `ERR_SOVEREIGNTY_CONFLICT`；会话级震荡侦测 |
| `GhostValueAnnotator` | 落败 P3+ 数据降维只读冻结 `ghost_value`，`__ghost` 标记不可伪造；`sanitizeForExecution` 断言权威字典零幽灵渗入 |
| `ConflictQuencher` | 同阶层打架 / 高频震荡 → 带 `conflict_sources` 的 L1 EvoRequirement；复用 `forge` 铸后装饰，`why` 校准锁 L1 |

### 5.1 classify L2 陷阱规避

`evoLevels.classify` 只读 `why+surface+kind`，且「网关/调度/压缩/核心流转」是 L2 触发词。
本域满纸「网关」，故淬火 `why` 一律措辞为「状态拓扑空洞，须**新增**意图裁决**工具**与状态锁」
（含 `拓扑空洞`+`新增…工具` 锁 L1），把「网关」等处方词收进 `proposedModules`（classify 不读），
`_decorate` 末尾再做 L1 不变式自检兜底，绝不擅升 L2。

## 6. 场景验证（§4）

| 场景 | 输入 | 网关裁决 | 结果 |
|---|---|---|---|
| 模型越权改安全设置 | `allow_delete`：user(P1)=false / model(P3)=true | P1 胜，P3 落败 | 注入 false；模型值留只读幽灵供反思（防呆②） |
| 两 P3 工具返回值冲突 | `price`：tool-return=100 / tool=105 | 同 P3 异值，无更高权威可裁 | 熔断 `ERR_SOVEREIGNTY_CONFLICT`，淬出「结果交叉验证工具」L1 需求（`conflict_sources=[tool,tool-return]`） |
| 同参数来回覆盖 | `view`：list→grid→list | 单值无冲突但侦测震荡 | 不熔断本次，淬出「状态锁」需求落账本（§3.3） |

## 7. 防呆规则与硬边界（§5）

| # | 铁律 | 落实点 |
|---|---|---|
| ① | 业务函数内严禁直读全局/环境/DB，必须全部经主权网关参数注入 | 来源决定阶层（`SOURCE_TIER` 真源）；`auditInjectionPurity` 机械扫描 `process.env`/`global.`/`db.query` 给 CI 门禁 |
| ② | 落败 P3+ 数据必以 `ghost_value` 随参下发供模型反思，但绝无权限参与逻辑流转 | 幽灵冻结 + `__ghost` 标记 + 与权威字典物理分桶；`sanitizeForExecution` 断言零渗入即抛 `GhostPollutionError` |
| ③ | 同阶层冲突绝不随机选择/先后覆盖，必须熔断抛 `ERR_SOVEREIGNTY_CONFLICT` + 淬 L1 器官新生需求 | `adjudicate` 检测最高阶层异值即 throw；门面 `inject` fail-closed 不放行任何参数 |
| ④ | 生成的 EvoRequirement 必打 `conflict_sources` 标签，记录是谁打架触发进化 | `ConflictQuencher._decorate` 强制装饰；落账本 payload 同载，审计可追溯 |

## 8. 验证

`tests/services/dataSovereignty/dataSovereignty.test.js` 21 绿：阶层映射 + 未知降 P4 + 幽灵阈值；
幽灵冻结/泄漏断言/分桶；跨阶层裁决 + P0 绝对 + 同值去重 + 同阶层熔断 + P4 不留幽灵 + 震荡侦测；
淬火 L1/conflict_sources/不擅升 L2/交叉验证处方；门面注入/§4 两场景表/震荡落账/纯度审计/哈希链。
邻近 evoEngine + dualTrackForge + envSymbiosis 93 绿零回归。

零侵入：自成纯子系统，不接管 `executeTool`；可由后续 PR 把真实多源取值（env/config/工具返回）
改道经本门面注入，把 `auditInjectionPurity` 挂为业务函数 CI 门禁。
