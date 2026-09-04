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
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 路径与 manifest 名一律取自 extensionRoots(单一真源,见 [DESIGN-ARCH-069] 第二/三节)。
// 本模块是**安装器**:它只往用户目录写,所以 EXTENSIONS_DIR 仍是 <appHome>/extensions
// —— 但那个字符串不再由这里拼,以免与发现路径的根集合再次漂移。
const extensionRoots = require('./extensionRoots');
const EXTENSIONS_DIR = extensionRoots.userExtensionsDir();
const MANIFEST_FILE = extensionRoots.MANIFEST_LEGACY_JSON;
const STATE_FILE = extensionRoots.stateFilePath();

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
      if (!dir.isDirectory()) {
        continue;
      }
      const manifestPath = path.join(EXTENSIONS_DIR, dir.name, MANIFEST_FILE);
      if (!fs.existsSync(manifestPath)) {
        continue;
      }

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
      } catch {
        /* skip corrupt manifest */
      }
    }
  } catch {
    /* dir doesn't exist */
  }

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
  const { safeMklink } = require('../../../../tools/platformUtils');
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

  if (!manifest.entry) {
    return null;
  }

  const entryPath = path.join(extPath, manifest.entry);
  if (!fs.existsSync(entryPath)) {
    return null;
  }

  return require(entryPath);
}

/**
 * 清除 state 里指向**已不存在目录**的残留条目。
 *
 * 这是「删除目录 → 拓展自动删除」的收尾（[DESIGN-ARCH-069] §4.1）。用户手动
 * `rm -rf` 一个拓展目录时不会经过 uninstallExtension，于是 `extensions_state.json`
 * 会留下一条 `{ enabled, installedAt }`。发现路径本来就看不见它（文件系统才是
 * 注册表），所以残留**不影响功能**——清理只是让 state 不再积累谎言。
 *
 * 残留识别委派给 `extensionRoots.findOrphanState()`（它看**全部根**，而不只是
 * EXTENSIONS_DIR：一个内置拓展被显式禁用后，state 里的条目对应的是仓库根里的
 * 目录，若只查用户目录就会把它误删，等于默默重新启用一个被禁用的拓展）。
 * 写盘仍只由本模块做：extensionRoots 是只读探测器。
 *
 * 幂等：没残留时**不写盘**（避开启动期无意义的写入）。
 *
 * @param {object} [opts] - { env } 便于单测注入
 * @returns {{ pruned: string[] }} 被清除的 id（已排序）
 */
function pruneOrphanState(opts = {}) {
  let orphans;
  try {
    orphans = extensionRoots.findOrphanState(opts);
  } catch {
    return { pruned: [] }; // 探测失败 → 宁可不清，绝不误删
  }
  if (!orphans || orphans.length === 0) {
    return { pruned: [] };
  }
  const state = _loadState();
  const pruned = orphans.filter((id) => Object.prototype.hasOwnProperty.call(state, id));
  if (pruned.length === 0) {
    return { pruned: [] };
  }
  for (const id of pruned) {
    delete state[id];
  }
  _saveState(state);
  return { pruned };
}

// ── State persistence ────────────────────────────────────────────────

function _loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch {
    /* ignore */
  }
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
  if (!fs.existsSync(manifestPath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
}

// 收敛到 utils/ensureDirSync 单一真源(逐字节委托,调用点不变)
const _ensureDir = require('../../../../utils/ensureDirSync');

module.exports = {
  listExtensions,
  installExtension,
  uninstallExtension,
  setEnabled,
  loadExtension,
  pruneOrphanState,
  EXTENSIONS_DIR,
};
