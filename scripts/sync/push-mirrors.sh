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

# Git Bash's `pwd` yields MSYS-style paths ("/d/Portable/khy-os"), which Windows Node
# resolves as "D:\d\Portable\khy-os" (prepends the current drive and treats the leading
# "d" as a literal directory name) -> MODULE_NOT_FOUND. Convert before handing to node.
NODE_ROOT="$ROOT"
if command -v cygpath >/dev/null 2>&1; then
  NODE_ROOT="$(cygpath -w "$ROOT")"
fi

# ---------------------------------------------------------------------------
# Bounded wall-clock budget for the network push (RUNTIME-003: an operation
# must be bounded by activity, never block forever).
#
# Why this is load-bearing: git runs post-commit *synchronously* and only
# updates refs/heads/<branch> after the hook returns. `mirror-sync.js push`
# talks to the network and, when a credential prompt or an unresponsive remote
# stalls it, it sits there indefinitely -- which means the branch ref is never
# written and `git log` reports "does not have any commits yet" even though the
# commit object is already safely on disk. Observed three times in this repo.
#
# So: cap the wait. On timeout the push is abandoned (never the commit), and the
# unsent work stays recoverable via the pending queue / `sync:mirrors:retry`.
# ---------------------------------------------------------------------------
PUSH_TIMEOUT="${KHY_MIRROR_PUSH_TIMEOUT:-120}"

# SIGTERM, then SIGKILL 5s later. Measured: a node process that ignores SIGTERM
# (default handler, no raw teardown) takes the full kill-after window, so the
# worst case is PUSH_TIMEOUT + 5s -- still bounded, which is the whole point.
PUSH_KILL_AFTER="${KHY_MIRROR_PUSH_KILL_AFTER:-5}"

if command -v timeout >/dev/null 2>&1; then
  timeout --kill-after="$PUSH_KILL_AFTER" "$PUSH_TIMEOUT" \
    node "$NODE_ROOT/scripts/sync/mirror-sync.js" push "${ARGS[@]}" || {
      rc=$?
      if [[ $rc -eq 124 || $rc -eq 137 ]]; then
        echo "[WARN] mirror push exceeded ${PUSH_TIMEOUT}s and was abandoned." >&2
        echo "       The commit is already recorded locally; retry later with:" >&2
        echo "       npm run sync:mirrors:retry" >&2
      fi
    }
else
  # No `timeout` on PATH: run it in the background and reap it after the budget
  # so a hung push still cannot hold the commit hostage.
  node "$NODE_ROOT/scripts/sync/mirror-sync.js" push "${ARGS[@]}" &
  push_pid=$!
  waited=0
  while kill -0 "$push_pid" 2>/dev/null; do
    if [[ "$waited" -ge "$PUSH_TIMEOUT" ]]; then
      echo "[WARN] mirror push exceeded ${PUSH_TIMEOUT}s and was abandoned (pid $push_pid)." >&2
      kill "$push_pid" 2>/dev/null || true
      sleep 1
      kill -9 "$push_pid" 2>/dev/null || true
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$push_pid" 2>/dev/null || true
fi

# A post-commit hook must not turn a successful local commit into a failed commit,
# and it must never prevent git from writing the branch ref.
exit 0
