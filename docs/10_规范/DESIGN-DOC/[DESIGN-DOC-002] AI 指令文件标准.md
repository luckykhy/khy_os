# [DESIGN-DOC-002] AI 指令文件标准

<!-- RULES-REGISTRY: DOCS-003 -->

> **用途**：约束 `AGENTS.md` / `CLAUDE.md` / `khy.md` / `.windsurfrules` /
> `.github/copilot-instructions.md` / `.cursor/rules/*` 这类**写给 AI 看的文件**怎么写。
> **核心命题**：这类文件的价值 = 「写进去的内容」∩「AI 实际读到的内容」。
> 交集之外的部分不是"文档冗余"，而是**静默失效** —— 作者以为立了规矩，AI 从未收到。
> 本文把这个交集变成可自动判定的约束，登记为规则 `DOCS-003`。
>
> 上位规范：[MGMT-STD-008]（规则编写元规则）、[MGMT-STD-001]（文档结构与索引铁律）、
> [MGMT-STD-007]（文档规则总纲）。本文不替代它们，只补「AI 指令文件」这一空白面。
>
> **【scope 边界 2026-09-17，DOCS 域四篇分工】** 文档规则族按 scope 分层、互不覆盖
> （依据 `[MGMT-STD-008]` §2.2「重叠即违规」——同域同 subject 必须合并，不靠优先级）：
>
> | 文档 | 管什么 |
> | --- | --- |
> | `[MGMT-STD-007] 文档规则总纲` | 命名 / 放置 / 登记 / 生命周期（总纲，其余为其下位件） |
> | `[DESIGN-DOC-001] 文档结构规范` | `.md` 的**结构**（章节骨架 §12）+ **中文排版**（§13，唯一真源） |
> | **本篇 `[DESIGN-DOC-002]`** | **`AGENTS.md`/`CLAUDE.md`/`khy.md` 一族**（写给 AI 看的文件） |
> | `[DESIGN-DOC-003] README 内容规范` | **`README.md` 一族**（写给人的入口文件），与本篇**互斥** |
>
> 一句话边界：**「给 AI 看的文件」看本篇，「给人看的 README」看 `DOC-003`，
> 「`.md` 怎么写」看 `DOC-001`，「文件该叫什么、放哪」看 `[MGMT-STD-007]`。**

---

## 1. 现状证据（实测，非推测）

### 1.1 读取方分两条链路，预算只存在于其中一条

> ⚠️ **本节初版写错，订正痕迹全文保留以免复发。**
> 初版称「`MAX_FILE_CHARS` 适用于 `CLAUDE.md`/`AGENTS.md`（compat 层）」，
> 并据此算出「`AGENTS.md` 只见 35.3%」。**实测为假** —— 见 §1.2。
> 教训：**不能拿守卫自己的输出当「实测证据」**（当时正是这么做的，构成循环论证）。

指令文件在运行时由**两个不同的读取方**加载，二者的预算互不相干：

| 层 | 文件 | 读取方 | 单文件预算 | 合计预算 |
|----|------|--------|-----------|----------|
| own | `khy.md` / `KHY.md`（及 `.khy/rules/*.md`、`@include` 目标） | `instructionFileService.js` 的 `loadInstructions()` | `MAX_FILE_CHARS` = 8000 | `MAX_TOTAL_CHARS` = 24000 |
| **compat** | `CLAUDE.md` / `.claude/CLAUDE.md` / `AGENTS.md` | `constants/prompts.js` 的 `_findCompatInstructionFiles()` | **无** | **无** |
| eco | `.windsurfrules` / `.cursor/rules/*` / `.github/copilot-instructions.md` … | `instructionFileService.js` 的 `discoverEcosystemInstructionFiles()` | `ECO_MAX_FILE_CHARS` = 4000 | `ECO_MAX_TOTAL_CHARS` = 8000 |

三条判据链（缺一不可，全部可复核）：

1. `instructionFileService.js:35-36` 定义 `MAX_FILE_CHARS` / `MAX_TOTAL_CHARS`，
   但 `readFileSafe()`（`:63`，超限只 `slice`、**不报错不标记**）只在
   `loadInstructions()` 装配 **own 层**时被调用；
2. compat 层由 `constants/prompts.js` 的 `_findCompatInstructionFiles()` 用
   `fs.readFileSync(...).trim()` 读取 —— **没有 `slice`**，随后
   `getProjectInstructionsSection()` 把全文 push 进 `project_instructions` 提示词段；
3. `instructionEcosystemRegistry.js` 明写「Project-level AGENTS.md is already handled
   by prompts.js compatibility discovery」—— 生态层**刻意不重复收纳** compat。

### 1.2 订正：compat 层不截断，「35.3%」是循环论证的产物

初版把 `node scripts/ci/check-agent-docs.js --verbose` 的输出当作「实测」，而那张表的
「AI 可见」列正是**守卫自己按 8000 常量算出来的** —— 守卫套错常量 → 文档引守卫当证据。

正确做法是直接调用真实注入函数量它：

```js
const { getProjectInstructionsSection } = require('./services/backend/src/constants/prompts.js');
const s = getProjectInstructionsSection(process.cwd());
s.length;                                                     // 33823
s.includes(fs.readFileSync('AGENTS.md', 'utf8').trim());      // true（全文 22668 字符都在）
s.includes(fs.readFileSync('CLAUDE.md', 'utf8').trim());      // true
```

| 文件 | 字符数 | 全量进入提示词 |
|------|--------|----------------|
| `AGENTS.md` | 22668 | ✅ 是（`includes()` 命中全文，含最后一行与「工程规则」全部四节） |
| `CLAUDE.md` | 6795 | ✅ 是 |

⇒ **`AGENTS.md` / `CLAUDE.md` 不存在静默截断**。因此本规范对 compat 层**不设字符预算**
（公理 A5：常量从源码读，不得为「看起来该有预算」而自造阈值），**D1 只对 own / eco 两档生效**。

> 连带影响：初版据 §1.2 推出的「`AGENTS.md` 工程规则须拆出」不成立 ——
> 拆了反而把「已 100% 送达」降级成「要 AI 自己点开指针」。公理 A4：**误报的守卫会被整体
> 绕过，比没有更糟**；同理，按错误判据做的重构比不做更糟。规则正文留在 `AGENTS.md`，
> 它仍是 `RUNTIME-001`~`004` 的语义真源（登记表 `ssot` 不动）。

### 1.3 现存违规（订正后 7 条；初版 11 条中 4 条为守卫误报）

**初版 11 条里 4 条经复核是守卫误报**，不是仓库的问题：

| 初版 # | 判据 | 误报原因 | 守卫侧处理 |
|---|---|---|---|
| 1 | D1 | compat 层无读取预算（§1.1/§1.2） | D1 收窄到 own/eco；`AGENTS.md` 保留工程规则正文 |
| 2 | D1 | 同上 | 同上；`tui/AGENTS.md` 不作拆分 |
| 6 | D6 | `[MGMT-STD-001]` §1.3 的管辖范围**显式限于 `.md`/`.txt`**（原文：「白名单之外的任何说明性 `.md`/`.txt`」），`.windsurfrules` 无扩展名，不在辖区内 | D6 根级分支复用 `check-repo-layout.js` 的 `ROOT_DOC_EXT_RE` |
| 7 | D6 | 同上 | 同上 |

真实违规 7 条，**已在收口步全部清零**：

| # | 级别 | 判据 | 位置 | 事实 | 收口处理 |
|---|------|------|------|------|----------|
| 1 | error | D6 | `_产物/khy.md` | 指令文件落在资产暂存区，读取器不扫；内容是**另一个项目（Y-CODE）**的开发指南，全仓零引用 | 删除（备份 `.khyos/tmp/khy.md.bak`） |
| 2 | error | D3a | `tui/AGENTS.md:684` | `npm run --workspace backend test:tui` —— `backend` 既不是 workspace 路径也不是包名（真名 `khy-os-backend`），npm 报 `No workspaces found` | 改为 `--workspace services/backend`（`test:tui` 确存在于 `services/backend/package.json`） |
| 3 | warning | D2 | `tui/AGENTS.md:5` | 自封「与根目录 `AGENTS.md` 冲突时以本文件为准」，未登记 | 改为声明**不自封**优先级，并说明运行时由 cwd 决定各自生效 |
| 4 | warning | D3c ×2 | `AGENTS.md:729` | 引用 `[GUIDE-001]`/`[GUIDE-002]`，两篇连同整个 GUIDE 阶段目录已不存在 | 删除「文档合规（2026-09-12 重构）」变更日志节（信息已固化在 `[DESIGN-GOV-001]` §8） |
| 5 | warning | D3d | `CLAUDE.md:53` | 引用 `.claude/commands/goal.md`，`.claude/` 下只有 `worktrees/` | 移除该死引用 |
| 6 | warning | D3d | `apps/khyos-desktop/CLAUDE.md:99` | 引用 `scripts/ci/check-brand-replacement.js`，全仓不存在该守卫 | 改为如实记载「无自动守卫，按下表人工核对」 |

> **收口后实测**：`node scripts/ci/check-agent-docs.js` → **0 error / 0 warning**
> （9 个指令文件）。基线已收紧到 `"DOCS-003": 0`（只降不升），回归即刻阻断。

---

## 2. 设计公理（不可让渡）

| # | 公理 | 推论 |
|---|------|------|
| **A1** | **到不了就等于没写** | 有效性以「预算内的字符」计量，不以文件里的字符计量。任何超出预算的内容必须在**写作时**就被拒，而不是运行时被切 |
| **A2** | **一个事实只有一个真源** | 复述即漂移。指令文件可以给指针，不可以给副本 |
| **A3** | **优先级只能登记，不能自封** | 文件里写「以本文件为准」不产生任何效力；效力来自登记表 + 运行时读取顺序 |
| **A4** | **示例与契约必须可区分** | 无法区分的守卫必然误报；误报的守卫会被整体绕过，比没有守卫更糟 |
| **A5** | **常量从源码读，清单从既有注册表派生** | 预算不得硬编码（否则与 `instructionFileService.js` 漂移）；候选文件集不得另立真源（否则与 `instructionEcosystemRegistry.js` 漂移） |

---

## 3. 与既有机制的边界

本仓库已有多个机制触碰这些文件。**本文只补缺口，不重复它们**：

| 既有件 | 它管什么 | 本文做什么 | 边界 |
|--------|----------|-----------|------|
| `scripts/ci/check-repo-layout.js` `ROOT_DOC_WHITELIST` | 根目录**能不能放**（`AGENTS.md`/`CLAUDE.md`/`khy.md` 已在白名单） | 放进去之后**写什么** | 位置 vs 内容。D6 只报「未登记的根级指令文件」，不改白名单 |
| `scripts/ci/check-rules-registry.js`（`TOOLING-007`） | 登记表 `ssot` 指向的文件，其 `RULES-REGISTRY` 标记行双向可达 | 把覆盖扩到**所有**引用已登记规则 ID 的指令文件，含子级（`tui/AGENTS.md` 等目前完全不可见） | D4 是 TOOLING-007 的**补集**，不重复其结论 |
| `khy metadata link`（`services/backend/src/services/metadataPointers.js`） | 生成 `<!-- khy-metadata:pointer -->` 块 | 只校验块 **START/END 成对**，不生成、不改内容 | D5 不实现生成器 |
| `instructionFileService.js` | 运行时读取（预算、截断、`@include`、注入扫描） | 把它的常量当**判据来源** | 本文不改读取行为，只让写作侧提前知道边界 |
| `instructionEcosystemRegistry.js` | 声明式生态来源清单（24 个来源） | 从它派生候选文件集 | 不另立文件清单真源 |
| `[MGMT-STD-001]` / `[MGMT-STD-007]` / `[MGMT-STD-008]` | 文档结构铁律 / 文档规则总纲 / 规则编写元规则 | 本文是 `DOCS` 域第三条规则，**服从**三者 | 不新增元规则 |

---

## 4. 强度梯度

**取向：事前 advisory、事中 warning、事末 error。** 过早阻断会逼 AI 谎报"已确认/已复现"，
反而比不拦更危险。

| 时机 | 强度 | 内容 |
|------|------|------|
| 起草前 | advisory | 告知 tier 与预算；建议写作线 **6000 字符**（留 25% 余量，因中文 1 字符 ≈ 3 字节但预算按字符算） |
| 提交时 | warning | D2 / D3b / D3c / D3d / D4 / D6(根白名单) / D7 / D8 |
| 提交时 | error | D1 预算超限 · D3a npm 脚本与 workspace 死引用 · D5 机器块不成对 · D6 落在 `_产物/` |

规则登记：`DOCS-003`，`priority=P2`，`gate=pr`，
执行器 `scripts/ci/check-agent-docs.js`，走 `ruleguard-baseline.json` 棘轮。

---

## 5. 防呆铁律

每条都必须**可自动判定**，判据只看客观证据（文件字节、源码常量、注册表结果），
**不接受 AI 自称**。

| # | 铁律 | 可自动判的判据 |
|---|------|----------------|
| **F1** | **预算铁律**：任一指令文件字符数 ≤ 其 tier 的 `perFile` 预算；建议 ≤ 6000 | `fs.readFileSync(f,'utf8').length` vs 源码常量 |
| **F2** | **真源唯一**：同一事实只在一处定义，其余为指针 | 跨文件 ≥160 字符逐字重复段落检测（排除机器管理块） |
| **F3** | **优先级登记制**：非根指令文件不得自行宣布覆盖他者 | 命中 `以本文件为准`/`优先于` 等句式 **且** 登记表无该文件**字面**路径登记 |
| **F4** | **死指针零容忍**：路径、`npm run` 脚本、`khy` 子命令、`[域-NNN]` 编号必须真实可达 | 见 §6 判据细则 |
| **F5** | **机器块只读**：`khy-metadata:pointer` 块由工具覆写，人工改动无效 | `START` 计数 == `END` 计数 |
| **F6** | **示例显式化**：示意性内容必须落在可识别语境（`❌`/`✅` 对照块，或紧邻标题含「示例/example/映射/示意」） | 围栏块内容 + 上溯 6 行语境 |
| **F7** | **落点铁律**：指令文件只放在读取器会扫的位置 | 不在 `_产物/`；根级文件须在白名单内 |

### 6. 判据细则（F4）

| 子判据 | 判据 | 踩过的坑（已固化进守卫） |
|--------|------|--------------------------|
| D3a `npm run` | 脚本名必须在**就近 `package.json`** 中；带 `--workspace <id>` 时 id 必须在根 `workspaces` 数组内，且脚本在该 workspace 包中 | ①只查根 `package.json` 会把 `apps/khyos-desktop/CLAUDE.md` 里的 `npm run dev` 全判死（子包脚本）；②参数可出现在脚本名**之前**（`npm run --workspace X test`），朴素正则会把 `--workspace` 当脚本名 |
| D3b `khy` 子命令 | 必须在 `aliases.js` ∪ `commandAutoRegistry` 的**实际注册结果**中 | `metadata` 不在别名表里却真实可达（自注册）；反过来「`handlers/` 下有同名文件」**不等于**可达（需导出命令清单） |
| D3c `[域-NNN]` | 要么在 `RULES-REGISTRY.json`，要么全仓存在同名文档 | ①`[DESIGN-ARCH-*]` 是**文档编号**不是规则 ID，混判会大面积误报；②只扫根 `docs/` 会漏掉子项目 `apps/khyos-desktop/docs/` |
| D3d 路径 | 必须**根锚定**（首段是真实顶层目录）、非占位符（`your*`/`xxx`/`example`/`...`）、且完整路径或 basename 在仓内存在 | ①`handlers/yourCmd.js` 是填空模板；②`ink-components/Viewport.js` 是文件内相对简写；③`.ai/` 下是生成物，按需存在 |

---

## 7. 写作规约（正面清单）

写一份新的 AI 指令文件时：

1. **先算预算**。目标 ≤ 6000 字符。超了不是"再写长点"，而是**拆**：细节移入 `docs/`，
   文件里只留指针 + 摘要（这正是 [MGMT-STD-008] §3.2「正文只做指针+摘要」）。
2. **开头放 `RULES-REGISTRY` 标记行**（若该文件承担任何已登记规则的语义真源）：
   `<!-- RULES-REGISTRY: DOCS-003 -->`
3. **标注每节角色**（真源 / 指针 / 速查），像根 `AGENTS.md` 现有做法那样。
4. **不要复述语言策略**等已有真源的事实 —— 给指针。
5. **要声明优先级，先登记**：在 `RULES-REGISTRY.json` 相应条目的 `paths` 里写该文件的
   **完整字面路径**（不含 `*`），再在正文声明。
6. **示例放进 `❌`/`✅` 对照块**，或让紧邻标题含「示例」字样。
7. **机器管理块不要手改**：`khy-metadata:pointer` 块由 `khy metadata link` 覆写。

---

## 8. B-L2 三步接线清单

> 依据 `SOURCING-006`：**一次提交只做一步，不得合一**。
>
> **执行状态**：第 1 步 ✅ 已落地；第 2 步 ✅ 已落地（含**登记表修复**与**执行器
> 解释器缺陷修复**各一处，见下方「执行实录」）；第 3 步 ⏳ 未开始
> （存量 11 条与基线归零留待收口）。

### 第 1 步 · 标记

1. `docs/10_规范/registry/RULES-REGISTRY.json`：在 `rules` 追加 `DOCS-003` 条目（字段齐全，
   含 `nature`/`grants`/`benefit` 三元，**`grants` 必须与 `constraint` 边界配对**）；
   `meta.ruleCount` 与 `rules.length` 必须同步（**登记表自身就是第一处会漂移的真源**：
   落地时实测 `rules.length` 比 `meta.ruleCount` 多 1）。
2. 本文顶部已有 `<!-- RULES-REGISTRY: DOCS-003 -->` 标记行 → `TOOLING-007` 双向可达满足。
3. ~~`AGENTS.md` 顶部标记行追加 `DOCS-003`~~ —— **不需要，且做了是错的**。
   `RULES-REGISTRY` 标记行的语义是「**本文件是这些规则的语义真源**」，
   不是「本文件受这些规则管辖」。`AGENTS.md` 是 `RUNTIME-001`~`004` 的真源，不是
   `DOCS-003` 的真源；往里塞 `DOCS-003` 等于伪造一条 ssot 声明。
   `check-rules-registry.js` 的孤儿标记检查只扫**登记表 `ssot` 指向的文件**，
   因此 `AGENTS.md` 不写也不会红。
4. 回写两处索引（本文已随交付完成，见 §10）。

**验收**：`npm run check:rules-registry`、`npm run check:gov-rules` 绿。

### 第 2 步 · 迁移

5. `_产物/check-agent-docs.js` → `scripts/ci/check-agent-docs.js`
   （脚本已按可重定位写：仓库根靠 `RULES-REGISTRY.json + package.json` 向上查找，
   移动后无需改路径）。
6. `package.json` 加别名 `"check:agent-docs": "node scripts/ci/check-agent-docs.js"`
   —— **不加会被 `check-wiring.js` 判 error（检查器零接线）**。
7. `scripts/ci/ruleguard-baseline.json` 的 `counts` 记入当前观测存量
   （**实测 `"DOCS-003": 11`**），此后**只降不升**。

   > ⚠️ 取值陷阱：`run.js` 对 `strength === 'ratchet'` 的规则**按全部 finding 计数**
   > （`ratchetObserved[rule] += 1` 在 severity 分支之外，error 与 warning 都算）。
   > 只看 `Summary: 4 error(s)` 会填成 `4`，而实测观测值是 `4 + 7 = 11` ——
   > 填 `4` 会让 pr 档当场判 7 条超额阻断。取值须用 `rules:gate` 的 JSON 报告核对，
   > 不要数人类可读摘要里的 error 行。
8. 生成规则卡：`npm run docs:rules-cards`（`docs/10_规范/规则卡/` **禁止手改**）。

**验收**：`npm run check:wiring`、`npm run rules:coverage`、`npm run rules:manifest` 绿。

#### 执行实录 · 落地时发现并修掉的两处既有缺陷

**A. 登记表丢失两条规则（已修复）**。以 `git` 索引副本为基线重建登记表时，
`LAYOUT-004`（仓库整理与巡检）、`LAYOUT-005`（构建产物单一根）被漏掉 ——
索引副本停留在 66 条，工作区已是 68 条（状态 `AM`，索引落后工作区）。
修复方式：以 `docs/10_规范/规则卡/` 的 68 张卡为反查真源逐条比对，按卡内
frontmatter 14 字段原样插回，并把 `meta.ruleCount` 校正为 69。
**教训**：`git status` 为 `AM` 时，索引**不是**工作区基线，拿索引当基线重建等于回滚别人的未提交改动。

**B. 登记表里 56 处路径停在已废止的 `docs/_规范/` 形式（已修复）**。
`[DESIGN-LAY-002]` 已明文废止「`_` 前缀 = 跨阶段资产」这一含义，文档侧早已迁到
`docs/10_规范/`，但 `RULES-REGISTRY.json` 是 `.json`，**没被那轮只扫 `.md` 的路径迁移
扫到**。后果是 `check-rules-registry.js` 报 36 条「语义真源文件不存在」+ 40 张规则卡
被判「产物过期」（卡里是对的，登记表里是旧的，于是「卡与登记表不一致」）。
修复方式：`docs/_规范/` → `docs/10_规范/`（含 `ssot` 与 `enforcement` 两处字段），
再 `npm run docs:rules-cards` 重生成。**修复后 `check-rules-registry` 由 39 error 降到 0。**

**C. 顺带清掉一条 `check-wiring` 存量债**。`LAYOUT-004` 声明的执行器
`scripts/maintenance/organize.py` 此前零接线（2 条 error：检查器零接线 + 声明未挂门）。
本次在 `package.json` 补 `"maintenance:organize"` 别名接线，`check-wiring` 转绿。

**C2. `ruleguard` 对 `.py` 执行器的解释器缺陷（已修复）**。C 步把 `organize.py`
接进门之后，立刻暴露出一条**实质缺陷**：`scripts/ruleguard/lib/wiring.js` 的
`CHECKER_SUFFIXES = ['.js', '.mjs', '.cjs', '.py']` 收 `.py` 为检查器，但
`lib/run.js` **一律** `spawnSync(process.execPath, [script, ...args])` —— `.py` 被
`node` 当 JS 解析，必然失败。表现为一条 `checker-failure`（因 `LAYOUT-004` 是 P2 /
ratchet 而**不阻断**，所以此前长期无人察觉）。

修复方式（两步，均为叶子改动，不碰业务）：

1. 新建 `scripts/lib/pythonInterpreter.js` —— 纯叶子模块，零外部依赖、确定性、
   **绝不抛**；导出 `interpreterFor(scriptRel)` / `runnerLabel(scriptRel)` /
   `resolvePythonCommand()`，并支持注入 `spawn` 以便离线单测。
   探测**按退出码判定**而非「命令是否存在」：Windows 未装 Python 时 `python` 会被
   Microsoft Store 的占位程序接管（命令存在、能启动、退出码非 0），只查 `which`
   会误判为可用。候选顺序 Windows 为 `python → py → python3`，POSIX 反之。
   刻意**不复用** `scripts/ci/run-python.js`：那是 CLI 不是模块，且它
   `require('../../services/backend/src/tools/platformUtils')` 是会被
   `check:layout` 的 `cross-layer-require` 计入基线的跨 workspace 深层相对 require。
2. 改造 `scripts/ruleguard/lib/run.js` —— 按后缀分派解释器
   （`.py` → python，其余 → `process.execPath`）；拿不到解释器时不 spawn，
   直接以 `runner.reason` 生成可读的 `checker-failure`；文案统一改用 `runnerLabel()`
   显示真实启动命令（`python x.py` / `node x.js`）。

**验收**：叶子单元探针 8 项全过（候选顺序、只认退出码 0、异常不炸、
`.py`→python / `.js|.mjs`→node、缺解释器给可读 reason）；实测
`python scripts/maintenance/organize.py --report` → **exit 0、耗时 1.44s**；
修复后 pr 档实测 `LAYOUT-004` 的 `checker-failure` **由 1 条降为 0 条**。

**D. 更深的接线缺口：pr 档 ruleguard 没有被任何 CI workflow 调用（已登记，未修）**。
本次实测：`.github/workflows/pr-gate.yml` 逐条列了 20 余个 `node scripts/ci/*.js` 步骤与
`ruleguard/index.js coverage`，**唯独没有 `npm run rules:gate`**（= `ruleguard run --mode pr`）；
`check:structure` 的 `&&` 链里也没有它。`.githooks/pre-commit` 只跑 `--mode commit`，
而 commit 档**只选声明了 `--changed` 的执行器** —— 本规则的 `exec.args = []`（有意为之，
见上文「不加 `--changed`」的理由）→ **它在 CI 里不会自动执行**。

> 也就是说：`check-wiring.js` 判绿的「已接线」= 「执行器被某个门**表面**引用」，
> 而 `check:agent-docs` 别名本身就构成一个表面。**「表面被引用」≠「CI 真的会跑」** ——
> 这条差别 `check-wiring.js` 按设计不管（它管孤儿，不管调用时机）。
> 修复代价：给 `pr-gate.yml` 加一步 `npm run rules:gate` 会同时跑 31 个执行器，
> 其中 3 个（`validate-json-schemas` / `check-code-standards` / `check-protocol-naming`）
> **当前就是 blocking 失败**（exit 1 且无可解析 finding）→ 先得修那三条。
> 故本步并入第 3 步「收口」，不在本次范围。

### 第 3 步 · 收口

9. 清理 §1.3 的存量（**订正**：初版「预算超标的两份靠拆分」不成立，见 §1.2；
   实际清掉的是 7 条真违规，另 4 条是守卫误报 → 改守卫而非改仓库）。
10. 收紧基线到 0，把 `DOCS-003` 从 `P2` 提级或保持棘轮。

**执行状态**：第 3 步 ✅ 已落地（2026-09-16）。

| 项 | 结果 |
|---|---|
| 真违规 | 7 条全部清零（`node scripts/ci/check-agent-docs.js` → 0 error / 0 warning） |
| 误报 | 4 条（D1 ×2、D6 ×2）→ 收窄守卫，另加 1 条收口途中新发现的 D2 误报 |
| 拆分 | **撤回**：`AGENTS.md` 不拆，仍是 `RUNTIME-001`~`004` 的语义真源，登记表 `ssot` 不动 |
| 基线 | `ruleguard-baseline.json` 的 `"DOCS-003"` 由 `11` 收紧到 **`0`** |
| 优先级 | **保持 P2 + 棘轮**（基线 0 已等价于「新增即阻断」；提 P1 会让它跳过棘轮直接阻断，与「P2 先记账」的设计意图不符，且当前无存量可记，保持 P2 更稳） |
| 场景矩阵 | 17 → **22**（新增 5 个对照场景，见 §9） |

> **门档不用改**：commit ⊂ pr ⊂ release 的成员资格从登记表派生（`[DESIGN-ARCH-111]`），
> **不要**动 `qualityGateStages.js` 或 `package.json` 的 `&&` 链。
> 本次实测印证：加 `DOCS-003` 后 pr 档自动多跑一个执行器（`checkersRun` 31），
> 无需改任何门档文件。

#### 执行实录 · 收口步

**E. 最大的一处订正：D1 的适用范围写错了（已修复）**。初版把
`instructionFileService.js` 的 `MAX_FILE_CHARS` 当成 compat 层的预算，据此判定
「`AGENTS.md` 只见 35.3%」。复核发现 compat 层根本不由它读取 —— 真实读取方是
`constants/prompts.js`，**无预算、全量注入**（实测 `getProjectInstructionsSection()`
返回 33823 字符，含 `AGENTS.md` 全文）。详见 §1.1/§1.2。
**根因**：初版把「守卫自己的输出」当成了实测证据 —— 守卫套错常量，文档再引守卫，
构成循环论证。**教训：守卫的输出不能自证其判据，判据必须回到运行时源码复核。**

**F. 连带撤回拆分**。收口初动时曾按初版清单新建
`docs/10_规范/[DESIGN-RUNTIME-001] 工程规则…` 并准备搬走 `AGENTS.md` 的工程规则正文 +
迁移 `RUNTIME-001`~`004` 的 `ssot` + 挪 `RULES-REGISTRY` 标记行。发现 §1.2 为假后立即
**撤回**（新文档已删，登记表未改）。理由：拆了会把「已 100% 送达」降级成「要 AI 自己
点开指针」，是净损失。

**G. D6 根级分支的管辖范围越界（已修复）**。`.windsurfrules` / `.clinerules` 被判
「不在根目录白名单」，但它们由 `khy metadata link` 生成、已在
`instructionEcosystemRegistry.js` 声明；而 D6 所引真源 `[MGMT-STD-001]` §1.3 的管辖
范围**显式限于 `.md`/`.txt`**。修复：D6 根级分支复用 `check-repo-layout.js` 的
`ROOT_DOC_EXT_RE`（A5：常量从源码读），**只收窄根级分支**，`_产物/` 分支不受影响。

**H. D2 的「优先于」过宽（已修复）**。收口途中 `tui/AGENTS.md:27`
「✅ 新增文件优先于修改现有文件」被判为自封优先级 —— 那是普通编码指引，宾语不是
指令文件。修复：`优先于` 命中时要求**同一行**出现指令文件宾语
（`AGENTS|CLAUDE|KHY.md` / 根目录 / 上级 / 根级 / 指令文件），否则放行。

---

## 9. 验证与反例清单

迁移后的 `scripts/ci/check-agent-docs.js` 支持 **26 个**预置场景，`--scenario=<名>` 可复现。
**15 个应拦、11 个应放行**（放行对照证明不是无脑拦）。下表「实测」列为**逐条实跑**结果
（`for s in ...; do node scripts/ci/check-agent-docs.js --scenario=$s; done`）：

| 场景 | 期望 | 实测 |
|------|------|------|
| `budget-overflow` | D1-budget（own 层 `khy.md`） | ✔ 1 error |
| `budget-within` | **放行** | ✔ 0 |
| `budget-compat-exempt` | **放行**（compat 无读取预算） | ✔ 0 |
| `budget-eco-overflow` | D1-budget（eco 层 4000） | ✔ 1 error |
| `precedence-usurp` | D2-precedence | ✔ 1 warning |
| `precedence-ordinary-wording` | **放行**（「优先于」宾语非指令文件） | ✔ 0 |
| `dead-npm-script` | D3a | ✔ 1 error |
| `bad-workspace` | D3a（workspace 名非法） | ✔ 1 error |
| `dead-cli-command` | D3b | ✔ 1 warning |
| `live-cli-command` | **放行**（`metadata` 靠自注册可达） | ✔ 0 |
| `unknown-rule-id` | D3c | ✔ 1 warning |
| `subproject-doc-id` | **放行**（子项目 docs/ 的编号） | ✔ 0 |
| `dead-path` | D3d | ✔ 1 warning |
| `relative-shorthand` | **放行**（文件内相对简写） | ✔ 0 |
| `missing-marker` | D4-marker | ✔ 1 warning |
| `broken-managed-block` | D5 | ✔ 1 error |
| `wrong-location` | D6（`_产物/`） | ✔ 1 error |
| `root-md-not-whitelisted` | D6（根目录 `.md` 未登记白名单） | ✔ 1 warning |
| `root-eco-dotfile` | **放行**（无扩展名生态文件不在 §1.3 辖区） | ✔ 0 |
| `contrast-block` | **放行**（`❌`/`✅` 对照块） | ✔ 0 |
| `duplication` | D8 | ✔ **2 warning**（A 与 B 各报一条：D8 按文件分报，见 §5 铁律） |
| `mirror-undeclared` | D9（声明了不存在的孪生面） | ✔ 1 warning |
| `mirror-one-way` | D9（孪生面存在但无反向声明） | ✔ 1 warning |
| `mirror-both-ways` | **放行**（双向声明） | ✔ 0 |
| `mirror-no-declaration` | **放行**（未声明 MIRROR 就不查） | ✔ 0 |
| `clean` | **放行** | ✔ 0 |

> 新增 5 个对照场景（`budget-compat-exempt` / `budget-eco-overflow` /
> `precedence-ordinary-wording` / `root-md-not-whitelisted` / `root-eco-dotfile`）
> 是收口步修掉的 5 处误报的**回归锁**：每一处都同时有「应拦」与「应放行」两条对照，
> 确保收窄判据时**没有把闸门整条废掉**。

> **D9 的 4 个场景是成对设计的**（2026-09-17 新增，承载 HQ 丢弃后的替代保障，见 §11.6）：
> `mirror-one-way` 与 `mirror-both-ways` 使用**同一对虚拟文件**，只差第二个文件有没有
> 反向声明 —— 缺了放行对照，「单向报错」这个断言就证明不了它不是「凡有 `MIRROR` 就报」。
> **两个设计陷阱（实测踩过，勿重犯）**：
> ① 场景文件是**虚拟的**（不落盘），孪生面查找必须能命中 `--scenario` 的文件集，
>    否则每个场景都退化成「文件不存在」（守卫为此加了 `virtualFiles` 参数）；
> ② **不要拿仓库真实文件当孪生面** —— `AGENTS.html` 一旦补上反向声明，
>    `mirror-one-way` 就会静默转绿。场景必须自包含、与仓库状态解耦。

---

## 10. 复现方式

```bash
# 全仓扫描（人类可读）
node scripts/ci/check-agent-docs.js --verbose

# 机器可读
node scripts/ci/check-agent-docs.js --json

# 只看指定文件
node scripts/ci/check-agent-docs.js --files=AGENTS.md,CLAUDE.md

# 反例矩阵
node scripts/ci/check-agent-docs.js --list-scenarios
node scripts/ci/check-agent-docs.js --scenario=budget-overflow
```

> 上列命令均已指向迁移后的正式位置。原型副本（`_产物/check-agent-docs.js`）已随第 2 步
> 完成迁移，`_产物/` 只保留非文档资产；`--list-scenarios` / `--scenario=` 两个自检开关
> 随脚本一并迁移，用于回归反例矩阵。

退出码契约与 `scripts/ci/` 其余检查器一致：`0` 干净、`1` 有 finding、`2` 用法错误。

**基线**：

- 接线时（2026-09-16 第 2 步）：扫描 10 个指令文件 → `4 error(s), 7 warning(s)`。
  `ruleguard` 对 P2 规则按**全部** finding 计数（error 与 warning 都算），故棘轮基线记 `11`
  （见 §8 第 2 步第 7 项）。
- **收口后（第 3 步）：存量清零 → `0 error(s), 0 warning(s)`（9 个指令文件），
  基线收紧为 `"DOCS-003": 0`** —— 此后任何新增 finding 都会立即超额阻断。

---

## 11. 已知边界与未覆盖

诚实登记本规范的**不覆盖项**，避免读者高估其保证：

1. **不校验机器块的块内内容**是否与 `metadataPointers` 生成结果一致（只校验成对）。
   需要更强的保证时，应由生成器侧提供 `--check` 模式。
2. **不校验合并总量**（`MAX_TOTAL_CHARS=24000`）。当前实测合并 16,597 字符未超限，
   但拆分 `AGENTS.md` 后需重新核算。原型已打印该预算，判据待补。
3. **D8 重复检测是启发式的**（≥160 字符、按空行分块）。格式化差异会导致漏报。
4. **不覆盖 `~/.khyquant/khy.md`** 等用户级文件 —— 它们在仓库外，本规范无管辖权。
5. **`.research-tmp/` 下的第三方克隆不扫描**（非本仓资产）。
6. **D9 只做「可离线判定」的那一半，不含提交时序**（2026-09-17 新增）。
   D9 的来历：指挥部仓库 `khy-os-hq` 的 `drivability` 检查曾强制
   「`CLAUDE.md` 与 `AGENTS.md` 必须同步修改」；HQ 被 khy-os 吸收
   （见 `[DESIGN-ARCH-118]`）后，这条机械保障在本仓**没有等价守卫**，
   双入口会静默漂移。D9 补上其中**能离线判定**的部分：孪生面是否真的存在、
   是否真的互相声明。**明确不覆盖**：
   * 「同一次提交里两面都改了」这类**时序**判定 —— 需要读 git 历史，
     会让检查器依赖工作区状态（违反本规范的「确定性、可离线跑」纪律），
     且「同一次提交」在 rebase/合并后会失真。该纪律留给 `PROCESS-005` 的人工评审。
   * **未声明 `<!-- MIRROR: X -->` 的文件完全不查** —— 这是刻意的（公理 A4
     「误报比漏报更贵」）：全仓 1000+ 个 `.html` 孪生件里绝大多数是文档构建产物，
     把「凡 `.md` 都要有 `.html`」做成硬拦会淹掉真正的漂移。
   * D9 定为 **warning 而非 error**：孪生件由 `build_docs_site.js` 批量重写，
     存在真实的不同步窗口，定 error 会让开发者在构建产物抖动时被误伤。
