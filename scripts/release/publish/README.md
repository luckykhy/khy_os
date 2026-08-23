# 多渠道发布工具箱（scripts/release/publish/）

引导式发布脚本：把 khy-os 发布到 **pip / npm / GitHub / GitLab / Gitee** 五个渠道。

设计目标——**离机可用**：这些脚本随源码快照一起打进 pip/npm 包。在一台只装了
`pip install khy-os`（没有工作树、没有 `.git`）的全新机器上，任意脚本都会先
`khy restore` 还原完整源码、必要时 `git init` 建仓，然后再发布。你只需要设置好
仓库地址并提供一个 token。

| 脚本 | 渠道 | 仓库地址 | 凭据环境变量（优先级从高到低） |
|------|------|----------|-------------------------------|
| `publish-pip.sh`    | PyPI（khy-os） | **默认原仓库**，无需设置 | `TWINE_PASSWORD` / `PYPI_TOKEN` / `PYPI_API_TOKEN` |
| `publish-npm.sh`    | npm（@khy-os/khy-os） | 引导（默认 npmjs.org） | `NPM_TOKEN` / `NODE_AUTH_TOKEN` / `NPM_AUTH_TOKEN` |
| `publish-github.sh` | GitHub 源码 | 引导 `owner/repo` | `GITHUB_TOKEN` / `GH_TOKEN` |
| `publish-gitlab.sh` | GitLab 源码 | 引导 `owner/repo` | `GITLAB_TOKEN` / `GL_TOKEN` / `CI_JOB_TOKEN` |
| `publish-gitee.sh`  | Gitee 源码 | 引导 `owner/repo`（+用户名） | `GITEE_TOKEN` |

> pip 与其它渠道的区别：**pip 默认发到 khy-os 的原始 PyPI 仓库**，只要 token；
> 其它渠道只需引导设置仓库地址 + 输入 token，即可还原源码并发布。

## 快速开始

```bash
# pip —— 默认原仓库，只需 token
PYPI_TOKEN=pypi-xxxx bash scripts/release/publish/publish-pip.sh

# npm —— 引导 registry + token
NPM_TOKEN=npm_xxxx bash scripts/release/publish/publish-npm.sh

# GitHub / GitLab —— owner/repo + token
GITHUB_TOKEN=ghp_xxxx bash scripts/release/publish/publish-github.sh --repo kodehu03/khy-os
GITLAB_TOKEN=glpat_xx bash scripts/release/publish/publish-gitlab.sh --repo kodehu03/khy-os

# Gitee —— 需要账号用户名
GITEE_TOKEN=xxxx bash scripts/release/publish/publish-gitee.sh --repo kodehu03/khy-os --user kodehu03
```

不带凭据环境变量运行时，脚本会**隐藏输入**（不回显）提示你键入 token。

## 通用参数

- `--dry-run` —— 走完整流程但**不真实上传/推送**（pip=`twine check`，npm=`npm publish --dry-run`，
  git=跳过 `git push`）。用于安全彩排。
- `-y, --yes` —— 非交互模式；此模式下 token **必须**来自环境变量。
- `-h, --help` —— 每个脚本的完整参数说明。

git 渠道额外：`--repo SLUG`、`--user NAME`、`--branch NAME`、`--force`（`--force-with-lease`）。
pip 额外：`--repository NAME`、`--test-pypi`、`--no-isolation`、`--skip-build`。
npm 额外：`--registry URL`、`--access public|restricted`、`--skip-tests`。

## 安全red line

- **Token 绝不回显、绝不落盘为持久配置**：git 渠道用一次性 token URL 直接
  `git push <url>`，token 不写进 `.git/config`；同时登记一个**免 token** 的持久
  remote 供你后续手动使用。npm 渠道把 authToken 写进一次性 `.npmrc`，发布后
  `trap` 立即删除（若检测到你已有 `.npmrc` 则复用、不覆盖）。
- **打印的 URL 一律脱敏**（`user:token@` → `***@`）。
- **发布前先审计**：pip 复用隔离构建 + 纯净度审计（node_modules/模型/二进制绝不
  进包）；npm 复用 `audit:purity` + 单元测试。任一失败即在上传前中止。

## 源码还原（fresh-machine）

脚本按此顺序定位源码树：

1. `KHY_PUBLISH_ROOT`（显式覆盖，必须是有效源码树）
2. 脚本所在的就地 checkout
3. 自动 `khy restore "$KHY_RESTORE_DIR" --force`（默认 `./khy-os-src`）——从 pip/npm
   包内嵌的加密快照还原完整源码

还原出的快照是 `git archive`（不含 `.git`），git 渠道会自动 `git init` + 提交，
然后推送。

## sdist 白名单：什么不再进发行包，以及怎么把它变回来

sdist 的内容由 `scripts/release/pip_packaging_rules.py` 单点决定，`MANIFEST.in`
由它生成（`npm run check:manifest-sync` 强制两者一致）。规则本身是「广撒网 +
prune」的**黑名单**形态，漏东西是必然的，所以打完包之后还要过一道**白名单**：
`audit_pip_artifacts.py` 列出 sdist 的全部成员，凡是白名单没点名的一律让构建失败。

下面这些东西**刻意不再进发行包**，每一条都能在本地一条命令重建：

| 不再分发的内容 | 为什么 | 重建命令 |
| --- | --- | --- |
| `docs/_assets/mermaid.min.js`（3.12 MB） | 可再生构建产物，不进 git 却因为 MANIFEST 走工作树而进了包 | `npm run docs:mermaid`（随后 `npm run docs:build` 生成带图表的离线站） |
| `**/*.html`（147 个文档站派生件） | 都是 `build_docs_site.js` 从同名 `.md` 生成的；5 个真入口已单独放回 | `npm run docs:build` |
| `services/backend/.khy/`、`.khy_*` 标记 | 本机运行时状态。带着预置的 hydration 标记发出去，新装的机器会以为 bootstrap 跑过了 | 无需重建，首次运行自动生成 |
| `*.db-shm` / `*.db-wal` / `test-data-criterion-*/` | 本机跑校验脚本留下的 SQLite 边角料 | `node services/backend/verify-criterion-*.js` |
| `*.ast` / `*.typedtree` | moon 的构建中间件，`.mbt` 源码照常分发 | `moon build` |
| `[OPS-MAN-066] khyos进化提示词手册-1000条.md` | 内部运维材料，不该出现在公开发行版 | 仓库内原文件未删，只是不分发 |

新增一类文件而白名单没覆盖时，构建会停在 `[FAIL] ... outside the sdist allowlist`
并打印具体路径。判断清楚它该不该进发行包：不该进就在规则文件里排除，该进就写进
`SDIST_ALLOWED_*` 并**留下理由**。

单文件体积上限 1 MB（`SDIST_MAX_FILE_BYTES`），只有离线运行时 `bundle.mjs` 例外。
这条是给「又一个生成物混进来」兜底的——白名单按后缀判断，识别不了「同样是 .md，
一个是公开设计文档，一个是内部材料」，那一类只能靠显式排除。

## 为什么 bundle.mjs 留着不动（离线安装的全部本体）

`platform/khy_platform/bundled/runtime/khy/bundle.mjs` 是 sdist 里最大的单个文件，
解压后 16.66 MB，占 sdist 63.07 MB 的四分之一；在 wheel 那一侧它几乎**就是**全部
载荷（wheel 装出来 17.31 MB / 31 个文件）。曾经评估过三条瘦身路线，全部否掉：

| 方向 | 为什么不做 |
| --- | --- |
| 安装后再生成 | 生成它需要整套 npm 依赖树。装包的机器不一定有网，也不一定有 Node |
| 首次运行惰性拉取 | 把「装完就能用」换成「装完还得联网一次」，这是功能降级 |
| 拆成可选依赖 | 它不是可选能力，它是运行时本体。缺了它 wheel 装完一条命令都跑不了 |

判据很简单：`pyproject.toml` 根本没有 `dependencies` 字段，`pip install --no-index
<wheel>` 能在完全离线的干净 venv 里装成并跑通全部基本命令。**这个 bundle 正是为
离线准备的**，删掉它不是瘦身而是删产品。所以它是 `SDIST_MAX_FILE_BYTES` 唯一的
例外条目（`SDIST_LARGE_FILE_PATHS`）。

## 可选安装项：kernel / khyquant / khy-mobile 的拆分评估

结论：**两个安装渠道上这件事已经做完了，不需要再拆**；只有源码发行包（sdist）还
带着它们，而那是源码包应有的样子。

实测各渠道的载荷边界：

| 渠道 | 装出来的内容 | 是否含 kernel / khyquant / khy-mobile |
| --- | --- | --- |
| pip wheel | 只有 `khy_platform`（22 个文件）+ 内嵌 bundle | 都不含 |
| npm `@khy-os/khy-os` | 只有 `bin/` + `bundled/` | 都不含 |
| npm `khy-os-backend` | 只有 `services/backend`（files 白名单 35 条） | 都不含 |
| sdist（源码发行包） | 全仓源码 | khyquant 6.14 MB / 447 个文件；kernel 1.37 MB / 178 个文件；ai-frontend 1.31 MB / 114 个文件；khy-mobile **0 个文件**（已被规则排除） |

也就是说「核心 CLI 加网关能独立安装运行」这条已经成立，而且是实测成立的：干净
venv 里 `--no-index` 装 wheel 之后，`--version` / `doctor` / `gateway status` /
`where` / `preflight` 全部跑通，机器上没有 kernel 目录也没有 khyquant 目录。

sdist 这一侧**刻意不拆**，理由写在 `pip_packaging_rules.py` 的
`REQUIRED_SDIST_PATHS` 里：它把 `kernel/src`、`kernel/boot`、`kernel/Makefile`、两个
kernel iso 配置、三个 `kernel/vendor/moonbit` 文件、`apps/ai-frontend/src/main.js`、
`software/khyquant/frontend/src/main.js` 钉成源码包的**地板**。少了任何一个就说明
规则改错了，构建直接失败。另外 `platform/khy_platform/cli.py` 还留着一条
`bundled/services/backend` 镜像树的兼容分支，把这些目录从源码包里摘出去会同时动到
它，属于「为省 8 MB 源码去碰启动链路」，收益和风险不成比例。

## 共享库

- `_common.sh` —— 日志、隐藏输入、`ensure_source_tree`、`ensure_git_repo`、
  per-forge token URL 构造、`push_with_token`、`resolve_token`。
- `_git-forge.sh` —— 三个 git 渠道的共享驱动；`publish-github/gitlab/gitee.sh`
  只是声明 `PLATFORM=` 的薄封装。

以 `_` 开头的文件是库，不直接执行。
