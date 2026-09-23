# [DESIGN-SEMVER-002] 版本管理与发布触发规范

<!-- RULES-REGISTRY: PROCESS-005 -->

> **定位**：回答四个此前依赖人工判断的问题 ——
> **「什么时候 bump？」「bump 成几？」「什么时候推 GitHub / Gitee？」「哪些动作是自动触发的，触发条件是什么？」**
> 本文件是规则 `PROCESS-005` 的**语义真源**；机器可读登记项在 `docs/10_规范/registry/RULES-REGISTRY.json`。
>
> **与既有规范的关系**（三份互补，无重叠）：
> - `[DESIGN-SEMVER-001]` 管**版本号本身**（格式、递增语义、预发布、废弃周期、真源清单）；
> - `PROCESS-002` 管**版本号一致性**（9 源组内相等、组间刻意不同），守卫 `check-version-sync.js`；
> - **本规范管「流转时机与推送触发」** —— 什么时候该动版本号、动完由谁推出去、推完谁自动接手。
>   三者正交：提问「真源对不对得上」看前两者，提问「何时动、谁触发」看本文。
>
> **编号与落点**：本文件属**规范族**（`[DESIGN-<域>-NNN>`），按 `[DESIGN-LAY-005]` §3.1 归入
> 跨阶段规范目录 `docs/10_规范/`（编号 ≥ 10 即跨阶段）。域字母取 `SEMVER`，
> 与既有 `[DESIGN-SEMVER-001] 语义化版本规范` 同族并列。
>
> **依据**：多轨道真源与 G1/G2/G3 分组依据 `CLAUDE.md` §一 R3（`PROCESS-002`）；
> 版本格式与递增语义依据 `[DESIGN-SEMVER-001]`；
> 分支与推送纪律依据 `CLAUDE.md` §一 R1（`PROCESS-001`，P0，**本规则不得放宽它**）；
> 发布流水线依据 `scripts/release/publish-dual.sh` 与 `.github/workflows/dual-channel-release.yml`；
> 镜像同步依据 `.github/workflows/sync-gitee.yml`。

---

## 一、现状：四处「发布时机」目前靠人记（2026-09-17 实测）

| # | 现状 | 实测证据 | 问题 |
|---|---|---|---|
| 1 | **何时 bump 无成文判据** | `CLAUDE.md` §一 R3 只规定「三条轨道组内一致」，未说触发条件 | 全靠记忆；要么攒着不发，要么随手改 `pyproject.toml` 造成 `check:version-sync` 红 |
| 2 | **推 GitHub 与推 Gitee 是两条独立链路，互不保证** | `sync-gitee.yml` 触发于 `push: branches: [main, master]`；`dual-channel-release.yml` 触发于 `push: tags: ['v*']` | 推了 `main` 不推 tag → 代码同步了但**没发版**；推了 tag 而 `main` 未推 → **发了版但镜像缺 tag**，两边长期漂移 |
| 3 | **发布通道仍是手动的** | `dual-channel-release.yml` 仅 `push: tags: ['v*']` + `workflow_dispatch`；`publish-dual.sh` 头部注释写明「不带 `--tag` = 只发包，不 commit / 不打 tag / 不 push——**版本红线需人另行点头**」 | 与用户诉求「避免依赖人工判断发布时机」**直接冲突** |
| 4 | **`master` 是影子分支** | 本仓实际分支为 `main`（`git branch --show-current` = `main`）；`main`/`master` 两个名字散落在 6 个 workflow 的过滤器里 | 分支改名即静默失效（过滤器不匹配则 workflow 永不触发，且**不会报错**） |

> **结论**：缺的不是「要不要自动」，而是**「自动的触发条件写清楚了没有」**。
> 本规则把触发条件从人的记忆搬进 workflow 的 `on:` 块，使「发布时机」成为**可机判、可复现**的事实。

---

## 二、规则正文（`PROCESS-005`）

> 以下五节即规则条款。**P1；门档 `pr`；守卫 `scripts/ci/check-release-triggers.js`（新增）。**

### 2.1 R-1 何时需要更新版本号（bump 触发）

**在三种情形下必须 bump，其余情形一律不 bump**：

| # | 触发条件（满足任一即 bump） | 判据（可机判） | 递增位 |
|---|---|---|---|
| **T1** | 面向用户的**功能新增** | 本版 `CHANGELOG.md` 的 `### Added` 段非空 | MINOR |
| **T2** | 面向用户的**行为变更 / 破坏性变更** | `### Changed` 或 `### Removed` 段非空，或 `### Security` 段非空 | MAJOR（破坏性）/ MINOR |
| **T3** | **仅缺陷修复** | `### Fixed` 段非空，且 Added / Changed / Removed 三段均空 | PATCH |

**不 bump 的情形（显式列举，避免"顺手改一下"）**：

- 仅改文档、注释、测试、CI 配置、`.gitignore`；
- 仅内部重构且**对外可观测行为不变**（无新增/变更/移除的公开 API 与 CLI 用法）；
- 仅同步上游依赖小版本（除非它改变了本包对外行为）；
- **工作区尚未收口**（`git status` 有未提交的业务改动）——此时 bump 只会制造
  「版本号先跳、内容后到」的空版本。

**一次提交只做一步**：bump 与功能改动**不放进同一个 commit**。
依据 `SOURCING-006` 的落地纪律「标记 → 迁移 → 收口，一次提交只做一步」，
使 `git revert` 能单独回滚版本号而不牵连业务代码。

### 2.2 R-2 版本号命名与递增规范

**命名**：严格 SemVer **`X.Y.Z`**，**三位数字，禁止前导 `v`、禁止预发布后缀、禁止构建元数据**。

```
✅ 1.1.15   1.2.0   2.0.0
❌ v1.1.15  （tag 才带 v，版本号字段不带）
❌ 1.1      （必须三位；isSemver 虽容两位，但发布轨道按三位收口）
❌ 1.1.15-rc.1 / 1.1.15+build.7   （本仓发布轨道不支持）
```

> 该约定**与守卫同源**：`scripts/ci/check-version-sync.js` 的 `isSemver()` 拒绝 `abc` /
> `v1.0` / `1.0..`。规则不得比守卫更宽（否则守卫绿而规则红），也不得更窄到拦下守卫放行的合法值。

**递增**（`MAJOR.MINOR.PATCH`，逐位独立，不得跳位）：

| 位 | 何时 +1 | 归零规则 |
|---|---|---|
| **MAJOR** | 对外契约破坏性变更（CLI 命令移除/改名、API 响应结构变更、数据格式不兼容） | MINOR、PATCH 归零 |
| **MINOR** | 向后兼容的功能新增 | PATCH 归零 |
| **PATCH** | 向后兼容的缺陷修复 | — |

**三条轨道独立递增，组间不联动**（依据 `PROCESS-002`）：
G1 主包 / G2 ai-backend / G3 浏览器 UI **各自按自己的变更性质递增**，
**禁止为了"看起来整齐"把三条轨道对齐成同一版本号** —— G2、G3 与 G1 刻意不同。

**bump 的落点（G1 必改 3 处，不能只改 1 处）**：

```
pyproject.toml                      # pip 单一真源
packaging/npm/package.json          # npm 渠道清单
services/backend/package.json       # khy --version 上报值
```

第 4 处 `packaging/modules/modules.json` 由构建流程或人工维护，
**最终由 `check-version-sync` 统一校验 G1 全 4 源一致**；
`platform/khy_platform/__init__.py` **永不改字面量**（运行时 `_detect_version()` 动态解析，
写死即被守卫判失败）。

**CHANGELOG 必须同步**：`CHANGELOG.md` 顶部版本段必须等于 `pyproject.toml` 的
`[project].version`，由 `node scripts/release/changelog-new.js --check` 强制。
**顺序是先写 CHANGELOG 段、再 bump 版本号**（`--check` 以 pyproject 为锚，反向操作会先红）。

### 2.3 R-3 何时以及如何推送 GitHub / Gitee

**推送分层：`main` 推代码，`vX.Y.Z` 推发布。两者是不同事件，不可互相替代。**

| 目标 | 推什么 | 由谁触发 | 前置条件 |
|---|---|---|---|
| **GitHub `main`** | 业务提交（不含版本号） | **人工**（受 `PROCESS-001` 约束：AI 不得自动 push，须用户明确点头） | 本地 `npm run check:structure` 全绿 |
| **Gitee `main`** | 镜像同步 | **自动**（`sync-gitee.yml`，见 2.4 A2） | 上一步成功 |
| **GitHub `vX.Y.Z` tag** | 版本发布 | **自动**（打 tag 即触发 `dual-channel-release.yml`） | 2.4 的 A1 全部满足 |
| **Gitee tag** | 镜像同步 | **自动**（同上 A2，`tags` 纳入后） | tag 已推 GitHub |

**如何推（标准动作，三条命令）**：

```bash
# 1) 版本收口：CHANGELOG 段 + bump G1 三源
node scripts/release/changelog-new.js 1.2.0
# 编辑三处版本号 → 见 2.2 的落点

# 2) 本地自检（必须全绿，否则第 3 步会制造一个坏 tag）
npm run check:version-sync && npm run check:structure

# 3) 推代码，再推 tag —— 顺序不可颠倒
git push origin main
git push origin v1.2.0
```

> **顺序纪律**：先推 `main` 再推 tag。反过来会出现
> 「tag 指向一个远端还不存在的 commit」→ 发布工作流 checkout 失败。
>
> **tag 必须以 `--annotate` 创建**（`git tag -a v1.2.0 -m "..."`），
> 既便于 `--follow-tags` 批量推送，也让 `git describe` 可用。

### 2.4 R-4 自动触发条件（本规则的核心：消灭人工判断）

机器可读的触发矩阵。**四条自动链路，条件全部写在 workflow 的 `on:` 块里，不写在人的记忆里。**

| 编号 | 触发动作 | 触发条件（机判） | 自动执行的后果 |
|---|---|---|---|
| **A1** | **推 `v*` tag** | `push: tags: ['v*']` **且** tag 形如 `vX.Y.Z` **且** `check-version-sync` 绿 **且** `changelog-new --check` 绿 | 全链发布：测试 → 版本校验 → CHANGELOG 校验 → `release-gate.js` → 构建 exe → 签 sigstore → 生成 SBOM → `publish-dual.sh --rehearse` → 上传 GitHub Release 资产 |
| **A2** | **推 `main` 或 `v*` tag** | `push: branches: [main]` **或** `push: tags: ['v*']` | Gitee 镜像同步（`sync-gitee.yml`）：`git fetch --depth=1` → push 到 `gitee` |
| **A3** | **`main` 上通过 PR 合入** | `pull_request: branches: [main]` | `pr-gate.yml` 全套检查（含 shadow-mode `rules:gate`，**当前 `continue-on-error: true`**） |
| **A4** | **人工补发**（逃生舱） | `workflow_dispatch` 手动触发 | 等同 A1，但 `--tag --push` 也由工作流代劳。**仅在 A1 因外部故障失败时使用**，用毕须在此登记原因 |

**四条`触发即阻断`的硬条件（任一不满足，发布链路必须失败而不是静默跳过）**：

1. `node scripts/ci/check-version-sync.js` **exit 0** —— 9 个真源组内一致；
2. `node scripts/release/changelog-new.js --check` **exit 0** —— 顶部版本段 == `pyproject.toml`；
3. `node scripts/release/release-gate.js` **exit 0** —— `tier=must` 全 PASS；
4. tag 与 `pyproject.toml` **版本号相等**（`GITHUB_REF#refs/tags/v` 去 `v` 后比对）。

> 这四条**必须写在 `jobs.release.steps` 里并默认阻断**。
> 禁止改写成 `continue-on-error: true` —— 那会把「发布门禁」退化成「发布建议」，
> 正是 `[DESIGN-ARCH-111]` 全仓批判的「无绑定层」模式。

### 2.5 R-5 守卫与反例（本规则的执行面）

**新增守卫 `scripts/ci/check-release-triggers.js`**，在 `pr` 档执行，校验：

| 检查 | 判级 | 反例（必须判红） |
|---|---|---|
| 每个 `release` 档 workflow 的 `on:` 块非空且含明确触发器 | error | 删掉 `dual-channel-release.yml` 的 `tags:` 过滤器 |
| `sync-gitee.yml` 的 `branches` 覆盖当前默认分支 | error | 默认分支改名后过滤器未同步 |
| 发布链路的四条硬条件 step **均未**设 `continue-on-error: true` | error | 给 `check-version-sync` 加豁免 |
| `dual-channel-release.yml` 的 `concurrency` 为 `cancel-in-progress: false` | error | 允许并发发布 → 产出「npm 已发、PyPI 未发」的半成品 |
| bump 落点三源在同一个 commit 内齐变 | warning | 只 bump `pyproject.toml` |
| `CHANGELOG.md` 顶部版本段存在 | warning | 直接 bump 不留 CHANGELOG |

**允许的豁免**：workflow 内以注释 `# release-trigger-exempt: <理由>` 显式声明，
**理由必填**（空理由不生效且被报出），与 `khy-allow-<规则ID>: <理由>` 语义一致。

**误报回归锁（依据公理 A4「误报比漏报更贵」）**：守卫必须对以下合法写法**判绿** ——
`workflow_dispatch` 单独存在、`tags: ['v*']` 通配、`branches` 同时列 `main` 与 `master`
（迁移期兼容）、`concurrency` 组名任意。每个反例都要配一个「应放行」对照，
否则守卫会逼着维护者改仓库去满足错误判据。

---

## 三、与 `PROCESS-001` 的边界（**不可放宽 P0**）

用户诉求是「**相关操作由什么条件自动触发，从而避免依赖人工判断发布时机**」。
本规则**只把"发布链路"自动化，不触碰 `PROCESS-001` 的推送红线**：

| 动作 | 谁决定 | 依据 |
|---|---|---|
| `git commit` | AI 可代劳，**须用户明确指示** | `PROCESS-001` |
| `git push origin main` | **用户点头**（AI 不得自动 push） | `PROCESS-001`（P0） |
| `git push origin vX.Y.Z` | 同上；推 tag 是「发布必须人工确认」的**最后一道闸** | 本规则 R-3 + `PROCESS-001` |
| tag 推送**之后**的一切（构建/签名/发包/镜像） | **全自动，无条件触发** | 本规则 R-4（A1/A2） |

> **一句话**：**人工只在"推 tag"这一处点头，推完之后不允许再有第二次人工判断。**
> 这既满足「避免依赖人工判断发布时机」，又不违反 P0 红线 ——
> 自动化的对象是**触发后的长链路**，不是**是否触碰远端**这个动作本身。
> 若未来要把「推 tag」也自动化，那是修改 P0 的决定，**必须先改 `PROCESS-001` 并单独评审**。

---

## 四、验收（三步接线清单，依据 `[DESIGN-ARCH-111]`）

新增规则必须完成三步接线，缺一步即为未完成：

1. **登记表**：`docs/10_规范/registry/RULES-REGISTRY.json` 新增 `PROCESS-005` 条目
   （`nature` / `grants` / `benefit` 三字段必备；`gate: "pr"`；
   `exec.script: "scripts/ci/check-release-triggers.js"`；同步 `meta.ruleCount` 71 → 72）；
2. **守卫**：新建 `scripts/ci/check-release-triggers.js`（零外部依赖、确定性、可离线、
   只读不改业务；产物落 `.khyos/`），并在 `package.json` 加别名 `check:release-triggers`；
3. **门引用**：`check-wiring.js` 要求检查器必须被某个门引用 ——
   在 `.github/workflows/pr-gate.yml` 增加对应 step（与既有的 check 排在一起）。

**验收命令**：

```bash
node scripts/ci/check-rules-registry.js   # TOOLING-007 双向可达
node scripts/ci/check-gov-rules.js        # GOV-TOOL-006 字段齐全
node scripts/ci/check-wiring.js           # 反孤儿
npm run docs:rules-cards                  # 由登记表渲染规则卡（禁止手改）
```

> **前置确认（依据 `MEMORY` §七.11）**：接线前先跑
> `git ls-files --error-unmatch scripts/ci/check-release-triggers.js`。
> 查不到 = CI 检出里根本没有这个执行器 → **接线即「执行器不存在」**。
> 必须先把守卫文件纳入版本控制，再改 workflow。

---

## 五、落点与后续

- 本文档落 `docs/10_规范/`，编号 **`DESIGN-SEMVER-002`**
  （与 `[DESIGN-SEMVER-001] 语义化版本规范` 同域并列；`SEMVER-002` 已实测未被占用）。
  孪生件 `[DESIGN-SEMVER-002] 版本管理与发布触发规范.html` 由 `build_docs_site.js` 生成；
  回写 `docs/10_规范/00_INDEX_规范-总目录.md`（**注意：总目录只扫 `0[1-9]_*` 目录**，
  `10_规范/` 的登记在本目录自己的索引内）。
- `CLAUDE.md` §一 R3 表格下补一行指针指向本规范（**不复制正文**，依据 `[MGMT-STD-008]` §3.2）；
  `AGENTS.md`「版本同步」节同步补指针。
- **本次交付边界**：本文件是**规则条款（规范真源）**。登记表条目与守卫脚本属实现，
  按 `SOURCING-006`「一次提交只做一步」纪律**另起一次提交**，不在本次混合交付。

#### 执行实录 · 第 2/3 步（2026-09-17）

三步接线已全部完成，实测结果如下：

| 步 | 交付件 | 实测 |
|---|---|---|
| 1 标记 | 本文件（含 `<!-- RULES-REGISTRY: PROCESS-005 -->`） | ✅ 双向可达（TOOLING-007 通过） |
| 2 登记表 | `docs/10_规范/registry/RULES-REGISTRY.json` 新增 `PROCESS-005` | ✅ `meta.ruleCount` 71 → **72**，与 `rules.length` 一致 |
| 2 守卫 | `scripts/ci/check-release-triggers.js`（零外部依赖，手写 YAML 结构扫描） | ✅ 全仓 0 error / 0 warning |
| 2 别名 | `package.json` 新增 `check:release-triggers` | ✅ `check-wiring` 通过（74 个检查器全接线） |
| 3 门 | `.github/workflows/pr-gate.yml` 新增 `Check release triggers` | ✅ 不再报「零接线」 |

**守卫的 14 个反例场景**（`--scenario=<名>`，7 拦 / 7 放行，全部实测）：

| 场景 | 期望 | 场景 | 期望 |
|---|---|---|---|
| `trigger-missing` | 1 error | `trigger-present` | 放行（`tags: [v*]` 通配） |
| `mirror-branch-drift` | 1 error | `trigger-dispatch-only` | 放行（仅 workflow_dispatch） |
| `hard-condition-exempt` | 1 error | `mirror-branch-ok` | 放行（main + master） |
| `hard-condition-step-deleted` | 1 error | `mirror-branch-dispatch-ok` | 放行 |
| `hard-condition-exempt-empty` | 1 error + 1 warning | `hard-condition-ok` | 放行 |
| `concurrency-true` | 1 error | `hard-condition-exempt-ok` | 放行（**有理由**的豁免） |
| `concurrency-missing` | 1 error | `concurrency-ok` | 放行（组名任意） |

**单测**：`scripts/tests/check-release-triggers.test.js`，28 个用例全绿。
除场景断言外，另含**真 workflow 定点变异**用例（对真 `.yml` 做一处替换后调纯函数），
用于挡住「场景全绿但真文件判错」的偏差。

> **三个实现陷阱（实测踩过，与源文件注释互为印证）**：
> ① 场景是「**单条检查**的反例」，不是「整仓快照」——早期版本每个场景跑全部四条检查，
>    导致每条断言都被「另外三条 step 不存在」的噪音淹掉（`hard-condition-exempt` 报 4 条）。
>    修法：`checkHardConditionSteps` 加 `onlySteps` 参数；`runScenario` 按场景名前缀分流。
> ② 真 workflow 是 **CRLF** 行尾，变异正则必须写 `\r?\n`，否则变异静默不生效。
> ③ `main()` 必须由 `require.main === module` 守卫，否则单测 `require()` 会顺带跑一次全仓扫描。
>
> **一处刻意不改的现状**：`--json` 之后仍会追加 `Summary: ...` 行（`scripts/ci/` 的既有约定，
> `check-agent-docs.js` 等同样如此）。测试里剥掉尾部行再 `JSON.parse`，
> **不为迎合测试去改守卫** —— 那会造成与其余检查器不一致（公理 A4：修判据而非改仓库）。
