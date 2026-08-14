/**
 * Workspace Checkpoint Service — save, restore, diff, and manage snapshots.
 *
 * Aligned with ANOLISA ws-ckpt design:
 * - Git worktree-based snapshots (lightweight, space-efficient)
 * - Tar + gzip fallback for non-git directories
 * - Incremental save: only stores changed files since last checkpoint
 * - Cross-platform: works on Linux, macOS, Windows (via tar)
 *
 * Storage layout:
 *   ~/.khyquant/checkpoints/
 *     <project-hash>/
 *       manifest.json        — checkpoint metadata index
 *       <id>.tar.gz          — full snapshot (tar mode)
 *       <id>.patch           — git diff (git mode)
 *
 * Snapshot modes:
 * 1. git-diff:   Store uncommitted changes as a patch (fast, tiny)
 * 2. git-stash:  Use git stash under the hood (with message tagging)
 * 3. tar-full:   Tar + gzip the working directory (fallback, universal)
 * 4. tar-incr:   Tar only files modified since last checkpoint
 */
'use strict';

const { execSync, execFileSync, execFile, exec } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');

const _execFileAsync = promisify(execFile);
const _execAsync = promisify(exec);
// Git Bash 优先解析是 Windows 专属关切(Unix 无特殊路径的 Git Bash 概念)。
// 仅在 win32 调用检测器,其它平台保持 'git'(字节回退兼容,不引入探针噪声)。
const _ensureDir = require('../../utils/ensureDirSync');
const _formatBytesAtom = require('../../utils/formatBytes');
const gitDetector = require('../gitExecutableDetector');

/** 解析 git 二进制路径:win32 时检测命中显式路径 → 返回它;否则 'git'。绝不抛。 */
function _gitBin() {
  if (process.platform !== 'win32') {
    return 'git';
  }
  try {
    return gitDetector.detectGitExecutable() || 'git';
  } catch {
    return 'git';
  }
}

// Lazily resolve the checkpoint root (portable-aware); fallback to legacy.
function _checkpointRoot() {
  try {
    const { getAppDataDir } = require('../../utils/dataHome');
    return getAppDataDir('checkpoints');
  } catch {
    return path.join(os.homedir(), '.khyquant', 'checkpoints');
  }
}
const MAX_CHECKPOINTS = 10;
const MAX_TOTAL_DISK_MB = 500; // hard cap: 500 MB total checkpoint storage per project
const TAR_SKIP_THRESHOLD_MB = 200; // skip tar-full if working dir > 200 MB (estimated)

// ─── Helpers ───────────────────────────────────────────────────────────────

// 收敛到 utils/ensureDirSync 单一真源(逐字节委托,调用点不变)

function _projectHash(projectDir) {
  return crypto.createHash('sha256').update(projectDir).digest('hex').slice(0, 12);
}

function _projectCheckpointDir(projectDir) {
  const dir = path.join(_checkpointRoot(), _projectHash(projectDir));
  _ensureDir(dir);
  return dir;
}

function _loadManifest(ckptDir) {
  const manifestPath = path.join(ckptDir, 'manifest.json');
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    return { project: '', checkpoints: [] };
  }
}

function _saveManifest(ckptDir, manifest) {
  fs.writeFileSync(path.join(ckptDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
}

function _isGitRepo(dir) {
  try {
    execFileSync(_gitBin(), ['rev-parse', '--is-inside-work-tree'], {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

// Async twin of _isGitRepo (same git invocation, non-blocking).
async function _isGitRepoAsync(dir) {
  try {
    await _execFileAsync(_gitBin(), ['rev-parse', '--is-inside-work-tree'], {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

function _gitExec(args, cwd) {
  return execFileSync(_gitBin(), args, {
    cwd,
    encoding: 'utf-8',
    timeout: 30000,
    stdio: 'pipe',
    maxBuffer: 50 * 1024 * 1024, // 50 MB
  }).trim();
}

// Async twin of _gitExec (execFile instead of execFileSync; same bin, args,
// timeout and buffer limits) — used by the *Async save path only.
async function _gitExecAsync(args, cwd) {
  const { stdout } = await _execFileAsync(_gitBin(), args, {
    cwd,
    encoding: 'utf-8',
    timeout: 30000,
    maxBuffer: 50 * 1024 * 1024, // 50 MB
  });
  return String(stdout).trim();
}

function _generateId() {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const rand = crypto.randomBytes(3).toString('hex');
  return `ckpt-${ts}-${rand}`;
}

// ─── Save Checkpoint ───────────────────────────────────────────────────────

/**
 * Save a workspace checkpoint.
 * @param {string} projectDir - Project root directory
 * @param {object} [options]
 * @param {string} [options.message] - Checkpoint description
 * @param {string} [options.mode] - 'auto', 'git-diff', 'git-stash', 'tar-full'
 * @returns {{ id: string, mode: string, size: number, files: number, message: string }}
 */
function saveCheckpoint(projectDir, options = {}) {
  const resolvedDir = path.resolve(projectDir);
  if (!fs.existsSync(resolvedDir)) {
    throw new Error(`Directory not found: ${resolvedDir}`);
  }

  const ckptDir = _projectCheckpointDir(resolvedDir);
  const manifest = _loadManifest(ckptDir);
  manifest.project = resolvedDir;

  const id = _generateId();
  const message = options.message || `Checkpoint at ${new Date().toISOString()}`;
  const isGit = _isGitRepo(resolvedDir);
  const mode =
    options.mode === 'auto' || !options.mode ? (isGit ? 'git-diff' : 'tar-full') : options.mode;

  let result;

  switch (mode) {
    case 'git-diff':
      result = _saveGitDiff(resolvedDir, ckptDir, id);
      break;
    case 'git-stash':
      result = _saveGitStash(resolvedDir, ckptDir, id, message);
      break;
    case 'tar-full':
      result = _saveTarFull(resolvedDir, ckptDir, id);
      break;
    default:
      throw new Error(`Unknown checkpoint mode: ${mode}`);
  }

  const entry = {
    id,
    mode,
    message,
    timestamp: new Date().toISOString(),
    branch: isGit ? _safeGitBranch(resolvedDir) : null,
    commitHash: isGit ? _safeGitHead(resolvedDir) : null,
    files: result.files,
    size: result.size,
  };

  manifest.checkpoints.push(entry);

  // Enforce max checkpoints — remove oldest if over limit
  while (manifest.checkpoints.length > MAX_CHECKPOINTS) {
    const old = manifest.checkpoints.shift();
    _removeCheckpointFiles(ckptDir, old);
  }

  _saveManifest(ckptDir, manifest);
  return entry;
}

function _safeGitBranch(dir) {
  try {
    return _gitExec(['branch', '--show-current'], dir) || 'HEAD';
  } catch {
    return 'unknown';
  }
}

function _safeGitHead(dir) {
  try {
    return _gitExec(['rev-parse', '--short', 'HEAD'], dir);
  } catch {
    return null;
  }
}

// ─── Async save path ───────────────────────────────────────────────────────────
// saveCheckpointAsync mirrors saveCheckpoint LOGIC exactly but routes every
// child-process call through execFile/exec (promisified) so the event loop is
// never frozen by git/tar (the sync version's execFileSync blocks for hundreds
// of ms on big repos — felt as TUI input stalls). The sync saveCheckpoint API
// above is intentionally untouched (other call sites keep their semantics).
// Small manifest/patch fs reads/writes stay synchronous — they are local tiny
// files and not the blocking culprit.

async function _safeGitBranchAsync(dir) {
  try {
    return (await _gitExecAsync(['branch', '--show-current'], dir)) || 'HEAD';
  } catch {
    return 'unknown';
  }
}

async function _safeGitHeadAsync(dir) {
  try {
    return await _gitExecAsync(['rev-parse', '--short', 'HEAD'], dir);
  } catch {
    return null;
  }
}

async function _saveGitDiffAsync(projectDir, ckptDir, id) {
  // Same capture as _saveGitDiff: staged + unstaged changes + untracked list.
  const diff = await _gitExecAsync(['diff', 'HEAD'], projectDir);
  const untrackedRaw = await _gitExecAsync(
    ['ls-files', '--others', '--exclude-standard'],
    projectDir
  );
  const untracked = untrackedRaw ? untrackedRaw.split('\n').filter(Boolean) : [];

  const patchPath = path.join(ckptDir, `${id}.patch`);
  let patchContent = diff;

  if (untracked.length > 0) {
    patchContent += '\n# UNTRACKED FILES (must be manually restored):\n';
    for (const f of untracked) {
      patchContent += `# ${f}\n`;
    }
  }

  fs.writeFileSync(patchPath, patchContent, 'utf-8');

  const diffStat = await _gitExecAsync(['diff', '--stat', 'HEAD'], projectDir);
  const fileCount = (diffStat.match(/\d+ file/g) || []).length || untracked.length;

  return { files: fileCount + untracked.length, size: Buffer.byteLength(patchContent) };
}

async function _saveGitStashAsync(projectDir, ckptDir, id, message) {
  const stashMsg = `khy-ckpt:${id} ${message}`;
  await _gitExecAsync(['stash', 'push', '-m', stashMsg, '--include-untracked'], projectDir);

  const stashList = await _gitExecAsync(['stash', 'list', '--oneline'], projectDir);
  const stashLine = stashList.split('\n').find((l) => l.includes(id));
  const stashRef = stashLine ? stashLine.split(':')[0] : 'stash@{0}';

  // Re-apply the stash so working directory is unchanged
  try {
    await _gitExecAsync(['stash', 'pop'], projectDir);
  } catch {
    /* stash was empty */
  }

  const metaPath = path.join(ckptDir, `${id}.stash.json`);
  fs.writeFileSync(metaPath, JSON.stringify({ stashRef, message: stashMsg }), 'utf-8');

  return { files: 0, size: 0 };
}

async function _saveTarFullAsync(projectDir, ckptDir, id) {
  // Same home-dir safety guard as _saveTarFull.
  const home = os.homedir();
  if (projectDir === home || projectDir === home + '/') {
    return { files: 0, size: 0, skipped: true };
  }

  const tarPath = path.join(ckptDir, `${id}.tar.gz`);
  const excludes = [
    'node_modules',
    '.git',
    '__pycache__',
    '.venv',
    'venv',
    'env',
    'dist',
    'build',
    '.next',
    '.nuxt',
    '.cache',
    '.tox',
    'coverage',
    '.nyc_output',
    'bower_components',
    '.khyquant',
    '.claude',
    '.npm',
    '.cargo',
    '.rustup',
    '*.pyc',
    '.DS_Store',
    'Thumbs.db',
    '*.tar.gz',
    '*.zip',
    '*.iso',
  ]
    .map((e) => `--exclude=${e}`)
    .join(' ');

  const parentDir = path.dirname(projectDir);
  const baseName = path.basename(projectDir);

  try {
    await _execAsync(`tar czf "${tarPath}" ${excludes} -C "${parentDir}" "${baseName}"`, {
      timeout: 120000,
    });
  } catch (err) {
    try {
      if (fs.existsSync(tarPath)) {
        fs.unlinkSync(tarPath);
      }
    } catch {
      /* */
    }
    throw new Error(`Tar failed: ${err.message}`);
  }

  const stat = fs.statSync(tarPath);

  if (stat.size > TAR_SKIP_THRESHOLD_MB * 1024 * 1024) {
    try {
      fs.unlinkSync(tarPath);
    } catch {
      /* */
    }
    return { files: 0, size: 0, skipped: true };
  }

  return { files: -1, size: stat.size };
}

/**
 * Async equivalent of saveCheckpoint — identical semantics/result shape, but
 * every git/tar invocation is non-blocking (execFile/exec).
 * @param {string} projectDir - Project root directory
 * @param {object} [options] - same options as saveCheckpoint
 * @returns {Promise<{ id: string, mode: string, size: number, files: number, message: string }>}
 */
async function saveCheckpointAsync(projectDir, options = {}) {
  const resolvedDir = path.resolve(projectDir);
  if (!fs.existsSync(resolvedDir)) {
    throw new Error(`Directory not found: ${resolvedDir}`);
  }

  const ckptDir = _projectCheckpointDir(resolvedDir);
  const manifest = _loadManifest(ckptDir);
  manifest.project = resolvedDir;

  const id = _generateId();
  const message = options.message || `Checkpoint at ${new Date().toISOString()}`;
  const isGit = await _isGitRepoAsync(resolvedDir);
  const mode =
    options.mode === 'auto' || !options.mode ? (isGit ? 'git-diff' : 'tar-full') : options.mode;

  let result;

  switch (mode) {
    case 'git-diff':
      result = await _saveGitDiffAsync(resolvedDir, ckptDir, id);
      break;
    case 'git-stash':
      result = await _saveGitStashAsync(resolvedDir, ckptDir, id, message);
      break;
    case 'tar-full':
      result = await _saveTarFullAsync(resolvedDir, ckptDir, id);
      break;
    default:
      throw new Error(`Unknown checkpoint mode: ${mode}`);
  }

  const entry = {
    id,
    mode,
    message,
    timestamp: new Date().toISOString(),
    branch: isGit ? await _safeGitBranchAsync(resolvedDir) : null,
    commitHash: isGit ? await _safeGitHeadAsync(resolvedDir) : null,
    files: result.files,
    size: result.size,
  };

  manifest.checkpoints.push(entry);

  // Enforce max checkpoints — remove oldest if over limit
  while (manifest.checkpoints.length > MAX_CHECKPOINTS) {
    const old = manifest.checkpoints.shift();
    _removeCheckpointFiles(ckptDir, old);
  }

  _saveManifest(ckptDir, manifest);
  return entry;
}

function _saveGitDiff(projectDir, ckptDir, id) {
  // Capture both staged and unstaged changes + untracked file list
  const diff = _gitExec(['diff', 'HEAD'], projectDir);
  const untrackedRaw = _gitExec(['ls-files', '--others', '--exclude-standard'], projectDir);
  const untracked = untrackedRaw ? untrackedRaw.split('\n').filter(Boolean) : [];

  const patchPath = path.join(ckptDir, `${id}.patch`);
  let patchContent = diff;

  // Append untracked files as a comment block
  if (untracked.length > 0) {
    patchContent += '\n# UNTRACKED FILES (must be manually restored):\n';
    for (const f of untracked) {
      patchContent += `# ${f}\n`;
    }
  }

  fs.writeFileSync(patchPath, patchContent, 'utf-8');

  const diffStat = _gitExec(['diff', '--stat', 'HEAD'], projectDir);
  const fileCount = (diffStat.match(/\d+ file/g) || []).length || untracked.length;

  return { files: fileCount + untracked.length, size: Buffer.byteLength(patchContent) };
}

function _saveGitStash(projectDir, ckptDir, id, message) {
  const stashMsg = `khy-ckpt:${id} ${message}`;
  _gitExec(['stash', 'push', '-m', stashMsg, '--include-untracked'], projectDir);

  // Record stash reference
  const stashList = _gitExec(['stash', 'list', '--oneline'], projectDir);
  const stashLine = stashList.split('\n').find((l) => l.includes(id));
  const stashRef = stashLine ? stashLine.split(':')[0] : 'stash@{0}';

  // Re-apply the stash so working directory is unchanged
  try {
    _gitExec(['stash', 'pop'], projectDir);
  } catch {
    /* stash was empty */
  }

  const metaPath = path.join(ckptDir, `${id}.stash.json`);
  fs.writeFileSync(metaPath, JSON.stringify({ stashRef, message: stashMsg }), 'utf-8');

  return { files: 0, size: 0 };
}

function _saveTarFull(projectDir, ckptDir, id) {
  // Safety: never tar the home directory or any directory that is clearly too large
  const home = os.homedir();
  if (projectDir === home || projectDir === home + '/') {
    return { files: 0, size: 0, skipped: true };
  }

  const tarPath = path.join(ckptDir, `${id}.tar.gz`);
  const excludes = [
    'node_modules',
    '.git',
    '__pycache__',
    '.venv',
    'venv',
    'env',
    'dist',
    'build',
    '.next',
    '.nuxt',
    '.cache',
    '.tox',
    'coverage',
    '.nyc_output',
    'bower_components',
    '.khyquant',
    '.claude',
    '.npm',
    '.cargo',
    '.rustup',
    '*.pyc',
    '.DS_Store',
    'Thumbs.db',
    '*.tar.gz',
    '*.zip',
    '*.iso',
  ]
    .map((e) => `--exclude=${e}`)
    .join(' ');

  const parentDir = path.dirname(projectDir);
  const baseName = path.basename(projectDir);

  // Cross-platform tar
  try {
    execSync(`tar czf "${tarPath}" ${excludes} -C "${parentDir}" "${baseName}"`, {
      timeout: 120000,
      stdio: 'pipe',
    });
  } catch (err) {
    // Clean up partial tar on failure
    try {
      if (fs.existsSync(tarPath)) {
        fs.unlinkSync(tarPath);
      }
    } catch {
      /* */
    }
    throw new Error(`Tar failed: ${err.message}`);
  }

  const stat = fs.statSync(tarPath);

  // Post-creation size guard: delete if tar is too large
  if (stat.size > TAR_SKIP_THRESHOLD_MB * 1024 * 1024) {
    try {
      fs.unlinkSync(tarPath);
    } catch {
      /* */
    }
    return { files: 0, size: 0, skipped: true };
  }

  return { files: -1, size: stat.size };
}

// ─── Restore Checkpoint ────────────────────────────────────────────────────

/**
 * Restore a workspace checkpoint.
 * @param {string} projectDir - Project root directory
 * @param {string} checkpointId - Checkpoint ID to restore
 * @param {object} [options]
 * @param {boolean} [options.dryRun] - Preview changes without applying
 * @returns {{ restored: boolean, mode: string, message: string }}
 */
function restoreCheckpoint(projectDir, checkpointId, options = {}) {
  const resolvedDir = path.resolve(projectDir);
  const ckptDir = _projectCheckpointDir(resolvedDir);
  const manifest = _loadManifest(ckptDir);
  const entry = manifest.checkpoints.find((c) => c.id === checkpointId);

  if (!entry) {
    throw new Error(`Checkpoint "${checkpointId}" not found`);
  }

  if (options.dryRun) {
    return {
      restored: false,
      mode: entry.mode,
      message: `[dry-run] Would restore: ${entry.message}`,
    };
  }

  switch (entry.mode) {
    case 'git-diff':
      return _restoreGitDiff(resolvedDir, ckptDir, entry);
    case 'git-stash':
      return _restoreGitStash(resolvedDir, ckptDir, entry);
    case 'tar-full':
      return _restoreTarFull(resolvedDir, ckptDir, entry);
    default:
      throw new Error(`Unknown checkpoint mode: ${entry.mode}`);
  }
}

function _restoreGitDiff(projectDir, ckptDir, entry) {
  const patchPath = path.join(ckptDir, `${entry.id}.patch`);
  if (!fs.existsSync(patchPath)) {
    throw new Error(`Patch file missing: ${patchPath}`);
  }

  const patch = fs.readFileSync(patchPath, 'utf-8');
  // Filter out comment lines (untracked file list)
  const cleanPatch = patch
    .split('\n')
    .filter((l) => !l.startsWith('# '))
    .join('\n');

  if (cleanPatch.trim()) {
    try {
      const gitBin = _gitBin();
      const quotedGit = gitBin === 'git' ? 'git' : `"${gitBin}"`;
      execSync(`${quotedGit} apply --3way`, {
        cwd: projectDir,
        input: cleanPatch,
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 50 * 1024 * 1024,
      });
    } catch (err) {
      throw new Error(`Failed to apply patch: ${err.stderr || err.message}`);
    }
  }

  return { restored: true, mode: 'git-diff', message: `Restored: ${entry.message}` };
}

function _restoreGitStash(projectDir, ckptDir, entry) {
  const metaPath = path.join(ckptDir, `${entry.id}.stash.json`);
  let stashRef = 'stash@{0}';
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    // Find stash by message
    const stashList = _gitExec(['stash', 'list', '--oneline'], projectDir);
    const line = stashList.split('\n').find((l) => l.includes(entry.id));
    if (line) {
      stashRef = line.split(':')[0];
    } else {
      stashRef = meta.stashRef;
    }
  } catch {
    /* use default */
  }

  _gitExec(['stash', 'apply', stashRef], projectDir);
  return { restored: true, mode: 'git-stash', message: `Applied stash: ${entry.message}` };
}

function _restoreTarFull(projectDir, ckptDir, entry) {
  const tarPath = path.join(ckptDir, `${entry.id}.tar.gz`);
  if (!fs.existsSync(tarPath)) {
    throw new Error(`Tar file missing: ${tarPath}`);
  }

  const parentDir = path.dirname(projectDir);
  execSync(`tar xzf "${tarPath}" -C "${parentDir}"`, {
    timeout: 120000,
    stdio: 'pipe',
  });

  return { restored: true, mode: 'tar-full', message: `Extracted: ${entry.message}` };
}

// ─── List & Diff ───────────────────────────────────────────────────────────

/**
 * List all checkpoints for a project.
 * @param {string} projectDir - Project root directory
 * @returns {Array<object>} Checkpoint entries
 */
function listCheckpoints(projectDir) {
  const resolvedDir = path.resolve(projectDir);
  const ckptDir = _projectCheckpointDir(resolvedDir);
  const manifest = _loadManifest(ckptDir);
  return manifest.checkpoints || [];
}

/**
 * Show diff between a checkpoint and the current workspace.
 * Only works for git-diff mode checkpoints.
 * @param {string} projectDir - Project root
 * @param {string} checkpointId - Checkpoint ID
 * @returns {{ diff: string, stats: { additions: number, deletions: number } }}
 */
function diffCheckpoint(projectDir, checkpointId) {
  const resolvedDir = path.resolve(projectDir);
  const ckptDir = _projectCheckpointDir(resolvedDir);
  const manifest = _loadManifest(ckptDir);
  const entry = manifest.checkpoints.find((c) => c.id === checkpointId);

  if (!entry) {
    throw new Error(`Checkpoint "${checkpointId}" not found`);
  }

  if (entry.mode === 'git-diff') {
    const patchPath = path.join(ckptDir, `${entry.id}.patch`);
    if (!fs.existsSync(patchPath)) {
      throw new Error('Patch file missing');
    }
    const patch = fs.readFileSync(patchPath, 'utf-8');
    const additions = (patch.match(/^\+[^+]/gm) || []).length;
    const deletions = (patch.match(/^-[^-]/gm) || []).length;
    return { diff: patch, stats: { additions, deletions } };
  }

  if (entry.mode === 'tar-full') {
    return {
      diff: `[tar-full checkpoint — ${_formatSize(entry.size)}]`,
      stats: { additions: 0, deletions: 0 },
    };
  }

  return {
    diff: `[${entry.mode} checkpoint — no diff available]`,
    stats: { additions: 0, deletions: 0 },
  };
}

// ─── Cleanup ───────────────────────────────────────────────────────────────

/**
 * Delete a specific checkpoint.
 * @param {string} projectDir
 * @param {string} checkpointId
 * @returns {boolean}
 */
function deleteCheckpoint(projectDir, checkpointId) {
  const resolvedDir = path.resolve(projectDir);
  const ckptDir = _projectCheckpointDir(resolvedDir);
  const manifest = _loadManifest(ckptDir);
  const idx = manifest.checkpoints.findIndex((c) => c.id === checkpointId);
  if (idx === -1) {
    return false;
  }

  const [entry] = manifest.checkpoints.splice(idx, 1);
  _removeCheckpointFiles(ckptDir, entry);
  _saveManifest(ckptDir, manifest);
  return true;
}

/**
 * Clean up old checkpoints, keeping only the N most recent.
 * @param {string} projectDir
 * @param {number} [keep=10] - Number of checkpoints to keep
 * @returns {number} Number of checkpoints removed
 */
function cleanupCheckpoints(projectDir, keep = 10) {
  const resolvedDir = path.resolve(projectDir);
  const ckptDir = _projectCheckpointDir(resolvedDir);
  const manifest = _loadManifest(ckptDir);

  let removed = 0;
  while (manifest.checkpoints.length > keep) {
    const old = manifest.checkpoints.shift();
    _removeCheckpointFiles(ckptDir, old);
    removed++;
  }

  if (removed > 0) {
    _saveManifest(ckptDir, manifest);
  }
  return removed;
}

function _removeCheckpointFiles(ckptDir, entry) {
  const extensions = ['.patch', '.tar.gz', '.stash.json'];
  for (const ext of extensions) {
    const filePath = path.join(ckptDir, `${entry.id}${ext}`);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      /* ignore */
    }
  }
}

// ─── Utility ───────────────────────────────────────────────────────────────

/**
 * Get total disk usage of all checkpoints for a project.
 * @param {string} projectDir
 * @returns {{ totalSize: number, count: number, formatted: string }}
 */
function getCheckpointStats(projectDir) {
  const resolvedDir = path.resolve(projectDir);
  const ckptDir = _projectCheckpointDir(resolvedDir);
  const manifest = _loadManifest(ckptDir);

  let totalSize = 0;
  for (const entry of manifest.checkpoints) {
    totalSize += entry.size || 0;
  }

  return {
    totalSize,
    count: manifest.checkpoints.length,
    formatted: _formatSize(totalSize),
  };
}

// Thin delegate to the canonical formatter (utils/formatBytes); maxUnit 'GB'
// reproduces the previous 4-tier B/KB/MB/GB cascade byte-for-byte.
function _formatSize(bytes) {
  return _formatBytesAtom(bytes, { maxUnit: 'GB' });
}

module.exports = {
  saveCheckpoint,
  saveCheckpointAsync,
  restoreCheckpoint,
  listCheckpoints,
  diffCheckpoint,
  deleteCheckpoint,
  cleanupCheckpoints,
  getCheckpointStats,
};

// Lazy getter keeps destructured requires working while resolving the
// portable-aware location at access time (not at require time).
Object.defineProperty(module.exports, 'CHECKPOINT_ROOT', {
  enumerable: true,
  get() {
    return _checkpointRoot();
  },
});
