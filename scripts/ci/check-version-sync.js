#!/usr/bin/env node
/**
 * @pattern Template Method, Visitor
 *
 * Version-sync gate. Three version tracks must stay in group-integrity; this
 * enforces it OUTSIDE of publish (pre-commit / CI / bootstrap).
 *
 * Pure-function design (KHY_VERSION_SYNC_ROOT): the whole check resolves files
 * against a configurable repo root so a caller (or a test fixture) can point
 * it at a synthetic tree without touching process.cwd(). This mirrors the
 * `opa test` fixture-root convention and `KHY_GOV_RULES_ROOT` already used by
 * check-gov-rules.js.
 *
 * Semver validity (P0, borrowed from semantic-release / Lerna): each parsed
 * version string is validated against strict semver before the group-equality
 * check runs. Nine sources agreeing on "abc" or "1.0.." is still a silent
 * drift until it explodes downstream at publish; rejecting malformed values
 * here closes that gap.
 */

const fs = require('fs');
const path = require('path');

/**
 * Version-declaration specs. These are the real single sources of truth; every
 * other version string in the repo derives from them. publish-dual.sh syncs
 * all three tracks from one --version input at release time; this gate
 * enforces the same invariant OUTSIDE of publish so a manual edit, partial
 * bump, or merge conflict cannot let one channel's manifest drift silently.
 *
 * NOTE: this array plus {@link VERSION_GROUPS} are exported so the aggregate
 * governance-status view (check-gov-status.js) can render its per-source table
 * from the same list instead of maintaining a hand-copied second one — a copy
 * that silently drifts the moment a fourth track is added here.
 *
 * @type {Array<{file: string, regex: RegExp}>}
 */
const VERSION_SPECS = [
  // ── Main khy-os package (pip + npm + modules) ───────────────────────────
  {
    file: 'pyproject.toml',
    regex: /^version\s*=\s*"([^"]+)"/m,
  },
  {
    file: 'packaging/npm/package.json',
    regex: /"version"\s*:\s*"([^"]+)"/m,
  },
  {
    file: 'services/backend/package.json',
    regex: /"version"\s*:\s*"([^"]+)"/m,
  },
  {
    file: 'packaging/modules/modules.json',
    regex: /"version"\s*:\s*"([^"]+)"/m,
  },
  // ── ai-backend ecosystem (independent version track) ────────────────────
  {
    file: 'services/ai-backend/package.json',
    regex: /"version"\s*:\s*"([^"]+)"/m,
  },
  {
    file: 'platform/packages/shared/package.json',
    regex: /"version"\s*:\s*"([^"]+)"/m,
  },
  {
    file: 'platform/packages/plugin-sdk/package.json',
    regex: /"version"\s*:\s*"([^"]+)"/m,
  },
  // ── Browser UI shared package (independent version track) ───────────────
  {
    file: 'platform/packages/ui-shared/package.json',
    regex: /"version"\s*:\s*"([^"]+)"/m,
  },
  {
    file: 'apps/ai-frontend/package.json',
    regex: /"@khy\/ui-shared"\s*:\s*"([^"]+)"/m,
  },
  {
    file: 'software/khyquant/frontend/package.json',
    regex: /"@khy\/ui-shared"\s*:\s*"([^"]+)"/m,
  },
];

/**
 * The three independent version tracks, as ordered groups over
 * {@link VERSION_SPECS}. Group members must be byte-identical; groups are
 * deliberately allowed to differ from each other.
 *
 * @type {Array<{id: string, label: string, files: string[]}>}
 */
const VERSION_GROUPS = [
  {
    id: 'main-khy-os',
    label: 'Main package version',
    files: [
      'pyproject.toml',
      'packaging/npm/package.json',
      'services/backend/package.json',
      'packaging/modules/modules.json',
    ],
  },
  {
    id: 'ai-backend',
    label: 'AI-backend ecosystem version',
    files: [
      'services/ai-backend/package.json',
      'platform/packages/shared/package.json',
      'platform/packages/plugin-sdk/package.json',
    ],
  },
  {
    id: 'browser-ui',
    label: 'Browser UI shared package version',
    files: [
      'platform/packages/ui-shared/package.json',
      'apps/ai-frontend/package.json',
      'software/khyquant/frontend/package.json',
    ],
  },
];

/** The runtime-resolved Python version source (carries no comparable literal). */
const INIT_FILE = 'platform/khy_platform/__init__.py';

/**
 * Strict semver validator (no leading "v", no pre-release/build metadata —
 * the khy-os version tracks use plain X.Y[.Z] numeric cores). Kept local so
 * the gate has zero runtime dependencies.
 * @param {string} v
 * @returns {boolean}
 */
function isSemver(v) {
  return /^\d+\.\d+(?:\.\d+)?$/.test(String(v).trim());
}

/**
 * Resolve a version source's file against the repo root.
 * @param {string} repoRoot
 * @param {object} [opts]
 * @param {boolean} [opts.quiet] - suppress per-group success lines (used by
 *   the aggregate status view, which renders its own table).
 */
function makeReaders(repoRoot, opts = {}) {
  const quiet = opts.quiet === true;
  return {
    readText(filePath) {
      const absPath = path.resolve(repoRoot, filePath);
      if (!fs.existsSync(absPath)) {
        throw new Error(`File not found: ${filePath} (root: ${repoRoot})`);
      }
      return fs.readFileSync(absPath, 'utf8');
    },
    readVersion(filePath, regex) {
      const text = this.readText(filePath);
      const match = text.match(regex);
      if (!match || !match[1]) {
        throw new Error(`Failed to parse version from ${filePath}`);
      }
      return match[1];
    },
    log(line) {
      if (!quiet) console.log(line);
    },
    error(line) {
      console.error(line);
    },
  };
}

function runMain(repoRoot, opts = {}) {
  const readers = makeReaders(repoRoot, opts);
  const specs = VERSION_SPECS;

  const versions = {};
  for (const spec of specs) {
    versions[spec.file] = readers.readVersion(spec.file, spec.regex);
  }

  // ── P0: semver validity across ALL sources ───────────────────────────────
  // A malformed value ("abc", "v1.0", "1.0..") is a silent drift even when
  // every source agrees on it. Fail fast, naming each offending file.
  const malformed = specs
    .filter((spec) => !isSemver(versions[spec.file]))
    .map((spec) => `${spec.file}: "${versions[spec.file]}"`);
  if (malformed.length) {
    readers.error('Non-semver version values detected (must be X.Y[.Z]):');
    for (const line of malformed) readers.error(`  ${line}`);
    throw new Error(`${malformed.length} version source(s) carry non-semver values`);
  }

  // platform/khy_platform/__init__.py intentionally resolves __version__ at
  // runtime from pyproject.toml / installed metadata (single source of truth),
  // so it carries no literal to compare. Guard against a regression that
  // re-hardcodes a literal here and silently reintroduces version drift.
  const initFile = INIT_FILE;
  const hardcoded = readers.readText(initFile).match(/^__version__\s*=\s*["']([^"']+)["']/m);
  if (hardcoded) {
    throw new Error(
      `${initFile} hard-codes __version__ = "${hardcoded[1]}"; it must resolve ` +
      'dynamically from pyproject.toml to stay drift-free',
    );
  }

  // ── Group integrity: one pass per declared track ──────────────────────────
  // Failure wording stays per-track so the operator sees WHICH track drifted;
  // the group table above is the only place tracks are declared.
  const mismatchMessage = {
    'main-khy-os': 'Version mismatch detected in main khy-os package group',
    'ai-backend': 'Version mismatch detected in ai-backend ecosystem group',
    'browser-ui': 'Version mismatch detected in browser UI shared package group',
  };
  for (const group of VERSION_GROUPS) {
    const groupVersions = new Set(group.files.map((f) => versions[f]));
    if (groupVersions.size !== 1) {
      for (const f of group.files) readers.error(`${f}: ${versions[f]}`);
      throw new Error(mismatchMessage[group.id] || `Version mismatch detected in ${group.id} group`);
    }
    readers.log(`${group.label}: ${[...groupVersions][0]}`);
  }

  readers.log(`\n${initFile}: <dynamic from pyproject.toml>`);
  readers.log('All version sync checks passed.');
}

// ── Entry point ──────────────────────────────────────────────────────────────
// KHY_VERSION_SYNC_ROOT lets a test fixture or a monorepo sub-checkout point the
// gate at a different tree without mutating process.cwd(). Defaults to the
// process working directory (the conventional invocation: `npm run
// check:version-sync` from the repo root).
if (require.main === module) {
  const repoRoot = process.env.KHY_VERSION_SYNC_ROOT
    ? path.resolve(process.env.KHY_VERSION_SYNC_ROOT)
    : process.cwd();
  try {
    runMain(repoRoot);
  } catch (error) {
    console.error(`[version-sync] ${error.message || error}`);
    process.exit(1);
  }
}

module.exports = {
  runMain,
  isSemver,
  makeReaders,
  VERSION_SPECS,
  VERSION_GROUPS,
  INIT_FILE,
};
