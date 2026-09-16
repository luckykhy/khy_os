'use strict';

const fs = require('fs');
const path = require('path');

/**
 * wiring.js — answer "is this checker actually attached to a gate?".
 *
 * A checker is wired when some gate surface references it. Gate surfaces:
 *   S1  package.json scripts          (root + workspace package.json files)
 *   S2  .github/workflows/*.yml
 *   S3  .githooks/*
 *   S4  stage tables                 (quality-gate / release-gate stage libs)
 *   S5  ruleguard manifest itself    (the derived binding layer)
 *
 * S1 references are expanded recursively: `check:changed` chains `npm run
 * check:agent-rules`, so a checker reachable only through such a chain counts
 * as wired. Cycle-safe fixed-point expansion.
 */

const CHECKER_SUFFIXES = ['.js', '.mjs', '.cjs', '.py'];
const STAGE_TABLE_FILES = [
  'scripts/quality-gate/lib/qualityGateStages.js',
  'scripts/release/lib/releaseGateStages.js',
  'scripts/quality-gate/index.js',
  'scripts/release/release-gate.js',
];

function readText(repoRoot, rel) {
  const abs = path.join(repoRoot, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
}

function walk(dir, out, isDir, statSync) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    return;
  }
  for (const name of entries) {
    const abs = path.join(dir, name);
    let stat;
    try {
      stat = statSync(abs);
    } catch (error) {
      continue;
    }
    if (isDir(stat)) walk(abs, out, isDir, statSync);
    else if (/\.(js|mjs|cjs)$/.test(name)) out.push(abs);
  }
}

/** Collect package.json paths: root plus workspace packages (depth-limited). */
function packageJsonFiles(repoRoot) {
  const out = [];
  const seen = new Set();

  const visit = (abs, depth) => {
    if (depth > 4 || seen.has(abs)) return;
    const manifest = path.join(abs, 'package.json');
    if (fs.existsSync(manifest)) {
      seen.add(manifest);
      out.push(path.relative(repoRoot, manifest).replace(/\\/g, '/'));
    }
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (error) {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      visit(path.join(abs, entry.name), depth + 1);
    }
  };

  visit(repoRoot, 0);
  return out;
}

/** Expand npm script references to a fixpoint, following `npm run <name>`. */
function expandScriptRefs(scripts) {
  const referenced = new Set();
  const queue = Object.keys(scripts);

  while (queue.length) {
    const name = queue.pop();
    if (referenced.has(name)) continue;
    referenced.add(name);
    const value = scripts[name];
    if (typeof value !== 'string') continue;
    for (const match of value.matchAll(/(?:npm(?:\.cmd)?\s+run|pnpm\s+run|yarn\s+run)\s+([a-zA-Z0-9:_-]+)/g)) {
      const target = match[1];
      if (scripts[target] !== undefined && !referenced.has(target)) queue.push(target);
    }
  }
  return referenced;
}

/** Every gate-surface text, keyed by a stable surface id. */
function surfaceTexts(repoRoot) {
  const surfaces = {};

  // S1 — package.json scripts, all manifests
  for (const rel of packageJsonFiles(repoRoot)) {
    const text = readText(repoRoot, rel);
    if (!text) continue;
    try {
      surfaces[rel] = Object.values(JSON.parse(text).scripts || {})
        .filter((value) => typeof value === 'string')
        .join('\n');
    } catch (error) {
      // malformed manifest: leave the surface empty rather than crashing
    }
  }

  // S2 — workflows
  const workflowDir = path.join(repoRoot, '.github', 'workflows');
  if (fs.existsSync(workflowDir)) {
    for (const name of fs.readdirSync(workflowDir)) {
      if (!/\.(ya?ml)$/.test(name)) continue;
      const rel = path.join('.github', 'workflows', name).replace(/\\/g, '/');
      const text = readText(repoRoot, rel);
      if (text) surfaces[rel] = text;
    }
  }

  // S3 — git hooks
  const hookDir = path.join(repoRoot, '.githooks');
  if (fs.existsSync(hookDir)) {
    for (const name of fs.readdirSync(hookDir)) {
      const rel = path.join('.githooks', name).replace(/\\/g, '/');
      const text = readText(repoRoot, rel);
      if (text) surfaces[rel] = text;
    }
  }

  // S4 — stage tables
  for (const rel of STAGE_TABLE_FILES) {
    const text = readText(repoRoot, rel);
    if (text) surfaces[rel] = text;
  }

  return surfaces;
}

/** Enumerate checker files under scripts/ci/. */
function checkerFiles(repoRoot) {
  const dir = path.join(repoRoot, 'scripts', 'ci');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => CHECKER_SUFFIXES.some((ext) => name.endsWith(ext)))
    .sort();
}

/**
 * Build the wiring map: checker basename -> referencing surfaces.
 *
 * `extraCheckers` is a list of repo-relative checker paths that live outside
 * scripts/ci (e.g. services/backend/scripts/archDebtScan.js, which owns
 * LAYOUT-002) or have no scripts/ci home yet. They get tracking entries so
 * their wiring status is judged the same way as the rest of the fleet.
 */
function analyzeWiring(repoRoot, options = {}) {
  const root = path.resolve(repoRoot);
  const surfaces = { ...surfaceTexts(root), ...(options.surfaces || {}) };

  const files = [...checkerFiles(root)];
  for (const rel of options.extraCheckers || []) {
    const name = String(rel).replace(/\\/g, '/').replace(/.*\//, '');
    if (!files.includes(name)) files.push(name);
  }

  // Recursive npm-script expansion so chained aliases count as wiring.
  const rootManifest = path.join(root, 'package.json');
  let scriptNames = new Set();
  if (fs.existsSync(rootManifest)) {
    try {
      scriptNames = expandScriptRefs(JSON.parse(fs.readFileSync(rootManifest, 'utf8')).scripts || {});
    } catch (error) {
      scriptNames = new Set();
    }
  }

  const refs = {};
  for (const file of files) refs[file] = [];

  for (const [surface, text] of Object.entries(surfaces)) {
    for (const file of Object.keys(refs)) {
      if (text.includes(file)) refs[file].push(surface);
    }
  }

  return {
    checkerFiles: Object.keys(refs),
    references: refs,
    surfaces: Object.keys(surfaces),
    scriptNames,
  };
}

/**
 * Whether a checker is reachable by any gate. `referenced` surfaces are
 * everything except the checker's own directory listing.
 */
function isWired(entry) {
  return Array.isArray(entry.references) && entry.references.length > 0;
}

module.exports = {
  analyzeWiring,
  checkerFiles,
  isWired,
  surfaceTexts,
  expandScriptRefs,
  packageJsonFiles,
  STAGE_TABLE_FILES,
};
