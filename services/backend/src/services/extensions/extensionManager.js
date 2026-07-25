/**
 * Extension Manager — install, uninstall, enable, disable CLI extensions.
 *
 * Extensions can provide:
 *   - Additional skills (SKILL.md files)
 *   - Gateway plugins (onBeforeRequest/onAfterResponse hooks)
 *   - MCP servers (tool providers)
 *   - CLI commands (slash commands)
 *
 * Extension format (openclaw.plugin.json):
 * {
 *   "name": "my-extension",
 *   "version": "1.0.0",
 *   "description": "...",
 *   "capabilities": ["skill", "gateway-plugin", "mcp-server", "cli-command"],
 *   "entry": "./src/index.js",
 *   "skills": ["./skills/my-skill/SKILL.md"],
 *   "mcp": { "command": "node", "args": ["./mcp-server.js"] }
 * }
 *
 * Storage: ~/.khyquant/extensions/<name>/
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const EXTENSIONS_DIR = path.join(os.homedir(), '.khyquant', 'extensions');
const MANIFEST_FILE = 'openclaw.plugin.json';
const STATE_FILE = path.join(os.homedir(), '.khyquant', 'extensions_state.json');

/**
 * List all installed extensions.
 */
function listExtensions() {
  _ensureDir(EXTENSIONS_DIR);
  const state = _loadState();
  const extensions = [];

  try {
    const dirs = fs.readdirSync(EXTENSIONS_DIR, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const manifestPath = path.join(EXTENSIONS_DIR, dir.name, MANIFEST_FILE);
      if (!fs.existsSync(manifestPath)) continue;

      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        extensions.push({
          name: manifest.name || dir.name,
          version: manifest.version || '0.0.0',
          description: manifest.description || '',
          capabilities: manifest.capabilities || [],
          enabled: state[dir.name]?.enabled !== false,
          path: path.join(EXTENSIONS_DIR, dir.name),
        });
      } catch { /* skip corrupt manifest */ }
    }
  } catch { /* dir doesn't exist */ }

  return extensions;
}

/**
 * Install an extension from a git URL or local path.
 */
function installExtension(source) {
  _ensureDir(EXTENSIONS_DIR);

  if (source.startsWith('http') || source.endsWith('.git')) {
    return _installFromGit(source);
  }

  if (fs.existsSync(source) && fs.statSync(source).isDirectory()) {
    return _installFromLocal(source);
  }

  throw new Error(`Unknown source format: ${source}`);
}

function _installFromGit(url) {
  // Extract name from URL
  const name = path.basename(url, '.git').replace(/[^a-zA-Z0-9_-]/g, '-');
  const dest = path.join(EXTENSIONS_DIR, name);

  if (fs.existsSync(dest)) {
    throw new Error(`Extension "${name}" already installed. Uninstall first.`);
  }

  execSync(`git clone --depth 1 ${url} ${dest}`, { stdio: 'pipe' });

  // Run npm install if package.json exists
  const pkgJson = path.join(dest, 'package.json');
  if (fs.existsSync(pkgJson)) {
    execSync('npm install --production', { cwd: dest, stdio: 'pipe' });
  }

  _setState(name, { enabled: true, installedAt: new Date().toISOString() });
  return { name, path: dest };
}

function _installFromLocal(sourcePath) {
  const manifest = _readManifest(sourcePath);
  const name = manifest.name || path.basename(sourcePath);
  const dest = path.join(EXTENSIONS_DIR, name);

  if (fs.existsSync(dest)) {
    throw new Error(`Extension "${name}" already installed.`);
  }

  // Symlink for local development (junction fallback on Windows)
  const { safeMklink } = require('../../tools/platformUtils');
  safeMklink(sourcePath, dest);
  _setState(name, { enabled: true, installedAt: new Date().toISOString(), linked: true });
  return { name, path: dest };
}

/**
 * Uninstall an extension.
 */
function uninstallExtension(name) {
  const extPath = path.join(EXTENSIONS_DIR, name);
  if (!fs.existsSync(extPath)) {
    throw new Error(`Extension "${name}" not found.`);
  }

  const stat = fs.lstatSync(extPath);
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(extPath);
  } else {
    fs.rmSync(extPath, { recursive: true, force: true });
  }

  _removeState(name);
  return true;
}

/**
 * Enable / disable an extension.
 */
function setEnabled(name, enabled) {
  const extPath = path.join(EXTENSIONS_DIR, name);
  if (!fs.existsSync(extPath)) {
    throw new Error(`Extension "${name}" not found.`);
  }
  _setState(name, { enabled });
}

/**
 * Load an extension's entry module.
 */
function loadExtension(name) {
  const extPath = path.join(EXTENSIONS_DIR, name);
  const manifest = _readManifest(extPath);

  if (!manifest.entry) return null;

  const entryPath = path.join(extPath, manifest.entry);
  if (!fs.existsSync(entryPath)) return null;

  return require(entryPath);
}

// ── State persistence ────────────────────────────────────────────────

function _loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

function _saveState(state) {
  _ensureDir(path.dirname(STATE_FILE));
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function _setState(name, props) {
  const state = _loadState();
  state[name] = { ...(state[name] || {}), ...props };
  _saveState(state);
}

function _removeState(name) {
  const state = _loadState();
  delete state[name];
  _saveState(state);
}

function _readManifest(dir) {
  const manifestPath = path.join(dir, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) return {};
  return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
}

// 收敛到 utils/ensureDirSync 单一真源(逐字节委托,调用点不变)
const _ensureDir = require('../../utils/ensureDirSync');

module.exports = {
  listExtensions,
  installExtension,
  uninstallExtension,
  setEnabled,
  loadExtension,
  EXTENSIONS_DIR,
};
