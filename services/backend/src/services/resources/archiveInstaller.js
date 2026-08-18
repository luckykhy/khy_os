'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const EXTRACT_TIMEOUT_MS = 5 * 60 * 1000;

function quotePowerShell(value) {
  return String(value).replace(/'/g, "''");
}

function extractArchive(archivePath, destDir, format, options = {}) {
  fs.mkdirSync(destDir, { recursive: true });
  if (format === 'file') {
    fs.copyFileSync(archivePath, path.join(destDir, options.filename || 'payload'));
    return;
  }
  const searchExecutable = options.searchExecutable || require('../../tools/platformUtils').searchExecutable;
  let command;
  let args;
  if (format === 'tar.gz' || format === 'tgz') {
    command = searchExecutable('tar'); args = ['-xzf', archivePath, '-C', destDir];
  } else if (format === 'tar') {
    command = searchExecutable('tar'); args = ['-xf', archivePath, '-C', destDir];
  } else if (format === 'zip' && process.platform === 'win32') {
    command = searchExecutable('powershell') || searchExecutable('pwsh') || 'powershell';
    args = ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${quotePowerShell(archivePath)}' -DestinationPath '${quotePowerShell(destDir)}' -Force`];
  } else if (format === 'zip') {
    command = searchExecutable('unzip');
    if (command) args = ['-q', '-o', archivePath, '-d', destDir];
    else {
      command = searchExecutable('7z') || searchExecutable('7za');
      args = command ? ['x', `-o${destDir}`, '-y', archivePath] : null;
    }
  } else throw new Error(`unsupported archive format: ${format}`);
  if (!command || !args) throw new Error(`extractor not found for ${format}`);
  const result = spawnSync(command, args, { timeout: options.timeoutMs || EXTRACT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' });
  if (result.error) throw new Error(`extraction failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`extraction failed (exit ${result.status}): ${(result.stderr || '').slice(0, 400)}`);
}

function locatePayloadRoot(stagingDir, sentinel, hint = '.') {
  const direct = hint && hint !== '.' ? [path.join(stagingDir, hint), stagingDir] : [stagingDir];
  for (const dir of direct) if (fs.existsSync(path.join(dir, sentinel))) return dir;
  const queue = [{ dir: stagingDir, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    if (fs.existsSync(path.join(current.dir, sentinel))) return current.dir;
    if (current.depth >= 5) continue;
    let entries = [];
    try { entries = fs.readdirSync(current.dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
  }
  return null;
}

function assertContainedPath(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`payload path escapes staging root: ${candidate}`);
  }
}

function assertNoSymlinkEscape(root, current = root) {
  assertContainedPath(root, current);
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const candidate = path.join(current, entry.name);
    assertContainedPath(root, candidate);
    if (entry.isSymbolicLink()) throw new Error(`symlink payload entry is not allowed: ${path.relative(root, candidate)}`);
    if (entry.isDirectory()) assertNoSymlinkEscape(root, candidate);
  }
}

function copyPayload(payloadRoot, targetDir) {
  assertNoSymlinkEscape(payloadRoot);
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(payloadRoot)) {
    const source = path.join(payloadRoot, entry);
    const target = path.join(targetDir, entry);
    assertContainedPath(targetDir, target);
    fs.cpSync(source, target, { recursive: true, verbatimSymlinks: true, errorOnExist: true, dereference: false });
  }
}

function applyChmod(targetDir, entries) {
  if (process.platform === 'win32') return;
  for (const rel of entries || []) {
    const target = path.join(targetDir, rel);
    if (fs.existsSync(target)) fs.chmodSync(target, 0o755);
  }
}

module.exports = { extractArchive, locatePayloadRoot, copyPayload, applyChmod };
