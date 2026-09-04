'use strict';

const fs = require('fs');
const path = require('path');
const { requestStream } = require('../../../../utils/nativeHttp');
const { getBaseDataDir } = require('../../../../utils/dataHome');
const { loadManifest, defaultManifestPath } = require('./manifestLoader');
const { extractArchive, locatePayloadRoot, copyPayload, applyChmod } = require('./archiveInstaller');
const { createStore } = require('./resourceStore');

function detectPlatformKey() {
  const arch = { x64: 'x64', arm64: 'arm64' }[process.arch] || process.arch;
  const platform = { win32: 'win32', darwin: 'darwin', linux: 'linux' }[process.platform] || process.platform;
  return `${platform}-${arch}`;
}

async function defaultDownloader(url, dest, options = {}) {
  const { validateUrl, isBlockedHostnameOrIp } = require('../../../ssrfGuard');
  await validateUrl(url, options.ssrfPolicy || {});
  const { status, stream, headers } = await requestStream(url, {
    timeoutMs: options.timeoutMs || 15 * 60 * 1000,
    maxRedirects: 5,
    signal: options.signal,
    beforeRedirect(redirectUrl) {
      if (isBlockedHostnameOrIp(redirectUrl.hostname)) throw new Error(`blocked redirect host: ${redirectUrl.hostname}`);
    },
    headers: { 'User-Agent': 'khy-resource-manager' },
  });
  if (status < 200 || status >= 300) { stream.resume(); throw new Error(`resource download HTTP ${status}`); }
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(dest);
    let bytes = 0;
    let settled = false;
    const fail = err => {
      if (settled) return;
      settled = true;
      try { output.destroy(); } catch { /* best effort */ }
      reject(err);
    };
    stream.on('data', chunk => { bytes += chunk.length; if (options.onProgress) options.onProgress(bytes, Number(headers['content-length']) || null); });
    stream.on('error', fail); output.on('error', fail);
    output.on('finish', () => { if (!settled) { settled = true; resolve({ bytes }); } });
    stream.pipe(output);
  });
}

function mirrorSources(sources) {
  const mirror = String(process.env.KHY_RESOURCE_MIRROR_BASE || '').trim();
  if (!mirror) return sources;
  return sources.map(source => `${mirror.replace(/\/+$/, '')}/${path.basename(new URL(source).pathname)}`);
}

function hashMatches(file, expected, store) { return store.sha256File(file) === expected; }

function createResourceManager(options = {}) {
  const root = path.resolve(options.root || process.env.KHY_RESOURCE_HOME || getBaseDataDir('resources'));
  const store = options.store || createStore({ root });
  const manifestPath = options.manifestPath || defaultManifestPath();
  const manifest = options.manifest || loadManifest(manifestPath);
  const platform = options.platform || detectPlatformKey();
  const inflight = new Map();

  function entry(id) {
    const item = manifest.resources.find(resource => resource.id === id);
    if (!item) throw new Error(`unknown resource: ${id}`);
    return item;
  }
  function variant(item) {
    const value = item.platforms[platform];
    if (!value) return null;
    return value;
  }
  function resolve(id) {
    const item = entry(id); const active = store.readActive(item.kind, item.id); const value = variant(item);
    if (!active || !value) return { id: item.id, kind: item.kind, version: item.version, status: value ? 'missing' : 'unsupported-platform', path: active && active.path || null, platform };
    const target = store.installPath(item.kind, item.id, active.version, platform);
    if (active.path && path.resolve(active.path) === path.resolve(target) && fs.existsSync(target)) return { id: item.id, kind: item.kind, version: active.version, status: 'present', path: target, platform };
    return { id: item.id, kind: item.kind, version: item.version, status: 'missing', path: null, platform };
  }
  function inspect(id) {
    if (id) return resolve(id);
    return manifest.resources.map(item => ({ ...resolve(item.id), policy: item.policy, description: item.description }));
  }
  async function ensure(id, ensureOptions = {}) {
    if (inflight.has(id)) return inflight.get(id);
    const promise = ensureImpl(id, ensureOptions).finally(() => inflight.delete(id));
    inflight.set(id, promise); return promise;
  }
  async function ensureImpl(id, ensureOptions) {
    const item = entry(id); const value = variant(item);
    const existing = resolve(id); if (existing.status === 'present' && existing.version === item.version) return existing;
    if (!value) return { id, kind: item.kind, version: item.version, status: 'unsupported-platform', platform };
    const lock = store.acquireLock(`${item.kind}-${id}-${platform}`);
    if (!lock) return { id, kind: item.kind, version: item.version, status: 'busy', platform };
    const stamp = `${process.pid}-${Date.now()}`; const stage = path.join(store.dirs.staging, `${id}-${stamp}`);
    const archive = path.join(stage, 'payload'); const blob = store.blobPath(value.sha256);
    try {
      const afterLock = resolve(id); if (afterLock.status === 'present' && afterLock.version === item.version) return afterLock;
      fs.mkdirSync(stage, { recursive: true });
      if (!fs.existsSync(blob)) {
        fs.mkdirSync(path.dirname(blob), { recursive: true });
        const sources = mirrorSources(value.sources); let lastError;
        for (const source of sources) {
          try {
            fs.rmSync(archive, { force: true });
            if (ensureOptions.onSource) ensureOptions.onSource(source);
            await (ensureOptions.downloader || defaultDownloader)(source, archive, ensureOptions);
            ensureOptions._resolvedSource = source;
            lastError = null;
            break;
          } catch (err) { lastError = err; }
        }
        if (lastError) throw lastError;
        if (!hashMatches(archive, value.sha256, store)) throw new Error(`SHA256 mismatch (expected ${value.sha256})`);
        const blobTemp = `${blob}.tmp-${process.pid}-${Date.now()}`;
        fs.renameSync(archive, blobTemp);
        try { fs.renameSync(blobTemp, blob); }
        catch (err) {
          if (err.code === 'EEXIST') fs.rmSync(blobTemp, { force: true });
          else throw err;
        }
      }
      if (!hashMatches(blob, value.sha256, store)) throw new Error(`stored blob hash mismatch for ${id}`);
      const extracted = path.join(stage, 'extracted');
      if (value.format === 'file') {
        fs.mkdirSync(extracted, { recursive: true });
        fs.copyFileSync(blob, path.join(extracted, value.sentinel || 'payload'));
      } else {
        extractArchive(blob, extracted, value.format);
      }
      const payload = value.sentinel ? locatePayloadRoot(extracted, value.sentinel, value.sourceSubdir) : extracted;
      if (!payload) throw new Error(`payload sentinel '${value.sentinel}' not found`);
      const target = store.installPath(item.kind, item.id, item.version, platform);
      const installStage = `${target}.staging-${process.pid}-${Date.now()}`;
      fs.mkdirSync(path.dirname(target), { recursive: true }); copyPayload(payload, installStage); applyChmod(installStage, value.chmod);
      if (!fs.existsSync(path.join(installStage, value.sentinel || 'payload'))) throw new Error('installed sentinel missing');
      try { fs.renameSync(installStage, target); } catch (err) { if (err.code === 'EEXIST') { fs.rmSync(installStage, { recursive: true, force: true }); } else throw err; }
      const record = { id, kind: item.kind, version: item.version, platform, sha256: value.sha256, path: target, blob, source: ensureOptions._resolvedSource || value.sources[0], installedAt: new Date().toISOString() };
      store.writeInstallRecord(record);
      store.activate(record);
      try {
        require('../../maintenance/uninstall/ledgerWriter').appendSideEffect({
          kind: 'runtime',
          target: store.root,
          action: 'remove-runtime',
          meta: { label: 'resource-store', platform },
        });
      } catch { /* resource install succeeds even when ledger recording does not */ }
      return { ...record, status: 'provisioned' };
    } catch (err) {
      return { id, kind: item.kind, version: item.version, status: 'failed', platform, error: err.message || String(err) };
    } finally { try { fs.rmSync(stage, { recursive: true, force: true }); } catch {} store.releaseLock(lock); }
  }
  function verify(id) {
    const item = entry(id); const active = store.readActive(item.kind, id); if (!active) return { id, status: 'missing' };
    const ok = fs.existsSync(active.path) && fs.existsSync(active.blob) && hashMatches(active.blob, active.sha256, store);
    return { ...active, status: ok ? 'verified' : 'corrupt' };
  }
  function activate(id, version) {
    const item = entry(id);
    const record = store.readInstallRecord(item.kind, id, version, platform);
    if (!record || !fs.existsSync(record.path)) return { id, status: 'missing', error: `version not installed: ${version}` };
    store.activate(record); return { ...record, status: 'activated' };
  }
  function rollback(id, version) {
    const result = activate(id, version);
    return result.status === 'activated' ? { ...result, status: 'rolled-back' } : result;
  }
  function gc(gcOptions = {}) {
    const referenced = new Set();
    const stack = [store.dirs.installs];
    while (stack.length) {
      const dir = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const item of entries) {
        const file = path.join(dir, item.name);
        if (item.isDirectory()) stack.push(file);
        else if (item.isFile() && item.name === 'install.json') {
          try {
            const record = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (record.blob) referenced.add(path.resolve(record.blob));
          } catch { /* corrupt install records do not protect blobs */ }
        }
      }
    }
    const candidates = [];
    const minAgeMs = Number.isFinite(gcOptions.minAgeMs) ? Math.max(0, gcOptions.minAgeMs) : 24 * 60 * 60 * 1000;
    const now = Date.now();
    if (fs.existsSync(store.dirs.blobs)) {
      for (const prefix of fs.readdirSync(store.dirs.blobs)) {
        const dir = path.join(store.dirs.blobs, prefix);
        let stat;
        try { stat = fs.statSync(dir); } catch { continue; }
        if (!stat.isDirectory()) continue;
        for (const name of fs.readdirSync(dir)) {
          const file = path.join(dir, name);
          if (referenced.has(path.resolve(file))) continue;
          let fileStat;
          try { fileStat = fs.statSync(file); } catch { continue; }
          if (fileStat.isFile() && now - fileStat.mtimeMs >= minAgeMs) candidates.push(file);
        }
      }
    }
    if (gcOptions.apply === true) for (const file of candidates) fs.rmSync(file, { force: true });
    return { status: gcOptions.apply === true ? 'cleaned' : 'preview', root: store.root, candidates, count: candidates.length };
  }
  return { manifest, platform, store, list: () => inspect(), inspect, resolve, ensure, prefetch: ensure, activate, verify, rollback, gc, path: id => resolve(id).path };
}

module.exports = { createResourceManager, detectPlatformKey, defaultDownloader };
