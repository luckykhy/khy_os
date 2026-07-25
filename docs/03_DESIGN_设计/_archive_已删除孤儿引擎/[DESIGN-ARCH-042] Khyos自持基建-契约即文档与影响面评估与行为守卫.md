> ⚠️ **已归档（孤儿设计稿）· 请勿据此实现** ⚠️
>
> 本规范描述的治理引擎 `selfSustainingInfra（与已在产 projectMetadataService 平行重造）` 经 2026-06-14「接线或删除」证据级核实为 **ORPHAN**
> （零消费者、从 `executeTool`/`toolUseLoop`/`aiManagementServer` 三入口均不可达），
> 已按 `.ai/GOVERNANCE-LEDGER.md` §B.0 **删除其实现代码**（基线 `0437b6b`，删除提交
> `a76785e` + `99ea828`）。本文件仅作**历史可追溯**留存，**非在产、不得作为实现依据**。
> 判「在产」唯一标准见 `.ai/GUARDS-AI.md` §0。
>
> ——归档于 2026-06-14
# [DESIGN-ARCH-042] Khyos自持基建 — 契约即文档·影响面评估·行为守卫·基建缺失淬火

> 状态：定稿 · 归属：`services/backend/src/services/selfSustainingInfra/` · 关联：[[DESIGN-ARCH-037]]（自举闭环自愈，EvoRequirement 真源）、[[project_maintainability_metadata]]（.ai/ 种子文档，宏观层）、[[DESIGN-ARCH-041]]（意图裁决，邻近子系统）

## 一、目标

为 Khyos 注入「**自说明、自验证、自修复**」基因，消灭依赖人类记忆或高级模型推理来维护项目的痛点。构建契约驱动、从代码自动坍缩出文档与测试的基础设施，使单人或简单模型只需关注「局部逻辑增删改」、无需理解全局脉络即可安全维护。

零侵入、加法式：自成纯子系统，不接管构建/提交主流程。可由后续 PR 把 `commitGate` 挂 pre-commit、`generateDocs` 挂 CI，落地「代码→契约→文档/测试」自动坍缩流。

## 二、自持基建流转图

```
源码契约(JSDoc/Schema)
   │  AST/结构层解析
   ├─► ContractDocGenerator    →  API Markdown（代码即唯一真相，防呆①）
   ├─► DependencyImpactScanner →  正/反依赖图 + 下游传递闭包（影响面评估，防呆④）
   ├─► AutoTestScaffolder      →  node:test 边界用例骨架（行为快照，§3.3）
   └─► InfraGapQuencher.audit  →  裸奔诊断(缺契约/any/隐式依赖/缺测试)
                                      │
                       commitGate ───┤ 裸奔→阻断提交（防呆③）
                                      ▼
                       quench → EvoRequirement(L1) → evoLedger 不可变哈希链
```

## 三、核心机制（§3）

### 3.1 契约即文档（`ContractDocGenerator`）

零依赖纯解析：逐个抽取 `/** … */` 文档块及其紧随声明签名（function/class/const arrow/method），坍缩出描述 + @param/@returns/@throws → API Markdown，标注「请勿手工编辑」杜绝双源。开发者只改契约注释，文档随之更新（防呆①）。

### 3.2 正交隔离影响扫描（`DependencyImpactScanner`）

`buildGraph(fileMap)` 解析 `require('./x')` 相对引用建正/反依赖图；`impactedBy(changed, graph)` 沿反向边 BFS 求受影响下游传递闭包 + 深度。改动若无下游可放心盲改；有下游则逐一标红强制评估（防呆④）。仅解析项目内相对引用，第三方包/内置模块刻意忽略。

### 3.3 行为守卫骨架（`AutoTestScaffolder`）

`parseSignatures` 解析导出函数形参；按参数名启发（count/num→极值、str/name→空串/emoji、list→空数组、opts→null/{}）推断边界用例；`scaffold` 生成 node:test 骨架，默认断言「调用不抛」作行为快照基线，`// TODO` 标记需补全的行为断言。纯字符串、零 I/O。

### 3.4 基建缺失淬火（`InfraGapQuencher`）

`audit(source, file)` 静态扫描四类裸奔：`missing-contract`（公共函数无 @param/@returns）、`untyped-any`（{any}/{*}/{Object}/{} 无形状）、`implicit-dependency`（直读 process.env/global/globalThis）、`missing-test`（门面结合已测符号索引）。`quench(gap)` 复用 [[DESIGN-ARCH-037]] 的 `evoRequirement` 真源铸 L1 自愈需求（why 含「拓扑空洞/新增…工具」锁 L1，规避 网关/压缩/调度 L2 触发词）。

## 四、门面编排（`SelfSustainingInfra`）

| 方法 | 职责 | 防呆 |
| --- | --- | --- |
| `generateDocs(fileMap)` | 坍缩 API Markdown | ① |
| `impactOf(changed, fileMap)` | 受影响下游评估 | ④ |
| `scaffoldTests(src, opts)` | 行为快照骨架 | §3.3 |
| `audit(fileMap, {testedSymbols})` | 全量裸奔诊断（含 missing-test） | ② |
| `commitGate(fileMap, opts)` | 裸奔阻断提交 + 淬火落账本 | ③ |
| `guardRefactor(changed, fileMap, {reviewedImpact})` | 未评估影响面禁改公共契约 | ④ |
| `pool()/verifyPool()` | 需求池 + 哈希链校验 | — |

需求池 branch `self_sustaining_infra_pool`。

## 五、场景验证（§4.4）

简单模型维护叶子工具 `reverseText`：① `guardRefactor` 告知 `hasDownstream=false` → 可安全盲改内部实现；② `scaffoldTests` 自动拉起 `reverseText — 边界: text` 测试骨架；③ 契约完备 + 已测 → `commitGate` 放行。全程无需理解系统全局。

## 六、防呆铁律（写死，不可绕过）

1. **绝对禁止** 代码库存在手写的、与代码分离的 API/数据结构文档（除高层设计哲学外），所有接口文档由基建脚本从代码生成。 → `ContractDocGenerator` 标注「请勿手工编辑」，文档从 JSDoc 契约坍缩。
2. **必须强制** 跨模块数据交互定义强类型契约，绝对禁止 `any`/无类型字典传递。 → `InfraGapQuencher` `untyped-any` 裸奔检测，commitGate 阻断。
3. **必须强制** 提交时新增公共函数缺行为快照/单测必须阻断提交并生成补全 `EvoRequirement`。 → `commitGate` 检出 missing-test/missing-contract → blocked + `quenchAll` 落账本。
4. **绝对禁止** 简单模型未查看 `DependencyImpactScanner` 输出前盲目重构公共契约。 → `guardRefactor` 有下游且 `reviewedImpact=false` 即拒。

## 七、验证

`tests/services/selfSustainingInfra/selfSustainingInfra.test.js` — 20 测试全绿：契约抽取/渲染、反向传递闭包+深度、边界用例启发、四类裸奔诊断、L1 淬火、commitGate 阻断+放行、guardRefactor 拒/放、§4.4 简单模型场景、哈希链校验。邻近回归（intentArbiter/dataSovereignty/evoEngine）77 测试零回归。
