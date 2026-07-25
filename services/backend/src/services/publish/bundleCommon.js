'use strict';

/**
 * bundleCommon.js — print-free shared deploy-bundle helpers (B1 split, 4th seam).
 *
 * Carved out of cli/handlers/publish.js: the low-level, presentation-free helpers
 * that every bundle builder (docker / pip / npm / origin-code) leans on —
 * JSON reading, recursive copy with skip filter, backend-root detection, ASCII
 * directory tree rendering, the INSTALL_LAYOUT.{md,json} writer, and the archive
 * (tar.gz / zip) packer. None of them print or depend on the CLI layer; they
 * rely only on fs/os/path/child_process plus two already-extracted service
 * helpers (`_readFileSafe`, `_toInt`). publish.js imports them back under their
 * original names so every existing call site is unchanged.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { _readFileSafe } = require('./projectState');
const { _toInt } = require('./publishUtils');

const DOCKER_BUNDLE_DEFAULT_OUT_DIR = path.join('dist', 'docker-bundles');
const DOCKER_BUNDLE_SKIP_NAMES = new Set([
  'node_modules', '.git', '.khy-runtime', '.cache',
  'coverage', 'dist', 'tests', '_build', '.github', '.githooks',
  'NUL', '.DS_Store',
]);

function _readJsonSafe(filePath, fallback = {}) {
  try {
    return JSON.parse(_readFileSafe(filePath) || '{}');
  } catch {
    return fallback;
  }
}

function _copyDirForBundle(srcDir, dstDir, skipNames = new Set()) {
  fs.cpSync(srcDir, dstDir, {
    recursive: true,
    force: true,
    filter: (src) => {
      const base = path.basename(src);
      if (skipNames.has(base)) return false;
      if (/^npm-debug\.log/i.test(base)) return false;
      if (/^yarn-error\.log/i.test(base)) return false;
      if (/\.py[co]$/i.test(base)) return false;
      return true;
    },
  });
}

function _isBackendRoot(dirPath) {
  if (!dirPath) return false;
  return fs.existsSync(path.join(dirPath, 'package.json'))
    && fs.existsSync(path.join(dirPath, 'server.js'))
    && fs.existsSync(path.join(dirPath, 'src'));
}

function _isSelfContainedBackend(dirPath) {
  if (!_isBackendRoot(dirPath)) return false;
  const pkg = _readJsonSafe(path.join(dirPath, 'package.json'));
  const dep = String(pkg?.dependencies?.['@khy/shared'] || '').trim();
  return dep === 'file:./vendor/shared'
    && fs.existsSync(path.join(dirPath, 'vendor', 'shared', 'package.json'));
}

function _sortDirEntries(entries = []) {
  return [...entries].sort((a, b) => {
    const ad = !!a?.isDirectory?.();
    const bd = !!b?.isDirectory?.();
    if (ad !== bd) return ad ? -1 : 1;
    return String(a?.name || '').localeCompare(String(b?.name || ''));
  });
}

function _buildAsciiTree(rootDir, options = {}) {
  const absRoot = path.resolve(rootDir);
  const rootLabel = String(options.rootLabel || path.basename(absRoot) || '.').replace(/\\/g, '/');
  const maxDepth = _toInt(options.maxDepth, 3, 1);
  const maxEntriesPerDir = _toInt(options.maxEntriesPerDir, 30, 1);
  const lines = [`${rootLabel}/`];

  function walk(dir, prefix, depth) {
    if (depth >= maxDepth) return;
    let entries = [];
    try {
      entries = _sortDirEntries(fs.readdirSync(dir, { withFileTypes: true }));
    } catch {
      return;
    }
    if (entries.length === 0) return;

    const shown = entries.slice(0, maxEntriesPerDir);
    for (let i = 0; i < shown.length; i++) {
      const entry = shown[i];
      const isLastShown = i === shown.length - 1;
      const noMoreHidden = shown.length === entries.length;
      const isLast = isLastShown && noMoreHidden;
      const name = `${entry.name}${entry.isDirectory() ? '/' : ''}`.replace(/\\/g, '/');
      lines.push(`${prefix}${isLast ? '\\-- ' : '|-- '}${name}`);
      if (entry.isDirectory()) {
        const nextPrefix = `${prefix}${isLast ? '    ' : '|   '}`;
        walk(path.join(dir, entry.name), nextPrefix, depth + 1);
      }
    }

    if (entries.length > shown.length) {
      const rest = entries.length - shown.length;
      lines.push(`${prefix}\\-- ... (${rest} more entries)`);
    }
  }

  walk(absRoot, '', 0);
  return lines.join('\n');
}

function _writeInstallLayoutArtifacts(bundleRoot, meta = {}) {
  const absBundleRoot = path.resolve(bundleRoot);
  const now = new Date().toISOString();
  const bundleType = String(meta.bundleType || 'docker').trim();
  const version = String(meta.version || '').trim() || '(unknown)';
  const sourceMappings = Array.isArray(meta.sourceMappings) ? meta.sourceMappings : [];
  const focusSubdir = String(meta.focusSubdir || '').trim();

  const rootTree = _buildAsciiTree(absBundleRoot, {
    rootLabel: path.basename(absBundleRoot),
    maxDepth: 3,
    maxEntriesPerDir: 24,
  });

  let focusTree = '';
  if (focusSubdir) {
    const focusDir = path.join(absBundleRoot, focusSubdir);
    if (fs.existsSync(focusDir)) {
      focusTree = _buildAsciiTree(focusDir, {
        rootLabel: focusSubdir.replace(/\\/g, '/'),
        maxDepth: 4,
        maxEntriesPerDir: 28,
      });
    }
  }

  const layoutJson = {
    generatedAt: now,
    bundleType,
    version,
    bundleRoot: absBundleRoot,
    focusSubdir: focusSubdir || null,
    sourceMappings: sourceMappings.map((item) => ({
      target: String(item?.target || '').replace(/\\/g, '/'),
      source: String(item?.source || ''),
      note: String(item?.note || ''),
    })),
    tree: {
      root: rootTree,
      focus: focusTree || null,
    },
  };
  fs.writeFileSync(
    path.join(absBundleRoot, 'INSTALL_LAYOUT.json'),
    `${JSON.stringify(layoutJson, null, 2)}\n`,
    'utf-8'
  );

  const mappingLines = sourceMappings.length > 0
    ? sourceMappings.map((item) => (
      `- \`${String(item?.target || '').replace(/\\/g, '/')}\` <= \`${String(item?.source || '')}\`${item?.note ? ` (${item.note})` : ''}`
    )).join('\n')
    : '- (no source mapping)';

  const focusBlock = focusTree
    ? `\n## Focus Tree\n\n\`\`\`text\n${focusTree}\n\`\`\`\n`
    : '';

  const md = `# Install Layout Map

Generated at: ${now}
Bundle type: ${bundleType}
Version: ${version}

## Source Mapping

${mappingLines}

## Bundle Tree

\`\`\`text
${rootTree}
\`\`\`${focusBlock}
`;
  fs.writeFileSync(path.join(absBundleRoot, 'INSTALL_LAYOUT.md'), md, 'utf-8');
}

function _buildDockerBundleArchive(bundleRoot, outDir, bundleName) {
  const absOutDir = path.resolve(outDir || path.join(process.cwd(), DOCKER_BUNDLE_DEFAULT_OUT_DIR));
  fs.mkdirSync(absOutDir, { recursive: true });

  if (process.platform === 'win32') {
    const zipPath = path.join(absOutDir, `${bundleName}.zip`);
    const ps = [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${bundleRoot}\\*' -DestinationPath '${zipPath}' -Force`,
    ];
    const result = spawnSync('powershell', ps, { encoding: 'utf-8' });
    if (result.status !== 0) {
      const errMsg = String(result.stderr || result.stdout || '').trim();
      throw new Error(`压缩 Docker 包失败(powershell): ${errMsg || `exit ${result.status}`}`);
    }
    return zipPath;
  }

  const tarPath = path.join(absOutDir, `${bundleName}.tar.gz`);
  const parent = path.dirname(bundleRoot);
  const base = path.basename(bundleRoot);
  const result = spawnSync('tar', ['-czf', tarPath, '-C', parent, base], {
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    const errMsg = String(result.stderr || result.stdout || '').trim();
    throw new Error(`压缩 Docker 包失败(tar): ${errMsg || `exit ${result.status}`}`);
  }
  return tarPath;
}

module.exports = {
  DOCKER_BUNDLE_DEFAULT_OUT_DIR,
  DOCKER_BUNDLE_SKIP_NAMES,
  _readJsonSafe,
  _copyDirForBundle,
  _isBackendRoot,
  _isSelfContainedBackend,
  _sortDirEntries,
  _buildAsciiTree,
  _writeInstallLayoutArtifacts,
  _buildDockerBundleArchive,
};
