#!/usr/bin/env bash
# publish-npm.sh — 引导式 npm 发布（@khy-os/khy-os）。
#
# 引导用户设置 registry 地址并输入 npm token，随后 assemble + 纯净度审计 +
# 单元测试，最后 `npm publish --access public`。token 只写入一次性 .npmrc，
# 发布后立即删除，绝不落进仓库或用户全局配置。
#
# 流程：
#   1. 解析/还原源码树（fresh-machine 走 `khy restore`）。
#   2. 引导 registry 地址（默认官方 https://registry.npmjs.org/）。
#   3. 解析 npm token（环境变量或隐藏输入）→ 写入临时 .npmrc（trap 清理）。
#   4. prepack assemble + audit:purity + test（复用 packaging/npm 既有脚本）。
#   5. npm publish --access public。--dry-run 走 npm 自带 --dry-run 不上传。
#
# 用法：
#   bash scripts/release/publish/publish-npm.sh [options]
#
# Options:
#   --registry URL   npm registry 地址（默认 https://registry.npmjs.org/）
#   --access LEVEL   发布可见性 public|restricted（默认 public）
#   --skip-tests     跳过 npm test（默认执行）
#   --dry-run        assemble + 审计 + npm publish --dry-run，但不上传
#   -y, --yes        非交互（token 必须来自环境变量）
#   -h, --help       显示帮助
#
# Token 来源（按序）：NPM_TOKEN → NODE_AUTH_TOKEN → NPM_AUTH_TOKEN → 隐藏输入。
#
# shellcheck shell=bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/release/publish/_common.sh
source "$SCRIPT_DIR/_common.sh"

REGISTRY='https://registry.npmjs.org/'
ACCESS='public'
SKIP_TESTS='0'

usage() {
  sed -n '2,29p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --registry)  REGISTRY="${2:-}"; shift 2 ;;
    --access)    ACCESS="${2:-}"; shift 2 ;;
    --skip-tests) SKIP_TESTS='1'; shift ;;
    --dry-run)   DRY_RUN='1'; shift ;;
    -y|--yes)    ASSUME_YES='1'; shift ;;
    -h|--help)   usage; exit 0 ;;
    *)           fail "未知参数: $1（--help 查看用法）" ;;
  esac
done

command -v npm  >/dev/null 2>&1 || fail "需要 npm"
command -v node >/dev/null 2>&1 || fail "需要 node"

# ── 1. 源码树 ────────────────────────────────────────────────────────────────
step "解析源码树"
ROOT="$(ensure_source_tree)"
NPM_DIR="$ROOT/packaging/npm"
[[ -f "$NPM_DIR/package.json" ]] || fail "未找到 npm 包目录: $NPM_DIR"
ok "npm 包目录: $NPM_DIR"
VERSION="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$NPM_DIR/package.json" 2>/dev/null || true)"
[[ -n "$VERSION" ]] && info "待发布版本: @khy-os/khy-os $VERSION"

# ── 2. Registry 地址 ─────────────────────────────────────────────────────────
step "设置 registry 地址"
prompt_default REGISTRY "npm registry 地址" "$REGISTRY"
[[ "$REGISTRY" =~ ^https?:// ]] || fail "registry 地址必须以 http(s):// 开头: $REGISTRY"
info "registry: $REGISTRY"

# ── 3. Token → 一次性 .npmrc ─────────────────────────────────────────────────
step "解析发布凭据"
resolve_token NPM_TOKEN_RESOLVED \
  "输入 npm 发布 token（automation/publish token）" \
  NPM_TOKEN NODE_AUTH_TOKEN NPM_AUTH_TOKEN

# 用一次性 .npmrc 承载 authToken：不改用户全局 ~/.npmrc，发布后立即删除。
NPMRC_FILE="$NPM_DIR/.npmrc"
NPMRC_PREEXISTING='0'
[[ -e "$NPMRC_FILE" ]] && NPMRC_PREEXISTING='1'
cleanup_npmrc() {
  # 仅当本脚本创建了 .npmrc 时才删除；不误删用户预置文件。
  [[ "$NPMRC_PREEXISTING" == '0' && -e "$NPMRC_FILE" ]] && rm -f "$NPMRC_FILE"
}
trap cleanup_npmrc EXIT

if [[ "$NPMRC_PREEXISTING" == '1' ]]; then
  warn "检测到已存在的 .npmrc，将复用它（不写入 token，避免覆盖用户配置）"
else
  # //host/:_authToken 形式绑定到该 registry 的主机。
  reg_host="${REGISTRY#*://}"; reg_host="${reg_host%%/*}"
  {
    echo "registry=${REGISTRY}"
    echo "//${reg_host}/:_authToken=${NPM_TOKEN_RESOLVED}"
  } > "$NPMRC_FILE"
  chmod 600 "$NPMRC_FILE"
  ok "已写入一次性 .npmrc（发布后自动删除）"
fi

# ── 4. Assemble + 审计 + 测试 ────────────────────────────────────────────────
step "assemble + 纯净度审计$([[ "$SKIP_TESTS" == '0' ]] && echo ' + 单元测试')"
(
  cd "$NPM_DIR"
  npm run audit:purity || exit 1
  if [[ "$SKIP_TESTS" == '0' ]]; then npm test || exit 1; fi
) || fail "npm 审计或测试未通过——已在发布前中止（未发布任何内容）。"
ok "审计通过"

# ── 5. 发布 ──────────────────────────────────────────────────────────────────
step "发布 npm"
if [[ "$DRY_RUN" == '1' ]]; then
  ( cd "$NPM_DIR" && npm publish --registry "$REGISTRY" --access "$ACCESS" --dry-run ) \
    || fail "npm publish --dry-run 失败"
  ok "DRY RUN：npm publish --dry-run 通过（未上传）"
  exit 0
fi

if ! confirm "确认发布 @khy-os/khy-os $VERSION 到 $REGISTRY (access=$ACCESS)?"; then
  fail "用户取消。"
fi

info "先干跑再发布：npm publish --dry-run..."
( cd "$NPM_DIR" && npm publish --registry "$REGISTRY" --access "$ACCESS" --dry-run ) \
  || fail "npm 干跑失败——已在发布前中止。"
ok "干跑通过，开始发布"

( cd "$NPM_DIR" && npm publish --registry "$REGISTRY" --access "$ACCESS" ) \
  || fail "npm 发布失败——请检查 token 权限与 registry 地址。"

ok "已发布 @khy-os/khy-os $VERSION 到 $REGISTRY"
echo "  验证: (cd /tmp && npm init -y >/dev/null && npm install @khy-os/khy-os && npx khy --version)"
