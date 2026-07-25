'use strict';

/**
 * Runtime Provisioner — on-demand fetch of the local inference runtimes
 * (ollama-runner, llama.cpp) that are intentionally NOT committed to git and
 * NOT shipped in the pip wheel (see config/runtime-binaries.json, setup.py
 * EXCLUDE_PATTERNS, and MANIFEST.in prune).
 *
 * ensureRuntime(name) flow:
 *   1. Fast-path: if the runtime's sentinel file already exists, return
 *      immediately with zero network I/O. This is the common case on dev
 *      machines (binaries kept locally after `git rm --cached`) and after any
 *      prior fetch.
 *   2. Resolve the platform key and the pinned archive (url + sha256) from the
 *      JSON manifest. An unsupported platform, or an entry with no pinned
 *      sha256, returns a non-error status so the caller keeps using its
 *      existing system-binary resolution. Provisioning never replaces the
 *      caller's own fallback logic — it only fills the bundled path when it can.
 *   3. Under a cross-process lock, download the archive (axios; honors
 *      HTTPS_PROXY/HTTP_PROXY via proxy-from-env, and the KHY_RUNTIME_MIRROR_BASE
 *      override), verify SHA256, extract to a staging dir on the same
 *      filesystem, relocate the payload to the runtime's original path, and
 *      chmod the executables.
 *
 * Control flow and return shape mirror ollamaModelManager.ensureOllamaRunning():
 * it returns a structured { name, status, ... } object and NEVER throws for
 * operational problems. Only a corrupt download (SHA256 mismatch) or a broken
 * archive refuses to land files — reported as { status: 'failed' } so the caller
 * still falls back to the system runtime.
 *
 * Zero hardcode: every URL/hash lives in the JSON manifest; the mirror base and
 * proxy come from environment variables. Test seams: KHY_RUNTIME_ROOT overrides
 * the backend root, KHY_RUNTIME_MANIFEST overrides the manifest path, and an
 * injected `downloader` replaces the network fetch.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// Backend root resolves correctly in both the source tree
// (services/backend/src/services -> services/backend) and the bundled wheel
// layout (bundled/services/backend/src/services -> bundled/services/backend).
const BACKEND_ROOT = process.env.KHY_RUNTIME_ROOT
  ? path.resolve(process.env.KHY_RUNTIME_ROOT)
  : path.resolve(__dirname, '..', '..');

const MANIFEST_PATH = process.env.KHY_RUNTIME_MANIFEST
  ? path.resolve(process.env.KHY_RUNTIME_MANIFEST)
  : path.join(BACKEND_ROOT, 'config', 'runtime-binaries.json');

const DOWNLOAD_TIMEOUT_MS =
  parseInt(process.env.KHY_RUNTIME_DOWNLOAD_TIMEOUT_MS || '', 10) || 15 * 60 * 1000;
const EXTRACT_TIMEOUT_MS = 5 * 60 * 1000;
const LOCK_STALE_MS = 20 * 60 * 1000;

// In-process dedupe: concurrent ensureRuntime(name) calls share one promise.
const _inflight = new Map();

function log(msg) {
  if (process.env.KHY_RUNTIME_PROVISION_DEBUG === '1' || process.env.KHY_DEBUG === '1') {
    try {
      console.error(`[runtime-provisioner] ${msg}`);
    } catch {
      /* ignore logging failures */
    }
  }
}

function loadManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
}

/**
 * Platform key in the form `<platform>-<arch>`, e.g. linux-x64, darwin-arm64,
 * win32-x64. Matches the keys under each runtime's `platforms` map.
 */
function detectPlatformKey() {
  const archMap = { x64: 'x64', arm64: 'arm64' };
  const platMap = { win32: 'win32', darwin: 'darwin', linux: 'linux' };
  const arch = archMap[process.arch] || process.arch;
  const plat = platMap[process.platform] || process.platform;
  return `${plat}-${arch}`;
}

/** Streaming SHA-256 of a file (archives are tens of MB; avoid loading whole). */
function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let bytes;
    while ((bytes = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * Default downloader: streams a URL to a file with axios. axios' node adapter
 * reads HTTPS_PROXY/HTTP_PROXY/NO_PROXY from the environment automatically
 * (via proxy-from-env) as long as `proxy` is left unset, so restricted-network
 * users only need the standard proxy env vars.
 */
async function defaultDownloader(url, destPath) {
  const axios = require('axios');
  const response = await axios({
    method: 'get',
    url,
    responseType: 'stream',
    timeout: DOWNLOAD_TIMEOUT_MS,
    maxRedirects: 5,
    headers: { 'User-Agent': 'khy-runtime-provisioner' },
  });
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(destPath);
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { ws.destroy(); } catch { /* ignore */ }
      reject(err);
    };
    response.data.on('error', fail);
    ws.on('error', fail);
    ws.on('finish', () => {
      if (!settled) { settled = true; resolve(); }
    });
    response.data.pipe(ws);
  });
}

/** Extract an archive into destDir using the platform's system tools. */
function extractArchive(archivePath, destDir, format) {
  const { searchExecutable } = require('../tools/platformUtils');
  fs.mkdirSync(destDir, { recursive: true });

  let command;
  let args;
  if (format === 'tar.gz' || format === 'tgz') {
    command = searchExecutable('tar');
    if (!command) throw new Error('tar not found — cannot extract .tar.gz runtime archive');
    args = ['-xzf', archivePath, '-C', destDir];
  } else if (format === 'tar') {
    command = searchExecutable('tar');
    if (!command) throw new Error('tar not found — cannot extract .tar runtime archive');
    args = ['-xf', archivePath, '-C', destDir];
  } else if (format === 'zip') {
    if (process.platform === 'win32') {
      command = searchExecutable('powershell') || searchExecutable('pwsh') || 'powershell';
      args = [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force`,
      ];
    } else {
      command = searchExecutable('unzip');
      if (command) {
        args = ['-q', '-o', archivePath, '-d', destDir];
      } else {
        command = searchExecutable('7z') || searchExecutable('7za');
        if (!command) throw new Error('no unzip/7z found — cannot extract .zip runtime archive');
        args = ['x', `-o${destDir}`, '-y', archivePath];
      }
    }
  } else {
    throw new Error(`unsupported archive format: ${format}`);
  }

  const result = spawnSync(command, args, {
    timeout: EXTRACT_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'utf-8',
  });
  if (result.error) throw new Error(`extraction failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`extraction failed (exit ${result.status}): ${(result.stderr || '').slice(0, 400)}`);
  }
}

/**
 * Locate the directory inside the staging tree that holds the payload, i.e. the
 * dir D for which `D/<sentinel>` exists. Tries the manifest `sourceSubdir` hint
 * first, then the staging root, then a bounded breadth-first search — so the
 * provisioner is robust to upstream archive-layout changes.
 */
function locatePayloadRoot(stagingDir, sentinel, hint) {
  const direct = [];
  if (hint && hint !== '.') direct.push(path.join(stagingDir, hint));
  direct.push(stagingDir);
  for (const dir of direct) {
    if (fs.existsSync(path.join(dir, sentinel))) return dir;
  }

  const queue = [{ dir: stagingDir, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (fs.existsSync(path.join(dir, sentinel))) return dir;
    if (depth >= 5) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  return null;
}

/** Move every top-level entry of payloadRoot into targetDir (overwriting). */
function movePayload(payloadRoot, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(payloadRoot)) {
    const src = path.join(payloadRoot, entry);
    const dst = path.join(targetDir, entry);
    try {
      fs.rmSync(dst, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      // rename preserves symlink chains (llama.cpp ships libggml.so -> .so.0 -> ...).
      fs.renameSync(src, dst);
    } catch (err) {
      if (err && err.code === 'EXDEV') {
        fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
      } else {
        throw err;
      }
    }
  }
}

/** chmod +x the executables a runtime actually invokes (POSIX only). */
function applyChmod(targetDir, chmodList) {
  if (process.platform === 'win32') return;
  for (const rel of chmodList || []) {
    const file = path.join(targetDir, rel);
    try {
      if (fs.existsSync(file)) fs.chmodSync(file, 0o755);
    } catch (err) {
      log(`chmod failed for ${file}: ${err.message}`);
    }
  }
}

function acquireLock(lockDir) {
  try {
    fs.mkdirSync(lockDir);
    return true;
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      try {
        const st = fs.statSync(lockDir);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          fs.mkdirSync(lockDir);
          return true;
        }
      } catch {
        /* ignore */
      }
      return false;
    }
    return false;
  }
}

function releaseLock(lockDir) {
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function resolveDownloadUrl(manifest, plat) {
  const envKey = manifest.mirrorBaseEnv || 'KHY_RUNTIME_MIRROR_BASE';
  const mirrorBase = String(process.env[envKey] || '').trim();
  if (mirrorBase) {
    const file = plat.filename || path.basename(plat.url || '');
    return `${mirrorBase.replace(/\/+$/, '')}/${file}`;
  }
  return plat.url;
}

/**
 * 把「已下载安装的便携运行时目录」记进安装台账,供 `khy uninstall` 逆序删除。
 * 便携 Node/ollama 落在包 manifest 之外,pip uninstall/npm rm 删不到 → 台账兜底。
 * fail-soft、绝不抛、门控 KHY_INSTALL_LEDGER 关时自动 no-op(逐字节回退)。
 */
function _recordRuntimeLedger(name, targetDir) {
  try {
    require('./uninstall/ledgerWriter').appendSideEffect({
      kind: 'runtime',
      target: targetDir,
      action: 'remove-runtime',
      meta: { label: name },
    });
  } catch { /* 记台账绝不拖累装运行时主流程 */ }
}

async function _ensureRuntimeImpl(name, opts) {
  let manifest;
  try {
    manifest = loadManifest();
  } catch (err) {
    return { name, status: 'failed', error: `manifest load failed: ${err.message}` };
  }

  const runtime = manifest.runtimes && manifest.runtimes[name];
  if (!runtime) return { name, status: 'failed', error: `unknown runtime: ${name}` };

  const targetDir = path.join(BACKEND_ROOT, runtime.targetDir);

  // Platform resolution happens before the fast-path because the sentinel file
  // (the proof that the runtime is already on disk) can differ per platform: the
  // POSIX archives ship bin/ollama, the Windows zip ships ollama.exe at the
  // archive root. The effective sentinel is plat.sentinel || runtime.sentinel.
  const platKey = detectPlatformKey();
  const plat = runtime.platforms && runtime.platforms[platKey];
  const sentinelRel = (plat && plat.sentinel) || runtime.sentinel;
  const sentinelPath = path.join(targetDir, sentinelRel);

  // 1. Fast-path — already present, no network.
  if (fs.existsSync(sentinelPath)) {
    return { name, status: 'present', path: targetDir };
  }

  // 2. Platform resolution.
  if (!plat) {
    log(`${name}: no manifest entry for ${platKey}; deferring to system fallback`);
    return { name, status: 'unsupported-platform', platform: platKey, path: targetDir };
  }
  if (!plat.url || !plat.sha256) {
    log(`${name}: ${platKey} not pinned (missing url/sha256); deferring to system fallback`);
    return { name, status: 'no-source', platform: platKey, path: targetDir };
  }

  const downloadUrl = resolveDownloadUrl(manifest, plat);

  // 3. Lock → download → verify → extract → relocate.
  const tmpRoot = path.join(BACKEND_ROOT, 'bin', '.provision');
  try {
    fs.mkdirSync(tmpRoot, { recursive: true });
  } catch (err) {
    return { name, status: 'failed', error: `cannot create temp dir: ${err.message}`, path: targetDir };
  }

  const lockDir = path.join(tmpRoot, `${name}.lock`);
  if (!acquireLock(lockDir)) {
    return { name, status: 'failed', error: 'another provision is already in progress', path: targetDir };
  }

  let staging = null;
  let archivePath = null;
  try {
    // Double-check after acquiring the lock (another process may have finished).
    if (fs.existsSync(sentinelPath)) {
      return { name, status: 'present', path: targetDir };
    }

    const stamp = `${process.pid}-${Date.now()}`;
    const ext = plat.format === 'zip' ? 'zip' : plat.format === 'tar' ? 'tar' : 'tar.gz';
    archivePath = path.join(tmpRoot, `${name}-${stamp}.${ext}`);
    staging = path.join(tmpRoot, `${name}-stage-${stamp}`);
    fs.mkdirSync(staging, { recursive: true });

    const downloader = opts.downloader || defaultDownloader;
    log(`${name}: downloading ${downloadUrl}`);
    await downloader(downloadUrl, archivePath);

    const actual = sha256File(archivePath);
    if (actual.toLowerCase() !== String(plat.sha256).toLowerCase()) {
      return {
        name,
        status: 'failed',
        error: `SHA256 mismatch (expected ${plat.sha256}, got ${actual})`,
        path: targetDir,
      };
    }
    log(`${name}: sha256 verified`);

    extractArchive(archivePath, staging, plat.format);

    const payloadRoot = locatePayloadRoot(staging, sentinelRel, plat.sourceSubdir);
    if (!payloadRoot) {
      return {
        name,
        status: 'failed',
        error: `payload sentinel '${sentinelRel}' not found in archive`,
        path: targetDir,
      };
    }

    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    movePayload(payloadRoot, targetDir);
    applyChmod(targetDir, plat.chmod);

    if (!fs.existsSync(sentinelPath)) {
      return {
        name,
        status: 'failed',
        error: `sentinel missing after extraction: ${sentinelPath}`,
        path: targetDir,
      };
    }

    log(`${name}: provisioned at ${targetDir}`);
    _recordRuntimeLedger(name, targetDir);
    return { name, status: 'provisioned', path: targetDir, source: downloadUrl };
  } catch (err) {
    return { name, status: 'failed', error: err.message || String(err), path: targetDir };
  } finally {
    if (staging) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    if (archivePath) {
      try { fs.rmSync(archivePath, { force: true }); } catch { /* ignore */ }
    }
    releaseLock(lockDir);
  }
}

/**
 * Ensure a runtime's binaries are present at their original path, fetching them
 * on demand if needed. Never throws; returns { name, status, path, error? } with
 * status in: present | provisioned | unsupported-platform | no-source | failed.
 *
 * @param {string} name - runtime key in the manifest (e.g. 'ollama-runner', 'llama-cpp')
 * @param {object} [opts]
 * @param {(url: string, dest: string) => Promise<void>} [opts.downloader] - test seam
 * @returns {Promise<object>}
 */
function ensureRuntime(name, opts = {}) {
  if (_inflight.has(name)) return _inflight.get(name);
  const promise = _ensureRuntimeImpl(name, opts).finally(() => _inflight.delete(name));
  _inflight.set(name, promise);
  return promise;
}

/**
 * Report (without downloading) the present/missing state and pinned source of
 * every runtime for the current platform. Used by `khy runtime status` and the
 * doctor diagnostic.
 */
function inspect() {
  let manifest;
  try {
    manifest = loadManifest();
  } catch (err) {
    return { error: err.message, platform: detectPlatformKey(), runtimes: [] };
  }
  const platKey = detectPlatformKey();
  const envKey = manifest.mirrorBaseEnv || 'KHY_RUNTIME_MIRROR_BASE';
  const mirrorBase = String(process.env[envKey] || '').trim();

  const runtimes = Object.entries(manifest.runtimes || {}).map(([name, rt]) => {
    const targetDir = path.join(BACKEND_ROOT, rt.targetDir);
    const plat = rt.platforms && rt.platforms[platKey];
    const sentinelRel = (plat && plat.sentinel) || rt.sentinel;
    return {
      name,
      description: rt.description || '',
      present: fs.existsSync(path.join(targetDir, sentinelRel)),
      targetDir,
      sentinel: sentinelRel,
      version: rt.version || '',
      platform: platKey,
      supported: !!plat,
      pinned: !!(plat && plat.url && plat.sha256),
      source: plat ? resolveDownloadUrl(manifest, plat) : '',
    };
  });

  return { platform: platKey, mirrorBase: mirrorBase || null, mirrorBaseEnv: envKey, runtimes };
}

module.exports = {
  ensureRuntime,
  inspect,
  detectPlatformKey,
  MANIFEST_PATH,
};
