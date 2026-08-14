#!/usr/bin/env bash
# @pattern Command
# ============================================================
#  export-sync.sh — 导出本机 git 增量 bundle（用于两台电脑间同步）
#
#  用法:
#    bash scripts/sync/export-sync.sh [--out <dir>] [--branch <name>] [--message <msg>] [--no-commit]
#
#  流程:
#    1. git add -A + git commit（把本机全部代码变更提交到当前分支）
#    2. git bundle create 生成增量 bundle 文件（含完整分支历史）
#    3. 将 bundle 发给另一台电脑，对方用 import-sync.sh 应用
#
#  本机 AI 数据（.khy/、.env、config.json 等）已由 .gitignore 排除，
#  不会进入 bundle —— 两台电脑的 AI 配置保持隔离。
# ============================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info() { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()   { echo -e "${GREEN}[OK]${NC}    $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail() { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

# --- Defaults ---
OUT_DIR=""
BRANCH=""
COMMIT_MSG=""
NO_COMMIT=0

usage() {
    cat <<'EOF'
用法:
  bash scripts/sync/export-sync.sh [选项]

选项:
  --out <dir>           bundle 输出目录（默认 <项目根>/../khy-sync/）
  --branch <name>       要导出的分支（默认当前分支）
  --message <msg>       提交信息（默认 "sync: 自动提交 <日期>"）
  --no-commit           不自动提交，仅导出已有提交的 bundle
  -h, --help            显示帮助

示例:
  bash scripts/sync/export-sync.sh                          # 提交+导出到 ../khy-sync/
  bash scripts/sync/export-sync.sh --out /mnt/usb/sync      # 指定输出目录
  bash scripts/sync/export-sync.sh --branch main            # 导出 main 分支
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --out) OUT_DIR="${2:-}"; shift 2 ;;
        --branch) BRANCH="${2:-}"; shift 2 ;;
        --message) COMMIT_MSG="${2:-}"; shift 2 ;;
        --no-commit) NO_COMMIT=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) fail "未知参数: $1 (用 --help 查看用法)" ;;
    esac
done

# --- Resolve branch ---
if [[ -z "$BRANCH" ]]; then
    BRANCH="$(git branch --show-current 2>/dev/null)" || fail "无法确定当前分支"
fi
[[ -z "$BRANCH" ]] && fail "当前不在任何分支上（detached HEAD），请先切换到分支"

# --- Default output dir ---
if [[ -z "$OUT_DIR" ]]; then
    OUT_DIR="$(dirname "$ROOT")/khy-sync"
fi
mkdir -p "$OUT_DIR"

# --- Optional commit ---
if [[ "$NO_COMMIT" == "0" ]]; then
    if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
        if [[ -z "$COMMIT_MSG" ]]; then
            COMMIT_MSG="sync: 自动提交 $(date +%Y-%m-%d)"
        fi
        info "提交本机变更到 $BRANCH ..."
        git add -A
        git commit -m "$COMMIT_MSG"
        ok "已提交: $(git log --oneline -1)"
    else
        info "工作区干净，无新增提交"
    fi
else
    info "--no-commit: 跳过提交"
fi

# --- Create bundle ---
STAMP="$(date +%Y%m%d-%H%M%S)"
BUNDLE="$OUT_DIR/khy-sync-$BRANCH-$STAMP.bundle"
info "导出 bundle: $BUNDLE (分支 $BRANCH) ..."
git bundle create "$BUNDLE" "$BRANCH"

echo
echo "=========================================="
echo "  导出完成"
echo "=========================================="
echo "  Bundle : $BUNDLE"
echo "  大小   : $(du -h "$BUNDLE" | awk '{print $1}')"
echo "  分支   : $BRANCH"
echo "  提交   : $(git log --oneline -1)"
echo
echo "  下一步: 将 bundle 发给另一台电脑，"
echo "          对方运行 bash scripts/sync/import-sync.sh --bundle <文件>"
echo "=========================================="
