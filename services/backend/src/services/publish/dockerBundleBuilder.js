'use strict';

/**
 * dockerBundleBuilder.js — the Docker deploy-bundle builder (B1 split, 4th seam).
 *
 * Builds a self-contained, deployable Docker bundle from a runtime backend
 * payload: resolve the backend source, copy it, vendor the @khy/shared
 * dependency, render the Dockerfile/compose/env/README + INSTALL_LAYOUT, then
 * archive it. This is service logic (it produces a deployable artifact, no UI),
 * so it lives in the services layer. The only CLI-ish coupling — three progress
 * prints — is solved by LOGGER INJECTION: callers pass `options.logger`
 * (`{ info, success, warn, error }`); absent that a no-op logger is used. This
 * lets the remote-deploy subsystem build a bundle WITHOUT reaching up into the
 * cli/handlers layer (clearing the remote→cli R1 layering violation), while
 * publish.js imports the builder back and injects its own `print*` formatters
 * so the CLI experience is byte-for-byte unchanged.
 *
 * __dirname note: `_resolveDockerBackendSource` resolves the runtime backend via
 * `path.resolve(__dirname, '../../..')`. This module sits at
 * `src/services/publish/` — exactly three levels under `services/backend`, the
 * SAME depth as the original `src/cli/handlers/`, so the resolution is identical.
 * Do NOT relocate this file to a different depth without revisiting that anchor.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DOCKER_BUNDLE_SKIP_NAMES,
  _readJsonSafe,
  _copyDirForBundle,
  _isBackendRoot,
  _isSelfContainedBackend,
  _writeInstallLayoutArtifacts,
  _buildDockerBundleArchive,
} = require('./bundleCommon');
const {
  _writeDockerBundleDockerfile,
  _writeDockerBundleCompose,
  _writeDockerBundleEnvExample,
  _writeDockerBundleReadme,
  _timestampForFileName,
} = require('./bundleArtifacts');

const NOOP_LOGGER = {
  info() {},
  success() {},
  warn() {},
  error() {},
};

function _normalizeLogger(logger) {
  if (!logger || typeof logger !== 'object') return NOOP_LOGGER;
  return {
    info: typeof logger.info === 'function' ? logger.info : NOOP_LOGGER.info,
    success: typeof logger.success === 'function' ? logger.success : NOOP_LOGGER.success,
    warn: typeof logger.warn === 'function' ? logger.warn : NOOP_LOGGER.warn,
    error: typeof logger.error === 'function' ? logger.error : NOOP_LOGGER.error,
  };
}

function _resolveDockerBackendSource(projectRoot) {
  const runtimeBackendRoot = path.resolve(__dirname, '../../..');
  const candidates = [];

  if (projectRoot) {
    candidates.push(path.join(projectRoot, 'khy_os', 'bundled', 'backend'));
  }
  candidates.push(runtimeBackendRoot);
  candidates.push(path.resolve(runtimeBackendRoot, '..', '..', 'khy_os', 'bundled', 'backend'));

  const seen = new Set();
  const uniq = candidates
    .map(p => path.resolve(p))
    .filter((p) => {
      if (seen.has(p)) return false;
      seen.add(p);
      return true;
    });

  // Prefer already self-contained backend (vendor/shared dependency)
  for (const candidate of uniq) {
    if (_isSelfContainedBackend(candidate)) return candidate;
  }
  // Fallback: any backend root we can patch to self-contained
  for (const candidate of uniq) {
    if (_isBackendRoot(candidate)) return candidate;
  }
  return '';
}

function _copyBackendForDockerBundle(srcBackendDir, dstBackendDir) {
  _copyDirForBundle(srcBackendDir, dstBackendDir, DOCKER_BUNDLE_SKIP_NAMES);
}

function _ensureSharedDependencyForBundle(backendDir, srcBackendDir) {
  const pkgPath = path.join(backendDir, 'package.json');
  const pkg = _readJsonSafe(pkgPath);
  if (!pkg || typeof pkg !== 'object') {
    throw new Error('无法解析 backend/package.json');
  }

  const dep = String(pkg?.dependencies?.['@khy/shared'] || '').trim();
  const vendorSharedDir = path.join(backendDir, 'vendor', 'shared');
  const vendorSharedExists = fs.existsSync(path.join(vendorSharedDir, 'package.json'));
  const depNeedsLocalVendor = !dep
    || dep.startsWith('file:')
    || dep.startsWith('workspace:')
    || dep.startsWith('./')
    || dep.startsWith('../');
  let patchedDependency = false;
  let touchedVendor = false;

  if (!vendorSharedExists) {
    if (depNeedsLocalVendor) {
      const sharedSrcCandidates = [
        path.resolve(srcBackendDir, '..', 'packages', 'shared'),
        path.resolve(srcBackendDir, '..', '..', 'packages', 'shared'),
        path.resolve(srcBackendDir, '..', 'vendor', 'shared'),
      ];
      let copied = false;
      for (const src of sharedSrcCandidates) {
        if (!fs.existsSync(path.join(src, 'package.json'))) continue;
        fs.mkdirSync(path.join(backendDir, 'vendor'), { recursive: true });
        fs.cpSync(src, vendorSharedDir, { recursive: true, force: true });
        copied = true;
        touchedVendor = true;
        break;
      }
      if (!copied) {
        throw new Error('缺少 @khy/shared 依赖目录，无法生成可部署 Docker 包');
      }
    } else {
      // Keep third-party/registry dependency as-is (common in npm installs),
      // but ensure vendor directory exists so Dockerfile COPY vendor does not fail.
      fs.mkdirSync(path.join(backendDir, 'vendor'), { recursive: true });
    }
  }

  if (depNeedsLocalVendor && dep !== 'file:./vendor/shared') {
    if (!pkg.dependencies || typeof pkg.dependencies !== 'object') pkg.dependencies = {};
    pkg.dependencies['@khy/shared'] = 'file:./vendor/shared';
    fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8');
    patchedDependency = true;
  }

  if (patchedDependency || touchedVendor) {
    const lockPath = path.join(backendDir, 'package-lock.json');
    if (fs.existsSync(lockPath)) {
      try { fs.rmSync(lockPath, { force: true }); } catch { /* ignore */ }
    }
  }
}

/**
 * Build a deployable Docker bundle and return its archive descriptor.
 * @param {string} projectRoot  Optional project root used to locate a bundled backend.
 * @param {object} state        Version-state ({ versions: { backend, pyproject } }).
 * @param {object} options      { name?, out?/output?/out-dir?/output-dir?, logger? }.
 * @returns {{archivePath:string, bundleName:string, sourceBackend:string, version:string}}
 */
function buildDockerBundle(projectRoot, state, options = {}) {
  const logger = _normalizeLogger(options.logger);
  const srcBackend = _resolveDockerBackendSource(projectRoot);
  if (!srcBackend) {
    throw new Error('未找到可打包的 backend 目录（需要包含 package.json + server.js + src）');
  }

  const runtimePkg = _readJsonSafe(path.join(srcBackend, 'package.json'));
  const version = String(runtimePkg.version || state?.versions?.backend || state?.versions?.pyproject || '0.0.0').trim();
  const safeVersion = String(version || '0.0.0').replace(/[^0-9A-Za-z._-]/g, '-');
  const bundleName = String(options.name || `khy-os-docker-${safeVersion}-${_timestampForFileName()}`).replace(/[^0-9A-Za-z._-]/g, '-');

  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-docker-bundle-'));
  const bundleRoot = path.join(stagingRoot, bundleName);
  const backendDst = path.join(bundleRoot, 'backend');
  fs.mkdirSync(bundleRoot, { recursive: true });

  logger.info(`打包 Docker 资源: 复制 backend (${srcBackend})`);
  _copyBackendForDockerBundle(srcBackend, backendDst);
  _ensureSharedDependencyForBundle(backendDst, srcBackend);
  _writeDockerBundleDockerfile(backendDst);
  _writeDockerBundleCompose(bundleRoot);
  _writeDockerBundleEnvExample(bundleRoot);
  _writeDockerBundleReadme(bundleRoot, {
    sourceBackend: srcBackend,
    version,
    serviceName: 'khy-backend',
  });
  _writeInstallLayoutArtifacts(bundleRoot, {
    bundleType: 'docker-bundle',
    version,
    focusSubdir: 'backend',
    sourceMappings: [
      { target: 'backend/', source: srcBackend, note: 'copied runtime backend payload' },
      { target: 'docker-compose.yml', source: '(generated)', note: 'Docker deploy entry' },
      { target: '.env.example', source: '(generated)', note: 'runtime env template' },
      { target: 'README.md', source: '(generated)', note: 'deploy guide' },
    ],
  });

  const archivePath = _buildDockerBundleArchive(
    bundleRoot,
    options.out || options.output || options['out-dir'] || options['output-dir'],
    bundleName
  );

  logger.success(`Docker 部署包已生成: ${archivePath}`);
  logger.info('接收方部署: 解压后运行 `docker compose up -d --build`');
  return {
    archivePath,
    bundleName,
    sourceBackend: srcBackend,
    version,
  };
}

module.exports = {
  buildDockerBundle,
  _resolveDockerBackendSource,
  _copyBackendForDockerBundle,
  _ensureSharedDependencyForBundle,
};
