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

## 共享库

- `_common.sh` —— 日志、隐藏输入、`ensure_source_tree`、`ensure_git_repo`、
  per-forge token URL 构造、`push_with_token`、`resolve_token`。
- `_git-forge.sh` —— 三个 git 渠道的共享驱动；`publish-github/gitlab/gitee.sh`
  只是声明 `PLATFORM=` 的薄封装。

以 `_` 开头的文件是库，不直接执行。
