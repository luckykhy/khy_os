/**
 * Memory Paths — canonical path resolution for the memory directory.
 *
 * Resolution order:
 *   1. KHY_MEMORY_DIR env var (explicit override)
 *   2. <KHY-OS project root>/.khy/memory/ (default)
 *
 * For compatibility, also checks ~/.claude/ if the project memory dir does
 * not exist (allows users migrating from Claude Code to keep their memories).
 *
 * Path security:
 *   - Rejects relative paths, root paths, and null-byte paths
 *   - All returned paths are normalized with a trailing separator
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Constants ──────────────────────────────────────────────────────────

const MEMORY_DIR_NAME = 'memory';
const MEMORY_INDEX_NAME = 'MEMORY.md';
const MAX_ENTRYPOINT_LINES = 200;
const MAX_ENTRYPOINT_BYTES = 25_000;

// ── Path resolution ────────────────────────────────────────────────────

let _cachedMemoryDir = null;

/**
 * Resolve the KHY-OS project-scoped data home (<root>/.khy).
 * Falls back to ~/.khy if dataHome cannot be loaded.
 * @returns {string}
 */
function _projectDataHome() {
  try {
    const { getProjectDataHome } = require('../utils/dataHome');
    return getProjectDataHome();
  } catch {
    return path.join(os.homedir(), '.khy');
  }
}

// Memory-home unification gate decisions (pure leaf). fail-soft: if the leaf is
// missing, treat both gates as OFF so resolution byte-reverts to legacy.
let _memoryUnify;
try { _memoryUnify = require('./memoryUnify'); } catch { _memoryUnify = null; }

/**
 * Resolve the DURABLE user-home memory dir (getDataHome()/memory, e.g.
 * ~/.khy/memory). This is the same root the dreaming/consolidation side writes
 * to (getDataDir('memory')); pointing recall here ends the split-brain and is
 * durable across pip upgrades. Falls back to ~/.khy/memory if dataHome fails.
 * @returns {string}
 */
function _dataHomeMemory() {
  try {
    const { getDataHome } = require('../utils/dataHome');
    return path.join(getDataHome(), MEMORY_DIR_NAME);
  } catch {
    return path.join(os.homedir(), '.khy', MEMORY_DIR_NAME);
  }
}

/**
 * Get the memory directory path.
 *
 * @returns {string} Absolute path to the memory directory (with trailing separator)
 */
function getMemoryDir() {
  if (_cachedMemoryDir) return _cachedMemoryDir;

  // 1. Environment override
  if (process.env.KHY_MEMORY_DIR) {
    const validated = _validatePath(process.env.KHY_MEMORY_DIR);
    if (validated) {
      _cachedMemoryDir = validated;
      return _cachedMemoryDir;
    }
  }

  // 2. Unified durable home (gate KHY_MEMORY_UNIFIED_HOME, default ON):
  //    resolve to getDataHome()/memory — the same root dreaming writes to,
  //    durable across pip upgrades. Gate OFF → fall through to legacy below
  //    (byte-identical historical resolution).
  if (_memoryUnify && _memoryUnify.unifiedHomeEnabled(process.env)) {
    _cachedMemoryDir = path.normalize(_dataHomeMemory()) + path.sep;
    return _cachedMemoryDir;
  }

  // 3. Legacy default: <project root>/.khy/memory/
  const khyDir = path.join(_projectDataHome(), MEMORY_DIR_NAME);
  if (fs.existsSync(khyDir) || !_hasClaudeMemory()) {
    _cachedMemoryDir = path.normalize(khyDir) + path.sep;
    return _cachedMemoryDir;
  }

  // 4. Fallback: ~/.claude/ for migration
  const claudeDir = path.join(os.homedir(), '.claude', MEMORY_DIR_NAME);
  if (fs.existsSync(claudeDir)) {
    _cachedMemoryDir = path.normalize(claudeDir) + path.sep;
    return _cachedMemoryDir;
  }

  // Default to ~/.khy/memory/ even if it doesn't exist yet
  _cachedMemoryDir = path.normalize(khyDir) + path.sep;
  return _cachedMemoryDir;
}

/**
 * Get the project-specific memory directory.
 *
 * @param {string} [projectRoot] - Project root path. Defaults to cwd.
 * @returns {string} Project memory directory path
 */
function getProjectMemoryDir(projectRoot) {
  const root = projectRoot || process.cwd();
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
  const baseDir = path.join(_projectDataHome(), 'projects', hash, MEMORY_DIR_NAME);
  return path.normalize(baseDir) + path.sep;
}

/**
 * Get the MEMORY.md index file path.
 * @returns {string}
 */
function getMemoryIndexPath() {
  return path.join(getMemoryDir(), MEMORY_INDEX_NAME);
}

/**
 * Get the full path for a memory file.
 * @param {string} filename - File name (e.g., 'user_role.md')
 * @returns {string}
 */
function getMemoryFilePath(filename) {
  // Security: prevent directory traversal
  const sanitized = path.basename(filename);
  return path.join(getMemoryDir(), sanitized);
}

/**
 * Ensure the memory directory exists. Idempotent.
 */
function ensureMemoryDirExists() {
  const dir = getMemoryDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  migrateLegacyMemoryOnce();
}

let _legacyMergeDone = false;

/**
 * One-time ADDITIVE merge of orphaned legacy memory into the canonical dir.
 *
 * When the unified-home gate moved recall to getDataHome()/memory, any memory
 * previously written under the legacy getProjectDataHome()/memory would be
 * orphaned. This copies the legacy-only files into the canonical dir so nothing
 * is lost — ADDITIVE only: the source is never deleted or moved (honoring
 * dataHome.js's "live data is not auto-migrated" red line), and established
 * canonical files are never overwritten (established-wins, see planLegacyMerge).
 * Copied files are unioned into MEMORY.md via the existing updateMemoryIndex.
 *
 * Best-effort and gated (KHY_MEMORY_MERGE_LEGACY); any error is swallowed so a
 * merge problem never blocks a save/recall. Runs at most once per process.
 */
function migrateLegacyMemoryOnce() {
  if (_legacyMergeDone) return;
  _legacyMergeDone = true;
  try {
    if (!_memoryUnify || !_memoryUnify.legacyMergeEnabled(process.env)) return;
    if (!_memoryUnify.unifiedHomeEnabled(process.env)) return; // legacy == canonical

    const canonicalDir = getMemoryDir();
    const legacyDir = path.normalize(path.join(_projectDataHome(), MEMORY_DIR_NAME)) + path.sep;
    if (path.normalize(legacyDir) === path.normalize(canonicalDir)) return;
    if (!fs.existsSync(legacyDir)) return;

    const legacyNames = fs.readdirSync(legacyDir);
    const canonicalNames = fs.existsSync(canonicalDir) ? fs.readdirSync(canonicalDir) : [];
    const toCopy = _memoryUnify.planLegacyMerge(canonicalNames, legacyNames);
    if (toCopy.length === 0) return;

    let memdir = null;
    try { memdir = require('./memdir'); } catch { memdir = null; }

    const indexEntries = [];
    for (const name of toCopy) {
      try {
        const content = fs.readFileSync(path.join(legacyDir, name), 'utf-8');
        fs.writeFileSync(path.join(canonicalDir, name), content);
        if (memdir && typeof memdir.parseFrontmatter === 'function') {
          const { frontmatter } = memdir.parseFrontmatter(content);
          if (frontmatter && (frontmatter.name || frontmatter.description)) {
            indexEntries.push({
              title: frontmatter.name || name.replace(/\.md$/i, ''),
              filename: name,
              description: frontmatter.description || frontmatter.name || name,
            });
          }
        }
      } catch { /* skip this file, keep going */ }
    }

    if (memdir && typeof memdir.updateMemoryIndex === 'function' && indexEntries.length > 0) {
      try { memdir.updateMemoryIndex(indexEntries); } catch { /* index union best-effort */ }
    }
  } catch { /* merge is best-effort; never block memory IO */ }
}

/**
 * Check if an absolute path is within the memory directory.
 * @param {string} absolutePath
 * @returns {boolean}
 */
function isMemoryPath(absolutePath) {
  const normalized = path.normalize(absolutePath);
  return normalized.startsWith(getMemoryDir());
}

// ── Validation ─────────────────────────────────────────────────────────

/**
 * Validate and normalize a memory path.
 *
 * Rejects:
 *   - Relative paths
 *   - Root or near-root paths (length < 3)
 *   - UNC paths
 *   - Paths containing null bytes
 *
 * @param {string} raw
 * @returns {string|null} Normalized path with trailing separator, or null
 */
function _validatePath(raw) {
  if (!raw || typeof raw !== 'string') return null;

  let candidate = raw;

  // Expand ~/
  if (candidate.startsWith('~/') || candidate.startsWith('~\\')) {
    candidate = path.join(os.homedir(), candidate.slice(2));
  }

  const normalized = path.normalize(candidate).replace(/[/\\]+$/, '');

  if (!path.isAbsolute(normalized)) return null;
  if (normalized.length < 3) return null;
  if (normalized.startsWith('\\\\') || normalized.startsWith('//')) return null;
  if (normalized.includes('\0')) return null;

  return normalized + path.sep;
}

/**
 * Check if ~/.claude/ memory directory exists (for migration compatibility).
 * @returns {boolean}
 */
function _hasClaudeMemory() {
  try {
    const claudeDir = path.join(os.homedir(), '.claude', MEMORY_DIR_NAME);
    return fs.existsSync(claudeDir);
  } catch {
    return false;
  }
}

/**
 * Reset cached paths (for testing).
 */
function _resetCache() {
  _cachedMemoryDir = null;
  _legacyMergeDone = false;
}

module.exports = {
  MEMORY_DIR_NAME,
  MEMORY_INDEX_NAME,
  MAX_ENTRYPOINT_LINES,
  MAX_ENTRYPOINT_BYTES,
  getMemoryDir,
  getProjectMemoryDir,
  getMemoryIndexPath,
  getMemoryFilePath,
  ensureMemoryDirExists,
  migrateLegacyMemoryOnce,
  isMemoryPath,
  _resetCache,
};
