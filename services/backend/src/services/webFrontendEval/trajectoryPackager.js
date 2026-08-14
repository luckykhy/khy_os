'use strict';

/**
 * trajectoryPackager — validates, manifests, and zips trajectory annotation packages.
 *
 * Package directory layout (user-specified):
 *   <task_id>/
 *   ├── manifest.json              ← auto-generated
 *   ├── task/
 *   │   ├── prompt.md
 *   │   └── assets/
 *   ├── trajectory/
 *   │   └── <timestamp>_api_call.json
 *   ├── screenshots/
 *   ├── workspace/
 *   │   ├── src/
 *   │   └── dist/
 *   ├── env/
 *   │   ├── <lockfile>
 *   │   ├── env_snapshot.json
 *   │   └── build.md
 *   └── qc/
 *       ├── self_check.md
 *       └── qc_report.json
 */
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Required subdirectory names (relative to package root) */
const REQUIRED_DIRS = ['task', 'trajectory', 'screenshots', 'workspace', 'env', 'qc'];

/**
 * Validate that the package directory has all required subdirectories.
 * @param {string} pkgDir
 * @returns {{ valid: boolean, missing: string[] }}
 */
function validateStructure(pkgDir) {
  const missing = [];
  for (const dir of REQUIRED_DIRS) {
    if (!fs.existsSync(path.join(pkgDir, dir))) {
      missing.push(dir + '/');
    }
  }
  return { valid: missing.length === 0, missing };
}

/**
 * Generate the manifest.json content for a trajectory package.
 * @param {string} pkgDir
 * @param {object} task
 * @param {object} run
 * @returns {object}
 */
function generateManifest(pkgDir, task, run) {
  const taskDir = path.join(pkgDir, 'task');
  const trajDir = path.join(pkgDir, 'trajectory');
  const envDir = path.join(pkgDir, 'env');
  const qcDir = path.join(pkgDir, 'qc');
  const wsDir = path.join(pkgDir, 'workspace');

  // Count API call files
  let apiCallCount = 0;
  try {
    const files = fs.readdirSync(trajDir);
    apiCallCount = files.filter((f) => f.endsWith('_api_call.json')).length;
  } catch {
    /* ignore */
  }

  // List assets
  let assets = [];
  try {
    const assetsDir = path.join(taskDir, 'assets');
    assets = fs.readdirSync(assetsDir).map((f) => ({
      name: f,
      path: `task/assets/${f}`,
      size: fs.statSync(path.join(assetsDir, f)).size,
      sha256: _sha256File(path.join(assetsDir, f)),
    }));
  } catch {
    /* ignore */
  }

  // List screenshots
  let screenshots = [];
  try {
    const ssDir = path.join(pkgDir, 'screenshots');
    screenshots = fs
      .readdirSync(ssDir)
      .filter((f) => /\.(png|jpg|jpeg|webp|gif)$/i.test(f))
      .map((f) => ({
        name: f,
        path: `screenshots/${f}`,
        size: fs.statSync(path.join(ssDir, f)).size,
      }));
  } catch {
    /* ignore */
  }

  // List workspace files
  let workspaceSrc = [];
  let workspaceDist = [];
  try {
    const srcDir = path.join(wsDir, 'src');
    workspaceSrc = _listFilesRecursive(srcDir, 'workspace/src/');
    const distDir = path.join(wsDir, 'dist');
    workspaceDist = _listFilesRecursive(distDir, 'workspace/dist/');
  } catch {
    /* ignore */
  }

  // Read lockfile
  let lockfile = null;
  try {
    const envFiles = fs.readdirSync(envDir);
    const lockFile = envFiles.find(
      (f) =>
        /lock/.test(f) ||
        /^package-lock/.test(f) ||
        /^pnpm-lock/.test(f) ||
        /^yarn.lock/.test(f) ||
        /^Pipfile\.lock/.test(f)
    );
    if (lockFile) {
      lockfile = {
        name: lockFile,
        path: `env/${lockFile}`,
        size: fs.statSync(path.join(envDir, lockFile)).size,
      };
    }
  } catch {
    /* ignore */
  }

  const manifest = {
    v: 1,
    kind: 'web-frontend-traj-package',
    task_id: task?.id || run?.task_id,
    task_name: task?.name || '',
    level: task?.level || 'L1',
    category: task?.category || '2d',
    created_by: task?.created_by || 0,
    run_id: run?.id,
    annotator_id: run?.annotator_id || 0,
    ai_model: run?.ai_model || '',
    createdAt: new Date().toISOString(),
    producer: 'khyos',
    package: {
      apiCallCount,
      assets: assets.length,
      screenshots: screenshots.length,
      workspaceSrcFiles: workspaceSrc.length,
      workspaceDistFiles: workspaceDist.length,
      hasLockfile: !!lockfile,
      hasEnvSnapshot: fs.existsSync(path.join(envDir, 'env_snapshot.json')),
      hasBuildMd: fs.existsSync(path.join(envDir, 'build.md')),
      hasSelfCheck: fs.existsSync(path.join(qcDir, 'self_check.md')),
      hasQcReport: fs.existsSync(path.join(qcDir, 'qc_report.json')),
    },
    files: {
      assets,
      screenshots,
      workspaceSrc: workspaceSrc,
      workspaceDist: workspaceDist,
      lockfile,
      envSnapshot: fs.existsSync(path.join(envDir, 'env_snapshot.json'))
        ? 'env/env_snapshot.json'
        : null,
      buildMd: fs.existsSync(path.join(envDir, 'build.md')) ? 'env/build.md' : null,
    },
    summary: {
      totalFiles:
        assets.length +
        screenshots.length +
        workspaceSrc.length +
        workspaceDist.length +
        apiCallCount +
        4,
    },
  };

  return manifest;
}

/**
 * Write manifest.json to the package directory.
 */
function writeManifest(pkgDir, manifest) {
  fs.writeFileSync(path.join(pkgDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  return manifest;
}

/**
 * Zip the package directory. Returns the zip file path.
 * @param {string} pkgDir
 * @param {string} [outDir]
 * @returns {string}
 */
function zipPackage(pkgDir, outDir) {
  const absPkgDir = path.resolve(pkgDir);
  const baseName = path.basename(absPkgDir);
  const absOutDir = path.resolve(outDir || path.join(process.cwd(), 'dist', 'trajectory-packages'));
  fs.mkdirSync(absOutDir, { recursive: true });
  const zipPath = path.join(absOutDir, `${baseName}.zip`);

  if (process.platform === 'win32') {
    const ps = [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${absPkgDir}\\*' -DestinationPath '${zipPath}' -Force`,
    ];
    const result = spawnSync('powershell', ps, { encoding: 'utf-8' });
    if (result.status !== 0) {
      const errMsg = String(result.stderr || result.stdout || '').trim();
      throw new Error(`Zip failed (powershell): ${errMsg || `exit ${result.status}`}`);
    }
    return zipPath;
  }

  const tarPath = path.join(absOutDir, `${baseName}.tar.gz`);
  const parent = path.dirname(absPkgDir);
  const name = path.basename(absPkgDir);
  const result = spawnSync('tar', ['-czf', tarPath, '-C', parent, name], { encoding: 'utf-8' });
  if (result.status !== 0) {
    const errMsg = String(result.stderr || result.stdout || '').trim();
    throw new Error(`Tar failed: ${errMsg || `exit ${result.status}`}`);
  }
  return tarPath;
}

// ── Helpers ──────────────────────────────────────────────────────

function _sha256File(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

function _listFilesRecursive(dir, prefix) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = path.join(prefix, entry.name);
      if (entry.isDirectory()) {
        results.push(..._listFilesRecursive(path.join(dir, entry.name), rel + '/'));
      } else {
        results.push({
          name: entry.name,
          path: rel.replace(/\\/g, '/'),
          size: fs.statSync(path.join(dir, entry.name)).size,
        });
      }
    }
  } catch {
    /* ignore */
  }
  return results;
}

module.exports = { validateStructure, generateManifest, writeManifest, zipPackage };
