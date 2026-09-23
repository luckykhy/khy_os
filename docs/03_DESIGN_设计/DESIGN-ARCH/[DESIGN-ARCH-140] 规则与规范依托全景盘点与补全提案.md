# [DESIGN-ARCH-140] 规则与规范依托全景盘点与补全提案

> **状态**：提案（待评审拍板）
> **范围**：全仓 91 条登记规则 + 80 个检查器的「依托」现状盘点与缺口补全 —— 回答「每条规则凭什么被执行」
> **上游依赖**：`[DESIGN-ARCH-111]`（ruleguard 绑定层，门成员资格从登记表派生）、`[DESIGN-MEM-007]` §3.F（四层依托模型的首次提出，本文将其泛化为全仓标准）、`npm run rules:coverage` / `rules:manifest`（本文全部数字的来源）
> **数据时点**：2026-09-23 14:28，`node scripts/ruleguard/index.js coverage`（exit=0）与 `manifest` 实测输出

---

## 0. 一句话结论

仓库的依托基建**本身是全的**（登记表 → ruleguard → 三个门档，91 条规则 79 条 enforced = 86.8%），真正无依托的不是「忘了接线」，而是**四类结构化缺口**：8 条 manual 规则、4 条 carrier 规则（运行时代码承载无检查器）、38 个「检查器在执行但登记表未收录」的盲区 ID、11 个零接线检查器 + 31 个未被任何规则登记的检查器。本文用四层依托模型逐条处置前两类（12 条全部给出去向），后两类给批处理战役规则 —— **不盲补、不凑数**。

---

## 1. 现状实证（工具输出，非估计）

| # | 事实 | 证据 |
|---|---|---|
| 1 | 91 条规则：79 enforced（86.8%）/ 8 manual / 4 carrier；优先级 P0×10、P1×55、P2×26 | `rules:coverage` 输出头部计数 |
| 2 | 68 条 enforced 规则逐条有门（commit/pr/release）有执行器（49 个检查器），见 manifest 全表 | `rules:manifest` 输出 |
| 3 | **盲区：38 个规则 ID 正被 24 个检查器实际执行，但登记表未收录**（含 ARCH-079/092/098/100/102/111/113/117/118/119/120/127、LAY-004/005/006/007、MEM-006、TOOLING 族、GOV-001 等） | `rules:coverage`「覆盖率盲区」节，`--ci` 不阻断 |
| 4 | **11 个零接线检查器**（annotate-patterns.js、check-core-safety.js、check-f2e-spec.js、check-f2e-wiring.js、check-frontend-tokens.js、check-traffic-log.js、codemod-f2e-bridge-mobile.js、export-pyproject-dependencies.py、lint-debt-tracker.js、security-scan.js、test-a2a-mcp-server-smoke.js） | `rules:coverage`「零接线」节 |
| 5 | **31 个检查器未被任何规则登记**（含实际在用的 check-leaf-contract.js、check-tui-gates.js、check-file-ratchet.js、check-staged-secrets.js 等） | `rules:coverage`「未被任何规则登记」节 |
| 6 | manual 8 条：MEMORY-001、MEMORY-004、PROCESS-001、PROCESS-101、DOCS-004、SKILL-001、PROCESS-006、PROCESS-011；carrier 4 条：PROCESS-003、AGENT-001、PROCESS-007、PROCESS-102 | `rules:coverage` 第 20–26 行；登记表逐条内容已提取核读 |
| 7 | **异常组合：PROCESS-001 是 P0 却 gate=manual**（「禁止 AI 自动 commit/push」）—— 与 `rules:coverage` 的 P0 红线口径（「P0 不允许无执行器」）表面冲突，coverage 却 exit=0，说明现行判定对 manual 有豁免通道 | coverage 输出 vs AGENTS.md「规则遵守保障」节对 P0 的表述；归因见 §8 待核实 |

---

## 2. 依托标准（四层模型，泛化自 [DESIGN-MEM-007] §3.F）

| 层 | 名称 | 机制 | 强度 |
|---|---|---|---|
| E1 | 写入口/动作口 fail-closed | 不合规的写入/动作**根本无法发生**（seam 校验、权限闸） | 机械保证 |
| E2 | CI 静态守卫 | 检查器进 gate（commit/pr/release），违规报红 | 机械保证 |
| E3 | 测试钉住行为 | node:test 断言载体行为，CI 全量扫描 | 机械保证 |
| E4 | 注入 + 台账 + 事后兜底 | 规则注入系统提示/指令文件；偏差台账带到期日自动升级 | **概率性，须如实声明** |

**入库判据（承接 DESIGN-MEM-007 立论，全仓适用）**：每条规则的 `gate` 字段必须对应四层之一 —— `enforced` ⇒ E2（或 E1/E3 并注明）、`carrier` ⇒ E3 必须有合同测试、`manual` ⇒ E4 且**必须登记豁免理由与到期日**。不允许出现「gate=manual 且无豁免台账」的裸悬挂。语义判断类规则**禁止**为凑 E2 写弱正则检查器 —— 假依托（红灯疲劳）比诚实 manual 更糟。

---

## 3. 缺口处置

### 3.1 A 类：8 条 manual 规则逐条处置

| ID | 内容摘要 | 判定 | 处置（目标依托层 → 动作） |
|---|---|---|---|
| PROCESS-001 (P0) | 禁止 AI 自动 commit/push | 行为意图类，**无法静态查证** | **维持 manual 但走显式豁免**：按 PROCESS-011 自身的偏差台账机制登记豁免理由 + 到期日；依托 = E4（指令层注入）+ 现有 git 流程约束。同时作为「P0+manual 例外」提交人工裁决（§8 #1）——要么接受为例外并写进 coverage 豁免口径，要么补一个可判定的子集检查器（如 pre-push hook 校验提交作者身份，属运行时手段非 CI） |
| MEMORY-001 | session/persistent 区分 | 写时语义判断 | **在建依托挂接**：`[DESIGN-MEM-007]` S1 将登记 MEMORY-005/006 + E1 写入口校验，落成后本条升 enforced(partial)。处置 = 等 S1，不做重复建设 |
| MEMORY-004 | session 残留禁升格 | 跨时间运行时行为，静态检查器不可观测（schema `items[2].reason` 已有同样结论） | **接受 manual**：登记豁免台账（理由 + 无到期日=永久人工兜底），不假装能查 |
| PROCESS-006 | 新机制四阶段纪律 | 阶段跳变/未裁决升阶**部分机械可判**，与 PROCESS-008 的 `check-rollout-stage.js` 同族 | **扩既有检查器**：check-rollout-stage.js 增补「以时间计毕业 / 有争议样本未裁决升阶」断言（E2）；样本量数字本身依赖运行时事件，保留 manual 子集并声明 |
| PROCESS-011 | P3 四问 + 偏差台账到期自动升级 | 四问前置属 E4；**台账逾期扫描完全机械** | **拆两半**：新检查器扫偏差台账「到期未收敛未升级」（E2，可判）；四问前置留 E4 + 豁免台账 |
| PROCESS-101 | 提案规则卡模板 + 查重 | 模板字段、同 domain 同 subject 查重**全机械** | **补登既有孤儿**：`check-rule-scaffold.js` 已存在且在「31 个未登记」清单里（§1#5）——把它登记为 PROCESS-101 的 exec，一石二鸟（D 类还债 + A 类补依托） |
| DOCS-004 | README 禁第二真源（行号/字面量/命令存在性） | 禁行号、禁版本字面量、`npm run X` 存在性**全机械** | **新检查器** `check-readme-no-dup.js`（E2），P2 走基线棘轮（存量违例只降不升） |
| SKILL-001 | Skill description 四段式 / 长度 / allowed-tools | frontmatter 结构**全机械** | **新检查器** `check-skill-contract.js`（E2），P1；扫描面 = 各 skills 目录的 SKILL.md |

### 3.2 B 类：4 条 carrier 规则 —— 一律补合同测试（E3）

carrier = 行为已由运行时代码承载，缺的是**行为被测试钉住**（否则重构载体时规则静默失效）：

| ID | 载体 | 动作 |
|---|---|---|
| PROCESS-003 | `goalModeService.js` 验收门禁清单 | node:test 断言：验证门禁清单与登记表 constraint 列举的门（node --check、测试、check-change-safety 等）一致，缺一门即红 |
| AGENT-001 | `AgentTool/index.js` 交接契约 | node:test 断言：子体收到自包含 prompt、所有权显式传递、并发派发独立性好坏例判定（对既有实现行为拍照，先钉后改） |
| PROCESS-007 | `contextCompressor.js` 压缩保留清单 | node:test 断言：四类保留信息（修改文件路径/失败堆栈/剩余步骤/已跑守卫）在压缩产物中存活 |
| PROCESS-102 | `hqStore.js` 五档瀑布 | node:test 断言：G0 优先、同档评分决胜（延迟成本×把握÷工量）、缺字段落 G4 停下来问人 —— 纯逻辑易测 |

### 3.3 C 类：38 个盲区 ID —— 按检查器分批补登，禁止盲补

依托**已存在**（检查器在执行），缺的是登记（违反 `[DESIGN-ARCH-111]`「门成员资格从登记表派生」）。批处理战役规则：

1. 以**检查器**为单位（24 个）而非以 ID 为单位：逐 checker 读其源码里引用的规则 ID，归因每个 ID 是「真规则待登记」还是「文档编号被误当规则 ID」还是「内部编码族」（coverage 已自证排除 PTX- 族）。
2. 三批推进：第一批 `check-commit-timing.js`（GIT-001~004、PROCESS-009 相关、LAY-005，7 ID 同源）；第二批 `check-gov-rules.js` / `check-agent-docs.js` / `check-repo-layout.js`（ACP/GOV/STD/TOOL 族，13 ID）；第三批其余。
3. 每批验收：`rules:coverage` 盲区清单对应行消失；`check:rules` 双向可达不破。**只补登或摘除标记，不改任何检查器行为** —— 行为变化另开条目。

### 3.4 D 类：11 零接线 + 31 未登记检查器 —— 先归因再裁决

这两类的正确问题不是「补接线」而是「它们该不该活着」：

- 11 个零接线检查器：逐一判定「登记进某条规则 / 归档（`_archive_` 模式，只搬不删）/ 写豁免 + 到期日」。
- 31 个未登记检查器中**至少 4 个确认在用**（check-leaf-contract.js 是 TUI 叶子守卫、check-tui-gates.js 是门预算棘轮、check-file-ratchet.js 是 CI HARD 指标、check-staged-secrets.js 是安全件）—— 它们的归宿是补登为对应规则的 exec（其中三个可挂 TOOLING/MEMORY 族新条目）。
- `check:wiring`（反孤儿守卫）为何没拦住这 42 个？见 §8 #2 —— **先核实其扫描范围与豁免台账，再决定是否扩它的职责**，不在本文直接改。

---

## 4. 实施分期（每期独立可回滚）

| 期 | 内容 | 验收 |
|---|---|---|
| S1 | 本提案拍板；登记豁免台账（MEMORY-004、PROCESS-001 待裁决件、PROCESS-006 手工子集）；`check-rule-scaffold.js` 补登为 PROCESS-101 exec | `rules:coverage`：manual 8→6，盲区 -1；`check:rules` 通过 |
| S2 | B 类合同测试四件（PROCESS-003/007/102 先，AGENT-001 后——它依赖 AgentTool 行为拍照，需先跑一次现行为） | 4 条 carrier 规则全部有 E3 依托；测试落地即绿（node:test） |
| S3 | C 类盲区三批补登 | 盲区 38→0（或每条残留都有豁免台账行） |
| S4 | 新检查器三件：check-skill-contract.js（SKILL-001）、check-readme-no-dup.js（DOCS-004）、偏差台账逾期扫描（PROCESS-011 半条）+ 扩 check-rollout-stage.js（PROCESS-006 半条）；D 类逐个归档/接线裁决 | manual 规则中「全机械可判」的 4 条（PROCESS-101/DOCS-004/SKILL-001/PROCESS-011 后半）升 enforced；11 零接线检查器清零（接线或归档） |

## 5. 诚实边界

- **PROCESS-001（P0+manual）没有也不可能有机械依托**：「AI 不自动 push」是意图纪律，CI 只能查产物不能查意图。本文如实将其标注为全仓唯一 P0 级 E4 依托规则，交人工裁决是否接受。
- **E4 类规则不进任何 ERROR 级守卫断言**（承接 DESIGN-MEM-007 MR-E5 口径）。
- 本文不改任何检查器行为；C 类补登是登记簿操作。行为变更（如给 check-rollout-stage.js 加断言）在 S4，独立可回滚。

## 6. 反模式（这条路别走）

1. **为凑 86.8%→100% 写弱正则检查器** —— 语义判断类规则（MEMORY-001 的归档判定、PROCESS-001 的意图）被正则假覆盖后，绿灯不再是绿灯，红灯疲劳会埋掉真红。manual + 豁免台账是合法终态。
2. **38 个盲区 ID 一把梭全补登** —— 里面混着「文档编号被误当规则 ID」的伪规则（PTX- 族已被 coverage 自动排除是先例），不归因的补登是把错误固化进登记表。
3. **给 carrier 规则补检查器而不是补测试** —— 载体是运行时行为（goal 验收、压缩保留、瀑布选取），静态扫描器查不了「行为对不对」，只有合同测试能钉。
4. **把 manual 规则从登记表删掉「消灭缺口」** —— 删规则 = 删约束，覆盖率数字变好、约束消失，方向反了。

## 7. 验收方式

- 全部数字可复现：`node scripts/ruleguard/index.js coverage` / `manifest`（登记表：`docs/10_规范/registry/rules-registry.json`）。
- 终态目标：enforced 79→约 87（A 类 4 条升级 + C 类补登数）、manual 8→2（MEMORY-001 挂接后 partial、MEMORY-004/PROCESS-001 豁免留册）、carrier 4 全部带 E3 测试、盲区 38→0、零接线检查器 11→0。
- 每期不动既有 79 条 enforced 规则的任何行为；`check:rules` / `rules:coverage` 全程 exit=0。

## 8. 待核实项

| # | 项 | 状态 |
|---|---|---|
| 1 | PROCESS-001 的 P0+manual 组合为何通过 coverage 的 P0 红线（manual 豁免通道在哪个判定分支） | **未核** —— S1 裁决前置，需读 ruleguard coverage 判定源码 |
| 2 | `check-wiring.js` 的扫描范围为何未拦住 11+31 个孤儿检查器（是范围不含 `services/backend/scripts/`，还是已有豁免台账） | **未核** —— D 类处置前置 |
| 3 | `check-rule-scaffold.js` 现有断言面与 PROCESS-101 constraint 的重合度（决定补登即生效还是需先扩断言） | **未核** —— S1 动作前置 |
| 4 | AGENT-001 合同测试所需的行为拍照（AgentTool 现行为基线） | **未核** —— S2 动作前置 |

## 9. 变更日志

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-09-23 | 0.1 | 初稿：coverage/manifest 实测盘点 + 四层依托标准泛化 + A/B 类 12 条逐条处置 + C/D 类批处理战役 + 四期计划 |
