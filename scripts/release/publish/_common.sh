#!/usr/bin/env bash
# _common.sh — shared library for the guided multi-channel publish scripts.
#
# Sourced by publish-pip.sh / publish-npm.sh / publish-github.sh /
# publish-gitlab.sh / publish-gitee.sh. It centralizes:
#
#   * consistent colored logging (info/ok/warn/fail/step)
#   * prompts, including HIDDEN (no-echo) token prompts
#   * source-tree detection + auto `khy restore` (the fresh-machine path:
#     a pip/npm install has no working tree — restore reconstructs it from the
#     embedded encrypted snapshot before we can publish anything)
#   * git bootstrap from a restored snapshot (which is a `git archive`, so it
#     carries NO .git — we `git init` + commit before the first push)
#   * per-forge token-authenticated HTTPS remote URLs (github/gitlab/gitee),
#     used TRANSIENTLY for a single push so the token is never written to
#     .git/config, and always masked in any printed output.
#
# Design rules honored here:
#   - Tokens are read into a variable and never echoed; printed URLs are masked.
#   - The token URL is used for one `git push` and NOT persisted as a remote.
#   - Nothing here uploads on its own; each channel script drives the action.
#
# shellcheck shell=bash

set -euo pipefail

# ── Colors / logging ─────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  C_RED='\033[0;31m'; C_GREEN='\033[0;32m'; C_YELLOW='\033[1;33m'
  C_CYAN='\033[0;36m'; C_DIM='\033[2m'; C_NC='\033[0m'
else
  C_RED=''; C_GREEN=''; C_YELLOW=''; C_CYAN=''; C_DIM=''; C_NC=''
fi

info() { echo -e "${C_CYAN}[INFO]${C_NC}  $*"; }
ok()   { echo -e "${C_GREEN}[OK]${C_NC}    $*"; }
warn() { echo -e "${C_YELLOW}[WARN]${C_NC}  $*"; }
fail() { echo -e "${C_RED}[FAIL]${C_NC}  $*" >&2; exit 1; }
step() { echo; echo -e "${C_CYAN}===${C_NC} $* ${C_CYAN}===${C_NC}"; }
hint() { echo -e "${C_DIM}      $*${C_NC}"; }

# ── Global toggles the channel scripts set before sourcing helpers ───────────
ASSUME_YES="${ASSUME_YES:-0}"
DRY_RUN="${DRY_RUN:-0}"

# ── Prompts ──────────────────────────────────────────────────────────────────

# prompt_default <var-name> <prompt-text> [default]
# Reads a line; if empty, uses the default. In --yes mode the default is taken
# without prompting (a required value with no default aborts).
prompt_default() {
  local __var="$1" __text="$2" __default="${3:-}"
  local __reply=''
  if [[ "$ASSUME_YES" == '1' ]]; then
    __reply="$__default"
  else
    if [[ -n "$__default" ]]; then
      printf '%b' "${C_CYAN}?${C_NC} ${__text} [${__default}]: " > /dev/tty
    else
      printf '%b' "${C_CYAN}?${C_NC} ${__text}: " > /dev/tty
    fi
    IFS= read -r __reply < /dev/tty || __reply=''
    [[ -z "$__reply" ]] && __reply="$__default"
  fi
  printf -v "$__var" '%s' "$__reply"
}

# prompt_hidden <var-name> <prompt-text>
# Reads a secret without echoing it to the terminal. Never printed anywhere.
prompt_hidden() {
  local __var="$1" __text="$2" __reply=''
  if [[ "$ASSUME_YES" == '1' ]]; then
    # In non-interactive mode the secret MUST come from the environment; the
    # caller resolves env fallbacks before calling this, so reaching here in
    # --yes mode means it is genuinely missing.
    fail "缺少必需的凭据（--yes 非交互模式下无法提示输入）。请通过环境变量提供 token。"
  fi
  printf '%b' "${C_CYAN}?${C_NC} ${__text} (输入时不显示): " > /dev/tty
  IFS= read -r -s __reply < /dev/tty || __reply=''
  echo > /dev/tty
  printf -v "$__var" '%s' "$__reply"
}

# confirm <prompt-text> — returns 0 on yes. Auto-yes in --yes mode.
confirm() {
  local __text="$1" __reply=''
  [[ "$ASSUME_YES" == '1' ]] && return 0
  printf '%b' "${C_YELLOW}?${C_NC} ${__text} [y/N] " > /dev/tty
  IFS= read -r __reply < /dev/tty || __reply=''
  case "$__reply" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

# ── Repo root / source-tree resolution ───────────────────────────────────────

# is_source_tree <dir> — true when <dir> looks like the khy-os project root
# (has both pyproject.toml and services/backend), i.e. a publishable tree.
is_source_tree() {
  local d="$1"
  [[ -f "$d/pyproject.toml" && -d "$d/services/backend" ]]
}

# find_repo_root — walk up from this script to locate the project root when the
# scripts are being run in-place from a checkout. Echoes the path or empty.
find_repo_root() {
  local d
  d="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." 2>/dev/null && pwd)" || return 0
  if is_source_tree "$d"; then echo "$d"; fi
}

# ensure_source_tree — guarantee we have a working tree to publish from and cd
# into it. Order of resolution:
#   1. $KHY_PUBLISH_ROOT (explicit override)
#   2. the checkout this script lives in (in-place run)
#   3. auto `khy restore` into $KHY_RESTORE_DIR (default ./khy-os-src) — the
#      fresh-machine path where only the pip/npm install exists.
# Echoes the resolved absolute root and cds into it.
ensure_source_tree() {
  local override="${KHY_PUBLISH_ROOT:-}"
  if [[ -n "$override" ]]; then
    is_source_tree "$override" || fail "KHY_PUBLISH_ROOT 不是有效源码树: $override"
    cd "$override"; echo "$override"; return 0
  fi

  local in_place; in_place="$(find_repo_root || true)"
  if [[ -n "$in_place" ]]; then
    cd "$in_place"; echo "$in_place"; return 0
  fi

  # Fresh machine: restore the source from the embedded snapshot.
  local dest="${KHY_RESTORE_DIR:-$PWD/khy-os-src}"
  if is_source_tree "$dest"; then
    info "复用已还原源码树: $dest" >&2
    cd "$dest"; echo "$dest"; return 0
  fi

  command -v khy >/dev/null 2>&1 \
    || fail "未找到源码树，且 khy 命令不可用——无法自动还原。请先 pip/npm 安装 khy，或设 KHY_PUBLISH_ROOT。"

  step "还原源码（fresh-machine 路径）" >&2
  info "运行: khy restore \"$dest\" --force" >&2
  khy restore "$dest" --force >&2 \
    || fail "khy restore 失败——无法从安装包中还原完整源码。"
  is_source_tree "$dest" \
    || fail "还原完成但目录不是有效源码树: $dest"
  ok "源码已还原到: $dest" >&2
  cd "$dest"; echo "$dest"
}

# ── Version helpers ──────────────────────────────────────────────────────────
read_project_version() {
  local pyproject="${1:-pyproject.toml}"
  perl -ne 'if (/^version\s*=\s*"([^"]+)"/) { print $1; last }' "$pyproject" 2>/dev/null || true
}

# ── Git bootstrap for a restored snapshot ────────────────────────────────────

# ensure_git_repo <root> [commit-message]
# A restored snapshot is a `git archive` — it has NO .git. This makes the tree a
# real git repo (init + add + commit) so it can be pushed. If .git already
# exists (in-place checkout), it commits any pending changes only when asked.
ensure_git_repo() {
  local root="$1"
  local msg="${2:-release: publish khy-os from restored source snapshot}"
  cd "$root"
  if [[ -d .git ]]; then
    ok "已是 git 仓库: $root"
    return 0
  fi
  info "初始化 git 仓库（还原快照不含 .git）..."
  git init -q
  # git archive drops .gitattributes-driven eol; that is fine for a publish repo.
  git add -A
  # Identity may be unset on a fresh machine — provide a non-persistent default.
  local have_name have_email
  have_name="$(git config user.name || true)"
  have_email="$(git config user.email || true)"
  [[ -z "$have_name" ]]  && git config user.name  "khy-os release"
  [[ -z "$have_email" ]] && git config user.email "release@khy-os.local"
  git commit -q -m "$msg"
  ok "已创建初始提交（$(git rev-list --count HEAD) commit）"
}

# ── Per-forge token URL construction ─────────────────────────────────────────

# forge_host <platform>
forge_host() {
  case "$1" in
    github) echo 'github.com' ;;
    gitlab) echo 'gitlab.com' ;;
    gitee)  echo 'gitee.com'  ;;
    *) fail "未知平台: $1（支持 github|gitlab|gitee）" ;;
  esac
}

# normalize_repo_slug <input> — strip scheme/host/.git, yield owner/repo.
normalize_repo_slug() {
  local raw="$1"
  raw="${raw#git@*:}"
  raw="${raw#ssh://git@*/}"
  raw="${raw#https://*/}"
  raw="${raw#http://*/}"
  raw="${raw#/}"; raw="${raw%/}"
  raw="${raw%.git}"
  echo "$raw"
}

# mask_url <url> — replace any embedded userinfo (user:token@) with ***.
mask_url() {
  echo "$1" | sed -E 's#(https?://)[^@/]*@#\1***@#g'
}

# build_token_remote_url <platform> <slug> <token>
# Produces a one-shot authenticated HTTPS URL. Gitee requires user:token; GitHub
# and GitLab accept token-as-userinfo, but username:token is universally valid,
# so when a username is known we embed it. The token is NEVER logged; callers use
# the returned URL transiently and rely on mask_url() for any display.
build_token_remote_url() {
  local platform="$1" slug="$2" token="$3" user="${4:-}"
  local host; host="$(forge_host "$platform")"
  case "$platform" in
    github)
      # GitHub: any username works with a PAT; use x-access-token by convention.
      echo "https://${user:-x-access-token}:${token}@${host}/${slug}.git" ;;
    gitlab)
      # GitLab: PAT with username oauth2 (or the real user). oauth2 is canonical.
      echo "https://${user:-oauth2}:${token}@${host}/${slug}.git" ;;
    gitee)
      # Gitee: requires the real account username with the token as password.
      [[ -n "$user" ]] || fail "Gitee 需要账号用户名（--user 或提示输入）以配合 token 推送。"
      echo "https://${user}:${token}@${host}/${slug}.git" ;;
    *) fail "未知平台: $platform" ;;
  esac
}

# push_with_token <platform> <slug> <token> <branch> <user>
# Adds a transient remote-less push using the authenticated URL. The URL is
# passed directly to `git push <url> <branch>` so it is never stored in config.
push_with_token() {
  local platform="$1" slug="$2" token="$3" branch="$4" user="${5:-}"
  local url; url="$(build_token_remote_url "$platform" "$slug" "$token" "$user")"
  local masked; masked="$(mask_url "$url")"

  # Also register a persistent, TOKEN-FREE remote for the user's convenience.
  local clean_url="https://$(forge_host "$platform")/${slug}.git"
  if git remote get-url "$platform" >/dev/null 2>&1; then
    git remote set-url "$platform" "$clean_url"
  else
    git remote add "$platform" "$clean_url"
  fi

  info "推送到 ${platform}: ${masked} (分支 ${branch})"
  if [[ "$DRY_RUN" == '1' ]]; then
    warn "DRY RUN: 跳过实际推送 (git push <token-url> ${branch})"
    return 0
  fi
  # Push via the authenticated URL literal; token stays out of .git/config.
  local force_flag=()
  [[ "${PUSH_FORCE:-0}" == '1' ]] && force_flag=(--force-with-lease)
  git push "${force_flag[@]}" "$url" "HEAD:${branch}" \
    || fail "推送失败——请检查 token 权限（需 repo/write 权限）与仓库地址是否存在。"
  ok "推送完成: ${platform}/${branch}（远程 ${platform} 已配置为免 token 地址）"
}

# resolve_token <var-name> <prompt-text> <env-var-1> [env-var-2 ...]
# Fills <var-name> from the first non-empty env var, else prompts hidden.
resolve_token() {
  local __var="$1" __text="$2"; shift 2
  local __v='' e
  for e in "$@"; do
    if [[ -n "${!e:-}" ]]; then __v="${!e}"; info "使用环境变量 ${e} 中的凭据" >&2; break; fi
  done
  [[ -z "$__v" ]] && prompt_hidden __v "$__text"
  [[ -n "$__v" ]] || fail "未提供凭据，无法继续。"
  printf -v "$__var" '%s' "$__v"
}
