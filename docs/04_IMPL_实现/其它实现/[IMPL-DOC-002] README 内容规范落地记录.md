# [IMPL-DOC-002] README 内容规范落地记录

> **用途**：`[DESIGN-DOC-003]`（规则 `DOCS-004`）的**证据层与落地层**。
> 规范正文按 `[DESIGN-DOC-001]` §12 骨架压到 ≤150 行，只保留可判定的红线条文；
> 实测证据、设计公理、判据论证、执行器接线设计与未覆盖项全部放在本文。
>
> **本文不是契约**。契约以 `[DESIGN-DOC-003]` 为准；本文若与正文冲突，以正文为准。

---

## 1. 实测证据（非推测）

> 遵循 `[DESIGN-DOC-002]` §1 的教训：**守卫自己的输出不能自证其判据**。
> 本节所有数字均为直接读文件或跑脚本所得，复现命令见 §5。

### 1.1 README 是唯一「零内容管辖」的文档族

| 既有机制 | 它管 README 的什么 | 不管什么 |
|---|---|---|
| `check-repo-layout.js` 的 `ROOT_DOC_WHITELIST` / `README_VARIANT_RE` | 根目录**能不能放**、名字是否形如 `README.<lang>.md` | 放进去之后**写什么** |
| `check-agent-docs.js`（`DOCS-003`） | **明确不管** —— 登记表 `exception` 原文「docs/ 下的普通文档不受本条约束」，`classify()` 也从不匹配 `README.md` | —— |
| `DOCS-001` / `DOCS-002` | 只管 `docs/**` 内的编号命名与索引 | `docs/` 之外的 README 不受编号约束 |
| `verify_docs_site.js`（LAY-5） | `.md` 必须有同名 `.html` 孪生 | 孪生里写什么 |

实测 `grep -c -i readme docs/10_规范/registry/RULES-REGISTRY.json` → **0**（登记 70 条规则时）。
全仓没有任何一条规则的 `scope` / `paths` / `constraint` 提到 README。

⇒ README 在**位置**上被治理，在**内容**上完全空白。

### 1.2 存量规模：36 个 README，跨 8 个层级

`find . -iname "README*.md"`（排除 `node_modules` / `.git` / `dist` / `build` / `_build` /
`.research-tmp` / `.khy`）→ **36 个**。按 `[DESIGN-DOC-003]` §1.3 判据分类：

| 档位 | 数量 | 代表 |
|---|---|---|
| T0 仓库入口 | 1 | `README.md`（290 行，本轮修订前） |
| T1 部署单元 | 9 | `apps/ai-frontend`、`services/backend`、`software/khyquant/frontend`、`kernel`、`tools/deepseek-eyes`、`extensions/tools/khy-markdown` … |
| T2 内部模块 | 26 | `scripts/*`、`extensions/scripts/khy-desktop-rd/**`、`services/backend/src/contracts/**` … |

同时发现 2 个**命名违规**与 2 个**孪生件孤儿**（即 `[DESIGN-DOC-003]` §1.5 与 §1.1 的存量）：

- `kernel/bridge/README-联调.md`、`scripts/release/README-runtime-placement.md` ——
  不匹配 `README_VARIANT_RE = /^README(?:\.[A-Za-z-]+)?\.md$/`（连字符后接 CJK / 英文词均不匹配）；
- `apps/khy-mobile/README.html`、`apps/khy-mobile/release/README.html` —— 有 `.html` 无同名 `.md`。

### 1.3 漂移实测：根 README 290 行里 5 处失实，**全部是「复述真源」类**

2026-09-17 对当时的 `README.md` 逐条核对真源，发现 5 处失实。
**没有一处是文笔或遗漏问题，全部是「README 抄了一份本该由别处维护的事实」**：

| # | README 原文 | 真值 | 真源（**给符号名，不给行号**） |
|---|---|---|---|
| 1 | 「前端管理界面 `http://localhost:3000` / 后端 API `http://localhost:5000`」 | AI 前端 **8090**、后端 **3000** | `constants/serviceDefaults.js` 的 `WEB_FRONTEND_PORT` / `BACKEND_PORT`；`apps/ai-frontend/vite.config.js` 的 `server.port` |
| 2 | 「`run.ps1` 等价于 `npm run dev`」「`run.ps1 build` → `npm run build`」 | 根 `package.json` **不存在** `dev` / `build` 脚本 | 根 `package.json` 的 `scripts`（curated 入口表） |
| 3 | 目录树含 `alpine/`、`_source/`；未含 `deploy/ electron/ patches/ tests/`；`apps/` 只列 1 个 | `alpine/`、`_source/` 不存在；`apps/` 实为 5 个 | `ls` + `check-repo-layout.js` 的 `LAYERS` / `CROSSCUTTING` |
| 4 | 「必须同步更新以下**三处**真源」 | **三轨道 9 真源**（G2 已含 `plugin-sdk`） | `check-version-sync.js` 的 `VERSION_GROUPS` |
| 5 | 「Node.js ≥ 20」 | `engines: ">=20.18.1"` | `services/backend/package.json` 的 `engines.node` |

> **本表的教训**：初版本表写的是行号（`serviceDefaults.js:89,99`、`check-repo-layout.js:117,128`）。
> 编写过程中 `scripts/ci/check-repo-layout.js` 被并发改动，`README_VARIANT_RE` 从第 128 行
> 移到第 136 行，初版引用当场失准 —— **连「记录漂移」的表格自己都在漂移**。
> 已全部改为符号名。这直接催生了 `[DESIGN-DOC-003]` §1.2 的「给符号名，不给行号」红线。

**定量**：5 / 290 ≈ **1.7% 行失实**，但失实**只出现在 6 类「复述真源」的内容**里；
同一份 README 的定位、架构说明、约定类正文**零漂移**。

⇒ 结论：漂移不是「作者不认真」，而是**结构性**的 —— README 天然想「一页说清全部」，
而「全部」里混进了必须随真源变化的事实。**修法是删掉复述，不是提醒作者更勤快。**

---

## 2. 设计公理（不可让渡）

| # | 公理 | 推论 |
|---|------|------|
| **A1** | **入口不做真源** | README 里任何**可被验证的事实**都必须来自某处真源；README 只允许「指针 + 稳定摘要」。可被验证 = 会变（端口、版本、脚本名、清单） |
| **A2** | **没跑过的命令不许写** | 每条命令在写作时**必须实际可执行**。README 是读者的第一份合同，写一条跑不通的命令比少写一条的代价高得多 |
| **A3** | **档位决定内容，不搞统一模板** | 必备节是档位的函数。统一模板会逼 17 行的模块 README 长出「架构总览」 |
| **A4** | **首屏即结论** | 陌生人（或半年后的自己）只看第一屏，就要能判断「这是不是我要的东西」「我能不能跑起来」 |
| **A5** | **README 不是台账** | 进度、TODO、变更日志、临时说明各有真源（任务板 / `CHANGELOG.md` / `tests/DEBT.md`） |

> **A3 的重要限定**：必备节是**下限**，不是上限。本文禁止的从来不是「写得多」，
> 而是「复述真源」（A1）。一份 T2 README 写满 200 行是可以的，只要不含事实副本。

---

## 3. 与既有机制的边界

| 既有件 | 它管什么 | `DOCS-004` 做什么 | 边界 |
|--------|----------|------------------|------|
| `check-repo-layout.js`（`ROOT_DOC_WHITELIST` / `README_VARIANT_RE`） | 根目录**能不能放**、命名变体正则 | 放进去之后**写什么**；据 1.5 登记 2 个现存命名违规 | 位置 vs 内容。**不修改**白名单与正则，只引用 |
| `check-agent-docs.js`（`DOCS-003`） | `AGENTS.md` / `CLAUDE.md` / `khy.md` 一族 | README 一族（其 `exception` 已明示不在其辖区） | 两族互斥，无重叠管辖。可达性判据**直接复用** D3a/D3b/D3d，不另写一套 |
| `DOCS-001` / `DOCS-002` | `docs/**` 内文档的编号命名与索引登记 | `docs/` **之外**的 README 内容 | `docs/**` 下的 README（现存 1 个 `[DEPLOY-MAN-004] README.md`）仍受 `DOCS-001` 命名；`DOCS-004` 只适用 `[DESIGN-DOC-003]` §1.1 禁项表 |
| `verify_docs_site.js`（LAY-5） | `.md` ↔ `.html` 孪生**存在性**，硬门 | 只声明「`.html` 禁止手改」 | 不重实现孪生校验 |
| `check-version-sync.js` | manifest 之间的版本一致（9 源） | 禁止把版本号**抄进 README 正文** | 补其盲区：该守卫只看 manifest，不看 markdown |
| `CHANGELOG.md` / `tests/DEBT.md` / 任务板 | 变更、债务、进度真源 | 禁止 README 承载（A5） | 单向：README 可指向，不可复制 |

---

## 4. 档位判据的抽样验证

判据本身必须机械可判，否则 `[DESIGN-DOC-003]` §1.4 的必答清单无法自动化。抽样 20 个真实目录，验证
「目录内是否存在构建清单」这一判据是否产生合理分档：

| 目录 | 构建清单 | 档位 | 是否合理 |
|---|---|---|---|
| `services/backend` | `package.json` | T1 | ✅ 可独立 `npm start` |
| `services/backend/src/contracts/a2a` | 无 | T2 | ✅ 单元内部契约 |
| `services/backend/wasm-indicators` | 无 | T2 | ✅ 上层单元的子目录 |
| `kernel` | `Makefile` | T1 | ✅ 可独立构建并 QEMU 引导 |
| `tools/deepseek-eyes` | `pyproject.toml` | T1 | ✅ 独立 MCP 服务 |
| `scripts`、`scripts/frontend`、`scripts/release/publish` | 无 | T2 | ✅ 工程脚本目录 |
| `platform/delivery` | 无 | T2 | ✅ 只是**下限低**，其 README 已远超 T2 要求（A3 允许） |
| `packaging/modules` | 无 | T2 | ✅ 清单目录 |
| `extensions/tools/khy-markdown` | `package.json` | T1 | ✅ 含独立安装与 CLI |
| `extensions/scripts/khy-desktop-rd` | 无 | T2 | ✅ 调研档案 |
| `.github/rulesets`、`.opencode` | 无 | T2 | ✅ 配置目录 |

**为什么不用「目录深度」或「手工登记档位」**：深度无法区分
`services/backend`（T1）与 `services/backend/src/contracts/a2a`（T2）；
手工登记档位会引入第二真源，直接违反 A1。

---

## 5. 人工评审清单与复现方式

### 5.1 评审清单（8 项）

| # | 检查 | 通过标准 |
|---|------|----------|
| 1 | 全域禁项 | 正文无端口/域名/版本号/命令全集/目录树副本（三类例外除外） |
| 2 | 命令可达 | 每条命令**实际跑过**；`npm run` 在就近 `package.json`；`khy` 子命令真实存在 |
| 3 | 路径可达 | 反引号里的仓库路径都存在 |
| 4 | 档位节齐备 | 按 `[DESIGN-DOC-003]` §1.4 对照，必有项都答了 |
| 5 | 首屏 | 第一屏答完「是什么 + 怎么跑」 |
| 6 | 台账污染 | 无 TODO / 进度 / 临时说明 |
| 7 | 命名与孪生 | 匹配 `README_VARIANT_RE`；有 md 有 html，且 html 未被手改 |
| 8 | 指针有效性 | 每个「真源指针」指向的文件或登记项真实存在 |

### 5.2 复现命令

```bash
# 档位分布（§1.2）
find . -iname "README*.md" -not -path "*/node_modules/*" -not -path "*/.git/*" \
  -not -path "*/dist/*" -not -path "*/build/*" -not -path "*/_build/*" \
  -not -path "*/.research-tmp/*" -not -path "*/.khy/*" | wc -l

# 真源抽查（§1.3 五例）—— 一律按符号名 grep，不按行号 sed
grep -n "BACKEND_PORT\|WEB_FRONTEND_PORT" services/backend/src/constants/serviceDefaults.js
grep -n "AI_FRONTEND_PORT" apps/ai-frontend/vite.config.js
node -e "console.log(Object.keys(require('./package.json').scripts).includes('dev'))"  # → false（根无 dev）
grep -n '"node"' services/backend/package.json                    # engines.node 真值
grep -n "VERSION_GROUPS" -A 30 scripts/ci/check-version-sync.js   # 三轨道 9 源
```

### 5.3 场景矩阵（供 §6 执行器落地时作回归基准）

| 场景 | 期望 |
|------|------|
| 正文写 `http://localhost:8090` | 违规（禁项·端口） |
| 正文写 `AI_FRONTEND_PORT`（变量名） | **放行**（指针标识） |
| 徽章 `pypi/v/khy-os` | **放行**（实时取值） |
| 手写 `v1.1.15` 徽章 | 违规（手写数字） |
| `❌ ... :3000 / ✅ ... 由 PORT 决定` | **放行**（对照块语境） |
| 写 `npm run dev`（根无此脚本） | 违规（命令不可达） |
| 写 `npm run test:backend`（根存在） | **放行** |
| `apps/khy-mobile/README.html`（无 `.md`） | 违规（无源孪生） |
| 首屏只有徽章墙 | 违规（首屏） |
| T1 README 缺「怎么测」 | 违规（档位节不齐备） |
| 正文写「待办：后续补上」 | 违规（台账） |
| `README-联调.md` | 违规（命名） |
| T2 README 写 200 行模块说明 | **放行**（下限非上限） |

---

## 6. 执行器接线设计（未落地）

拟新增 `scripts/ci/check-readme.js`。**必须复用而非重写**的部分：

| 判据 | 复用来源 |
|---|---|
| `npm run` 脚本可达性 | `check-agent-docs.js` 的 D3a（含 `--workspace` 可在脚本名之前的陷阱） |
| `khy` 子命令可达性 | 同上 D3b（别名表 ∪ `commandAutoRegistry`） |
| 路径可达性 | 同上 D3d（根锚定 + 非占位符 + 完整路径或 basename） |
| 档位判定 | `[DESIGN-DOC-003]` §1.3（构建清单探测） |
| 孪生件 | `verify_docs_site.js`（不重复实现） |

接线清单（缺一项即失败 —— 依据既有守卫的硬性要求）：

1. 新建 `scripts/ci/check-readme.js`，输出契约 `[ERROR] <finding-id> <file>:<line>`，退出码 `0|1|2`；
2. 根 `package.json` 加别名 `"check:readme"` —— **不加会被 `check-wiring.js` 判 error（检查器零接线）**；
3. 登记表 `DOCS-004` 补 `exec`（`script` / `args` / `findings`），`gate` 由 `manual` 改为 `pr`；
4. `.github/workflows/pr-gate.yml` 加步骤 —— 否则「表面被引用」≠「CI 真会跑」，
   该差别见 `[DESIGN-DOC-002]` §8 执行实录 D；
5. `npm run docs:rules-cards` 重生成规则卡（**禁手改**）；
6. P2 走棘轮：`npm run rules:baseline` 收紧基线（只降不升）。

> **门档不用改**：commit ⊂ pr ⊂ release 的成员资格从登记表派生（`[DESIGN-ARCH-111]`），
> **不要**动 `qualityGateStages.js` 或 `package.json` 的 `&&` 链。

---

## 7. 已知边界与未覆盖

诚实登记 `DOCS-004` 的**不覆盖项**，避免读者高估其保证：

1. **本期无自动执行器** —— §5.3 的场景矩阵是设计基准，不是已运行的守卫。
   执行强度如实为 `manual`（人工评审）。
2. **不校验「摘要是否还准确」** —— A1 允许的「稳定摘要」也可能过期（如能力条目）。
   这类漂移只能靠真源侧的变更推动，本规范无法自动发现。
3. **不覆盖非 README 名的入口文档** —— `kernel/bridge/README-联调.md` 属命名违规，
   但一个叫 `GUIDE.md` 的入口文档不在本规范辖区（应归 `DOCS-001` 的命名管辖）。
4. **不覆盖 `docs/**` 下 README 的档位** —— 它们受 `DOCS-001` 命名管辖，
   本规范只适用其 §1.1 全域禁项表。
5. **不覆盖用户级与第三方目录** —— `~/.khyquant/`、`.research-tmp/` 下的 README 不在辖区内。
6. **`README.html` 是否入版本控制** —— `[DESIGN-LAY-002]` §8① 已裁定「入」，
   但实测**根级孪生件全部未被 git 跟踪**。这属既有裁定与存量的偏差，
   本规范不重新裁决，仅登记待收口。
7. **存量违规未清理** —— §1.2 的 2 个命名违规与 2 个无源孪生孤儿仍存在，
   按 `[DESIGN-DOC-003]` §3 的「先定判据、后机械化」顺序，清理并入执行器落地后一并处理。
