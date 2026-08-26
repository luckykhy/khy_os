#!/usr/bin/env bash
# push-mirrors.sh - Push the current branch to configured GitHub/Gitee mirrors.
# Thin wrapper: all logic (failure classification, pending queue, retry) lives in
# scripts/sync/mirror-sync.js so it is testable and shared with the post-commit hook.
# Credentials stay in Git's credential helper or CI secrets.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

ARGS=()
BRANCH=""
for arg in "$@"; do
  case "$arg" in
    --*) ARGS+=("$arg") ;;
    *) [[ -z "$BRANCH" ]] && BRANCH="$arg" ;;
  esac
done

if [[ -z "$BRANCH" ]]; then
  BRANCH="$(git branch --show-current 2>/dev/null || true)"
fi
if [[ -n "$BRANCH" && "$BRANCH" != "HEAD" ]]; then
  ARGS+=("--branch=$BRANCH")
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[WARN] node not found on PATH; cannot record or flush the mirror push queue." >&2
  echo "       Install Node.js, then run: npm run sync:mirrors:retry" >&2
  exit 0
fi

node "$ROOT/scripts/sync/mirror-sync.js" push "${ARGS[@]}"

# A post-commit hook must not turn a successful local commit into a failed commit.
exit 0
