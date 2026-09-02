#!/usr/bin/env bash
# enable-fs-compression.sh
# One-shot, best-effort transparent filesystem compression for a khy-os
# installation on Linux. This is the non-Windows counterpart of
# scripts/install/enable-ntfs-compression.ps1 and shares the same contract:
#
#   - Linux-only in practice; other systems exit 0 and do nothing.
#   - Btrfs: per-directory zstd via `btrfs property set` (new files inherit);
#     existing files are rewritten with `btrfs filesystem defragment -czstd`.
#     Falls back to `chattr +c` when btrfs-progs is missing (new files only).
#   - ZFS: enables `compression=zstd` (falls back to lz4) on the dataset that
#     hosts the project root. Dataset-wide by nature; existing data is not
#     rewritten. Needs privileges; failures are reported and ignored.
#   - ext4/XFS/F2FS/APFS: no supported transparent per-directory compression;
#     skipped with an honest message.
#   - Best-effort: never throws, never fails the calling installer.
#   - Idempotent: enabling twice is a no-op; a second defragment is cheap.
#
# Shared pnpm store: node_modules entries are hardlinks into the
# content-addressable store, so compressing the store compresses every
# hardlink view for free. The store is detected via `pnpm store path` and
# compressed with the same mechanism when it sits on a supported filesystem.
#
# Background mode re-invokes this same script per target in foreground mode
# from a detached runner, so the enable/compress logic exists exactly once.

set -u

say() { printf '[fs-compress] %s\n' "$1"; }

# --- Locate the installation root --------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT=""
FOREGROUND=0
NO_PNPM_STORE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --project-root) PROJECT_ROOT="${2:-}"; shift 2 ;;
    --foreground) FOREGROUND=1; shift ;;
    --no-pnpm-store) NO_PNPM_STORE=1; shift ;;
    *) shift ;;
  esac
done
if [ -z "$PROJECT_ROOT" ]; then
  # Default: repo root that contains this script (scripts/install/ -> root).
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." 2>/dev/null && pwd || true)"
fi
if [ ! -d "$PROJECT_ROOT" ]; then
  say "未找到安装目录: $PROJECT_ROOT，跳过压缩 (0 项待处理)"
  exit 0
fi

# --- Platform guard -----------------------------------------------------------
OS="$(uname -s 2>/dev/null || echo unknown)"
if [ "$OS" != "Linux" ]; then
  say "非 Linux 系统 ($OS): APFS/HFS+ 等无公开的目录级透明压缩接口，已跳过 (0 项待处理)"
  exit 0
fi

# --- Filesystem detection ------------------------------------------------------
fstype_of() {
  local p="$1" t=""
  t="$(findmnt -n -o FSTYPE -T "$p" 2>/dev/null | head -n 1)"
  if [ -z "$t" ]; then t="$(stat -f -c %T "$p" 2>/dev/null)"; fi
  printf '%s' "$t"
}

ROOT_FS="$(fstype_of "$PROJECT_ROOT")"
case "$ROOT_FS" in
  btrfs|zfs) : ;;
  *)
    say "文件系统 ${ROOT_FS:-未知} 不支持目录级透明压缩 (仅 btrfs/zfs 支持)，已跳过 (0 项待处理)"
    exit 0
    ;;
esac

# --- Shared pnpm store (hardlink source of node_modules) -----------------------
PNPM_STORE=""
if [ "$NO_PNPM_STORE" -eq 0 ] && command -v pnpm >/dev/null 2>&1; then
  P="$(pnpm store path 2>/dev/null | tail -n 1)"
  if [ -n "$P" ] && [ -d "$P" ]; then
    case "$P" in "$PROJECT_ROOT"|"$PROJECT_ROOT"/*) P="" ;; esac
    if [ -n "$P" ]; then
      case "$(fstype_of "$P")" in
        btrfs|zfs) PNPM_STORE="$P" ;;
      esac
    fi
  fi
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="${TMPDIR:-/tmp}/khy-os-fs-compress-$STAMP.log"

# --- Enablement: new files inherit compression (returns 0 if supported) -------
enable_target() {
  local t="$1" fs="$2"
  case "$fs" in
    btrfs)
      if command -v btrfs >/dev/null 2>&1; then
        btrfs property set "$t" compression zstd >/dev/null 2>&1 \
          || chattr +c "$t" >/dev/null 2>&1 || return 1
      else
        # btrfs-progs missing: chattr +c still covers newly written files.
        chattr +c "$t" >/dev/null 2>&1 || return 1
      fi
      ;;
    zfs)
      local ds cur
      ds="$(zfs list -H -o name,mountpoint -t filesystem 2>/dev/null \
            | awk -v p="$t" '$2==p {print $1; exit}')"
      if [ -z "$ds" ]; then
        # Longest-mountpoint prefix match as a fallback.
        ds="$(zfs list -H -o name,mountpoint -t filesystem 2>/dev/null \
              | awk -v p="$t" 'index(p,$2)==1 {if (length($2)>m){m=length($2);d=$1}} END{print d}')"
      fi
      [ -n "$ds" ] || return 1
      cur="$(zfs get -H -o value compression "$ds" 2>/dev/null)"
      case "$cur" in
        on|zstd|lz4|gzip*|zle|lze) : ;;
        *)
          zfs set compression=zstd "$ds" >/dev/null 2>&1 \
            || zfs set compression=lz4 "$ds" >/dev/null 2>&1 || return 1
          ;;
      esac
      ;;
    *) return 1 ;;
  esac
  return 0
}

# --- Rewrite existing data so it actually occupies compressed blocks ----------
# btrfs: defragment with -czstd; zfs: no safe online rewrite here, new writes
# are compressed and existing data gradually migrates.
compress_existing() {
  local t="$1" fs="$2"
  if [ "$fs" = "btrfs" ] && command -v btrfs >/dev/null 2>&1; then
    btrfs filesystem defragment -r -f -czstd "$t" >>"$LOG_FILE" 2>&1 || true
  fi
}

if [ "$FOREGROUND" -eq 1 ]; then
  if enable_target "$PROJECT_ROOT" "$ROOT_FS"; then
    say "已启用 $PROJECT_ROOT ($ROOT_FS，新文件自动继承压缩)，正在重写存量文件以落盘压缩..."
    compress_existing "$PROJECT_ROOT" "$ROOT_FS"
    say "压缩完成: $PROJECT_ROOT (明细见日志: $LOG_FILE)"
  else
    say "压缩启用失败: $PROJECT_ROOT (可能缺少 btrfs-progs 或权限不足)，已跳过该目标"
  fi
  exit 0
fi

# --- Background mode: detached runner re-invokes foreground per target --------
TARGETS=("$PROJECT_ROOT")
if [ -n "$PNPM_STORE" ]; then
  TARGETS+=("$PNPM_STORE")
fi

TARGET_FILE="${TMPDIR:-/tmp}/khy-os-fs-compress-targets-$STAMP.txt"
RUNNER="${TMPDIR:-/tmp}/khy-os-fs-compress-runner-$STAMP.sh"
: >"$LOG_FILE"
for t in "${TARGETS[@]}"; do
  printf '%s\n' "$t" >>"$TARGET_FILE"
done

cat >"$RUNNER" <<RUNNER_EOF
#!/usr/bin/env bash
set -u
while IFS= read -r t; do
  [ -n "\$t" ] || continue
  bash "$SCRIPT_DIR/enable-fs-compression.sh" --project-root "\$t" --foreground --no-pnpm-store
done <"$TARGET_FILE"
printf '[fs-compress] 后台压缩任务全部结束，日志: %s\n' "$LOG_FILE"
RUNNER_EOF
chmod +x "$RUNNER" 2>/dev/null || true

nohup bash "$RUNNER" >>"$LOG_FILE" 2>&1 &
disown 2>/dev/null || true

say "已在后台开始压缩 ${#TARGETS[@]} 个目录: $(printf '%s ; ' "${TARGETS[@]}")($ROOT_FS 文件系统，新文件自动继承压缩)"
say "进度日志: $LOG_FILE (不影响安装与日常使用，无需等待)"

exit 0
