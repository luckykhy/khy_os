# 00_INDEX 已删除孤儿引擎·设计稿归档

> **索引总领文件** · 本子目录唯一入口 · 排序首位 · 结构遵循 [MGMT-STD-001] 第三章

## 一、分类内容边界

本子目录（`docs/03_DESIGN_设计/_archive_已删除孤儿引擎/`）收容**已删除治理引擎的历史设计稿**：
这些规范描述的引擎经 2026-06-14「接线或删除」（wire-or-delete）证据级核实为 **ORPHAN**——
零外部消费者、从三个真实执行入口（`executeTool` / `toolUseLoop` / `aiManagementServer`）均不可达，
仅有隔离单测。其**实现代码已删除**（见 `.ai/GOVERNANCE-LEDGER.md` §B.0），设计稿在此留存仅为
**历史可追溯**。

> 🔴 **本目录文档一律非在产、不得作为实现依据**。判定「在产」的唯一标准见 `.ai/GUARDS-AI.md` §0。
> 若日后要重做其中某项能力，必须先按 `.ai/GUARDS-AI.md` §4 想清接线点，不得照搬本目录的孤儿实现。

## 二、文件清单

| 文件名(含编号) | 对应已删引擎 | 删除依据(10字内) | 状态 |
| --- | --- | --- | --- |
| [DESIGN-ARCH-024] khyos元帅双模式任命与约束规范.md | `marshal` 生命周期半边 | 零消费者（叶子 capabilityVector 仍在产，例外见下） | 已归档 |
| [DESIGN-ARCH-033] 模型自适应与双轨热插拔架构.md | `dualTrack` + `user_patch` | 零消费者，适配器层已覆盖选轨 | 已归档 |
| [DESIGN-ARCH-035] 上下文永续与认知压缩引擎.md | `cognitiveSnapshot` | 与 compactPipeline 平行重造 | 已归档 |
| [DESIGN-ARCH-038] Khyos双轨淬火-Bug升维引擎.md | `dualTrackForge` | 与 evoEngine/painPointScanner 真重叠 | 已归档 |
| [DESIGN-ARCH-039] Khyos环境共生-原生亲和架构.md | `envSymbiosis` | 与 platformUtils 平行重造 | 已归档 |
| [DESIGN-ARCH-040] Khyos数据主权与极权路由.md | `dataSovereignty` | 零消费者，弱重叠无在产复用 | 已归档 |
| [DESIGN-ARCH-042] Khyos自持基建-契约即文档.md | `selfSustainingInfra` | 与 projectMetadataService 平行重造 | 已归档 |

> **例外（DESIGN-ARCH-024）**：marshal 的叶子 `marshal/capabilityVector` **仍在产**（经
> `metaConstraint/capabilityProbe` 投影分带，是「模型→数值能力」单一真源），其权威文档见
> `.ai/GUARDS-AI.md` §2。仅该规范描述的「任命/弹劾/接力」生命周期半边被删并归档于此。

## 三、跨分类关联指引

- 上级设计索引：`../00_INDEX_设计-分类索引.md`。
- 删除裁决与证据台账：`.ai/GOVERNANCE-LEDGER.md` §B.0（含基线/删除提交哈希）。
- 「在产 vs 没在产」接地红线：`.ai/GUARDS-AI.md`（§0 判据、§4 加新引擎清单）。
