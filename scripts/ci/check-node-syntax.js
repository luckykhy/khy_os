#!/usr/bin/env node
/**
 * @pattern Template Method, Visitor
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const root = process.cwd();
const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['services/backend', 'services/ai-backend', 'platform/packages', 'apps/ai-frontend', 'scripts'];

const validExts = new Set(['.js', '.cjs', '.mjs']);
const ignoreDirs = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.cache',
  '.tmp',
  'coverage',
  'android',
  'android-sdk',
  'khy_os.egg-info',
  '__pycache__',
]);

function shouldIgnore(relPath) {
  const parts = relPath.split(path.sep);
  return parts.some((part) => ignoreDirs.has(part));
}

function collectFiles(relPath, out) {
  const normalized = path.normalize(relPath);
  // Prune ignored directories (node_modules, build, …) BEFORE descending so we
  // never walk into them. This also stops the walker from following workspace
  // self-symlinks like platform/packages/shared/node_modules/@khy/shared →
  // itself, which previously recursed until fs.statSync threw ELOOP.
  if (shouldIgnore(normalized)) return;

  const absPath = path.resolve(root, relPath);
  // lstatSync (not statSync) so symlinks are inspected, not followed. We skip
  // symlinks entirely: real source files are never symlinks, and following them
  // risks cyclic links / broken targets crashing the syntax sweep.
  let stats;
  try {
    stats = fs.lstatSync(absPath);
  } catch {
    return; // missing or unreadable entry — nothing to syntax-check
  }
  if (stats.isSymbolicLink()) return;

  if (stats.isDirectory()) {
    for (const entry of fs.readdirSync(absPath)) {
      collectFiles(path.join(relPath, entry), out);
    }
    return;
  }

  if (!stats.isFile()) return;
  if (!validExts.has(path.extname(normalized))) return;

  out.push(normalized);
}

function main() {
  const files = [];
  for (const target of targets) {
    collectFiles(target, files);
  }

  const deduped = [...new Set(files)].sort();
  if (deduped.length === 0) {
    console.log('No JavaScript files found for syntax check.');
    return;
  }

  let failed = 0;
  for (const relFile of deduped) {
    const absFile = path.resolve(root, relFile);
    const result = cp.spawnSync(process.execPath, ['--check', absFile], {
      encoding: 'utf8',
    });

    if (result.status !== 0) {
      failed += 1;
      console.error(`\n[syntax-error] ${relFile}`);
      if (result.stderr) {
        console.error(result.stderr.trim());
      } else if (result.stdout) {
        console.error(result.stdout.trim());
      }
    }
  }

  console.log(`Checked ${deduped.length} JavaScript files.`);
  if (failed > 0) {
    console.error(`Node syntax check failed: ${failed} file(s) contain syntax errors.`);
    process.exit(1);
  }

  console.log('Node syntax check passed.');
}

main();
