# [DESIGN-DELIV-001] 可交付性判断标准

> 文档编号（非规则 ID）：`[DESIGN-DELIV-001]`
> 落点：`docs/10_规范/其它规范/`
> 孪生件：`[DESIGN-DELIV-001] 可交付性判断标准.html`（由 `build_docs_site.js` 生成）
> 调研日期：2026-09-22
> 调研对象：`github.com/zai-org/ZCode`、`github.com/sst/opencode`（v2）

---

## §0 为什么需要这份标准

### 0.1 问题的提出

khy-os 已有 **88 条规则**、**约 70 个 `check:*` 守卫**、**发布门禁 `release-gate.js`**、
**7 项 ZCode 代理指标全 PASS**。按任何一个"我们有没有在治理"的指标看，它都远超同类项目。

但它的**可交付性**（deliverability）——即"一个陌生人能否在陌生机器上，从公开渠道安装、
运行、信任并升级这个东西"——却明显差于体量更小的同类。**规则数量与守卫通过率，
与可交付性之间没有正相关**，甚至在某些维度上是负相关。

本文先把"可交付性差"这个模糊感受，拆成**可证伪的实测发现**（§1），
再用 ZCode / opencode v2 的 GitHub 实证提炼**判断标准**（§2–§3），
最后给出**适配本仓的落地判据与首轮体检结论**（§4–§5）。

### 0.2 本文的定位

- 本文是**判断标准**（standard），不是整改清单。它定义"什么叫可交付"以及如何度量。
- 它**不替代**任何既有单一真源：发布流程真源仍为
  `scripts/release/publish-dual.sh` 及其头注，门禁真源仍为
  `scripts/release/lib/releaseGateStages.js`。
- 本文定义的度量**应被实现为一个记分板**（对标既有的 `check-zcode-baseline.js`），
  但**首轮以 S1 观察者落地**（只记录不拦截），理由见 §4.3。

---

## §1 khy-os 可交付性的实测发现（证据）

> 全部结论来自本机 `D:\Portable\khy-os` 的真实运行证据，每条附复现命令。
> **不以"看起来乱"为依据**（参见项目记忆：同类判断已撤回三次）。

### 1.1 仓库本身不可信地克隆 —— 最高优先级

精确分解（`git fsck --no-progress` 输出按类型归类）：

| 类别 | 数量 | 含义 |
|---|---|---|
| `missing blob` | **314** | 文件内容真实缺失 —— **最严重** |
| `missing tree` | **63** | 目录树真实缺失 |
| `missing commit` | **3** | 提交对象真实缺失 |
| `broken link from <tree/commit>` | **69** | 引用了不存在的对象（62 tree + 7 commit） |
| `invalid sha1 pointer in cache-tree of .git/index` | **49** | 索引缓存树失效 |
| `dangling blob/tree/commit` | 237 | 悬空对象（无害，但示意历史被改写过） |
| `error:` 行合计 | **50** | —— |
| `git log --oneline --all` | **直接 fatal** | `bad object refs/remotes/origin/dependabot/...` |
| `.git` 体积 | 173 MB | —— |

复现：
```bash
git fsck --no-progress 2>&1 | sed 's/[0-9a-f]\{40\}/<sha>/g' | sort | uniq -c | sort -rn
# 314 missing blob / 63 missing tree / 3 missing commit / 62+7 broken link / 49 cache-tree
git log --oneline --all                      # fatal: bad object
```

> ⚠ **314 个缺失 blob 意味着历史提交中的文件内容真的不见了**——
> 这不是"索引陈旧"，而是**对象库有洞**。任何试图 checkout 到受影响提交的操作都会失败。

**为什么这是可交付性的头号问题**：交付的第一动作是 `git clone`。
一个 `git log --all` 都会 fatal 的仓库，对下游是**不可审计**的——
审查者无法遍历历史，CI 的某些历史操作也会失败。
这与"代码写得好不好"无关，它是**交付物完整性**问题。

> ⚠ 注意区分：`HEAD` 本身可读（`git ls-tree HEAD` 正常），
> 因此**日常开发不会感到痛**——这正是它长期未被发现的原因。
> 属于典型的**静默失真**：痛感只在"别人来拿"的时候出现。

### 1.2 发布基础设施"存在但不可验证"

这是本仓最系统性的一类可交付性缺陷：**机制齐全，但没有任何强制力**。

| 机制 | 实况 | 问题 |
|---|---|---|
| SBOM（CycloneDX） | `.github/workflows/dual-channel-release.yml:140-160` 真实生成 `sbom-npm.json` / `sbom-pip.json` | **只 `upload-artifact`**，无校验步骤、无消费者、不进发布门 |
| SHA256 校验和 | 发布链有生成 | 无"下载后校验"回路，无失败断言 |
| sigstore 签名 | `:134` `sigstore sign ... \|\| echo "... (non-fatal, continuing)"` | **显式吞掉失败**——签名失败仍继续发布 |
| `source-hygiene-scan.js` | 发布期密钥/许可证/符号链接扫描 | **S1 观察者，恒 `exit 0`**（见 §1.3） |
| `check-zcode-baseline.js` | 7 项代理指标**全 PASS** | S1 观察者，**恒返回 0**（脚本自述） |

复现：
```bash
grep -n -A6 -B4 "sbom" .github/workflows/dual-channel-release.yml
grep -n "non-fatal" .github/workflows/dual-channel-release.yml
node scripts/ci/check-zcode-baseline.js   # PASS 7 · 但"恒返回 0"
```

**要害**：`check-zcode-baseline.js` 的记分板打印 **PASS 7 · PARTIAL 0 · GAP 0**，
看起来无懈可击。但它**同时自述"S1 观察者档不参与放行判定，本脚本恒返回 0"**。
即：**这份漂亮成绩单对发布结果零影响**。

更关键的是，该记分板**没有任何"关掉守卫它应该变红"的反向验证**
（`grep -iE "防空转|变红|self-test"` 无命中）。

> ⚠ 这与项目记忆中已记录的一条判据完全同源：
> **"验收必须实测关掉守卫时它真变红，防空转断言"**。
> 一个恒真的断言，与没有断言，在交付质量上等价。

### 1.3 "非阻塞"被用作永久豁免通道

本仓的 rollout 四阶段机制（`PROCESS-008`）本意是好的：新机制先在 S1 旁路观察、
攒够样本再升阶。但当**几乎所有发布相关的强检查都停在 S1** 时，
机制就从"谨慎上线"退化成"**永远不上线**"。

实测处于 S1 / 恒不阻断的项：
- `source-hygiene-scan.js`（`STAGE = 'S1'`，头注自述 "ALWAYS exits 0"）
- `check-zcode-baseline.js`（`STAGE = 'S1'`，头注自述 "恒返回 0"）
- `check-staged-secrets.js` 头注**明确引用**上述事实作为自身的说明

复现：
```bash
grep -n "STAGE = " scripts/release/source-hygiene-scan.js scripts/ci/check-zcode-baseline.js
grep -n "ALWAYS exits 0\|恒返回 0" scripts/release/source-hygiene-scan.js scripts/ci/check-zcode-baseline.js
```

**判断**：这不是"机制设计错"，而是**毕业机制没有被执行**——
S1 的样本量门槛（≥200 条）从未被任何人结算，于是 S1 成了事实上的墓碑。

### 1.4 发布流程依赖"人的记忆"，而非可重复的自动化

`scripts/release/publish-dual.sh` 的头注完整记录了真实痛点，摘录：

- 标准发版命令需要 `yes y | bash ...` **喂交互确认**（非交互环境才这么用）
- **已知坑**：离线时 `python3 -m build --sdist` **静默失败**，`dist/` 只剩 wheel，
  审计报 `[FAIL] No sdist (*.tar.gz) found` —— **失败点与根因不在同一处**
- PyPI 单项目 **10GB 累计配额**可能挡上传
- 需要 `--skip-pip` / `--no-isolation` / `--tag` / `--push` 等多个手动开关组合

这些坑**全部以注释形式存在**，**没有一条被编码成检查**。
即：知识沉淀在"注释"里，而不是"机制"里——下一个维护者（或 AI）必须重读整段注释。

### 1.5 交付面分散，且存在真实的"新克隆缺件"

| 项 | 实测 |
|---|---|
| 根 `package.json` | **无** `dev` / `build` 顶层脚本（设计如此，见 README 自述） |
| 工作区 | 8 个 workspace，构建命令分散到各 workspace |
| `git status --porcelain` 分解 | 已修改 `M` **194** · **未跟踪 `??` 149** · 已删除 `D` **127** |
| `apps/ai-frontend/src/views/admin/` | **27 个视图未跟踪** ⇒ 新克隆**缺这些界面** |
| `dist/` | **不存在**（本机从未构建出可交付包） |
| CHANGELOG | 仅 **4** 个版本条目的 `##` 段 |

复现：
```bash
git status --porcelain | cut -c1-2 | sort | uniq -c | sort -rn   # 194 M / 149 ?? / 127 D
ls apps/ai-frontend/src/views/admin/ | wc -l       # 27
ls dist                                            # No such file or directory
grep -c "^## " CHANGELOG.md                         # 4
```

> ⚠ 注意 **127 项 `D`（工作区已删除但未提交）**——这意味着当前工作区
> **既不是 HEAD 的样子，也不是任何已提交的样子**。
> 参照项目记忆的纪律：**别把读到的工作区行为当成 HEAD 行为**。

**要害**：交付物（可安装包）在本机**从未存在过**。
仓库能跑，但"**能交给别人**"这件事没有被执行过哪怕一次。

### 1.6 文档面极重，但"上手路径"未收敛

| 项 | 实测 |
|---|---|
| `docs/**/*.md` | **918** |
| `docs/**/*.html`（孪生件） | **908** |
| 规则 | 88 条 / 88 张规则卡 |
| `check:*` 守卫 | 约 70 个 |

文档与规则的**绝对量**远超同类项目，但 README 的"安装方式"之后，
读者要在 `install:core` / `install:all` / `install:frontend` /
`khy-portable/run.ps1` / `khy.bat` / `khy.sh` 之间自行选择，
且**没有一条"从零到可运行"的黄金路径被端到端验证过**。

### 1.7 发现汇总

| # | 维度 | 判定 | 严重度 |
|---|---|---|---|
| 1 | 仓库完整性（**314 缺失 blob** / 63 缺失 tree / 3 缺失 commit / `log --all` fatal） | **GAP** | P0 |
| 2 | 发布物从未产出（无 `dist/`） | **GAP** | P0 |
| 3 | 新克隆缺 27 个视图；工作区 149 未跟踪 + **127 已删除未提交** | **GAP** | P0 |
| 4 | 签名失败被 `\|\| echo` 吞掉（**2 处**） | **GAP** | P1 |
| 5 | SBOM/校验和只传 artifact，无验证回路 | **GAP** | P1 |
| 6 | 发布期强检查全部停在 S1（恒 exit 0） | **GAP** | P1 |
| 7 | 记分板 7 PASS 无反向验证（空转断言） | **GAP** | P1 |
| 8 | 已知发布坑只在注释里，未编码成检查 | **PARTIAL** | P2 |
| 9 | 无端到端"黄金路径"验证 | **PARTIAL** | P2 |
| 10 | 文档/规则体量巨大但上手路径未收敛 | **OBSERVE** | P2 |

> 这张表本身**不是**交付物。参照 ZCode/opencode 的差距，它需要被**收敛成一组
> 有阈值、可回归、且真正阻断的指标**（§3）。

---

## §2 GitHub 调研：ZCode 与 opencode v2 的可交付性做法

> 两者都是"AI 编程 agent"，与 khy-os 同赛道，且 khy-os 已把 ZCode 作为对标基线
> （`check-zcode-baseline.js` 的阈值直接取自 ZCode 公布的 `architecture-policy.yaml`）。

### 2.1 ZCode（`github.com/zai-org/ZCode`）—— 闭源商业产品的"可交付性纪律"

| 维度 | ZCode 的做法 |
|---|---|
| **形态** | 三形态同源：Desktop（Electron）/ Web+CLI / Agent CLI，**共用同一后端与 Agent 运行时** |
| **构建** | `pnpm build` 递归；桌面 `pnpm bundle:desktop --os mac\|win\|linux --arch x64\|arm64`；命令行 `pnpm build:zcode` |
| **分发** | **自托管下载源**：`ZCODE_DIST_BASE_URL` + `latest.json` + `install.sh`；装到 `~/.zcode/runtime`，`~/.local/bin/zcode` 建软链 |
| **校验** | 发布产物含 **`sha256.txt`** 校验摘要，与 tarball 同目录发布 |
| **版本索引** | `latest.json` 是**机器可读的版本索引**（安装脚本据此选版本） |
| **配置** | 目录可用 `ZCODE_DIST_HOME` / `ZCODE_DIST_BIN_DIR` **环境变量覆盖** |
| **工程基线** | `mise.toml` + `.nvmrc` + `.npmrc` + `pnpm-lock.yaml` **四重锁定**工具链 |
| **架构守卫** | `architecture-policy.yaml`（策略）+ `.architecture-baseline.json`（基线）**声明式比对** |
| **迁移模型** | `managed` / `legacy` 双态：`managed:false` 存量豁免，**逐模块迁移后** `managed:true` 必须达标 |
| **合规** | `NOTICE.md` + `THIRD-PARTY-NOTICES.md` + `third-party/README.md` 说明**声明在发行物中的位置** |
| **文档** | 中英双语 README + `CONTEXT.md` / `DESIGN.md` / `AGENTS.md`，命令示例丰富 |
| **边界照顾** | 明确写清 macOS 未签名拦截、端口占用、PATH 指向旧版本的排查 |

**ZCode 可交付性的关键设计（值得直接借鉴）**：

1. **`managed` / `legacy` 双态迁移模型**——这是本仓最缺的一环。
   ZCode 可以**如实承认"有 566 个超标文件"**，但通过"未纳管 = 豁免，
   纳管 = 必须达标"让**债务可见且可收敛**。
2. **`latest.json` 作为机器可读的版本真源**——安装脚本消费它，而非硬编码版本。
3. **`install.sh` 是可交付物的一部分**——安装脚本与产物**同源发布**。
4. **校验和与产物同目录**——校验是**下载侧**的事，不是发布侧的自娱自乐。

### 2.2 opencode v2（`github.com/sst/opencode`）—— 开源项目的"分发广度"

| 维度 | opencode v2 的做法 |
|---|---|
| **形态** | CLI / Desktop / Web（`opencode pair`）/ Docker，**四个交付通道** |
| **CLI 安装** | 一行脚本 `curl -fsSL https://opencode.ai/v2/install \| bash` |
| **包管理器** | npm / Bun / pnpm / yarn / Homebrew(tap+formula) / AUR / mise / Nix —— **7+ 渠道** |
| **独立二进制** | **每平台独立 zip/tar.gz**（darwin/win/linux × arm64/x64 × glibc/musl × baseline） |
| **原生二进制选择** | npm 包用 **postinstall 脚本按平台选原生二进制** |
| **Desktop 交付** | `.dmg` / `.exe` / `.deb` / `.rpm` / `.AppImage`，且 `brew install --cask` / `scoop` |
| **Docker** | 版本化 tag，如 `ghcr.io/anomalyco/opencode:2.0.0` |
| **版本号** | **统一同步**（`sync release versions for v1.18.32`，跨包/跨目录一次同步） |
| **安装目录** | `$OPENCODE_INSTALL_DIR` → `$XDG_BIN_DIR` → `$HOME/bin` → `$HOME/.opencode/bin` **优先级明确** |
| **质量工具** | Oxlint（启用 type-aware 规则）/ Prettier / EditorConfig / **Gitleaks** / Husky / Conventional Commits |
| **安全政策** | `SECURITY.md` **明文拒绝 AI 生成的安全报告**（保护维护者时间） |
| **文档** | v2 独立文档站（`/v2/docs`），**逐平台下载链接内嵌版本号** |

**opencode 可交付性的关键设计（值得直接借鉴）**：

1. **"每平台独立二进制 + postinstall 选型"**——用户不需要有 Node 也能装。
2. **安装目录优先级链条**——明确、可覆盖、有默认回退。
3. **文档站的下载链接内嵌确切版本号**（`.../files/bin/2.0.6/...`）——
   文档与产物**强绑定**，不会出现"文档说 v2、产物是 v1"。
4. **统一版本同步**——跨包一次同步，避免"CLI 是 2.0.6、SDK 是 2.0.3"。
5. **`SECURITY.md` 明确边界**——**知道自己不收什么**，也是一种可交付性。

### 2.3 对比矩阵

| 维度 | khy-os | ZCode | opencode v2 |
|---|---|---|---|
| 分发渠道数 | 2（PyPI + npm） | 1（自托管）+ 桌面 | **7+** |
| 独立二进制（免 Node） | 部分（pip 内嵌 bundle） | ✅ tarball | ✅ 每平台 |
| `install.sh` 与产物同源 | ❌ | ✅ | ✅ |
| 机器可读版本索引 | ❌ | ✅ `latest.json` | ✅ 文档站内嵌 |
| 校验和（下载侧可验） | 生成但无回路 | ✅ 同目录 `sha256.txt` | ✅ |
| SBOM | **生成但不校验** | 未公开 | 未公开 |
| 签名失败是否阻断 | ❌ 被 `\|\| echo` 吞 | 未知 | OIDC 相关 |
| 架构策略 + 基线 | 登记表 + 门禁 | ✅ 声明式 yaml + baseline | `.oxlintrc` 等 |
| 存量债务迁移模型 | ❌（一次性全量） | ✅ **managed/legacy** | 未公开 |
| 工具链锁定 | pnpm + lockfile | ✅ **四重** | bun.lock + mise |
| 仓库历史完整性 | ❌ **314 缺失 blob + `log --all` fatal** | 未知 | 未知 |
| 端到端黄金路径 | ❌ | ✅ 文档步骤 | ✅ 文档站 |
| "拒绝什么"是否写明 | 部分 | ✅ NOTICE | ✅ SECURITY |

---

## §3 可交付性判断标准（D1–D10）

> 以下 10 条是从上述调研**提炼**的标准。每条给出：**定义**、**为什么**（对标依据）、
> **可测判据**（能落到命令/脚本上）、**khy-os 现状**、**目标**。
>
> 判据设计原则（继承本仓既有纪律）：
> ① 每个判据**必须能被反向验证**（构造违规 fixture 时真的变红）；
> ② 只认**结构化输出**，不认人读文案；
> ③ 阈值**不得硬编码在检查器内部**，必须来自单一真源。

### D1 仓库完整性 —— 「陌生人能完整克隆并遍历历史」

- **定义**：任意人 `git clone` 后，`git fsck` 干净、`git log --all` 可完整遍历。
- **对标**：这是"交付"二字的物理前提。ZCode/opencode 均未公开此项，
  但**任何**release 流程都隐含依赖它。
- **判据**：
  - `git fsck --no-progress` 中 `missing blob` / `missing tree` / `missing commit` 计数 **= 0**
  - `broken link from` 计数 **= 0**
  - `git log --oneline --all` 退出码 **= 0**
  - 索引 `cache-tree` 无效 sha1 计数 **= 0**
- **khy-os 现状**：**314 missing blob / 63 missing tree / 3 missing commit / 69 broken link /
  49 cache-tree / `log --all` fatal** → **GAP**
- **目标**：四项全 0，且纳入发布门 `must` 阶段。

> ⚠ **本项是本文唯一的 P0 硬阻断项**。其余 GAP 可以观察，这一项不行——
> 一个不能遍历历史的仓库，其"可交付"是字面意义上不成立的。

### D2 发布物真实存在且可安装 —— 「`dist/` 非空，且在干净环境装得上」

- **定义**：每次发布**必须先在本机产出真实产物**，并在**干净容器**里安装成功。
- **对标**：ZCode 的 `dist/zcode/releases/<version>/zcode-<version>.tar.gz` 是硬产物；
  opencode 每平台独立 tarball。两者都**先把产物做出来**，而不是"命令写好了"。
- **判据**：
  - 发布门存在阶段：`dist/` 中 wheel + sdist + npm tarball **均存在且非零字节**
  - 存在阶段：干净容器（docker）内 `pip install <wheel>` / `npm i -g <tarball>` 成功
  - 该阶段在 `release-gate.js` 中 `tier='must'`
- **khy-os 现状**：`dist/` **不存在**；`publish-dual.sh` 会 `rm -rf dist` 再构建，
  但**构建从本机跑到过（CHANGELOG 有版本号）却从未留盘** → **GAP**
- **目标**：`npm run release:artifact` 产出的产物可被**另一个人**装上并 `khy doctor` 通过。

### D3 新克隆零缺件 —— 「克隆出来的就是能跑的」

- **定义**：`git clone` + 文档首条命令，即可得到完整可运行系统，**无未跟踪依赖**。
- **对标**：ZCode/opencode 的仓库自带全部源码。
- **判据**：
  - `git status --porcelain` 中 `??`（未跟踪）项 **= 0**（生成物除外，需显式声明）
  - `D`（已删除未提交）项 **= 0** —— 工作区必须与某个已提交状态一致
  - 存在 `check:clone-completeness`：在 `git worktree add --detach` 出的干净树里
    跑一遍黄金路径
- **khy-os 现状**：149 项未跟踪（含 **27 个前端视图**）+ **127 项已删除未提交** → **GAP**
- **目标**：`??` 项全部归零或列入显式白名单并说明原因。

> ⚠ 注意：项目记忆已记录"`apps/ai-frontend/src/views/admin/` 是一次未提交的真实重构"。
> 这条判据正是把那个已知待办**变成可回归的指标**。

### D4 失败必须阻断，不得吞掉 —— 「没有 `|| echo` 的签名/校验」

- **定义**：发布链上任何**校验类**步骤失败，必须使整次发布 NO-GO。
- **对标**：ZCode 的 sha256 是**发布物的一部分**（缺失即产物不完整）；
  opencode 用 OIDC。两者的共同点是**校验不是可选项**。
- **判据**：
  - 发布相关 workflow / 脚本中，`|| echo` / `|| true` / `continue-on-error`
    作用于 `sign` / `verify` / `checksum` / `audit` 类步骤的次数 **= 0**
  - 或：每个此类豁免必须有 `# khy-allow-*: <理由>` 且理由非空
- **khy-os 现状**：`sigstore sign ... || echo "... (non-fatal, continuing)"` → **GAP**
- **目标**：签名失败必须 NO-GO，或明确声明"本仓不做签名"并移除该步骤。

### D5 可验证的产物完整性 —— 「下载侧能独立校验」

- **定义**：每个公开产物必须附带**下载侧可独立执行**的校验信息，
  且该信息**与产物同源发布**。
- **对标**：
  - ZCode：`sha256.txt` 与 tarball **同目录**发布
  - opencode：文档站链接内嵌确切版本号，产物按版本目录组织
- **判据**：
  - 每个发布产物存在同名 `.sha256`（或 `SHA256SUMS`）
  - `SHA256SUMS` 在**发布物内**（而非仅 CI artifact）
  - 存在"下载 → 校验 → 安装"三步的**可复现文档段落**，且被黄金路径脚本覆盖
- **khy-os 现状**：生成但不进发布物、无校验回路 → **GAP**
- **目标**：`install.sh`/`install-khy.ps1` 内**先校验再安装**。

### D6 SBOM 必须被消费 —— 「SBOM 不是上传了事」

- **定义**：SBOM 的用途是**下游可扫漏洞**。若从未有消费者，则它只是装饰。
- **对标**：ZCode/opencode 均未公开 SBOM 细节，但两者都有明确的
  **第三方合规材料位置说明**（`third-party/README.md` / `THIRD-PARTY-NOTICES.md`），
  即"这些材料去向何处"是**被写明的**。
- **判据**：
  - SBOM 生成后在**同一 workflow 内被至少一个步骤消费**（如 `grype` / `osv-scanner` / `trivy`）
  - 或：SBOM 与产物**同发布**，并有一行文档说明消费者如何取用
- **khy-os 现状**：仅 `upload-artifact`，90 天过期 → **GAP**
- **目标**：SBOM 驱动一次真实漏洞扫描，结果进发布门（可为 `recommended`）。

### D7 债务必须可收敛（managed / legacy 模型）

- **定义**：允许存量违规，但必须**按模块显式豁免**，且**豁免清单单调递减**。
- **对标**：**ZCode 的 `managed` / `legacy` 双态模型**——
  这是 ZCode 最值得直接照搬的一条。
  opencode 则用 `.gitleaksignore` 等基线文件表达同类思想。
- **判据**：
  - 每个"存量豁免"必须是**逐模块登记**，不得是"整类跳过"
  - 豁免条目数存在**棘轮**：只降不升（本仓已有 `ruleguard-baseline.json` 与
    `check:debt-ledger`，可复用同一模式）
  - 台账 `measured` 必须与**实测 `counts` 对账**（项目记忆已记录二者曾脱节）
- **khy-os 现状**：`check-zcode-baseline.js` 已实现 `managedOnly` 语义且记账清晰
  （"纳管 498 文件 · 违规 0 ‖ legacy 未纳管 3037 文件 · 超标 566"）→ **PASS**
- **目标**：保持，并把 566 这个数字纳入棘轮，防止它悄悄变大。

### D8 阶段毕业必须被结算 —— 「S1 不是墓碑」

- **定义**：S1 观察者必须有**明确的毕业判据与结算动作**；
  长期停在 S1 的强检查，要么毕业、要么**明确记录"为何不毕业"**。
- **对标**：ZCode 的迁移是**逐模块推进的工程活动**，不是"登记了就完事"。
  opencode 的 Oxlint 从"启用"到"启用 type-aware 规则并修 8 处违规"是**可见的推进史**。
- **判据**：
  - 每个 S1 机制有 `graduationCriteria`（本仓已有，见 `FEATURE-OWNERSHIP.json`）
  - 存在**结算动作**：到期未毕业者必须留 `slipped` 痕迹（本仓 `check:debt-ledger`
    已有该语义）——**把它扩展到 rollout**
  - 发布相关的强检查，S1 停留**不得超过一个发布周期**
- **khy-os 现状**：发布链上多个强检查停在 S1 且无结算 → **GAP**
- **目标**：发布门相关机制**不允许停在 S1**（见 §4.3 的例外说明）。

### D9 端到端黄金路径 —— 「一条命令，已被验证」

- **定义**：存在**唯一一条**从零到可运行的路径，且**每次发布前在干净环境跑通**。
- **对标**：
  - ZCode：`install.sh` → `~/.zcode/runtime` → `zcode` 可跑
  - opencode：`curl ... | bash` → `opencode` 可跑；或 `npm i -g` → 可跑
- **判据**：
  - 存在 `check:golden-path`：在**干净容器/新 worktree** 中执行文档首条命令并断言成功
  - 该检查在发布门中 `tier='must'`
  - 文档中的命令与脚本中的命令**来自同一真源**（不是两处手写）
- **khy-os 现状**：README 给 6+ 种起步方式，**无一条被端到端验证** → **PARTIAL**
- **目标**：收敛为一条（或每渠道一条），并自动化验证。

### D10 边界必须写明 —— 「知道自己不做什么」

- **定义**：明确声明支持范围、不支持范围、已知限制与降级策略。
- **对标**：
  - opencode `SECURITY.md`：**明文拒绝 AI 生成的安全报告**
  - opencode v2 文档：**"Windows package managers are not supported"**（直说不支持）
  - ZCode `NOTICE.md`：功能与优惠范围、维护规则、执行与数据风险、许可边界
- **判据**：
  - 存在 `SECURITY.md` / `NOTICE.md` 等边界文档且**含"不支持"清单**
  - 平台支持矩阵（OS × 架构）**显式列出**，未支持项直说不支持
  - 降级策略写明（如"无 Node 时如何"）
- **khy-os 现状**：README 有平台徽章，但**无"不支持什么"清单**；
  `docs/06_DEPLOY_部署/` 材料丰富但未收敛成边界声明 → **PARTIAL**
- **目标**：一份 1 页的 `DELIVERY-BOUNDARY.md`（支持矩阵 + 不支持清单 + 降级策略）。

---

## §4 判据落地：记分板与门禁接线

### 4.1 判据优先级与阈值总表

| ID | 判据 | 阈值 | 首轮档位 | 是否阻断 |
|---|---|---|---|---|
| **D1** | 仓库完整性 | fsck error = 0 且 `log --all` 退出码 0 | **S3 / must** | ✅ **阻断** |
| **D2** | 发布物存在且可安装 | `dist/` 三件非空 + 干净容器装成功 | S2 / must | 暂不阻断（先记录 1 周期） |
| **D3** | 新克隆零缺件 | `??` 项 = 0（白名单显式声明） | S2 / must | 暂不阻断 |
| **D4** | 失败须阻断 | 校验类 `\|\| echo` = 0 | **S3 / must** | ✅ **阻断** |
| **D5** | 产物完整性可验 | 每产物有同源 `SHA256SUMS` | S2 / must | 暂不阻断 |
| **D6** | SBOM 被消费 | SBOM → 至少一次真实扫描 | S1 / advisory | ❌ |
| **D7** | 债务可收敛 | legacy 超标数**只降不升** | S3 / must | ✅ **阻断** |
| **D8** | 阶段已结算 | 发布相关机制不在 S1 超一周期 | S1 / advisory | ❌ |
| **D9** | 黄金路径 | 干净环境一条命令跑通 | S2 / must | 暂不阻断 |
| **D10** | 边界写明 | 存在含"不支持清单"的边界文档 | S1 / advisory | ❌ |

> ⚠ **档位判定依据**（不臆造）：
> - D1 / D4 直接**阻断**：因为它们是"交付物完整性"与"失败可见性"，
>   属于**一旦缺失则其余度量全部失去意义**的地基。允许观察期等于允许交付残次品。
> - D7 直接阻断：**棘轮**是本仓已验证的成熟模式（`ruleguard-baseline.json` 已跑通），
>   复用既有机制而非新造，故无需观察期。
> - 其余先 S1/S2 记录，**但必须在本文档的"下一轮结算"中给出升阶决定**，
>   否则重蹈 §1.3 的墓碑化。

### 4.2 记分板设计（对标 `check-zcode-baseline.js`）

建议新增 `scripts/ci/check-delivery-baseline.js`，输出**同构**的记分板：

```
== 可交付性记分板（[DESIGN-DELIV-001]）==
阶段: <S1|S2|S3>   根: <repoRoot>
------------------------------------------------------------------
[D1 PASS   ] 仓库完整性
            目标: fsck error = 0 且 git log --all 退出码 = 0
            现状: fsck error = 0 · log --all = 0 · broken link = 0
[D2 GAP    ] 发布物存在且可安装
            目标: dist/ 含 wheel + sdist + npm tarball，干净容器装成功
            现状: dist/ 不存在
...
------------------------------------------------------------------
汇总: PASS 3 · PARTIAL 2 · GAP 5 · OBSERVE 0
```

**必须满足的三条硬要求**（否则重蹈 §1.2 的"漂亮但无害"）：

1. **结构化输出**：`--json` 可被测试消费；
   判读一律认 `counts` 而非人读文案（本仓已有该纪律）。
2. **反向验证**：每个检查项必须有**fixture 让它在违规时变红**。
   测试断言：`GAP 数 > 0 时 exit code 必须非 0`（S3 档）。
3. **阈值外部化**：阈值来自本文档 / 登记表，**不得硬编码在检查器内部**。

### 4.3 阶段选择：为什么 D1/D4/D7 可以直进 S3

本仓 `PROCESS-008` 规定**禁止直进 S3**，理由是"新机制误报率未知"。

本文认为 **D1 / D4 / D7 不适用该顾虑**，依据：

| 判据 | 为何无"误报率"问题 |
|---|---|
| D1 | `git fsck` 是 **git 自身的权威判定**，非自研阈值。真红即真错 |
| D4 | `\|\| echo` 是**文本事实**，命中即为真（且有 `khy-allow` 豁免通道） |
| D7 | 复用**既有**棘轮机制（已跑通、已做过反向验证），非新机制 |

即：**这不是"新机制"，而是"把既有机制接到交付面"**。
按 `PROCESS-008` 的精神（毕业以样本量计，防的是**自研判定**的误报），
引用权威外部判定 + 复用已验证机制，**不构成新建机制**。

> ⚠ **此判断需在评审时确认**。若评审认为仍应从 S1 起，则 D1 至少必须以
> **"独立于发布门的手动体检项"**存在，并在 §5 的首轮体检中立刻执行——
> **不允许它进入 S1 墓碑队列**。

### 4.4 接线清单（参照本仓四触点）

新增 `check-delivery-baseline.js` 后，按既有接线契约补齐：

1. **门表面**：`package.json` 增 `"check:delivery": "node scripts/ci/check-delivery-baseline.js"`
2. **登记表**：`RULES-REGISTRY.json` 补条目（`ssot` = 本文档、
   `exec.script` = 上述路径）；同步 `meta.ruleCount`
3. **真源标记**：本文档头部加 `<!-- RULES-REGISTRY: <新规则ID> -->`；
   `AGENTS.md` 第 3 行 marker 补 ID 并补规则正文
4. **规则卡**：`npm run docs:rules-cards` 重生成（**禁止手改卡片**）
5. **发布门阶段表**：`scripts/release/lib/releaseGateStages.js` **追加阶段**，
   D1 阶段 `tier='must'`

> ⚠ 依据项目记忆：阶段表匹配是 `text.includes(<执行器 basename>)` 且取全文，
> **无 stage 过滤器** ⇒ 端到端验收只能跑整门；
> 且契约测试只锁 `length>0`+id 唯一 ⇒ **加阶段不会被既有测试发现** ⇒
> **必须补断言，并实测"关掉守卫它真变红"**。

---

## §5 首轮体检结论（对本仓即为整改顺序）

> 以下按"**先恢复可信，再谈优雅**"排序。前 3 项做完之前，
> 其余所有可交付性度量都建立在流沙上。

| 序 | 动作 | 对应判据 | 验收 |
|---|---|---|---|
| **1** | 修仓库完整性：找回/重建 314 缺失 blob、63 缺失 tree、3 缺失 commit，重建 cache-tree，清理失效远端 ref | D1 | `git fsck` 四类计数全 0、`log --all` 退出码 0 |
| **2** | 补提交 27 个前端视图；处理 149 未跟踪 + 127 已删除未提交 | D3 | `??` = 0 且 `D` = 0 |
| **3** | 真正产出一次发布物并留盘（可 `--dry-run` 但须出 `dist/`） | D2 | `dist/` 三件非空 |
| **4** | 去掉 2 处签名步骤的 `\|\| echo`，或明确移除签名 | D4 | `grep` 计数 = 0 |
| **5** | 校验和 / SBOM 进发布物 + 加下载侧校验回路 | D5 / D6 | `SHA256SUMS` 在产物内 |
| **6** | 发布相关 S1 机制结算（毕业或记 `slipped`） | D8 | 无"发布相关且停在 S1" |
| **7** | 收敛黄金路径为一条并自动化 | D9 | `check:golden-path` 通 |
| **8** | 写 `DELIVERY-BOUNDARY.md`（支持矩阵 + 不支持清单） | D10 | 文档存在且含不支持项 |
| **9** | 落地 `check-delivery-baseline.js` 记分板 + 反向验证测试 | 全部 | 违规 fixture 真变红 |

### 5.1 一句话诊断

> **khy-os 的可交付性差，不是因为"治理不足"，而是因为"治理全部指向内部一致性，
> 没有一条指向外部可交付性"。**
>
> 88 条规则守的是"仓库内部自洽"（分层、命名、登记、孪生件、规则卡）；
> 而真正决定"别人能不能用上"的五件事——**仓库能克隆、产物存在、校验可验、
> 失败阻断、路径已验**——一件都没有被强制。
>
> ZCode 用 `managed/legacy` 让债务**可收敛**；opencode 用 7+ 渠道让交付**可触达**。
> khy-os 用 88 条规则让内部**可审计**——这三者是**不同维度**，
> 前者不能替代后者。

---

## §6 结论

1. **"可交付性差"已被证伪为"不是感觉，是可测事实"**：
   **314 个缺失 blob / 63 个缺失 tree / 3 个缺失 commit**、`git log --all` 直接 fatal、
   `dist/` 不存在、149 未跟踪 + 127 已删除未提交、签名失败被吞、
   SBOM 无人消费、记分板 7 PASS 但恒不阻断。

2. **根因是度量维度错位**：既有治理**全部**指向仓库内部一致性，
   而交付面（克隆完整性 / 产物 / 校验 / 阻断 / 路径）**无一条被强制**。

3. **判断标准已给出**：D1–D10，每条有定义、对标依据、可测判据、现状与目标。
   其中 **D1 / D4 / D7 建议直接阻断**（依据见 §4.3），
   其余先记录但**必须在下一轮结算**。

4. **最值得照搬的两条外部实践**：
   - ZCode 的 **`managed` / `legacy` 双态迁移模型**（让债务可收敛）
   - opencode 的 **"每平台独立二进制 + 安装脚本与产物同源 + 版本索引机器可读"**
     （让交付可触达、可复现）

5. **立即动作见 §5**：先修仓库完整性与补件（1–3），
   再谈校验/阻断（4–6），最后上记分板（9）。

---

## 附录 A 复现命令速查

```bash
# D1 仓库完整性
git fsck --no-progress 2>&1 | sed 's/[0-9a-f]\{40\}/<sha>/g' | sort | uniq -c | sort -rn
#   314 missing blob · 63 missing tree · 3 missing commit · 62+7 broken link · 49 cache-tree
git log --oneline --all                              # fatal（目标：退出码 0）

# D2 发布物
ls dist                                              # 不存在（目标：三件非空）

# D3 新克隆零缺件
git status --porcelain | cut -c1-2 | sort | uniq -c | sort -rn  # 194 M / 149 ?? / 127 D
ls apps/ai-frontend/src/views/admin/ | wc -l          # 27（未跟踪的真实缺件）

# D4 失败须阻断
grep -rn "|| echo\|continue-on-error" .github/workflows scripts/release | grep -iE "sign|verify|checksum|audit"

# D6 SBOM 被消费
grep -n -A6 -B4 "sbom" .github/workflows/dual-channel-release.yml

# D7 债务棘轮
node scripts/ci/check-zcode-baseline.js              # managed 498/0 ‖ legacy 3037/566

# 记分板自述（恒不阻断）
grep -n "恒返回 0\|ALWAYS exits 0" scripts/ci/check-zcode-baseline.js scripts/release/source-hygiene-scan.js
```

## 附录 B 外部对标来源

| 来源 | 采信的要点 |
|---|---|
| `github.com/zai-org/ZCode` README + 文件列表 | 多形态同源、`bundle:desktop`/`build:zcode`、`ZCODE_DIST_BASE_URL` + `latest.json` + `install.sh`、`sha256.txt`、`architecture-policy.yaml` + `.architecture-baseline.json`、`managed/legacy`、mise/nvmrc/npmrc 四重锁定、`THIRD-PARTY-NOTICES.md` |
| `opencode.ai/v2/docs` | v2 版本号 **2.0.6**、`/v2/install` 一行脚本、7+ 包管理器、**每平台独立二进制**（darwin/win/linux × arm64/x64 × glibc/musl × baseline）、`postinstall` 选原生二进制、Desktop 五格式、`opencode pair`、Docker 版本化 tag、安装目录优先级链、**"Windows package managers are not supported"** |
| `github.com/sst/opencode` | Oxlint（type-aware）/ Prettier / **Gitleaks** / Husky / Conventional Commits、`sync release versions` 统一同步、`SECURITY.md` 拒绝 AI 生成安全报告、18+ 语言 README |
| `scripts/ci/check-zcode-baseline.js`（仓内） | 阈值来源说明（对齐 ZCode `architecture-policy.yaml` `global`）、`managedOnly` 语义、S1 自述 |

---

## 附录 C 术语

| 术语 | 含义 |
|---|---|
| **可交付性**（deliverability） | 陌生人能否在陌生机器上从公开渠道安装、运行、信任并升级本产品 |
| **交付面** | 决定可交付性的最小检查集合（克隆完整性 / 产物 / 校验 / 阻断 / 黄金路径 / 边界） |
| **内部一致性** | 仓库自身自洽（分层、命名、登记、孪生件等）——**不等于**可交付性 |
| **managed / legacy** | ZCode 的债务双态：未纳管豁免、纳管必达标，逐模块迁移 |
| **恒真断言 / 空转断言** | 无论输入如何都不失败的检查——与无检查等价 |
| **S1 墓碑** | 登记为观察者后从未结算、也从不阻断的机制 |
