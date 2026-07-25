/**
 * Per-project memory service.
 *
 * Like Claude Code's .claude/projects/ directory, KHY-Quant stores
 * per-directory context under ~/.khyquant/projects/<hash>/.
 *
 * Each project directory gets:
 *   - memory/          conversation traces, notes
 *   - khy.md           project-level instructions (symlink or copy)
 *   - last_session.json  last session metadata for "recent activity"
 *
 * The directory key is a hash of the absolute cwd path.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const PROJECTS_DIR = path.join(os.homedir(), '.khyquant', 'projects');
const MAX_PROJECTS = 50; // prune oldest when exceeded

// ── Helpers ─────────────────────────────────────────────────────────────

function hashPath(dirPath) {
  return crypto.createHash('sha256').update(dirPath).digest('hex').slice(0, 16);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Core API ────────────────────────────────────────────────────────────

/**
 * Get the project data directory for a given cwd.
 * Creates the directory if it does not exist.
 */
function getProjectDir(cwd) {
  cwd = path.resolve(cwd || process.cwd());
  const hash = hashPath(cwd);
  const dir = path.join(PROJECTS_DIR, hash);
  ensureDir(dir);

  // Write a metadata file so we can map hash → path
  const metaPath = path.join(dir, 'project.json');
  try {
    const meta = fs.existsSync(metaPath)
      ? JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
      : {};
    meta.path = cwd;
    meta.lastAccessed = new Date().toISOString();
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
  } catch { /* best effort */ }

  return dir;
}

/**
 * Get the memory sub-directory for a cwd.
 */
function getMemoryDir(cwd) {
  const dir = path.join(getProjectDir(cwd), 'memory');
  ensureDir(dir);
  return dir;
}

/**
 * Save a session trace (conversation summary, commands used, etc.).
 */
function saveSessionTrace(cwd, trace) {
  const dir = getProjectDir(cwd);
  try {
    fs.writeFileSync(
      path.join(dir, 'last_session.json'),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        ...trace,
      }, null, 2),
      'utf-8'
    );
  } catch { /* best effort */ }
}

/**
 * Load last session trace for a cwd.
 */
function loadLastSession(cwd) {
  const dir = getProjectDir(cwd);
  const filePath = path.join(dir, 'last_session.json');
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * List all known projects (most recently accessed first).
 */
function listProjects() {
  try {
    if (!fs.existsSync(PROJECTS_DIR)) return [];
    const dirs = fs.readdirSync(PROJECTS_DIR);
    const projects = [];
    for (const d of dirs) {
      const metaPath = path.join(PROJECTS_DIR, d, 'project.json');
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        projects.push({ hash: d, ...meta });
      } catch { /* skip corrupt entries */ }
    }
    return projects.sort((a, b) => (b.lastAccessed || '').localeCompare(a.lastAccessed || ''));
  } catch { return []; }
}

/**
 * Prune old projects when exceeding MAX_PROJECTS.
 */
function pruneProjects(maxKeep = MAX_PROJECTS) {
  const projects = listProjects();
  if (projects.length <= maxKeep) return 0;

  const toRemove = projects.slice(maxKeep);
  let removed = 0;
  for (const p of toRemove) {
    try {
      fs.rmSync(path.join(PROJECTS_DIR, p.hash), { recursive: true, force: true });
      removed++;
    } catch { /* skip */ }
  }
  return removed;
}

module.exports = {
  getProjectDir,
  getMemoryDir,
  saveSessionTrace,
  loadLastSession,
  listProjects,
  pruneProjects,
  PROJECTS_DIR,
};
