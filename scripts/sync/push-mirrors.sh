#!/usr/bin/env bash
# push-mirrors.sh - Push the current branch to configured GitHub/Gitee mirrors.
# Credentials stay in Git's credential helper or CI secrets.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

BRANCH="${1:-$(git branch --show-current 2>/dev/null)}"
if [[ -z "$BRANCH" || "$BRANCH" == "HEAD" ]]; then
  echo "[FAIL] Cannot determine the current branch." >&2
  exit 1
fi

REMOTES=()
for remote in origin gitee; do
  if git remote get-url "$remote" >/dev/null 2>&1; then
    REMOTES+=("$remote")
  fi
done

if [[ -n "${KHY_GITEE_REPO:-}" ]] && ! git remote get-url gitee >/dev/null 2>&1; then
  git remote add gitee "$KHY_GITEE_REPO"
  REMOTES+=(gitee)
fi

if [[ "${#REMOTES[@]}" -eq 0 ]]; then
  echo "[WARN] No mirror remotes configured; set origin and/or gitee." >&2
  exit 0
fi

for remote in "${REMOTES[@]}"; do
  echo "[INFO] Pushing $BRANCH to $remote ..."
  if git push "$remote" "HEAD:$BRANCH"; then
    echo "[OK] $remote/$BRANCH is up to date."
  else
    echo "[WARN] Push to $remote failed; the local commit is preserved." >&2
  fi
done

# A post-commit hook must not turn a successful local commit into a failed commit.
exit 0
