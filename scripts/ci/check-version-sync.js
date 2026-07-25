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

  const unique = new Set(Object.values(versions));
  for (const [file, version] of Object.entries(versions)) {
    console.log(`${file}: ${version}`);
  }
  console.log(`${initFile}: <dynamic from pyproject.toml>`);

  if (unique.size !== 1) {
    throw new Error('Version mismatch detected across required files');
  }

  const [version] = [...unique];
  console.log(`Version sync check passed: ${version}`);
}

try {
  main();
} catch (error) {
  console.error(`[version-sync] ${error.message || error}`);
  process.exit(1);
}
