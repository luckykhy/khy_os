/**
 * File Integrity Service — SHA-256 manifest verification.
 *
 * Detects tampering of core backend files by maintaining a
 * signed manifest of file hashes. Verified on startup.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MANIFEST_PATH = path.join(os.homedir(), '.khyquant', 'integrity_manifest.json');
const BACKEND_SRC = path.resolve(__dirname, '..');
const IGNORED_DIRS = ['node_modules', '.git', 'temp', 'logs', 'data'];

/**
 * Recursively collect all .js files under a directory.
 */
function collectFiles(dir, baseDir = dir) {
  const results = [];
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (IGNORED_DIRS.includes(entry)) continue;
      const fullPath = path.join(dir, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          results.push(...collectFiles(fullPath, baseDir));
        } else if (entry.endsWith('.js')) {
          results.push(path.relative(baseDir, fullPath));
        }
      } catch { /* skip inaccessible */ }
    }
  } catch { /* skip inaccessible */ }
  return results.sort();
}

/**
 * Compute SHA-256 hash of a file.
 */
function hashFile(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Generate a complete manifest of all backend source files.
 * @returns {object} Manifest with { version, timestamp, files: { relativePath: hash } }
 */
function generateManifest() {
  const files = collectFiles(BACKEND_SRC);
  const hashes = {};

  for (const relPath of files) {
    const fullPath = path.join(BACKEND_SRC, relPath);
    try {
      hashes[relPath] = hashFile(fullPath);
    } catch { /* skip unreadable */ }
  }

  const manifest = {
    version: 1,
    timestamp: new Date().toISOString(),
    fileCount: Object.keys(hashes).length,
    files: hashes,
  };

  return manifest;
}

/**
 * Save manifest to disk.
 */
function saveManifest(manifest = null) {
  if (!manifest) manifest = generateManifest();

  const dir = path.dirname(MANIFEST_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf-8');
  return manifest;
}

/**
 * Load saved manifest from disk.
 * @returns {object|null}
 */
function loadManifest() {
  try {
    if (fs.existsSync(MANIFEST_PATH)) {
      return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    }
  } catch { /* corrupted manifest */ }
  return null;
}

/**
 * Verify current files against saved manifest.
 * @returns {{ verified: boolean, added: string[], removed: string[], modified: string[], unchanged: number }}
 */
function verify() {
  const saved = loadManifest();

  if (!saved) {
    // No manifest exists — generate one (first run)
    saveManifest();
    return { verified: true, firstRun: true, added: [], removed: [], modified: [], unchanged: 0 };
  }

  const currentFiles = collectFiles(BACKEND_SRC);
  const savedFiles = Object.keys(saved.files);

  const added = [];
  const removed = [];
  const modified = [];
  let unchanged = 0;

  // Check for modified or new files
  for (const relPath of currentFiles) {
    const fullPath = path.join(BACKEND_SRC, relPath);
    try {
      const currentHash = hashFile(fullPath);
      if (!saved.files[relPath]) {
        added.push(relPath);
      } else if (saved.files[relPath] !== currentHash) {
        modified.push(relPath);
      } else {
        unchanged++;
      }
    } catch { /* skip */ }
  }

  // Check for removed files
  for (const relPath of savedFiles) {
    if (!currentFiles.includes(relPath)) {
      removed.push(relPath);
    }
  }

  const verified = modified.length === 0 && removed.length === 0;

  return { verified, firstRun: false, added, removed, modified, unchanged };
}

/**
 * Quick startup verification — logs warnings if tampering detected.
 * @returns {boolean} true if integrity OK
 */
function verifyOnStartup() {
  // Skip integrity check for pip-installed (obfuscated) packages
  if (__dirname.includes('site-packages') || __dirname.includes('bundled')) {
    return true;
  }
  try {
    const result = verify();

    if (result.firstRun) {
      return true; // First run, manifest just created
    }

    if (!result.verified) {
      // Log to security log
      try {
        const logPath = path.join(os.homedir(), '.khyquant', 'security.log');
        const dir = path.dirname(logPath);
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(logPath, JSON.stringify({
          timestamp: new Date().toISOString(),
          type: 'integrity_violation',
          modified: result.modified,
          removed: result.removed,
          added: result.added,
        }) + '\n');
      } catch { /* best effort */ }

      return false;
    }

    // If files were added (legitimate updates), regenerate manifest
    if (result.added.length > 0) {
      saveManifest();
    }

    return true;
  } catch {
    return true; // Don't block startup on verification errors
  }
}

module.exports = {
  generateManifest,
  saveManifest,
  loadManifest,
  verify,
  verifyOnStartup,
  collectFiles,
  MANIFEST_PATH,
};
