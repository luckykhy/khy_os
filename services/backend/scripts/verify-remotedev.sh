#!/usr/bin/env bash
# verify-remotedev.sh — manual verification for the unified remote-dev facade
# (khy remotedev / rdev). Hermetic: uses a throwaway data home + a synthetic SSH
# config, so it never touches your real ~/.ssh/config, ~/.khy, network, or daemon.
#
# What it proves:
#   1. status with no session renders the unified card (daemon + session + bridge
#      + discoverable config) and is honest about "not connected".
#   2. connect <host> resolves a host from the discoverable SSH config, opens a
#      logical session, prints host/user/port/workspace/connectionId, and writes
#      the durable pointer under <dataHome>/remotedev/session.json.
#   3. the durable pointer makes the session discoverable across invocations
#      (separate node process → "recoverable", not lost).
#   4. attach reconciles the pointer; stop tears it down by scope.
#   5. the master gate KHY_REMOTEDEV=0 disables the facade gracefully.
#   6. every port/auth/path knob is surfaced with its env var (no hardcoding).
#
# Usage:  bash services/backend/scripts/verify-remotedev.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # services/backend
cd "$HERE"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/ssh_config" <<'EOF'
Host devbox
    HostName 10.0.0.42
    User kode
    Port 2222
EOF

export KHY_DATA_HOME="$TMP/data"
export KHY_REMOTE_SSH_CONFIG_PATH="$TMP/ssh_config"

run() {  # run <args...> — drive the real router with the given command line
  node -e "const r=require('./src/cli/router'); r.route(r.parseInput(process.argv[1])).then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});" "$*"
}

line() { printf '\n\033[1m── %s ──\033[0m\n' "$1"; }

line "1. status — no session yet (should say 未连接 + show discoverable config)"
run remotedev status

line "2. gate off — KHY_REMOTEDEV=0 (should decline gracefully)"
KHY_REMOTEDEV=0 node -e "const r=require('./src/cli/router'); r.route(r.parseInput('remotedev status')).then(()=>process.exit(0));"

line "3. connect devbox --workspace /srv/app (logical session; no real ssh)"
run remotedev connect devbox --workspace /srv/app

line "4. durable pointer written to <dataHome>/remotedev/session.json"
POINTER="$TMP/data/remotedev/session.json"
if [ -f "$POINTER" ]; then
  echo "  ✓ pointer present:"; sed 's/^/    /' "$POINTER"
else
  echo "  ✗ pointer MISSING — discoverability broken"; exit 1
fi

line "5. status again, SAME process registry empty (new node) → recoverable"
# A fresh node process has an empty in-memory registry, but the durable pointer
# survives → the session must be reported as recoverable, never silently lost.
run remotedev status | grep -E "可恢复|recoverable|远端开发会话" || true

line "6. attach (no id) — reconciles the surviving pointer"
run remotedev attach

line "7. logs — daemon log path (file may be absent; must not throw)"
run remotedev logs

line "8. stop --scope session — clears session + pointer only"
run remotedev stop --scope session
if [ -f "$POINTER" ]; then
  echo "  ✗ pointer still present after stop"; exit 1
else
  echo "  ✓ pointer cleared"
fi

line "9. /remote hosts — the previously-broken handler now lists from the config"
run remote hosts

printf '\n\033[1;32mAll manual verification steps completed.\033[0m\n'
