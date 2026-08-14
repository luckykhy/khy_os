/**
 * Per-project memory service.
 *
 * Like Claude Code's .claude/projects/ directory, khy OS stores
 * per-directory context under ~/.khyquant/projects/<hash>/.
 *
 * Each project directory gets:
 *   - memory/          conversation traces, notes
 *   - khy.md           project-level instructions (symlink or copy)
 *   - last_session.json  last session metadata for "recent activity"
 *
 * The directory key is a hash of the absolute cwd path.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECTS_DIR_NAME = 'projects';
const MAX_PROJECTS = 50; // prune oldest when exceeded

let _cachedProjectsDir = null;

/**
 * Resolve the projects root lazily via the portable-aware dataHome resolver.
 * Portable deployments (.portable marker or KHYQUANT_PORTABLE_ROOT) keep the
 * projects store under the project-scoped data home (<root>/.khy/projects);
 * regular installs keep the HISTORICAL location ~/.khyquant/projects
 * unchanged (100% behavior-compatible for non-portable installs).
 * @returns {string} Absolute path to the projects root
 */
function getProjectsDir() {
  if (_cachedProjectsDir) {
    return _cachedProjectsDir;
  }
  try {
    const dataHome = require('../utils/dataHome');
    if (typeof dataHome.isPortableDeployment === 'function' && dataHome.isPortableDeployment()) {
      _cachedProjectsDir = dataHome.getProjectDataDir(PROJECTS_DIR_NAME);
    } else {
      // Non-portable installs: pin the historical user-home location so
      // behavior stays byte-identical regardless of getAppHome() fallbacks.
      _cachedProjectsDir = path.join(os.homedir(), '.khyquant', PROJECTS_DIR_NAME);
    }
  } catch {
    // Legacy-compatible fallback when dataHome is unavailable.
    _cachedProjectsDir = path.join(os.homedir(), '.khyquant', PROJECTS_DIR_NAME);
  }
  return _cachedProjectsDir;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function hashPath(dirPath) {
  return crypto.createHash('sha256').update(dirPath).digest('hex').slice(0, 16);
}

// 收敛到 utils/ensureDirSync 单一真源(逐字节委托,调用点不变)
const ensureDir = require('../utils/ensureDirSync');

// ── Core API ────────────────────────────────────────────────────────────

/**
 * Get the project data directory for a given cwd.
 * Creates the directory if it does not exist.
 */
function getProjectDir(cwd) {
  cwd = path.resolve(cwd || process.cwd());
  const hash = hashPath(cwd);
  const dir = path.join(getProjectsDir(), hash);
  ensureDir(dir);

  // Write a metadata file so we can map hash → path
  const metaPath = path.join(dir, 'project.json');
  try {
    const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf-8')) : {};
    meta.path = cwd;
    meta.lastAccessed = new Date().toISOString();
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
  } catch {
    /* best effort */
  }

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
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          ...trace,
        },
        null,
        2
      ),
      'utf-8'
    );
  } catch {
    /* best effort */
  }
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
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * List all known projects (most recently accessed first).
 */
function listProjects() {
  try {
    const projectsDir = getProjectsDir();
    if (!fs.existsSync(projectsDir)) {
      return [];
    }
    const dirs = fs.readdirSync(projectsDir);
    const projects = [];
    for (const d of dirs) {
      const metaPath = path.join(projectsDir, d, 'project.json');
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        projects.push({ hash: d, ...meta });
      } catch {
        /* skip corrupt entries */
      }
    }
    return projects.sort((a, b) => (b.lastAccessed || '').localeCompare(a.lastAccessed || ''));
  } catch {
    return [];
  }
}

/**
 * Prune old projects when exceeding MAX_PROJECTS.
 */
function pruneProjects(maxKeep = MAX_PROJECTS) {
  const projects = listProjects();
  if (projects.length <= maxKeep) {
    return 0;
  }

  const toRemove = projects.slice(maxKeep);
  let removed = 0;
  for (const p of toRemove) {
    try {
      fs.rmSync(path.join(getProjectsDir(), p.hash), { recursive: true, force: true });
      removed++;
    } catch {
      /* skip */
    }
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
  getProjectsDir,
};

// Legacy compatibility: PROJECTS_DIR used to be a hardcoded constant; expose
// it as a lazy getter so existing consumers keep working with the
// portable-aware resolution. The getter returns a plain string path and is
// enumerable, so destructuring require (`const { PROJECTS_DIR } = ...`) keeps
// working — it just snapshots the resolved path at destructure time.
Object.defineProperty(module.exports, 'PROJECTS_DIR', {
  get: getProjectsDir,
  enumerable: true,
});
