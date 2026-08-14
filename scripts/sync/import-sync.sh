#!/usr/bin/env bash
# @pattern Command
# ============================================================
#  import-sync.sh — 导入另一台电脑的 git bundle（两台电脑间同步）
#
#  用法:
#    bash scripts/sync/import-sync.sh --bundle <file> [--branch <name>] [--merge] [--dry-run]
#
#  流程:
#    1. git fetch 从 bundle 拉取对方分支
#    2. 默认: 检出/更新到对方分支（--merge 时合并到当前分支）
#
#  说明:
#    - bundle 是完整分支历史，导入后本机拥有对方全部提交
#    - 若当前分支与对方分支名不同，默认切换到对方分支工作
#    - 用 --merge 保留本机分支并合并对方变更（需解决冲突时 git 会提示）
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

BUNDLE=""
BRANCH=""
MODE="checkout"   # checkout | merge
DRY_RUN=0

usage() {
    cat <<'EOF'
用法:
  bash scripts/sync/import-sync.sh --bundle <file> [选项]

必填:
  --bundle <file>       要导入的 bundle 文件（另一台电脑导出的 .bundle）

选项:
  --branch <name>       目标分支名（默认取 bundle 内的分支名）
  --merge               合并到当前分支，而非切换（默认: 切换到对方分支）
  --dry-run             只预览，不实际修改
  -h, --help            显示帮助

示例:
  bash scripts/sync/import-sync.sh --bundle ../khy-sync/khy-sync-main-20260813.bundle
  bash scripts/sync/import-sync.sh --bundle x.bundle --merge
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --bundle) BUNDLE="${2:-}"; shift 2 ;;
        --branch) BRANCH="${2:-}"; shift 2 ;;
        --merge) MODE="merge"; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) fail "未知参数: $1 (用 --help 查看用法)" ;;
    esac
done

[[ -z "$BUNDLE" ]] && { echo "缺少 --bundle <file>"; usage; exit 1; }
[[ -f "$BUNDLE" ]] || fail "bundle 文件不存在: $BUNDLE"

# --- Verify bundle ---
info "校验 bundle: $BUNDLE ..."
git bundle verify "$BUNDLE"

# --- Discover branch inside bundle ---
if [[ -z "$BRANCH" ]]; then
    BRANCH="$(git bundle list-heads "$BUNDLE" | awk '{print $2}' | sed 's|refs/heads/||' | head -1)"
fi
[[ -z "$BRANCH" ]] && fail "无法从 bundle 中确定分支名，请用 --branch 指定"
info "目标分支: $BRANCH"

# --- Dry-run preview ---
if [[ "$DRY_RUN" == "1" ]]; then
    info "[dry-run] 预览 bundle 内容:"
    git bundle list-heads "$BUNDLE"
    echo "  (dry-run 模式，未做任何修改)"
    exit 0
fi

# --- Fetch from bundle into a temp ref (avoids "checked out" refusal) ---
info "从 bundle 拉取分支 $BRANCH ..."
TMP_REF="refs/remotes/bundle-import/$BRANCH"
if ! git fetch "$BUNDLE" "refs/heads/$BRANCH:$TMP_REF"; then
    echo "  bundle 中实际可用的分支:"
    git bundle list-heads "$BUNDLE"
    fail "git fetch 失败: bundle 中不存在分支 $BRANCH"
fi

if [[ "$MODE" == "merge" ]]; then
    CUR="$(git branch --show-current 2>/dev/null || echo '')"
    [[ -z "$CUR" ]] && fail "当前不在分支上，无法 --merge"
    info "合并 $BRANCH 到当前分支 $CUR ..."
    git merge "$TMP_REF" --no-edit
else
    # If the branch already exists locally, just switch; otherwise create from temp ref.
    if git rev-parse --verify --quiet "refs/heads/$BRANCH" >/dev/null 2>&1; then
        info "切换到本地已有分支 $BRANCH ..."
        git checkout "$BRANCH"
        git merge "$TMP_REF" --no-edit
    else
        info "从 bundle 创建并切换分支 $BRANCH ..."
        git branch "$BRANCH" "$TMP_REF"
        if ! git checkout "$BRANCH"; then
            echo "  本机存在与导入分支冲突的 untracked 文件。"
            echo "  可选处理:"
            echo "    - 备份/移走冲突文件后重试"
            echo "    - 或丢弃本机 untracked 文件: git clean -fd"
            fail "git checkout 失败，导入已中止（本机文件未被改动）"
        fi
    fi
fi

echo
echo "=========================================="
echo "  导入完成"
echo "=========================================="
echo "  分支   : $BRANCH"
echo "  当前   : $(git branch --show-current 2>/dev/null || echo '-')"
echo "  最近提交: $(git log --oneline -1)"
echo
echo "  若合并产生冲突，请手动解决后:"
echo "    git add -A && git commit"
echo "=========================================="
