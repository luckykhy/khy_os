# 贡献指南（Contributing to Khy-OS）

本文件是协作规范的**单一真源**。GitHub 只识别仓库根目录、`.github/` 与 `docs/` 顶层的
`CONTRIBUTING.md`，因此它放在根目录；`docs/08_MGMT_项目管理/CONTRIBUTING.md` 已改为指针页。

开发者手册（架构、模块职责、AI 协作约定）见 [AGENTS.md](AGENTS.md)。

---

## 1. 分支策略

| 分支 | 用途 | 保护 |
| --- | --- | --- |
| `master` | 唯一可部署主干（仓库当前主干名） | 见 §6 分支保护 |
| `feat/<area-id>/<简述>` | 新功能 | 无 |
| `fix/<area-id>/<简述>` | 缺陷修复 | 无 |
| `docs/<简述>` | 纯文档 | 无 |
| `chore/<简述>` | 构建、依赖、CI | 无 |
| `dev/<姓名>/<简述>` | 个人实验，不要求可合并 | 无 |

`<area-id>` 取自 [`docs/_维护者/维护映射表.json`](docs/_维护者/维护映射表.json) 的 `areas[].id`，
共 111 个区域。用它做前缀的好处是：分支名直接对应 CODEOWNERS 的归属单元。

> **关于 `main` 与 `master`**：本仓库主干名为 `master`，但所有 workflow 的触发条件同时列出
> `[main, master]`。这样即使将来重命名主干，也不需要再改 CI 配置。

**分支纪律**

- 分支存活尽量不超过 3 天；长命分支的冲突成本远高于拆分成本。
- 合并前 rebase 到最新主干（`git fetch && git rebase origin/master`）。
- 启用冲突记忆：`git config rerere.enabled true`。

---

## 2. 提交信息

采用 Conventional Commits：

```
<type>(<scope>): <简述>

<正文：为什么这样改，而不是改了什么>
```

`type` ∈ `feat` / `fix` / `docs` / `refactor` / `perf` / `test` / `build` / `ci` / `chore` / `revert`。
`scope` 建议用 area-id。Dependabot 已按 `chore(deps)` 前缀提交。

> 当前**没有** commitlint / husky 强制校验，这是约定而非门禁。若要强制，
> 加一个 `commit-msg` 钩子即可，但请先权衡：钩子会拖慢每次提交。

---

## 3. 改动规模限制（这是硬门禁，不是建议）

`scripts/ci/check-change-safety.js` 在 PR 门禁里运行，阈值如下（源码即真源）：

| 条件 | 等级 | 是否阻断合并 |
| --- | --- | --- |
| 改动 > 20 个文件 | error | **阻断** |
| 改动集含 `.env*` / `*.pem` / `*.key` / `credentials.json` / `secrets.{yml,yaml,json}` | 提升为 error | **阻断** |
| 受监控高危文件的 `[AI-弱模型…]` 护栏横幅被删 | error | **阻断** |
| 改动 > 8 个文件 | warning | 报告 |
| 新增 > 3 个文件 | warning | 报告 |
| 跨 > 3 个顶层目录 | warning | 报告 |
| 触及 gateway 核心 / 路由层 / 系统提示词 / 打包配置 | warning | 报告 |

因此：**一个 PR 20 个文件是硬上限，8 个以内是舒适区。** 超过 8 个不会被拒，但会在
PR 里留下建议拆分的提示。

---

## 4. 提交 PR 前的本地自检

按代价从低到高排列，都是零安装的仓库内脚本：

```bash
# 1) 变更安全（与 CI 阻断项完全一致的调用方式）
node scripts/ci/check-change-safety.js --changed --promote=sensitive-paths

# 2) 想看完整的严格结论（含所有建议项）
node scripts/ci/check-change-safety.js --changed --strict-warnings

# 3) 多生态版本同步（khy-os 与 ai-backend 两套版本各自内部必须一致）
node scripts/ci/check-version-sync.js

# 4) AI 协作规则 / 叶子模块契约
node scripts/ci/check-agent-rules.js --changed
node scripts/ci/check-leaf-contract.js --changed

# 5) 全仓 JS 语法（约 4700 个文件，本地耗时可达数分钟）
node scripts/ci/check-node-syntax.js

# 6) 变更到的 Python 文件语法（纯标准库 py_compile，无需 pip install）
python scripts/ci/check-python-syntax.py <改动的 .py 文件...>

# 7) 后端代码风格与测试
cd services/backend
npx eslint <你改动或新增的文件...> --max-warnings 0   # 新增文件必须零问题，见 §5
npm test
npm run test:node

# 8) 前端（改了 apps/ai-frontend 或 software/khyquant/frontend 时）
cd apps/ai-frontend && npm test && npm run test:node   # vitest 14 文件 / 162 用例 + node:test
npm run build --prefix apps/ai-frontend
node scripts/ci/check-frontend-size.js                 # 产物体积对比基线（报告态）
```

**工具链现状请勿误信旧文档**：

- JavaScript：ESLint 9（flat config，`services/backend/eslint.config.js`）+ Prettier，已配置可用。
- Python：CI 中只有 `py_compile` 语法检查。**flake8 / black 并未配置**（仓库内不存在
  `.flake8`、`setup.cfg`、`tox.ini`，`pyproject.toml` 里也没有对应段落）。
- Shell：**没有** shellcheck 配置。
- 行尾由 [`.gitattributes`](.gitattributes) 强制（`.sh` → LF，`.bat` / `.ps1` → CRLF）。
  在 Windows 上改脚本前请确认没有被编辑器改掉行尾。

---

## 5. 代码风格棘轮（为什么你的新文件比老文件要求更严）

`services/backend/src` 现存 3417 个 lint 问题（428 errors + 2989 warnings，覆盖 2246 个
文件中的 1060 个）。全量 `--max-warnings 0` 在可预见期内不可能通过，所以门禁按文件状态分级：

| 文件在本 PR 中的状态 | 要求 | 是否阻断 |
| --- | --- | --- |
| **新增** | `eslint --max-warnings 0` 完全干净 | **阻断** |
| **修改** | 仅输出报告 | 报告 |

新文件没有历史债务，因此零误伤地立即阻断；存量文件顺手清理即可，不强制。
待存量债务清零，删掉 `pr-gate.yml` 中对应步骤的 `continue-on-error` 就升级为全面阻断。

---

## 6. 代码审查要求

**归属**：由 [`.github/CODEOWNERS`](.github/CODEOWNERS) 决定，该文件是生成产物 ——
真源是 `docs/_维护者/维护映射表.json`（区域与路径）+ [`.github/maintainers.json`](.github/maintainers.json)（区域 → GitHub 账号）。

```bash
# 给某个区域分配维护者：编辑 .github/maintainers.json 的 areaOwners，然后
node scripts/maintenance/gen-codeowners.js
# 映射表新增/删除了 area：
node scripts/maintenance/gen-codeowners.js --sync-roster
```

请**不要手改 `.github/CODEOWNERS`** —— `codeowners.yml` 工作流会检测漂移并失败。

> 当前 111 个区域全部尚未分配具体维护者，统一由全局兜底 owner 接管。这是刻意的：
> GitHub 对无效 owner 的处理是**静默忽略**，写 110 个假账号看起来很完整，实际一条都不生效。
> 名册填一个，CODEOWNERS 就多生效一条。

**审查基线**

| 要求 | 内容 |
| --- | --- |
| 批准数 | ≥ 1 |
| Code Owner 审查 | 必须（由分支保护规则强制） |
| 新 push 后 | 旧批准自动失效（`dismiss_stale_reviews_on_push`） |
| 评审会话 | 必须全部 resolve 才能合并 |
| 跨模块 PR | 触及 3+ 个顶层目录时，建议拆分；需所有相关区域 owner 批准 |
| 合并方式 | squash（保持主干线性历史） |

**必须通过的状态检查**：`Contract checks`、`Python syntax`、`Lint ratchet`。
`Test baseline (non-blocking)` 刻意不列为必需项 —— 现存 9 个已知失败用例，
把它设为必需等于让所有 PR 无法合并。
`Frontend CI`（`AI frontend` / `KhyQuant frontend`）同样**不能**设为必需项：
它带 `paths` 过滤器，在不改前端的 PR 上根本不会运行，也就永远不上报状态。
详见 [`.github/rulesets/README.md`](.github/rulesets/README.md)。

**体积与性能**：任何影响产物体积的改动，请在 PR 描述里附
`node scripts/ci/check-frontend-size.js` 的前后对比。基线在
[`scripts/ci/frontend-size-baseline.json`](scripts/ci/frontend-size-baseline.json)，
确认增长可接受后用 `--update` 更新基线，并在 PR 里说明理由。

**贡献者分级**（约定，用于判断该找谁审查；GitHub 权限本身由仓库 Settings 决定）

| 级别 | 建议改动范围 | 审批要求 |
| --- | --- | --- |
| 新手 | 文档、测试、非核心模块 | 需 code owner 批准 |
| 成员 | 自有区域内的完整功能 | 自有区域内由任一其他成员批准即可；跨区域需对应 owner 批准 |
| 核心 | 全部模块 | 同上 |

> 旧文档曾写「核心成员紧急修复可 self-merge」，**该条已废止**：分支保护规则的
> `bypass_actors` 为空，且 `required_approving_review_count: 1`，任何人都无法自行合并。
> 如果确实需要紧急通道，请按 [`.github/rulesets/README.md`](.github/rulesets/README.md)
> 显式添加 bypass 并在 PR 中说明，而不是靠口头约定。

---

## 7. 分支保护（ruleset-as-code）

规则以 JSON 形式版本化在 [`.github/rulesets/`](.github/rulesets/)，不靠人在网页上点。
应用方式见 [`.github/rulesets/README.md`](.github/rulesets/README.md)。

---

## 8. 安全

**不要用 Issue 报告安全问题。** 流程见 [SECURITY.md](SECURITY.md)。

日常开发中的硬性要求：

- 任何凭据、私钥、`.env` 文件都不得进入版本库（PR 门禁会阻断）。
- 依赖更新由 Dependabot 提出（见 [`.github/dependabot.yml`](.github/dependabot.yml)），
  请阅读 changelog 后再合并，不要盲批。
- 代码扫描由 `codeql-analysis.yml` 承担，结果在仓库 Security 页签。

---

## 9. 离线协作（双机同步）

本项目支持无远端的 bundle 交换（`.bat` 与 `.sh` 双平台配对）：

```bash
scripts/sync/export-sync.sh                                  # Windows: scripts\sync\export-sync.bat
scripts/sync/import-sync.sh --bundle <file> --merge           # Windows: import-sync.bat
scripts\sync\merge-contributions.bat <bundle1> <bundle2> ...  # 多人合入（仅 .bat）
```

---

## 10. 发布

发布由维护者执行。流程文档：

- [`docs/07_OPS_运维/[OPS-MAN-042] 发布手册-pip与npm-无AI照做.md`](docs/07_OPS_运维/) — 逐步照做的发布手册
- [`docs/07_OPS_运维/[OPS-MAN-061] 发布门禁.md`](docs/07_OPS_运维/) — 发布前必须通过的检查
- [`.github/workflows/dual-channel-release.yml`](.github/workflows/dual-channel-release.yml) — npm + PyPI 双通道自动化

贡献者只需注意一点：**改动版本号时多处必须同步**，以 `node scripts/ci/check-version-sync.js`
的结论为准（仓库存在两套独立版本线：`khy-os` 与 `ai-backend`），PR 门禁会校验。

变更日志写在根目录 [`CHANGELOG.md`](CHANGELOG.md)。发版时预置条目：

```bash
node scripts/release/changelog-new.js <version>
node scripts/release/changelog-new.js --check   # 校验顶部版本 == pyproject 版本
```
