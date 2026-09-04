'use strict';

/**
 * Unified first-use provisioner for release payloads excluded from install packages.
 * GitHub Release download -> SHA-256 verify -> same-directory atomic rename -> ledger.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PAYLOAD } = require('../constants/serviceDefaults');

const PAYLOAD_SPECS = Object.freeze({
  'source-snapshot': Object.freeze({
    label: '源码快照',
    required: Object.freeze(['snapshot.json', 'khy-os-source.tar.gz.enc']),
  }),
  'markdown-vendor': Object.freeze({
    label: 'Markdown WYSIWYG 资源',
    required: Object.freeze(['MANIFEST.json', 'khyos-muya.js', 'khyos-muya.css']),
  }),
});

const _inflight = new Map();
const CACHED_MANIFEST = 'khy-payload-manifest.json';

function _installedVersion() {
  try {
    return String(require('./versionService').getCurrentVersion() || '').trim();
  } catch {
    return '';
  }
}

function _tagFor(version, cfg = PAYLOAD) {
  return String(cfg.TAG_PATTERN || 'v<version>').replace('<version>', version);
}

function _releaseAssetUrl(version, asset, cfg = PAYLOAD) {
  const tag = encodeURIComponent(_tagFor(version, cfg));
  return `${String(cfg.RELEASE_DOWNLOAD_BASE_URL).replace(/\/+$/, '')}/${tag}/${encodeURIComponent(asset)}`;
}

function _cacheRoot(cfg = PAYLOAD) {
  if (cfg.CACHE_ROOT) return path.resolve(cfg.CACHE_ROOT);
  const { getDataHome } = require('../utils/dataHome');
  return path.join(getDataHome(), 'payloads');
}

function payloadDir(id, version, cfg = PAYLOAD) {
  return path.join(_cacheRoot(cfg), version, id);
}

function _hasRequiredFiles(dir, spec) {
  try {
    return spec.required.every(name => fs.statSync(path.join(dir, name)).isFile());
  } catch {
    return false;
  }
}

function _sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(file);
    input.on('data', chunk => hash.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function _validateManifest(raw, id, version) {
  if (!raw || typeof raw !== 'object' || String(raw.version || '') !== version) {
    throw new Error('payload manifest version mismatch');
  }
  const payload = raw.payloads && raw.payloads[id];
  if (!payload || !Array.isArray(payload.files) || payload.files.length === 0) {
    throw new Error(`payload manifest missing ${id}`);
  }
  const files = payload.files.map(item => {
    const asset = String(item && item.asset || '').trim();
    const rel = String(item && item.path || '').replace(/\\/g, '/').trim();
    const sha256 = String(item && item.sha256 || '').toLowerCase().trim();
    if (!asset || !rel || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error(`invalid payload manifest entry for ${id}`);
    }
    if (path.posix.isAbsolute(rel) || rel.split('/').some(part => !part || part === '..')) {
      throw new Error(`unsafe payload path: ${rel}`);
    }
    return { asset, path: rel, sha256, size: Number(item.size) || 0 };
  });
  const required = PAYLOAD_SPECS[id].required;
  if (!required.every(name => files.some(file => file.path === name))) {
    throw new Error(`payload manifest incomplete for ${id}`);
  }
  return files;
}

async function _download(url, dest, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const idleMs = Math.max(1, Number(options.idleTimeoutMs) || PAYLOAD.DOWNLOAD_IDLE_TIMEOUT_MS);
  const controller = new AbortController();
  let timer = null;
  const armIdle = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error('download idle timeout')), idleMs);
    if (timer.unref) timer.unref();
  };
  let output;
  let received = 0;
  try {
    armIdle();
    const response = await fetchImpl(url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const total = Number(response.headers && response.headers.get('content-length')) || 0;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    output = fs.createWriteStream(dest, { flags: 'wx' });
    for await (const raw of response.body) {
      const chunk = Buffer.from(raw);
      if (!output.write(chunk)) await new Promise(resolve => output.once('drain', resolve));
      received += chunk.length;
      armIdle();
      if (typeof options.onProgress === 'function') options.onProgress(received, total);
    }
    await new Promise((resolve, reject) => {
      output.once('error', reject);
      output.end(resolve);
    });
    output = null;
    return { received, total };
  } catch (error) {
    if (output) output.destroy();
    try { fs.rmSync(dest, { force: true }); } catch {}
    if (controller.signal.aborted) throw new Error('download idle timeout');
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function _downloadJson(url, options) {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'khy-payload-manifest-'));
  const tmp = path.join(tmpDir, 'manifest.json');
  try {
    await _download(url, tmp, options);
    return JSON.parse(fs.readFileSync(tmp, 'utf8'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function _recordFile(file, checksum, id, recordFile) {
  const entry = {
    kind: 'file',
    target: file,
    action: 'unlink',
    checksum,
    meta: { scope: 'payload', package: id, reason: 'first-use-provision' },
  };
  try {
    if (typeof recordFile === 'function') recordFile(entry);
    else require('./domain/maintenance/uninstall/ledgerWriter').appendSideEffect(entry);
  } catch {}
}

async function _verifiedCachedFiles(targetDir, id, version, options = {}) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(targetDir, CACHED_MANIFEST), 'utf8'));
    const files = _validateManifest(raw, id, version);
    for (const file of files) {
      const finalPath = path.resolve(targetDir, ...file.path.split('/'));
      let valid = false;
      try {
        valid = fs.statSync(finalPath).isFile() && await _sha256File(finalPath) === file.sha256;
      } catch {}
      if (valid) continue;

      const manualAsset = path.join(targetDir, file.asset);
      if (manualAsset === finalPath || !fs.existsSync(manualAsset)) return false;
      if (await _sha256File(manualAsset) !== file.sha256) return false;
      fs.mkdirSync(path.dirname(finalPath), { recursive: true });
      fs.renameSync(manualAsset, finalPath);
      _recordFile(finalPath, file.sha256, id, options.recordFile);
    }
    return true;
  } catch {
    return false;
  }
}

async function _provision(id, options = {}) {
  const spec = PAYLOAD_SPECS[id];
  const version = String(options.version || _installedVersion()).trim();
  const cfg = options.config || PAYLOAD;
  const targetDir = path.resolve(options.targetDir || payloadDir(id, version, cfg));
  const manualUrl = _releaseAssetUrl(version, cfg.MANIFEST_ASSET, cfg);
  if (!spec) return { ok: false, reason: 'unknown-payload', id, version, targetDir, manualUrl };
  if (!version) return { ok: false, reason: 'unknown-version', id, version, targetDir, manualUrl };
  if (_hasRequiredFiles(targetDir, spec) && await _verifiedCachedFiles(targetDir, id, version, options)) {
    return { ok: true, reused: true, id, version, targetDir, manualUrl };
  }
  if (await _verifiedCachedFiles(targetDir, id, version, options)) {
    const cachedManifest = path.join(targetDir, CACHED_MANIFEST);
    _recordFile(cachedManifest, await _sha256File(cachedManifest), id, options.recordFile);
    return { ok: true, reused: true, adopted: true, id, version, targetDir, manualUrl };
  }

  const downloadOptions = {
    fetchImpl: options.fetchImpl,
    idleTimeoutMs: cfg.DOWNLOAD_IDLE_TIMEOUT_MS,
  };
  try {
    const manifest = await _downloadJson(manualUrl, downloadOptions);
    const files = _validateManifest(manifest, id, version);
    fs.mkdirSync(targetDir, { recursive: true });
    const retries = Math.max(0, Number(cfg.RETRY_COUNT) || 0);
    for (const file of files) {
      const finalPath = path.resolve(targetDir, ...file.path.split('/'));
      const within = path.relative(targetDir, finalPath);
      if (within.startsWith('..') || path.isAbsolute(within)) throw new Error('payload path escaped target');
      if (fs.existsSync(finalPath) && await _sha256File(finalPath) === file.sha256) continue;
      fs.mkdirSync(path.dirname(finalPath), { recursive: true });
      let lastError;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        const tmp = `${finalPath}.part-${process.pid}-${Date.now()}`;
        try {
          await _download(_releaseAssetUrl(version, file.asset, cfg), tmp, {
            ...downloadOptions,
            onProgress: (received, total) => {
              if (typeof options.onProgress === 'function') {
                options.onProgress({ id, label: spec.label, asset: file.asset, received, total });
              }
            },
          });
          const actual = await _sha256File(tmp);
          if (actual !== file.sha256) throw new Error(`sha256 mismatch for ${file.asset}`);
          fs.renameSync(tmp, finalPath);
          _recordFile(finalPath, actual, id, options.recordFile);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          try { fs.rmSync(tmp, { force: true }); } catch {}
        }
      }
      if (lastError) throw lastError;
    }
    if (!_hasRequiredFiles(targetDir, spec)) throw new Error(`payload incomplete after download: ${id}`);
    const cachedManifest = path.join(targetDir, CACHED_MANIFEST);
    const cachedManifestTmp = `${cachedManifest}.part-${process.pid}-${Date.now()}`;
    const cachedManifestBody = `${JSON.stringify(manifest, null, 2)}\n`;
    fs.writeFileSync(cachedManifestTmp, cachedManifestBody, { flag: 'wx' });
    fs.rmSync(cachedManifest, { force: true });
    fs.renameSync(cachedManifestTmp, cachedManifest);
    _recordFile(cachedManifest, crypto.createHash('sha256').update(cachedManifestBody).digest('hex'), id, options.recordFile);
    return { ok: true, reused: false, id, version, targetDir, manualUrl };
  } catch (error) {
    return {
      ok: false,
      reason: error && error.message ? error.message : 'provision-failed',
      id,
      version,
      targetDir,
      manualUrl,
    };
  }
}

function ensurePayload(id, options = {}) {
  const version = String(options.version || _installedVersion()).trim();
  const target = options.targetDir ? path.resolve(options.targetDir) : '';
  const key = `${id}@${version}@${target}`;
  if (_inflight.has(key)) return _inflight.get(key);
  const promise = _provision(id, { ...options, version }).finally(() => _inflight.delete(key));
  _inflight.set(key, promise);
  return promise;
}

module.exports = {
  PAYLOAD_SPECS,
  ensurePayload,
  payloadDir,
  _download,
  _releaseAssetUrl,
  _validateManifest,
  _inflight,
};
