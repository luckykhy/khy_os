#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const MANAGED_MARKER = 'KHY_MANAGED_HOOK';
const args = process.argv.slice(2);
const removeMode = args.includes('--remove');
const dryRun = args.includes('--dry-run');
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const hooksSourceDir = path.join(repoRoot, '.githooks');

function run(cmd) {
  return cp.execSync(cmd, {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  }).trim();
}

function getGitHooksDir() {
  let gitDir;
  try {
    gitDir = run('git rev-parse --git-dir');
  } catch {
    throw new Error('Not a git repository. Run "git init" first or use --dry-run to preview.');
  }
  if (!gitDir) {
    throw new Error('Not a git repository. Run "git init" first or use --dry-run to preview.');
  }
  return path.resolve(repoRoot, gitDir, 'hooks');
}

function readTextSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function isManagedHook(content) {
  return String(content || '').includes(MANAGED_MARKER);
}

function listHookNames() {
  try {
    return fs.readdirSync(hooksSourceDir, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function installHook(sourcePath, targetPath) {
  const sourceContent = fs.readFileSync(sourcePath, 'utf8');
  const targetContent = readTextSafe(targetPath);

  if (targetContent && !isManagedHook(targetContent)) {
    throw new Error(`Refusing to overwrite existing unmanaged hook: ${path.basename(targetPath)}`);
  }

  if (dryRun) {
    console.log(`[dry-run] install ${path.basename(targetPath)} -> ${targetPath}`);
    return;
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, sourceContent, 'utf8');
  fs.chmodSync(targetPath, 0o755);
  console.log(`installed ${path.basename(targetPath)} -> ${targetPath}`);
}

function removeHook(targetPath) {
  const targetContent = readTextSafe(targetPath);
  if (!targetContent) {
    console.log(`skip missing ${path.basename(targetPath)}`);
    return;
  }
  if (!isManagedHook(targetContent)) {
    throw new Error(`Refusing to remove unmanaged hook: ${path.basename(targetPath)}`);
  }

  if (dryRun) {
    console.log(`[dry-run] remove ${path.basename(targetPath)} -> ${targetPath}`);
    return;
  }

  fs.unlinkSync(targetPath);
  console.log(`removed ${path.basename(targetPath)} -> ${targetPath}`);
}

function main() {
  const hooksDir = getGitHooksDir();
  const hookNames = listHookNames();

  if (hookNames.length === 0) {
    console.log('No managed hooks found in .githooks/.');
    return;
  }

  for (const hookName of hookNames) {
    const sourcePath = path.join(hooksSourceDir, hookName);
    const targetPath = path.join(hooksDir, hookName);
    if (removeMode) removeHook(targetPath);
    else installHook(sourcePath, targetPath);
  }
}

try {
  main();
} catch (error) {
  console.error(`install-git-hooks: ${error.message}`);
  process.exit(1);
}
