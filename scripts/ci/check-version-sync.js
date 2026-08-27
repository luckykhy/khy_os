#!/usr/bin/env node
/**
 * @pattern Template Method, Visitor
 */

const fs = require('fs');
const path = require('path');

function readText(filePath) {
  const absPath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  return fs.readFileSync(absPath, 'utf8');
}

function readVersion(filePath, regex) {
  const text = readText(filePath);
  const match = text.match(regex);
  if (!match || !match[1]) {
    throw new Error(`Failed to parse version from ${filePath}`);
  }
  return match[1];
}

function main() {
  // Independent version declarations that must agree. These are the real single
  // sources of truth; every other version string in the repo derives from them.
  // publish-dual.sh syncs all three from one --version input at release time;
  // this gate enforces the same invariant OUTSIDE of publish (pre-commit / CI /
  // bootstrap) so a manual edit, partial bump, or merge conflict cannot let one
  // channel's manifest drift silently.
  const specs = [
    // ── Main khy-os package (pip + npm + modules) ─────────────────────────────
    {
      file: 'pyproject.toml',
      regex: /^version\s*=\s*"([^"]+)"/m,
    },
    {
      // npm channel manifest (@khy-os/khy-os) — what `npm install` publishes. Its own
      // "version" is the first "version": key in the file (deps use "^x.y.z",
      // not a "version": key), so the first-match regex targets the package version.
      file: 'packaging/npm/package.json',
      regex: /"version"\s*:\s*"([^"]+)"/m,
    },
    {
      file: 'services/backend/package.json',
      regex: /"version"\s*:\s*"([^"]+)"/m,
    },
    {
      // Modular packaging manifest — each module inherits this version at build
      // time; must stay aligned with the rest of the monorepo version sources.
      file: 'packaging/modules/modules.json',
      regex: /"version"\s*:\s*"([^"]+)"/m,
    },
    // ── ai-backend ecosystem (independent version track) ──────────────────────
    // ai-backend and @khy/shared share a version because they ship as a bundled
    // unit inside the pip wheel and are developed together. They intentionally
    // differ from the main khy-os version (1.1.x vs 1.6.x), so they are checked
    // as a SEPARATE group here.
    {
      file: 'services/ai-backend/package.json',
      regex: /"version"\s*:\s*"([^"]+)"/m,
    },
    {
      file: 'platform/packages/shared/package.json',
      regex: /"version"\s*:\s*"([^"]+)"/m,
    },
    // ── Browser UI shared package (independent version track) ───────────────────
    // The two frontend applications retain their own release versions. Their
    // dependency declarations must point at the exact @khy/ui-shared version.
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

  const versions = {};
  for (const spec of specs) {
    versions[spec.file] = readVersion(spec.file, spec.regex);
  }

  // platform/khy_platform/__init__.py intentionally resolves __version__ at
  // runtime from pyproject.toml / installed metadata (single source of truth),
  // so it carries no literal to compare. Guard against a regression that
  // re-hardcodes a literal here and silently reintroduces version drift.
  const initFile = 'platform/khy_platform/__init__.py';
  const hardcoded = readText(initFile).match(/^__version__\s*=\s*["']([^"']+)["']/m);
  if (hardcoded) {
    throw new Error(
      `${initFile} hard-codes __version__ = "${hardcoded[1]}"; it must resolve ` +
      'dynamically from pyproject.toml to stay drift-free',
    );
  }

  // ── Group 1: main khy-os package ────────────────────────────────────────────
  const mainGroup = [
    'pyproject.toml',
    'packaging/npm/package.json',
    'services/backend/package.json',
    'packaging/modules/modules.json',
  ];
  const mainVersions = new Set(mainGroup.map(f => versions[f]));
  if (mainVersions.size !== 1) {
    for (const f of mainGroup) {
      console.log(`${f}: ${versions[f]}`);
    }
    throw new Error('Version mismatch detected in main khy-os package group');
  }
  console.log(`Main package version: ${[...mainVersions][0]}`);

  // ── Group 2: ai-backend ecosystem ──────────────────────────────────────────
  const aiGroup = [
    'services/ai-backend/package.json',
    'platform/packages/shared/package.json',
  ];
  const aiVersions = new Set(aiGroup.map(f => versions[f]));
  if (aiVersions.size !== 1) {
    for (const f of aiGroup) {
      console.log(`${f}: ${versions[f]}`);
    }
    throw new Error('Version mismatch detected in ai-backend ecosystem group');
  }
  console.log(`AI-backend ecosystem version: ${[...aiVersions][0]}`);

  // ── Group 3: browser UI shared package ───────────────────────────────────────
  const uiGroup = [
    'platform/packages/ui-shared/package.json',
    'apps/ai-frontend/package.json',
    'software/khyquant/frontend/package.json',
  ];
  const uiVersions = new Set(uiGroup.map(f => versions[f]));
  if (uiVersions.size !== 1) {
    for (const f of uiGroup) {
      console.log(`${f}: ${versions[f]}`);
    }
    throw new Error('Version mismatch detected in browser UI shared package group');
  }
  console.log(`Browser UI shared package version: ${[...uiVersions][0]}`);

  console.log(`\n${initFile}: <dynamic from pyproject.toml>`);
  console.log('All version sync checks passed.');
}

try {
  main();
} catch (error) {
  console.error(`[version-sync] ${error.message || error}`);
  process.exit(1);
}
