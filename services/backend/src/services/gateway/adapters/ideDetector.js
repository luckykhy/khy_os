/**
 * IDE Installation Detector — find local installations of Kiro, Cursor, Trae, Warp.
 *
 * Searches default installation paths per platform + user-configured custom paths.
 * Falls back to manual path configuration if auto-detection fails.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const PLATFORM = process.platform;
// On Windows, USERPROFILE/HOMEDRIVE+HOMEPATH may differ from os.homedir()
const WIN_HOME = PLATFORM === 'win32'
  ? (process.env.USERPROFILE
    || (process.env.HOMEDRIVE && process.env.HOMEPATH ? path.join(process.env.HOMEDRIVE, process.env.HOMEPATH) : '')
    || HOME)
  : HOME;

// ── Default installation paths ───────────────────────────────────────────

const DEFAULT_PATHS = {
  kiro: {
    win32: [
      path.join(HOME, 'AppData', 'Local', 'Programs', 'Kiro'),
      path.join(HOME, 'AppData', 'Local', 'Kiro'),
      ...(WIN_HOME !== HOME ? [
        path.join(WIN_HOME, 'AppData', 'Local', 'Programs', 'Kiro'),
        path.join(WIN_HOME, 'AppData', 'Local', 'Kiro'),
      ] : []),
      ...(process.env.LOCALAPPDATA ? [
        path.join(process.env.LOCALAPPDATA, 'Programs', 'Kiro'),
        path.join(process.env.LOCALAPPDATA, 'Kiro'),
      ] : []),
      'C:\\Program Files\\Kiro',
      'C:\\Program Files (x86)\\Kiro',
    ],
    darwin: [
      '/Applications/Kiro.app',
      path.join(HOME, 'Applications', 'Kiro.app'),
    ],
    linux: [
      '/opt/kiro',
      '/usr/share/kiro',
      path.join(HOME, '.local', 'share', 'kiro'),
      '/snap/kiro/current',
    ],
  },

  cursor: {
    win32: [
      path.join(HOME, 'AppData', 'Local', 'Programs', 'Cursor'),
      path.join(HOME, 'AppData', 'Local', 'Cursor'),
      'C:\\Program Files\\Cursor',
    ],
    darwin: [
      '/Applications/Cursor.app',
      path.join(HOME, 'Applications', 'Cursor.app'),
    ],
    linux: [
      '/opt/cursor',
      '/usr/share/cursor',
      path.join(HOME, '.local', 'share', 'cursor'),
      path.join(HOME, 'Applications', 'cursor.AppImage'),
      '/snap/cursor-ide/current',
    ],
  },

  trae: {
    win32: [
      path.join(HOME, 'AppData', 'Local', 'Programs', 'Trae CN'),
      path.join(HOME, 'AppData', 'Local', 'Programs', 'Trae'),
      path.join(HOME, 'AppData', 'Local', 'Trae CN'),
      path.join(HOME, 'AppData', 'Local', 'Trae'),
      'C:\\Program Files\\Trae CN',
      'C:\\Program Files\\Trae',
    ],
    darwin: [
      '/Applications/Trae.app',
      '/Applications/Trae CN.app',
      path.join(HOME, 'Applications', 'Trae.app'),
    ],
    linux: [
      '/opt/trae',
      path.join(HOME, '.local', 'share', 'trae'),
    ],
  },

  warp: {
    win32: [
      path.join(HOME, 'AppData', 'Local', 'Programs', 'Warp'),
      path.join(HOME, 'AppData', 'Local', 'Warp'),
      'C:\\Program Files\\Warp',
    ],
    darwin: [
      '/Applications/Warp.app',
      path.join(HOME, 'Applications', 'Warp.app'),
    ],
    linux: [
      '/opt/warp',
      path.join(HOME, '.warp'),
      path.join(HOME, '.local', 'share', 'warp-terminal'),
    ],
  },

  windsurf: {
    win32: [
      path.join(HOME, 'AppData', 'Local', 'Programs', 'Windsurf'),
      path.join(HOME, 'AppData', 'Local', 'Windsurf'),
      'C:\\Program Files\\Windsurf',
      path.join(HOME, 'AppData', 'Local', 'Programs', 'Codeium'),
    ],
    darwin: [
      '/Applications/Windsurf.app',
      path.join(HOME, 'Applications', 'Windsurf.app'),
      '/Applications/Codeium.app',
    ],
    linux: [
      '/opt/windsurf',
      path.join(HOME, '.local', 'share', 'windsurf'),
      '/snap/windsurf/current',
    ],
  },

  vscode: {
    win32: [
      path.join(HOME, 'AppData', 'Local', 'Programs', 'Microsoft VS Code'),
      'C:\\Program Files\\Microsoft VS Code',
      'C:\\Program Files (x86)\\Microsoft VS Code',
    ],
    darwin: [
      '/Applications/Visual Studio Code.app',
      path.join(HOME, 'Applications', 'Visual Studio Code.app'),
    ],
    linux: [
      '/usr/share/code',
      '/snap/code/current',
      path.join(HOME, '.local', 'share', 'code'),
    ],
  },
};

// ── Auth token / config data paths ───────────────────────────────────────

const DATA_PATHS = {
  kiro: {
    win32: [
      path.join(HOME, 'AppData', 'Roaming', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'profile.json'),
    ],
    darwin: [
      path.join(HOME, 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'profile.json'),
    ],
    linux: [
      path.join(HOME, '.config', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'profile.json'),
    ],
  },

  cursor: {
    win32: [
      path.join(HOME, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'storage.json'),
    ],
    darwin: [
      path.join(HOME, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'storage.json'),
    ],
    linux: [
      path.join(HOME, '.config', 'Cursor', 'User', 'globalStorage', 'storage.json'),
    ],
  },

  trae: {
    win32: [
      path.join(HOME, 'AppData', 'Roaming', 'Trae CN', 'User', 'globalStorage', 'storage.json'),
      path.join(HOME, 'AppData', 'Roaming', 'Trae', 'User', 'globalStorage', 'storage.json'),
    ],
    darwin: [
      path.join(HOME, 'Library', 'Application Support', 'Trae CN', 'User', 'globalStorage', 'storage.json'),
      path.join(HOME, 'Library', 'Application Support', 'Trae', 'User', 'globalStorage', 'storage.json'),
    ],
    linux: [
      path.join(HOME, '.config', 'Trae CN', 'User', 'globalStorage', 'storage.json'),
      path.join(HOME, '.config', 'Trae', 'User', 'globalStorage', 'storage.json'),
    ],
  },

  warp: {
    win32: [
      path.join(HOME, 'AppData', 'Local', 'Warp', 'data'),
    ],
    darwin: [
      path.join(HOME, '.warp'),
    ],
    linux: [
      path.join(HOME, '.local', 'share', 'warp-terminal'),
    ],
  },

  windsurf: {
    win32: [
      path.join(HOME, 'AppData', 'Roaming', 'Windsurf', 'User', 'globalStorage', 'storage.json'),
      path.join(HOME, 'AppData', 'Roaming', 'Codeium', 'User', 'globalStorage', 'storage.json'),
    ],
    darwin: [
      path.join(HOME, 'Library', 'Application Support', 'Windsurf', 'User', 'globalStorage', 'storage.json'),
    ],
    linux: [
      path.join(HOME, '.config', 'Windsurf', 'User', 'globalStorage', 'storage.json'),
    ],
  },

  vscode: {
    win32: [
      path.join(HOME, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'storage.json'),
    ],
    darwin: [
      path.join(HOME, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'storage.json'),
    ],
    linux: [
      path.join(HOME, '.config', 'Code', 'User', 'globalStorage', 'storage.json'),
    ],
  },
};

// Custom user-configured paths (loaded from .env or settings)
const _customPaths = {};

/**
 * Set a custom installation path for an IDE.
 */
function setCustomPath(ideName, installPath) {
  _customPaths[ideName.toLowerCase()] = installPath;
}

/**
 * Get the custom path if configured.
 */
function getCustomPath(ideName) {
  const envKey = `${ideName.toUpperCase()}_INSTALL_PATH`;
  return _customPaths[ideName.toLowerCase()] || process.env[envKey] || null;
}

/**
 * Find the installation directory for an IDE.
 * Returns the first valid path found, or null.
 */
function findInstallation(ideName) {
  const name = ideName.toLowerCase();

  // Check custom path first
  const custom = getCustomPath(name);
  if (custom && fs.existsSync(custom)) return custom;

  // Search default paths for current platform
  const platformPaths = DEFAULT_PATHS[name]?.[PLATFORM] || [];
  for (const p of platformPaths) {
    if (fs.existsSync(p)) return p;
  }

  // Also check all platform paths (for cross-drive installations)
  // Scan common drive letters on Windows
  if (PLATFORM === 'win32') {
    const drives = ['C', 'D', 'E', 'F'];
    for (const drive of drives) {
      const variants = [
        `${drive}:\\Users\\${path.basename(HOME)}\\AppData\\Local\\Programs\\${ideName}`,
        `${drive}:\\Program Files\\${ideName}`,
      ];
      for (const p of variants) {
        if (fs.existsSync(p)) return p;
      }
    }
  }

  return null;
}

/**
 * Find the auth/config data directory for an IDE.
 */
function findDataPath(ideName) {
  const name = ideName.toLowerCase();
  const platformPaths = DATA_PATHS[name]?.[PLATFORM] || [];
  for (const p of platformPaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Detect all installed IDEs.
 * Returns an array of { name, installPath, dataPath, available }.
 */
function detectAll() {
  const results = [];
  for (const name of Object.keys(DEFAULT_PATHS)) {
    const installPath = findInstallation(name);
    const dataPath = findDataPath(name);
    results.push({
      name,
      installPath,
      dataPath,
      available: !!(installPath || dataPath),
    });
  }
  // Dynamic IDE hints from env:
  //   GATEWAY_EXTRA_IDES=name1,name2
  //   NAME1_INSTALL_PATH=/abs/path
  //   NAME1_DATA_PATH=/abs/path
  const extras = String(process.env.GATEWAY_EXTRA_IDES || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  for (const name of extras) {
    if (results.find(r => r.name === name)) continue;
    const installPath = process.env[`${name.toUpperCase()}_INSTALL_PATH`] || null;
    const dataPath = process.env[`${name.toUpperCase()}_DATA_PATH`] || null;
    results.push({
      name,
      installPath: installPath && fs.existsSync(installPath) ? installPath : null,
      dataPath: dataPath && fs.existsSync(dataPath) ? dataPath : null,
      available: !!((installPath && fs.existsSync(installPath)) || (dataPath && fs.existsSync(dataPath))),
    });
  }
  return results;
}

module.exports = {
  findInstallation,
  findDataPath,
  detectAll,
  setCustomPath,
  getCustomPath,
  DEFAULT_PATHS,
  DATA_PATHS,
};
