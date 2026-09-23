---
name: 三态目录立体分层
id: LAYOUT-007
domain: LAYOUT
nature: 约束为主，兼权力与福利
scope: "仓库顶层（A 轴三态根）、.khy/ 与 .khyos/ 两个数据根的档位与领域归位、以及绕开 utils/dataHome.js 的字面路径拼接点；不覆盖 L0–L6 板块归属（[DESIGN-LAY-005]）与层内可见性（[DESIGN-LAY-002]）"
priority: P1
trigger: "在 .khy/ 或 .khyos/ 根新增一个数据落点时；在仓库顶层新增文件或目录时；抱怨「找不到东西」或要做目录搬迁时"
constraint: "数据态根的直接子项只能是 DATA-LOCATIONS.json 登记的 T0–T4 五档 + 1 个 00_INDEX_data.md，不得出现第 6 类平铺条目；任一登记目录的直接条目不得超过其 budget（档 50 / 领域 20 / 数据根 6 / 仓库顶层 20），超了只能按固定轴序 A→B→C→D→E 拆分，不得以豁免绕过；一切数据路径拼接必须经 utils/dataHome.js 的 DATA_PATHS 查表，不得在别处字面拼接 .khy/.khyos 段；T0 权威档与 T3 留痕档禁止递归删除，T3 另禁压缩。"
grants: "授权任何人在不询问维护者的前提下，把 .khy/ 未归位条目按 §2.2 八族搬入对应 T* 档并留 junction 兼容老路径（[DESIGN-LAY-007] §5）；授权对 T2/T4 两档做递归清理（它们按定义可再生）；授权由执行器 --index 生成数据态楼层索引。边界：本授权不覆盖 T0/T3 的任何搬移与删除，也不覆盖工具契约文件的移动。"
benefit: "把「这个数据在哪」从「ls 211 项人眼扫」压到「读 1 个索引 + 下 2 层」；档位名即备份档与删除授权凭证，搬数据与防丢策略不再靠口口相传；.khy/ 与 .khyos/ 的互不穿透红线从注释升级成目录名。"
exception: "四类：① 工具按名读取的契约文件（清单见 DATA-LOCATIONS.json 的 protected.toolContractRootFiles）永不搬移；② append-only 通道（audit-trajectory）保持原语义只换父路径；③ 点目录与 vendor 不计入预算；安装产物（node_modules/、khy_os.egg-info/）按 2026-09-19 裁决登记在 topLevel.installArtifacts——豁免「可寻址项」计数但**必须单列可见且刻意不搬**（搬 node_modules 破坏 npm 按名解析），不得静默隐藏；④ 过渡期 junction/symlink 老路径不计入条目数，S4 前有效。"
version: "1.1.0 (2026-09-19) 并入 §10 四项裁决（8 族领域轴 / 安装产物登记不搬 / 两库按可再生性分档 / 档位数字前缀非 ID 声明）；1.0.0 (2026-09-18) 初版配套 S1 观察者执行器。基线口径以 npm run check:data-layout 输出为准（顶层含点文件 71 条，可寻址项另计）"
status: draft
ssot: "docs/10_规范/DESIGN-LAY/[DESIGN-LAY-007] 三态目录立体分层方案.md"
formerly: 无
owner: architecture-team
enforcement: "scripts/ci/check-data-layout.js"
---

# [LAYOUT-007] 三态目录立体分层

<!-- RULES-REGISTRY: LAYOUT-007 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/DESIGN-LAY/[DESIGN-LAY-007] 三态目录立体分层方案.md。

## 约束

数据态根的直接子项只能是 DATA-LOCATIONS.json 登记的 T0–T4 五档 + 1 个 00_INDEX_data.md，不得出现第 6 类平铺条目；任一登记目录的直接条目不得超过其 budget（档 50 / 领域 20 / 数据根 6 / 仓库顶层 20），超了只能按固定轴序 A→B→C→D→E 拆分，不得以豁免绕过；一切数据路径拼接必须经 utils/dataHome.js 的 DATA_PATHS 查表，不得在别处字面拼接 .khy/.khyos 段；T0 权威档与 T3 留痕档禁止递归删除，T3 另禁压缩。

## 授予权力

授权任何人在不询问维护者的前提下，把 .khy/ 未归位条目按 §2.2 八族搬入对应 T* 档并留 junction 兼容老路径（[DESIGN-LAY-007] §5）；授权对 T2/T4 两档做递归清理（它们按定义可再生）；授权由执行器 --index 生成数据态楼层索引。边界：本授权不覆盖 T0/T3 的任何搬移与删除，也不覆盖工具契约文件的移动。

## 提供福利

把「这个数据在哪」从「ls 211 项人眼扫」压到「读 1 个索引 + 下 2 层」；档位名即备份档与删除授权凭证，搬数据与防丢策略不再靠口口相传；.khy/ 与 .khyos/ 的互不穿透红线从注释升级成目录名。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

四类：① 工具按名读取的契约文件（清单见 DATA-LOCATIONS.json 的 protected.toolContractRootFiles）永不搬移；② append-only 通道（audit-trajectory）保持原语义只换父路径；③ 点目录与 vendor 不计入预算；安装产物（node_modules/、khy_os.egg-info/）按 2026-09-19 裁决登记在 topLevel.installArtifacts——豁免「可寻址项」计数但**必须单列可见且刻意不搬**（搬 node_modules 破坏 npm 按名解析），不得静默隐藏；④ 过渡期 junction/symlink 老路径不计入条目数，S4 前有效。

## 版本记录

- 1.1.0 (2026-09-19) 并入 §10 四项裁决（8 族领域轴 / 安装产物登记不搬 / 两库按可再生性分档 / 档位数字前缀非 ID 声明）；1.0.0 (2026-09-18) 初版配套 S1 观察者执行器。基线口径以 npm run check:data-layout 输出为准（顶层含点文件 71 条，可寻址项另计） 初版 / 迁移自 无
