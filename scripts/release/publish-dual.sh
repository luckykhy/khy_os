#!/usr/bin/env bash
# @pattern Command, Template Method
#
# One-shot dual-channel release: publish khy OS to BOTH PyPI (khy-os) and
# npm (@khy-os/khy-os) from a single command.
#
# Flow (audit-gated — nothing is published until BOTH channels audit clean):
#   1. Sync the version into its sources of truth:
#        - pyproject.toml                      (pip single source — what the wheel is built under)
#        - packaging/npm/package.json          (npm channel manifest)
#        - services/backend/package.json       (what `khy --version` reports)
#      platform/khy_platform/__init__.py keeps __version__ = _detect_version()
#      (resolved from pyproject.toml at runtime) so it can never drift — it is
#      normalized to the dynamic form, never hard-coded to a literal.
#   2. pip : isolated clean build + purity/completeness audit.
#   3. npm : prepack assemble + purity/completeness audit (+ devenv unit tests).
#   4. Publish — pip via twine, then npm via `npm publish --access public`.
#      A single audit failure aborts the whole run before anything is uploaded.
#   5. (optional) --tag commits the version bump + creates an annotated git tag
#      vX.Y.Z; --push also pushes the branch and tag to the remote.
#
# --dry-run runs every step EXCEPT the real upload (twine check / npm --dry-run)
# and the tag/push, so you can rehearse the full pipeline safely.
#
# ── 发布注解（单人维护速查，2026-07-14）──────────────────────────────────────
# 发一次 X.Y.Z 标准命令：
#     yes y | bash scripts/release/publish-dual.sh --version X.Y.Z
#   （脚本自带 `Proceed? [y/N]` 交互确认；非交互环境用 `yes y |` 喂确认。
#    不带 --tag = 只发包，不 commit / 不打 tag / 不 push——版本红线需人另行点头。）
#
# 已知坑：pip 审计报 `[FAIL] No sdist (*.tar.gz) found in .../dist`。
#   根因不在版本，而在 build-and-audit-pip-purity.sh：它先 `rm -rf dist` 再跑
#   `python3 -m build --sdist --wheel`。**隔离(isolated)构建**要联网取 build 依赖；
#   离线/无网时 sdist 步静默失败，dist/ 只剩 wheel → 审计找不到 tar.gz 而 FAIL。
#   规避：加 --no-isolation 走离线构建，或确保有网络后重跑：
#     yes y | bash scripts/release/publish-dual.sh --version X.Y.Z --no-isolation
#   另一历史外部坑：PyPI 单项目 10GB 配额可能挡 pip 上传(非本包超限，是累计配额)；
#   若只需先发 npm，加 --skip-pip，事后在 pypi.org 提额再补 pip。
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info() { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()   { echo -e "${GREEN}[OK]${NC}    $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail() { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }
step() { echo; echo -e "${CYAN}===${NC} $* ${CYAN}===${NC}"; }

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

INIT_PY="$ROOT_DIR/platform/khy_platform/__init__.py"
PYPROJECT="$ROOT_DIR/pyproject.toml"
NPM_PKG="$ROOT_DIR/packaging/npm/package.json"
BACKEND_PKG="$ROOT_DIR/services/backend/package.json"

VERSION=''
DRY_RUN='0'
REHEARSE='0'
SKIP_PIP='0'
SKIP_NPM='0'
TEST_PYPI='0'
NO_ISOLATION='0'
ASSUME_YES='0'
DO_TAG='0'
DO_PUSH='0'
REMOTE=''
BUMPED_FILES=()

usage() {
  cat <<'EOF'
Usage:
  bash scripts/release/publish-dual.sh <version> [options]
  bash scripts/release/publish-dual.sh --version <version> [options]

Publishes khy OS to BOTH PyPI (khy-os) and npm (@khy-os/khy-os). The version is synced
into all three version files, both channels are built + audited, and only if
both audits pass are the artifacts uploaded.

Options:
  --version X.Y.Z   Target version (also accepted as the first positional arg)
  --dry-run         Build + audit everything, but do NOT upload
                    (uses `twine check` and `npm publish --dry-run`)
  --rehearse        先干跑再发布: on a LIVE publish, run each channel's upload
                    dry-run (twine check / npm publish --dry-run) as a final
                    pre-flight immediately before the real upload. If the
                    rehearsal fails, that channel aborts BEFORE uploading.
                    Redundant with --dry-run (which never uploads). This is the
                    default authorized-publish safety step.
  --skip-pip        Publish npm only
  --skip-npm        Publish pip only
  --test-pypi       Upload pip to TestPyPI instead of PyPI
  --no-isolation    Build the wheel/sdist without build isolation (offline)
  --tag             After a successful publish, commit the version bump and
                    create an annotated git tag vX.Y.Z
  --push            Push the branch and tag to the remote (implies --tag)
  --remote NAME     Remote to push to (default: origin if present, else the
                    first configured remote)
  -y, --yes         Do not prompt for confirmation
  -h, --help        Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)      VERSION="${2:-}"; shift 2 ;;
    --dry-run)      DRY_RUN='1'; shift ;;
    --rehearse)     REHEARSE='1'; shift ;;
    --skip-pip)     SKIP_PIP='1'; shift ;;
    --skip-npm)     SKIP_NPM='1'; shift ;;
    --test-pypi)    TEST_PYPI='1'; shift ;;
    --no-isolation) NO_ISOLATION='1'; shift ;;
    --tag)          DO_TAG='1'; shift ;;
    --push)         DO_PUSH='1'; DO_TAG='1'; shift ;;
    --remote)       REMOTE="${2:-}"; shift 2 ;;
    -y|--yes)       ASSUME_YES='1'; shift ;;
    -h|--help)      usage; exit 0 ;;
    -*)             fail "Unknown option: $1" ;;
    *)
      if [[ -z "$VERSION" ]]; then VERSION="$1"; shift
      else fail "Unexpected argument: $1"; fi
      ;;
  esac
done

[[ -n "$VERSION" ]] || { usage; echo; fail "A version is required (e.g. 0.1.95)"; }
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.]+)?$ ]] \
  || fail "Version '$VERSION' is not a valid semantic version (X.Y.Z[-tag])"

if [[ "$SKIP_PIP" == '1' && "$SKIP_NPM" == '1' ]]; then
  fail "--skip-pip and --skip-npm together would publish nothing"
fi

# ── Preflight: required tooling ──────────────────────────────────────────────
step "Preflight"
if [[ "$SKIP_PIP" == '0' ]]; then
  command -v python3 >/dev/null 2>&1 || fail "python3 is required for the pip channel"
  python3 -m twine --version >/dev/null 2>&1 \
    || fail "twine missing — install it: python3 -m pip install twine"
fi
if [[ "$SKIP_NPM" == '0' ]]; then
  command -v npm  >/dev/null 2>&1 || fail "npm is required for the npm channel"
  command -v node >/dev/null 2>&1 || fail "node is required for the npm channel"
  if [[ "$DRY_RUN" == '0' ]]; then
    # The npm channel publishes from packaging/npm/, whose committed .npmrc binds
    # the registry auth token to ${NPM_TOKEN}:
    #     //registry.npmjs.org/:_authToken=${NPM_TOKEN}
    # If NPM_TOKEN is UNSET it expands to an EMPTY token that SHADOWS the real
    # token in ~/.npmrc, and `npm publish` fails with a 404 (no scope permission)
    # even though `npm whoami` (which reads ~/.npmrc directly) passes — a false
    # green. Since pip publishes first, that split-brain leaves pip on the new
    # version while npm stays a version behind, breaking dual-channel parity.
    #
    # Fix: when NPM_TOKEN is unset, derive it up front — from the sibling env
    # vars the guided publisher honors, then from ~/.npmrc via the pure leaf
    # resolveNpmRegistryToken (which rejects unresolved ${VAR} placeholders). If
    # nothing yields a token, fail HERE — before the pip channel uploads — so the
    # two channels can never drift.
    if [[ -z "${NPM_TOKEN:-}" ]]; then
      for _npm_env_fallback in NODE_AUTH_TOKEN NPM_AUTH_TOKEN; do
        if [[ -n "${!_npm_env_fallback:-}" ]]; then
          export NPM_TOKEN="${!_npm_env_fallback}"
          info "NPM_TOKEN taken from \$$_npm_env_fallback for the npm channel"
          break
        fi
      done
      unset _npm_env_fallback
    fi
    if [[ -z "${NPM_TOKEN:-}" && -f "$HOME/.npmrc" ]]; then
      # IO (reading ~/.npmrc) lives in this inline node shell; the parsing itself
      # is the pure leaf. The token is only ever assigned to an env var — never
      # printed (we log its length, not its value).
      _npm_derived_token="$(node -e 'const fs=require("fs");const {resolveNpmRegistryToken}=require(process.argv[1]);let c="";try{c=fs.readFileSync(process.argv[2],"utf8")}catch(e){}const t=resolveNpmRegistryToken(c,process.argv[3]);if(t)process.stdout.write(t)' \
        "$ROOT_DIR/scripts/release/lib/resolveNpmRegistryToken.js" "$HOME/.npmrc" "https://registry.npmjs.org/" 2>/dev/null || true)"
      if [[ -n "$_npm_derived_token" ]]; then
        export NPM_TOKEN="$_npm_derived_token"
        ok "NPM_TOKEN derived from ~/.npmrc for the npm channel (${#NPM_TOKEN} chars)"
      fi
      unset _npm_derived_token
    fi
    if [[ -z "${NPM_TOKEN:-}" ]]; then
      fail "npm channel needs an auth token but none was found. Set NPM_TOKEN (granular token with write on @khy-os + Bypass-2FA) or add \`//registry.npmjs.org/:_authToken=...\` to ~/.npmrc. Aborting BEFORE any upload so pip and npm can't drift."
    fi
    npm whoami >/dev/null 2>&1 \
      || fail "not logged in to npm — run \`npm login\` first (\`npm whoami\` must succeed)"
  fi
fi
command -v perl >/dev/null 2>&1 || fail "perl is required for in-place version edits"

TAG_NAME="v$VERSION"
if [[ "$DO_TAG" == '1' ]]; then
  command -v git >/dev/null 2>&1 || fail "git is required for --tag/--push"
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "not inside a git work tree"
  if git rev-parse -q --verify "refs/tags/$TAG_NAME" >/dev/null; then
    fail "git tag $TAG_NAME already exists — bump the version or delete the tag"
  fi
  if [[ "$DO_PUSH" == '1' ]]; then
    if [[ -z "$REMOTE" ]]; then
      if git remote | grep -qx origin; then REMOTE='origin'
      else REMOTE="$(git remote | head -1)"; fi
    fi
    [[ -n "$REMOTE" ]] || fail "--push requested but no git remote is configured"
    git remote | grep -qx "$REMOTE" || fail "git remote '$REMOTE' not found"
  fi
fi
ok "required tooling present"

# ── Current version (for the summary) ────────────────────────────────────────
# __init__.py no longer carries a literal (it resolves dynamically), so read the
# outgoing version from pyproject.toml — the static [project] source of truth.
CURRENT="$(perl -ne 'if (/^version\s*=\s*"([^"]+)"/) { print $1; last }' "$PYPROJECT" 2>/dev/null || true)"
[[ -n "$CURRENT" ]] || CURRENT='(unknown)'

# ── Confirmation ─────────────────────────────────────────────────────────────
TARGETS=()
if [[ "$SKIP_PIP" == '0' ]]; then
  if [[ "$TEST_PYPI" == '1' ]]; then TARGETS+=( "PyPI khy-os (TestPyPI)" )
  else TARGETS+=( "PyPI khy-os" ); fi
fi
[[ "$SKIP_NPM" == '0' ]] && TARGETS+=( "npm @khy-os/khy-os" ) || true

step "Release plan"
echo "  version : $CURRENT  ->  $VERSION"
echo "  targets : ${TARGETS[*]}"
echo "  mode    : $([[ "$DRY_RUN" == '1' ]] && echo 'DRY RUN (no upload)' || echo "LIVE PUBLISH$([[ "$REHEARSE" == '1' ]] && echo ' (rehearse then upload)')")"
if [[ "$DO_TAG" == '1' ]]; then
  echo "  git     : commit bump + tag $TAG_NAME$([[ "$DO_PUSH" == '1' ]] && echo " + push to $REMOTE")"
fi
if [[ "$ASSUME_YES" == '0' ]]; then
  printf "Proceed? [y/N] "
  read -r reply
  case "$reply" in [yY]|[yY][eE][sS]) ;; *) fail "aborted by user" ;; esac
fi

# ── 1. Sync the version into all three sources of truth ──────────────────────
step "Syncing version to $VERSION"

bump_init() {
  # __version__ resolves dynamically from pyproject.toml (single source of truth).
  # NEVER write a literal here: the version-sync gate (scripts/ci/check-version-sync.js)
  # rejects a hard-coded __version__, and a literal silently reintroduces drift.
  # Normalize to the dynamic form in case a prior run left a literal behind.
  perl -i -pe 's/^__version__\s*=.*/__version__ = _detect_version()/' "$INIT_PY"
  grep -q '^__version__ = _detect_version()' "$INIT_PY" || fail "failed to normalize $INIT_PY"
  BUMPED_FILES+=( "$INIT_PY" )
  ok "platform/khy_platform/__init__.py (dynamic)"
}
bump_json() {
  local file="$1" label="$2"
  # Replace only the FIRST "version": "..." (the package's own version field).
  perl -i -pe "if (!\$d && s/\"version\":\\s*\"[^\"]*\"/\"version\": \"$VERSION\"/) { \$d=1 }" "$file"
  grep -q "\"version\": \"$VERSION\"" "$file" || fail "failed to bump $file"
  BUMPED_FILES+=( "$file" )
  ok "$label"
}
bump_pyproject() {
  # pyproject.toml carries a STATIC [project] version that the build reads as the
  # source of truth — it MUST be bumped in lockstep with __init__.py or the wheel
  # is built under the old version. Replace only the first top-level version = "...".
  perl -i -pe "if (!\$d && s/^version\\s*=\\s*\"[^\"]*\"/version = \"$VERSION\"/) { \$d=1 }" "$PYPROJECT"
  grep -q "^version = \"$VERSION\"" "$PYPROJECT" || fail "failed to bump $PYPROJECT"
  BUMPED_FILES+=( "$PYPROJECT" )
  ok "pyproject.toml"
}

if [[ "$SKIP_PIP" == '0' ]]; then
  bump_init
  bump_pyproject
fi
# npm manifest + backend (what `khy --version` reports) stay in lockstep with pip.
bump_json "$NPM_PKG" "packaging/npm/package.json"
bump_json "$BACKEND_PKG" "services/backend/package.json"

# ── 2. Audit gate — BOTH channels must pass before anything is uploaded ───────
# 2a. Network-free khyos toolchain pin gate: a manifest carrying a drift-prone
#     pin (GitHub branch archive, or empty/malformed sha) must never ship — the
#     "strict-pin" half of strict-pin + graceful-degrade. Ships in BOTH channels,
#     so this runs regardless of --skip-pip/--skip-npm.
step "khyos toolchain pin gate (no drift-prone pins)"
node "$ROOT_DIR/scripts/release/pin-khyos-toolchain.js" --lint \
  || fail "khyos toolchain has a drift-prone pin — re-pin on a networked machine (see message above) before publishing"
ok "khyos toolchain pins are stable (no branch archives)"

if [[ "$SKIP_PIP" == '0' ]]; then
  step "pip — isolated build + purity/completeness audit"
  pip_audit_args=()
  [[ "$NO_ISOLATION" == '1' ]] && pip_audit_args+=( --no-isolation )
  bash "$ROOT_DIR/scripts/release/build-and-audit-pip-purity.sh" "${pip_audit_args[@]}"
fi

if [[ "$SKIP_NPM" == '0' ]]; then
  step "npm — prepack assemble + purity/completeness audit + unit tests"
  ( cd "$ROOT_DIR/packaging/npm" && npm run audit:purity && npm test )
fi

ok "all audits passed — proceeding to publish"

# ── 3. Publish (pip, then npm) ───────────────────────────────────────────────
if [[ "$SKIP_PIP" == '0' ]]; then
  step "Publishing pip"
  if [[ "$DRY_RUN" == '1' ]]; then
    python3 -m twine check "$ROOT_DIR"/dist/*
    ok "dry run: twine check passed (not uploaded)"
  else
    # 先干跑再发布: rehearse the exact artifacts about to ship, then upload.
    if [[ "$REHEARSE" == '1' ]]; then
      info "rehearsing pip upload (twine check) before the real upload…"
      python3 -m twine check "$ROOT_DIR"/dist/* \
        || fail "pip rehearsal failed — aborting BEFORE upload (nothing published)"
      ok "pip rehearsal passed — proceeding to real upload"
    fi
    if [[ "$TEST_PYPI" == '1' ]]; then
      python3 -m twine upload --repository testpypi "$ROOT_DIR"/dist/*
      ok "uploaded khy-os $VERSION to TestPyPI"
    else
      python3 -m twine upload "$ROOT_DIR"/dist/*
      ok "uploaded khy-os $VERSION to PyPI"
    fi
  fi
fi

if [[ "$SKIP_NPM" == '0' ]]; then
  step "Publishing npm"
  if [[ "$DRY_RUN" == '1' ]]; then
    ( cd "$ROOT_DIR/packaging/npm" && npm publish --access public --dry-run )
    ok "dry run: npm publish --dry-run passed (not uploaded)"
  else
    # 先干跑再发布: rehearse with npm's own dry-run, then the real publish.
    if [[ "$REHEARSE" == '1' ]]; then
      info "rehearsing npm publish (--dry-run) before the real publish…"
      ( cd "$ROOT_DIR/packaging/npm" && npm publish --access public --dry-run ) \
        || fail "npm rehearsal failed — aborting BEFORE publish (nothing published)"
      ok "npm rehearsal passed — proceeding to real publish"
    fi
    ( cd "$ROOT_DIR/packaging/npm" && npm publish --access public )
    ok "published @khy-os/khy-os $VERSION to npm"
  fi
fi

# ── 4. (optional) Commit the version bump, tag, and push ─────────────────────
if [[ "$DO_TAG" == '1' ]]; then
  step "Git tag$([[ "$DO_PUSH" == '1' ]] && echo ' + push')"
  if [[ "$DRY_RUN" == '1' ]]; then
    warn "dry run: skipping commit/tag$([[ "$DO_PUSH" == '1' ]] && echo '/push') ($TAG_NAME)"
  else
    git add -- "${BUMPED_FILES[@]}"
    git commit -m "release: $TAG_NAME" -- "${BUMPED_FILES[@]}"
    git tag -a "$TAG_NAME" -m "khy OS $VERSION"
    ok "committed version bump + tagged $TAG_NAME"
    if [[ "$DO_PUSH" == '1' ]]; then
      branch="$(git rev-parse --abbrev-ref HEAD)"
      git push "$REMOTE" "$branch"
      git push "$REMOTE" "$TAG_NAME"
      ok "pushed $branch and $TAG_NAME to $REMOTE"
    fi
  fi
fi

echo
if [[ "$DRY_RUN" == '1' ]]; then
  ok "DRY RUN complete — version files bumped to $VERSION, both channels audited clean. Nothing was uploaded."
else
  ok "Dual-channel release $VERSION complete."
  echo "  verify: pip install --upgrade khy-os && khy --version"
  echo "          (cd /tmp && npm init -y >/dev/null && npm install @khy-os/khy-os && npx khy --version)"
fi
