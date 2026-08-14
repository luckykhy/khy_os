#!/usr/bin/env bash
# _git-forge.sh — 三个 git 托管平台（github/gitlab/gitee）发布脚本的共享驱动。
#
# 被 publish-github.sh / publish-gitlab.sh / publish-gitee.sh 以
# `PLATFORM=<平台> source _git-forge.sh` 的方式引入。它把三者唯一的差异
# （平台名 + token 环境变量名 + 是否强制要求用户名）收敛到一处，wrapper 只需
# 声明 PLATFORM 即可。
#
# 流程（与 pip/npm 渠道一致的“先还原源码再发布”）：
#   1. ensure_source_tree —— fresh-machine 自动 `khy restore`。
#   2. 引导仓库地址（owner/repo 或完整 URL，normalize 成 slug）。
#   3. 解析 token（平台环境变量优先，否则隐藏输入）；gitee 需账号用户名。
#   4. ensure_git_repo —— 还原快照不含 .git，则 git init + commit。
#   5. push_with_token —— 用一次性 token URL 推送，token 不落 .git/config，
#      并登记一个免 token 的持久 remote 供用户后续使用。
#
# 通用 Options（三个 wrapper 共享）：
#   --repo SLUG      owner/repo 或完整仓库 URL
#   --user NAME      账号用户名（gitee 必填；github/gitlab 可选）
#   --branch NAME    推送分支（默认当前分支，还原快照默认 main）
#   --force          以 --force-with-lease 推送（覆盖远端历史，谨慎）
#   --dry-run        走完全流程但跳过真实 push
#   -y, --yes        非交互（token 必须来自环境变量）
#   -h, --help       显示帮助
#
# shellcheck shell=bash
set -euo pipefail

: "${PLATFORM:?internal: PLATFORM must be set before sourcing _git-forge.sh}"

_FORGE_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/release/publish/_common.sh
source "$_FORGE_SCRIPT_DIR/_common.sh"

# 平台专属 token 环境变量名。
case "$PLATFORM" in
  github) TOKEN_ENVS=(GITHUB_TOKEN GH_TOKEN) ;;
  gitlab) TOKEN_ENVS=(GITLAB_TOKEN GL_TOKEN CI_JOB_TOKEN) ;;
  gitee)  TOKEN_ENVS=(GITEE_TOKEN) ;;
  *) fail "内部错误：未知平台 $PLATFORM" ;;
esac

REPO_SLUG=''
FORGE_USER=''
BRANCH=''
# DRY_RUN / ASSUME_YES / PUSH_FORCE come via env; flags below may set them.

forge_usage() {
  cat <<EOF
用法：
  bash scripts/release/publish/publish-${PLATFORM}.sh [options]

引导设置 ${PLATFORM} 仓库地址并输入 token，随后还原源码（若需要）并推送发布。

Options:
  --repo SLUG      owner/repo 或完整仓库 URL
  --user NAME      账号用户名（gitee 必填；github/gitlab 可选）
  --branch NAME    推送分支（默认当前分支）
  --force          以 --force-with-lease 推送（谨慎）
  --dry-run        走完流程但不真实推送
  -y, --yes        非交互（token 必须来自环境变量）
  -h, --help       显示帮助

Token 环境变量（按序）：${TOKEN_ENVS[*]}
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)    REPO_SLUG="${2:-}"; shift 2 ;;
    --user)    FORGE_USER="${2:-}"; shift 2 ;;
    --branch)  BRANCH="${2:-}"; shift 2 ;;
    --force)   PUSH_FORCE='1'; shift ;;
    --dry-run) DRY_RUN='1'; shift ;;
    -y|--yes)  ASSUME_YES='1'; shift ;;
    -h|--help) forge_usage; exit 0 ;;
    *)         fail "未知参数: $1（--help 查看用法）" ;;
  esac
done
export PUSH_FORCE="${PUSH_FORCE:-0}"

# ── 1. 源码树 ────────────────────────────────────────────────────────────────
step "解析源码树（${PLATFORM}）"
ROOT="$(ensure_source_tree)"
ok "源码根目录: $ROOT"
VERSION="$(read_project_version "$ROOT/pyproject.toml")"
[[ -n "$VERSION" ]] && info "源码版本: khy-os $VERSION"

# ── 2. 仓库地址 ──────────────────────────────────────────────────────────────
step "设置 ${PLATFORM} 仓库地址"
if [[ -z "$REPO_SLUG" ]]; then
  prompt_default REPO_SLUG "$(forge_host "$PLATFORM") 仓库（owner/repo 或完整 URL）" ""
fi
[[ -n "$REPO_SLUG" ]] || fail "必须提供仓库地址（--repo owner/repo）。"
SLUG="$(normalize_repo_slug "$REPO_SLUG")"
[[ "$SLUG" == */* ]] || fail "仓库地址无法解析为 owner/repo: $REPO_SLUG"
info "目标仓库: $(forge_host "$PLATFORM")/${SLUG}"

# gitee 的 token 推送需要真实账号用户名。
if [[ "$PLATFORM" == 'gitee' && -z "$FORGE_USER" ]]; then
  # 默认取 slug 的 owner 段作为用户名候选。
  prompt_default FORGE_USER "gitee 账号用户名" "${SLUG%%/*}"
fi

# ── 3. Token ─────────────────────────────────────────────────────────────────
step "解析 ${PLATFORM} 访问凭据"
resolve_token FORGE_TOKEN \
  "输入 ${PLATFORM} 访问 token（需 repo/write 权限）" \
  "${TOKEN_ENVS[@]}"

# ── 4. Git 仓库（还原快照无 .git 时初始化）────────────────────────────────
step "准备 git 仓库"
ensure_git_repo "$ROOT" "release: publish khy-os $VERSION to ${PLATFORM}"

# 默认分支：现有仓库取当前分支；否则 main。
if [[ -z "$BRANCH" ]]; then
  BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
  [[ "$BRANCH" == 'HEAD' || -z "$BRANCH" ]] && BRANCH='main'
fi
info "推送分支: $BRANCH"

# ── 5. 推送 ──────────────────────────────────────────────────────────────────
step "推送到 ${PLATFORM}"
if [[ "$ASSUME_YES" == '0' && "$DRY_RUN" == '0' ]]; then
  confirm "确认推送到 ${PLATFORM}/${SLUG} 分支 ${BRANCH}?" || fail "用户取消。"
fi
cd "$ROOT"
push_with_token "$PLATFORM" "$SLUG" "$FORGE_TOKEN" "$BRANCH" "$FORGE_USER"

echo
ok "${PLATFORM} 发布流程完成。"
echo "  远端: https://$(forge_host "$PLATFORM")/${SLUG}"
