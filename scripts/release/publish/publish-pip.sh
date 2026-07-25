#!/usr/bin/env bash
# publish-pip.sh — 引导式 PyPI 发布（默认原仓库 khy-os）。
#
# 与其它渠道脚本不同：pip 默认发到 khy-os 的原始仓库（官方 PyPI），无需引导
# 设置仓库地址；用户只需提供一个上传 token（环境变量或隐藏输入）即可。
#
# 流程：
#   1. 解析/还原源码树（fresh-machine 走 `khy restore`）。
#   2. 复用 build-and-audit-pip-purity.sh：隔离构建 + 纯净度/完整性审计
#      （node_modules / 模型 / 二进制绝不进包）。审计不过则中止。
#   3. 解析 token（TWINE_PASSWORD / PYPI_TOKEN / PYPI_API_TOKEN，或隐藏输入）。
#   4. twine upload。--dry-run 只跑 twine check 不上传。
#
# 用法：
#   bash scripts/release/publish/publish-pip.sh [options]
#
# Options:
#   --repository NAME   twine 仓库名（默认 pypi；也可 testpypi 或 .pypirc 中的别名）
#   --test-pypi         等价 --repository testpypi
#   --no-isolation      离线构建（--no-isolation，需本机已装 build/setuptools/wheel）
#   --skip-build        审计并上传 ./dist 中已存在的产物（不重建）
#   --dry-run           构建 + 审计 + twine check，但不上传
#   -y, --yes           非交互（token 必须来自环境变量）
#   -h, --help          显示帮助
#
# Token 来源（按序）：TWINE_PASSWORD → PYPI_TOKEN → PYPI_API_TOKEN → 隐藏输入。
# 用户名固定为 __token__（PyPI API token 约定）。token 绝不回显、绝不落盘。
#
# shellcheck shell=bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/release/publish/_common.sh
source "$SCRIPT_DIR/_common.sh"

REPOSITORY='pypi'
NO_ISOLATION='0'
SKIP_BUILD='0'
# DRY_RUN / ASSUME_YES come from _common.sh env defaults; allow flags to set them.

usage() {
  sed -n '2,29p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repository)   REPOSITORY="${2:-}"; shift 2 ;;
    --test-pypi)    REPOSITORY='testpypi'; shift ;;
    --no-isolation) NO_ISOLATION='1'; shift ;;
    --skip-build)   SKIP_BUILD='1'; shift ;;
    --dry-run)      DRY_RUN='1'; shift ;;
    -y|--yes)       ASSUME_YES='1'; shift ;;
    -h|--help)      usage; exit 0 ;;
    *)              fail "未知参数: $1（--help 查看用法）" ;;
  esac
done

# ── 1. 源码树 ────────────────────────────────────────────────────────────────
step "解析源码树"
ROOT="$(ensure_source_tree)"
ok "源码根目录: $ROOT"
VERSION="$(read_project_version "$ROOT/pyproject.toml")"
[[ -n "$VERSION" ]] && info "待发布版本: khy-os $VERSION" || warn "无法从 pyproject.toml 读取版本号"

# ── 2. 隔离构建 + 纯净度审计（复用既有闸门）────────────────────────────────
step "隔离构建 + 纯净度/完整性审计"
audit_args=()
[[ "$NO_ISOLATION" == '1' ]] && audit_args+=( --no-isolation )
[[ "$SKIP_BUILD"   == '1' ]] && audit_args+=( --skip-build )
bash "$ROOT/scripts/release/build-and-audit-pip-purity.sh" "${audit_args[@]}" \
  || fail "构建或纯净度审计未通过——已在上传前中止（未发布任何内容）。"
ok "审计通过：产物在 $ROOT/dist"

command -v python3 >/dev/null 2>&1 || fail "需要 python3 以运行 twine"
python3 -m twine --version >/dev/null 2>&1 \
  || fail "缺少 twine——安装：python3 -m pip install twine"

# ── 3. Token ─────────────────────────────────────────────────────────────────
step "解析上传凭据"
info "目标仓库: $REPOSITORY（默认 pypi = khy-os 原始仓库）"
resolve_token PYPI_TOKEN_RESOLVED \
  "输入 PyPI API token（用户名固定 __token__）" \
  TWINE_PASSWORD PYPI_TOKEN PYPI_API_TOKEN

# ── 4. 上传 ──────────────────────────────────────────────────────────────────
step "发布 pip"
if [[ "$DRY_RUN" == '1' ]]; then
  python3 -m twine check "$ROOT"/dist/* \
    || fail "twine check 失败"
  ok "DRY RUN：twine check 通过（未上传）"
  exit 0
fi

if ! confirm "确认上传 khy-os $VERSION 到 $REPOSITORY?"; then
  fail "用户取消。"
fi

# 通过环境变量把凭据交给 twine，绝不出现在命令行/进程列表参数里。
info "先干跑再发布：twine check..."
python3 -m twine check "$ROOT"/dist/* \
  || fail "twine check 失败——已在上传前中止。"
ok "twine check 通过，开始上传"

TWINE_USERNAME='__token__' \
TWINE_PASSWORD="$PYPI_TOKEN_RESOLVED" \
python3 -m twine upload --repository "$REPOSITORY" "$ROOT"/dist/* \
  || fail "twine 上传失败——请检查 token 权限与网络。"

ok "已发布 khy-os $VERSION 到 $REPOSITORY"
echo "  验证: pip install --upgrade khy-os && khy --version"
