#!/usr/bin/env python3
"""Single source of truth for pip packaging rules.

This module centralizes the include / exclude / required-path rules that were
previously duplicated across:

- ``MANIFEST.in`` (sdist source selection)
- ``setup.py`` (wheel bundled payload copy/prune logic)
- ``scripts/release/build-and-audit-pip-purity.sh`` (release-time auditing)

The goal is to keep the policy explicit and drift-resistant: packaging edits
should update this file first, then the generated manifest and audit consumers
pick up the same intent.
"""

from __future__ import annotations

from collections import OrderedDict


def _ordered_unique(items):
    return list(OrderedDict((item, None) for item in items).keys())


# Directories/files that MUST ship inside the sdist so the source release can
# rebuild the wheel and preserve the multi-language workshop.
SDIST_RECURSIVE_INCLUDES = _ordered_unique([
    "services/backend",
    # ai-backend hosts the user-gateway / proxy-subscription / marketplace /
    # plugins / workflow routers that services/backend's aiManagementServer
    # cross-requires via ../../../ai-backend/src/... . Omitting it made every
    # such daemon route 500 with "Cannot find module '../../../ai-backend/...'".
    "services/ai-backend",
    "platform/packages/shared",
    "platform/packages/moonbit-plugin-sdk",
    "docs",
    "extensions",
    "apps/ai-frontend",
    "software/khyquant",
    "kernel/src",
    "kernel/boot",
    "kernel/moonbit",
    "kernel/userland",
    "kernel/iso",
    "kernel/vendor",
    "kernel/alpine",
    "scripts",
])

SDIST_FILE_INCLUDES = _ordered_unique([
    "kernel/Makefile",
    "kernel/linker.ld",
    "kernel/README.md",
    "platform/khy_platform/_resources/dev-constraints.txt",
    "platform/khy_platform/_resources/__init__.py",
    "platform/khy_platform/_resources/tray-icon.png",
    "platform/khy_platform/bundled/runtime/khy/bundle.mjs",
    "package-lock.json",
    "apps/ai-frontend/package-lock.json",
    "software/khyquant/frontend/package-lock.json",
    "README.md",
    "AGENTS.md",
    "scripts/obfuscate.js",
])

# Historical / generated / sensitive trees that must never enter the source
# distribution. Keep the list path-specific where broad basenames would delete
# required application source such as ``src/models`` or ``src/data``.
SDIST_PRUNE_DIRS = _ordered_unique([
    "extensions/bridges/khy-trae-bridge/node_modules",
    "services/backend/node_modules",
    "services/backend/vendor",
    # Historical prepack output. Source snapshots are immutable Release payloads
    # and must never return to either pip artifact.
    "services/backend/_source",
    # ai-backend/node_modules is a dev symlink -> ../backend/node_modules;
    # without this prune, recursive-include would follow it and drag the entire
    # backend node_modules tree into the sdist.
    "services/ai-backend/node_modules",
    # khyosMarkdown's bridge, HTML shell, and OS integration ship in the sdist;
    # the 10.5 MB WYSIWYG vendor bundle is an immutable first-use payload.
    "extensions/tools/khy-markdown/muya-embed/node_modules",
    "extensions/tools/khy-markdown/vendor",
    "apps/ai-frontend/node_modules",
    "services/backend/models",
    "services/backend/logs",
    "services/backend/temp",
    "services/backend/data",
    "services/backend/ml/models",
    "services/backend/ml/data",
    "platform/packages/shared/logs",
    "platform/packages/shared/node_modules",
    "platform/packages/shared/vendor",
    "software/khyquant/frontend/node_modules",
    "software/khyquant/frontend/android",
    "software/khyquant/frontend/android-sdk",
    "software/khyquant/ml/models",
    "software/khyquant/ml/data",
    "software/khyquant/khy_quant/bundled",
    ".tmp",
    "dist",
    # ``prune dist`` above only matches the REPOSITORY-ROOT dist/. Nested frontend
    # build outputs are gitignored (apps/ai-frontend/.gitignore:11, .gitignore:9)
    # with zero git-tracked files, but MANIFEST.in walks the WORKING TREE, so
    # ``recursive-include apps/ai-frontend *`` drags a local ``npm run build``
    # result into the sdist. That leaked ~24 MB, including a THIRD byte-identical
    # copy of the muya bundle (dist/vendor/khyos-muya.{js,css}, 10.52 MB) on top
    # of the SSOT and the public/ mirror below. Both trees regenerate from source
    # via each frontend's build script, so they are pure derivatives.
    "apps/ai-frontend/dist",
    "software/khyquant/frontend/dist",
    # Build-time mirror of extensions/tools/khy-markdown/vendor/ produced by
    # apps/ai-frontend/scripts/sync-md-vendor.mjs (srcDir -> public/vendor).
    # Verified byte-identical to the SSOT, so shipping it doubles 10.52 MB for
    # nothing; the sync script recreates it during the frontend build.
    "apps/ai-frontend/public/vendor",
    # Local reference material: 23.77 MB across 40 files with ZERO runtime
    # consumers (only .gitignore:107, .dockerignore:48, two generated nav cards
    # in docs/index.html, and the generated docs/_assets/nav-data.js reference
    # it). Already gitignored, so it is never part of a clean checkout. Its mass
    # is a nested .git/objects/pack (11.82 MB / 25 files) plus a single 11.59 MB
    # 测试视频.mp4 — neither is reachable from any code path.
    "docs/_ref",
    # Test trees. Directory-level prunes cover fixtures, helpers and snapshots
    # that GLOBAL_EXCLUDES' *.test.* globs cannot match by basename. Tests are a
    # development artifact: the sdist exists to rebuild the wheel, and the wheel
    # is a single esbuild bundle that never reads them.
    "services/backend/tests",
    "services/backend/test",
    "scripts/tests",
    "services/ai-backend/test",
    "software/khyquant/tests",
    "platform/packages/shared/tests",
    "extensions/tools/khy-markdown/test",
    "apps/ai-frontend/test",
    "kernel/build",
    "kernel/iso/output",
    "platform/packages/moonbit-plugin-sdk/node_modules",
    "platform/packages/moonbit-plugin-sdk/target",
    "platform/packages/moonbit-plugin-sdk/_build",
    "services/backend/wasm-chain/_build",
    "services/backend/wasm-context/_build",
    "services/backend/wasm-indicators/_build",
    "kernel/moonbit/_build",
    "services/backend/bin/llama-cpp",
    "services/backend/bin/ollama-runner",
])

SDIST_EXCLUDES = _ordered_unique([
    "docs/INTERNAL_CREDENTIALS.md",
    # Defense-in-depth: exact ``.env`` paths pruned from the sdist even though
    # .gitignore already blocks them and GLOBAL_EXCLUDES ``.env.*`` covers suffixed
    # variants. Forest layout keeps real dev credentials under both the service root
    # (services/.env) and the backend (services/backend/.env); the legacy ``backend/.env``
    # stays listed so a pre-forest checkout can never regress. Users configure via real
    # env vars / docs, never a shipped file.
    "services/backend/.env",
    "services/.env",
    "backend/.env",
    ".env",
])

SDIST_RECURSIVE_EXCLUDES = [
    ("services/backend", ["*.db", "*.sqlite", "*.sqlite3", "*.joblib", "*.log", "*.pyc"]),
    ("kernel", ["*.o", "*.bin", "*.elf", "*.efi", "*.iso", "*.img"]),
    ("platform/packages/moonbit-plugin-sdk", ["*.wasm"]),
    # Drop pre-rendered doc-site OUTPUTS from the source distribution. Every
    # docs/**/*.html is a build_docs_site.js derivative of an adjacent .md, and
    # the three docs/**/*.pdf are rendered exports of their OPS-MAN .md sources.
    # ~11.8 MB/version of pure derivatives with zero runtime consumers (docs.js
    # reads only .md / 维护映射表.json). The .md sources, the generator, and
    # docs/_assets/ (mermaid + css + js) all stay, so `khy docs:build` can
    # regenerate the offline site on demand. Scoped to docs/ so runtime HTML
    # shipped elsewhere (apps/ai-frontend dist, muya editor) is untouched.
    ("docs", ["*.html", "*.pdf"]),
]

GLOBAL_EXCLUDES = _ordered_unique([
    "*.iso",
    "*.img",
    "*.gguf",
    "*.safetensors",
    "*.so",
    "*.so.*",
    "*.dylib",
    "*.bin",
    "*.onnx",
    "*.pt",
    "*.pth",
    "*.h5",
    "*.pkl",
    "*.pyc",
    # Test files scattered outside the pruned test trees (e.g. the nested
    # src/**/__tests__/ directories, which sit at arbitrary depth and therefore
    # cannot be reached by a path-specific ``prune``). Basename globs catch all
    # 2164 of them (12.90 MB) wherever they live. Same rationale as the test-tree
    # prunes: the wheel is a single esbuild bundle that never reads a test file.
    # *.spec.* matches nothing in-tree today and is defense-in-depth against a
    # future convention change.
    "*.test.js",
    "*.test.cjs",
    "*.test.mjs",
    "*.test.jsx",
    "*.spec.js",
    "*.spec.cjs",
    "*.spec.mjs",
    "*.spec.jsx",
    # Video assets: no rule covered these before, so a single 11.59 MB
    # 测试视频.mp4 under docs/_ref/ shipped in every sdist. The docs/_ref prune
    # removes that specific file; these globs keep any future stray recording out
    # regardless of where it lands. No runtime code path reads video.
    "*.mp4",
    "*.mov",
    "*.webm",
    # Security defense-in-depth for the sdist: never global-include private
    # keys / certs / stray rar archives. Zero such files exist in-tree today.
    "*.key",
    "*.pem",
    "*.rar",
    # Environment files must NEVER travel in the source distribution. Broad
    # recursive includes can pick them up at any depth, so exclude both the exact
    # basename and every suffixed variant globally.
    ".env",
    ".env.*",
])

# Wheel build copy/prune rules used by ``setup.py``.
BASE_COPY_PAYLOADS = [
    ("services/backend", "services/backend"),
    # ai-backend must sit beside services/backend in the bundle so the daemon's
    # ../../../ai-backend/src/... cross-requires resolve. Its bare npm deps +
    # @khy/shared are resolved at runtime via a NODE_PATH fallback to
    # bundled/services/backend/node_modules (see aiBackendModuleResolve.js);
    # COPY_EXCLUDE_PATTERNS ("node_modules") skips the dev symlink here.
    ("services/ai-backend", "services/ai-backend"),
    ("docs", "docs"),
    ("kernel/alpine", "alpine"),
    # Full root scripts/ tree (workshop completeness, consistent with kernel/
    # moonbit/khyquant source shipping). Ships guard cores (scripts/lib/*),
    # install/portable/khytogo/docs/ci helpers, and scripts/alpine (Docker ISO
    # build). scripts/lib/* is *runtime-referenced*: selfRepair/primitives.js
    # does require('../../../../../scripts/lib/leafContractGuard') which resolves
    # to bundled/scripts/lib in the installed layout — shipping it enables the
    # self-repair guard cores in a pip install instead of the null fail-soft.
    # __pycache__/*.pyc/node_modules are stripped by COPY_EXCLUDE_PATTERNS; the
    # tree carries no data/models/node_modules so no source is at risk.
    ("scripts", "scripts"),
    # Built-in extensions ([DESIGN-ARCH-069] 拓展契约). khy-markdown carries the
    # khyosMarkdown shell + bridge + OS registration; its vendor/ subtree is
    # excluded by SDIST_PRUNE_DIRS and provisioned from the immutable Release.
    # Shipping the whole tree (not just one extension) is what makes the repo
    # extension root <appRoot>/extensions/ exist in an installed layout at all.
    ("extensions", "extensions"),
]

ROOT_DOCS = ["README.md", "AGENTS.md"]
ROOT_LOCKFILES = [
    "package-lock.json",
]

PACKAGE_RESOURCE_INCLUDES = {
    "khy_platform": [
        "_resources/dev-constraints.txt",
        "_resources/tray-icon.png",
        "bundled/runtime/khy/bundle.mjs",
    ],
}

# Generic basename ignores for ``shutil.ignore_patterns``. Keep this list free
# of broad names like ``data`` / ``models`` / ``ml`` that would match required
# source directories at any depth.
COPY_EXCLUDE_PATTERNS = _ordered_unique([
    "node_modules",
    "__pycache__",
    "_build",
    "target",
    ".env",
    ".env.local",
    ".env.*",
    "logs",
    "temp",
    ".DS_Store",
    "Thumbs.db",
    "*.pyc",
    "*.db",
    "*.sqlite",
    "*.sqlite3",
    "*.joblib",
    "*.log",
    "*.iso",
    "*.img",
    "*.gguf",
    "*.safetensors",
    "*.bin",
    "*.onnx",
    "*.pt",
    "*.pth",
    "*.h5",
    "*.pkl",
    "android",
    "android-sdk",
    "INTERNAL_CREDENTIALS*",
    "NUL",
    "*.so",
    "*.so.*",
    "*.dylib",
    # Security defense-in-depth: private keys / certs must never enter the
    # bundled runtime copy. .gitignore + the git-archive snapshot already drop
    # them; this covers the setup.py copytree path too. Zero legit *.key/*.pem
    # exist in the source tree, so nothing legitimate is lost.
    "*.key",
    "*.pem",
    # Runtime data + stray archives that are cruft, never source. *.zip is
    # intentionally NOT excluded — services/ai-backend ships a legit test
    # fixture (test/fixtures/coze/sample-linear.zip).
    "*.rar",
    ".khy",
    "khy-Trajectory",
    "sessions.db*",
    "*.db-shm",
    "*.db-wal",
])

POST_COPY_PRUNE_BASENAMES = _ordered_unique([
    "node_modules",
    "__pycache__",
    "_build",
    "target",
    "logs",
    "temp",
    ".git",
    "android",
    "android-sdk",
    ".tmp",
    ".pytest_cache",
    "llama-cpp",
    "ollama-runner",
    # Local runtime scratch that must never travel in the bundle.
    ".khy",
    "khy-Trajectory",
])

TOPLEVEL_DATA_PRUNE_TARGETS = ["data"]
TOPLEVEL_WEIGHT_PRUNE_TARGETS = ["models", "ml/models", "ml/data"]

# Pre-rendered doc-site OUTPUTS stripped from the wheel's bundled/docs/ copy.
# Mirrors the SDIST_RECURSIVE_EXCLUDES ("docs", ["*.html", "*.pdf"]) rule so both
# channels ship the .md sources + generator + _assets (regenerable) but not the
# ~11.8 MB/version of derived .html / .pdf. Scoped to the bundled docs subtree by
# the caller, never applied to runtime HTML elsewhere in the bundle.
DOCS_DERIVATIVE_SUFFIXES = _ordered_unique([
    ".html",
    ".pdf",
])

KERNEL_COPY_EXTRA_EXCLUDES = _ordered_unique([
    "build",
    "_build",
    "target",
    "*.o",
    "*.bin",
    "*.elf",
    "*.efi",
    "*.iso",
    "*.img",
    "*.lock",
])

MOONBIT_COPY_EXTRA_EXCLUDES = _ordered_unique([
    "target",
    "*.wasm",
])

# Release audit rules.
AUDIT_FORBIDDEN_DIRS = _ordered_unique([
    "node_modules",
    "bower_components",
    ".pnpm-store",
    "site-packages",
    ".venv",
    "venv",
    ".tox",
    "jspm_packages",
    "_build",
    "target",
])

AUDIT_FORBIDDEN_FILE_GLOBS = _ordered_unique([
    "*.o",
    "*.bin",
    "*.elf",
    "*.efi",
    "*.iso",
    "*.img",
    "*.so",
    "*.dylib",
    "*.gguf",
    "*.safetensors",
    # Stray archives and encrypted payloads must never land in install artifacts.
    # First-use payloads live on the immutable GitHub Release instead.
    # *.zip is intentionally NOT forbidden — services/ai-backend ships a legit
    # test fixture (test/fixtures/coze/sample-linear.zip).
    "*.rar",
    "*.tar.gz",
    "*.enc",
    # Environment files are secret carriers — the audit must FAIL the build if any
    # ``.env`` / ``.env.<suffix>`` lands in the shipped artifacts (this net once
    # missed a stray ``.env.broken-*`` backup with a real JWT_SECRET in the sdist).
    # ``.env.example`` templates are pruned upstream by GLOBAL_EXCLUDES, so a hit
    # here means a real environment file slipped through — always a hard stop.
    ".env",
    ".env.*",
])

# Directory-wide audit exemptions are intentionally empty. On-demand payloads
# live outside pip artifacts, so an encrypted/archive hit is always actionable.
AUDIT_FORBIDDEN_FILE_EXEMPT_DIRS = _ordered_unique([])

# Metadata cross-package contamination rules (root cause of the "1.8.0" version
# confusion): khy-os must never declare a runtime/extra dependency on the
# unrelated khy-quant package family, nor advertise itself as financial/quant
# software. These are matched (case-insensitively) against ``Requires-Dist`` and
# ``Classifier`` lines of the built METADATA / PKG-INFO. Any hit fails the audit
# so a contaminated build can never be published.
#
# HOW-TO-EXTEND: add a new forbidden dependency-name substring to
# ``AUDIT_FORBIDDEN_REQUIRES_SUBSTRINGS`` or a forbidden classifier substring to
# ``AUDIT_FORBIDDEN_CLASSIFIER_SUBSTRINGS``. Keep them specific — broad terms
# like "os" would false-positive on legitimate deps.
AUDIT_FORBIDDEN_REQUIRES_SUBSTRINGS = _ordered_unique([
    "khy-quant",
    "khy_quant",
])

AUDIT_FORBIDDEN_CLASSIFIER_SUBSTRINGS = _ordered_unique([
    "financial",
    "investment",
])

REQUIRED_SDIST_PATHS = _ordered_unique([
    "kernel/Makefile",
    "kernel/src",
    "kernel/boot",
    "kernel/iso/boot/grub/grub.cfg",
    "kernel/iso/boot/limine/limine.conf",
    "kernel/vendor/moonbit/moonbit_gen.c",
    "kernel/vendor/moonbit/runtime.c",
    "kernel/vendor/moonbit/include/moonbit.h",
    "platform/khy_platform/_resources/dev-constraints.txt",
    "platform/khy_platform/_resources/__init__.py",
    "scripts/release/pip_packaging_rules.py",
    "scripts/release/render_manifest.py",
    "scripts/lib/leafContractGuard.js",
    # Launch floor: the exact script the pip launcher execs (cli.py:2304 ->
    # <bundle>/services/backend/bin/khy.js; missing -> fatal exit at cli.py:2307).
    # npm has always pinned both; pip historically pinned models/auth/main but not
    # the entrypoint it launches itself. An sdist that drops either now fails the
    # release audit instead of installing dead on a fresh machine.
    "services/backend/bin/khy.js",
    # bin/khy.js:442 & server.js:54 require('./package.json') at top-level boot
    # (read version); dropping it crashes boot with Cannot find module. Pin it.
    "services/backend/package.json",
    "services/backend/server.js",
    "services/backend/src/models/index.js",
    # Drift guard for the exact file whose absence 500'd every proxy/user-gateway
    # route on bundled installs. If ai-backend ever drops out of packaging again,
    # the release audit fails here instead of shipping a broken wheel.
    "services/ai-backend/src/middleware/auth.js",
    "apps/ai-frontend/src/main.js",
    "software/khyquant/frontend/src/main.js",
    "platform/khy_platform/bundled/runtime/khy/bundle.mjs",
])

REQUIRED_WHEEL_PATHS = _ordered_unique([
    "khy_platform/__init__.py",
    "khy_platform/cli.py",
    "khy_platform/_resources/dev-constraints.txt",
    "khy_platform/_resources/tray-icon.png",
    "khy_platform/bundled/runtime/khy/bundle.mjs",
])


def render_manifest() -> str:
    """Render the canonical MANIFEST.in content from the shared rules."""
    lines = [
        "# AUTO-GENERATED by scripts/release/render_manifest.py",
        "# Do not edit manually. Update scripts/release/pip_packaging_rules.py instead.",
        "",
        "# Include full source trees needed to rebuild pip wheel from sdist.",
        "# Use broad include patterns here, then prune/exclude below.",
    ]

    for path in SDIST_RECURSIVE_INCLUDES:
        lines.append(f"recursive-include {path} *")

    lines.extend([
        "",
        "# Include standalone files required by build/runtime packaging.",
    ])
    for path in SDIST_FILE_INCLUDES:
        lines.append(f"include {path}")

    lines.extend([
        "",
        "# Exclude internal credentials docs and local env files.",
    ])
    for path in SDIST_EXCLUDES:
        lines.append(f"exclude {path}")

    lines.extend([
        "",
        "# Exclude heavy / generated / sensitive content.",
    ])
    for path in SDIST_PRUNE_DIRS:
        lines.append(f"prune {path}")

    lines.extend([
        "",
        "# Extension-specific recursive excludes.",
    ])
    for root, patterns in SDIST_RECURSIVE_EXCLUDES:
        lines.append(f"recursive-exclude {root} {' '.join(patterns)}")

    lines.extend([
        "",
        "# Never ship prebuilt binaries / model payloads in pip distributions.",
    ])
    for pattern in GLOBAL_EXCLUDES:
        lines.append(f"global-exclude {pattern}")

    lines.append("")
    return "\n".join(lines)
