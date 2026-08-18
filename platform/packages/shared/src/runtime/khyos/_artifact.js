'use strict';

/**
 * Shared pinned-artifact primitives for the khyos runtime provisioners.
 *
 * Extracted verbatim from isoProvisioner.js so the ISO, the QEMU builder
 * appliance, and the portable QEMU toolchain all share ONE download → verify →
 * atomically-cache path (sha256-pinned, cross-process locked, mirror-overridable)
 * instead of three copies. @khy/shared carries no axios dependency, so download
 * uses Node's built-in https with redirect handling.
 *
 * Contract: `ensurePinnedArtifact` THROWS on any failure (missing url/sha256,
 * HTTP error, checksum mismatch, lock contention) and never leaves a partial
 * file behind. Callers that want fail-soft behavior catch and degrade.
 */

const fsDefault = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// Backstop only: a lock with no readable owner (cross-host network cache, or a
// legacy lock from before owner-files existed) is considered abandoned past this
// age. Kept just above DEFAULT_DOWNLOAD_TIMEOUT_MS (15 min) so it never steals a
// genuinely in-flight slow download. The fast path is owner-pid liveness below.
const LOCK_STALE_MS = 20 * 60 * 1000;
// Name of the owner descriptor written inside each lock dir. Lets a later run
// detect a lock orphaned by a DEAD process (e.g. a build ^C'd before its
// `finally` released the lock) and reclaim it immediately, instead of blocking
// for up to LOCK_STALE_MS on a lock that no live process holds.
const LOCK_OWNER_FILE = 'owner.json';
const DEFAULT_DOWNLOAD_TIMEOUT_MS =
  parseInt(process.env.KHY_KHYOS_DOWNLOAD_TIMEOUT_MS || '', 10) || 15 * 60 * 1000;

/** Per-URL transient-failure retries (a flaky network blip shouldn't fail a build). */
const DEFAULT_DOWNLOAD_RETRIES =
  parseInt(process.env.KHY_KHYOS_DOWNLOAD_RETRIES || '', 10) || 3;
const DEFAULT_BACKOFF_BASE_MS =
  parseInt(process.env.KHY_KHYOS_DOWNLOAD_BACKOFF_MS || '', 10) || 600;
const DEFAULT_BACKOFF_CAP_MS = 8000;

function noop() {}

/** Exponential backoff (capped) for retry attempt N (1-based). */
function backoffMs(attempt, base = DEFAULT_BACKOFF_BASE_MS) {
  return Math.min(DEFAULT_BACKOFF_CAP_MS, base * Math.pow(2, Math.max(0, attempt - 1)));
}

const _defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Classify a download error: transient (retry the SAME url) vs terminal (give up on
 * this url, move to the next mirror). HTTP 4xx and checksum mismatches are terminal
 * for a url; timeouts, resets, DNS, and HTTP 5xx are transient.
 */
function isTransientDownloadError(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  if (/sha256 mismatch/.test(msg)) return false;
  if (/http 4\d\d/.test(msg)) return false;
  if (/too many redirects/.test(msg)) return false;
  if (/offline/.test(msg)) return false;
  // timeouts / connection resets / DNS / 5xx / generic socket errors → retry.
  return /timed out|timeout|econnreset|econnrefused|enotfound|eai_again|socket hang up|network|http 5\d\d|epipe|etimedout/.test(msg)
    || msg === ''; // unknown → optimistically retryable
}

/** Streaming SHA-256 of a file (artifacts are tens of MB; never load whole). */
function sha256File(filePath, fs = fsDefault) {
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
 * Resolve a manifest entry's download URL, honoring an optional mirror-base env
 * override (KHY_KHYOS_MIRROR_BASE rehosts every artifact under one base).
 *
 * @param {{url?: string, filename?: string}} entry manifest sub-entry
 * @returns {string|null}
 */
function resolveMirrorUrl(entry) {
  const url = entry && entry.url;
  if (!url) return null;
  const mirrorBase = String(process.env.KHY_KHYOS_MIRROR_BASE || '').trim();
  if (mirrorBase) {
    const file = (entry && entry.filename) || path.basename(url);
    return `${mirrorBase.replace(/\/+$/, '')}/${file}`;
  }
  return url;
}

/** GitHub-family asset hosts that ghproxy-style CN mirrors can rehost byte-for-byte. */
function _isGithubAsset(url) {
  let h;
  try { h = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return h === 'github.com'
    || h === 'codeload.github.com'
    || h === 'raw.githubusercontent.com'
    || h === 'objects.githubusercontent.com'
    || h.endsWith('.githubusercontent.com');
}

/**
 * Default CN ghproxy front prefixes. They rehost github.com assets verbatim, so the
 * shared sha256 pin still validates — a stale/dead mirror just fails the checksum
 * (or the connection) and the cascade fails over to the next candidate, with ZERO
 * corruption risk. The list is best-effort and fully overridable.
 */
const DEFAULT_CN_GH_MIRRORS = ['https://ghfast.top', 'https://gh-proxy.com', 'https://ghproxy.net'];

/**
 * The ordered ghproxy prefixes to use for CN fallbacks, honoring the env knobs:
 *   - KHY_KHYOS_NO_CN_MIRROR=1   → disable CN fallbacks entirely
 *   - KHY_KHYOS_CN_MIRRORS=a,b   → replace the default prefix list (comma-separated)
 */
function _cnGithubMirrorPrefixes(env = process.env) {
  if (String(env.KHY_KHYOS_NO_CN_MIRROR || '').trim() === '1') return [];
  const custom = String(env.KHY_KHYOS_CN_MIRRORS || '').trim();
  const list = custom ? custom.split(',') : DEFAULT_CN_GH_MIRRORS;
  return list.map((p) => String(p).trim().replace(/\/+$/, '')).filter(Boolean);
}

/**
 * Derive byte-identical, CN-reachable fallback URLs for a github-hosted asset by
 * prefixing it with each configured ghproxy front (`<prefix>/<originalUrl>`). These
 * serve the SAME bytes as the upstream, so the artifact's sha256 pin still applies.
 * Non-github URLs yield none — there is no generic CN rehost for arbitrary hosts
 * (nasm/sourceforge/frippery rely on a proxy or KHY_KHYOS_MIRROR_BASE instead).
 *
 * @param {string} url  the upstream (github) asset URL
 * @param {object} [env]
 * @returns {string[]}
 */
function resolveCnMirrors(url, env = process.env) {
  if (!url || !_isGithubAsset(url)) return [];
  return _cnGithubMirrorPrefixes(env).map((prefix) => `${prefix}/${url}`);
}

/**
 * Resolve the ORDERED list of byte-identical download candidates for an artifact,
 * so a single dead/blocked upstream no longer sinks the whole provision. Order:
 *   1. KHY_KHYOS_MIRROR_BASE rehost (operator's own mirror wins when set),
 *   2. the primary `url`,
 *   3. each `entry.mirrors[]` fallback, in declared order,
 *   4. CN ghproxy fallbacks derived from every github-hosted candidate (so a
 *      blocked github.com no longer sinks the build on a CN network).
 * (4) is appended LAST by default — try the direct upstream first, fall back to the
 * proxy mirror — but `KHY_KHYOS_PREFER_CN=1` front-loads it (after the operator
 * mirror) so a host that KNOWS github is blocked skips each tool's direct-connect
 * timeout. All candidates must serve the SAME bytes (the sha256 pin is shared) —
 * these are mirrors, not alternative builds. Duplicates are removed, order preserved.
 *
 * @param {{url?: string, filename?: string, mirrors?: string[]}} entry
 * @param {object} [env] env source for the mirror/proxy knobs (test seam)
 * @returns {string[]}
 */
function resolveArtifactUrls(entry, env = process.env) {
  const out = [];
  const primary = entry && entry.url;
  const declaredMirrors = (entry && Array.isArray(entry.mirrors))
    ? entry.mirrors.filter((m) => m && typeof m === 'string').map((m) => m.trim())
    : [];

  const mirrorBase = String(env.KHY_KHYOS_MIRROR_BASE || '').trim();
  if (mirrorBase && primary) {
    const file = (entry && entry.filename) || path.basename(primary);
    out.push(`${mirrorBase.replace(/\/+$/, '')}/${file}`);
  }

  // CN ghproxy fallbacks derived from every github-hosted candidate (primary + mirrors).
  const cn = [primary, ...declaredMirrors]
    .filter(Boolean)
    .flatMap((u) => resolveCnMirrors(u, env));
  const preferCn = String(env.KHY_KHYOS_PREFER_CN || '').trim() === '1';

  if (preferCn) out.push(...cn);
  if (primary) out.push(primary);
  out.push(...declaredMirrors);
  if (!preferCn) out.push(...cn);

  return [...new Set(out.filter(Boolean))];
}

const DOWNLOAD_UA = 'khy-khyos-provisioner';

/**
 * Resolve the proxy to use for `targetUrl`, honoring the conventional proxy env
 * vars (HTTPS_PROXY / HTTP_PROXY / ALL_PROXY, both cases) and NO_PROXY. Returns a
 * parsed `URL` or null when no proxy applies. Exported so tests can assert the
 * env matrix without touching the network. This is the fix that lets the native
 * toolchain download succeed on proxied networks (e.g. Clash on a CN host).
 */
function resolveProxy(targetUrl, env = process.env) {
  let target;
  try { target = new URL(targetUrl); } catch { return null; }
  const host = target.hostname.toLowerCase();

  const noProxy = String(env.NO_PROXY || env.no_proxy || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const rule of noProxy) {
    if (rule === '*') return null;
    const bare = rule.replace(/^\./, '');
    if (host === bare || host.endsWith('.' + bare)) return null;
  }

  const pick = (...names) => {
    for (const n of names) {
      const v = env[n];
      if (v && String(v).trim()) return String(v).trim();
    }
    return '';
  };
  const proxyStr = target.protocol === 'https:'
    ? pick('HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy')
    : pick('HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy');
  if (!proxyStr) return null;
  try {
    // Bare `host:port` (no scheme) is a common proxy form — default to http://.
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(proxyStr) ? proxyStr : `http://${proxyStr}`);
  } catch {
    return null;
  }
}

/** Proxy-Authorization header value from a proxy URL's userinfo, or null. */
function _proxyAuthHeader(proxy) {
  if (!proxy.username && !proxy.password) return null;
  const cred = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return 'Basic ' + Buffer.from(cred).toString('base64');
}

/**
 * Download a URL to destPath via Node http/https, following redirects, routing
 * through an env-configured proxy when present, and reporting byte progress.
 *
 * @param {string} url
 * @param {string} destPath
 * @param {object} [opts]
 * @param {object}   [opts.fs]
 * @param {number}   [opts.timeoutMs]
 * @param {object}   [opts.env]         env source for proxy resolution (test seam)
 * @param {(p: {downloaded:number,total:number,done?:boolean}) => void} [opts.onProgress]
 */
function httpsDownload(url, destPath, opts = {}) {
  const fs = opts.fs || fsDefault;
  const env = opts.env || process.env;
  const timeoutMs = opts.timeoutMs || DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  return new Promise((resolve, reject) => {
    const https = require('https');
    const http = require('http');
    const tls = require('tls');
    let redirects = 0;

    // Pipe a 200 response body to destPath, emitting progress and resolving on finish.
    const sink = (res, current) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (++redirects > 5) return reject(new Error('too many redirects'));
        return get(new URL(res.headers.location, current).toString());
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} fetching ${current}`));
      }
      const total = parseInt(res.headers['content-length'] || '', 10) || 0;
      let downloaded = 0;
      const ws = fs.createWriteStream(destPath);
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        try { ws.destroy(); } catch { /* ignore */ }
        reject(err);
      };
      res.on('error', fail);
      ws.on('error', fail);
      if (onProgress) {
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          try { onProgress({ downloaded, total }); } catch { /* progress must never break a download */ }
        });
      }
      ws.on('finish', () => {
        if (settled) return;
        settled = true;
        if (onProgress) { try { onProgress({ downloaded, total, done: true }); } catch { /* ignore */ } }
        resolve();
      });
      res.pipe(ws);
    };

    const wireReq = (req, current) => {
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('download timed out')));
      return req;
    };

    // Direct (no proxy): plain GET to the origin.
    const directGet = (current, target) => {
      const mod = target.protocol === 'http:' ? http : https;
      wireReq(
        mod.get(current, { headers: { 'User-Agent': DOWNLOAD_UA }, timeout: timeoutMs }, (res) => sink(res, current)),
        current,
      );
    };

    // HTTP origin via proxy: absolute-URI request line to the proxy.
    const proxyGetHttp = (current, target, proxy) => {
      const headers = { 'User-Agent': DOWNLOAD_UA, Host: target.host };
      const auth = _proxyAuthHeader(proxy);
      if (auth) headers['Proxy-Authorization'] = auth;
      wireReq(
        http.get(
          { host: proxy.hostname, port: proxy.port || 80, path: current, headers, timeout: timeoutMs },
          (res) => sink(res, current),
        ),
        current,
      );
    };

    // HTTPS origin via proxy: CONNECT tunnel, then TLS over the tunneled socket.
    const proxyGetHttps = (current, target, proxy) => {
      const port = target.port || 443;
      const headers = { Host: `${target.hostname}:${port}` };
      const auth = _proxyAuthHeader(proxy);
      if (auth) headers['Proxy-Authorization'] = auth;
      const connectReq = http.request({
        host: proxy.hostname, port: proxy.port || 80, method: 'CONNECT',
        path: `${target.hostname}:${port}`, headers, timeout: timeoutMs,
      });
      connectReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          try { socket.destroy(); } catch { /* ignore */ }
          return reject(new Error(`proxy CONNECT failed: HTTP ${res.statusCode}`));
        }
        const tlsSocket = tls.connect({ socket, servername: target.hostname }, () => {
          wireReq(
            https.get({
              host: target.hostname,
              path: target.pathname + target.search,
              headers: { 'User-Agent': DOWNLOAD_UA },
              agent: false,
              createConnection: () => tlsSocket,
              timeout: timeoutMs,
            }, (r) => sink(r, current)),
            current,
          );
        });
        tlsSocket.on('error', reject);
      });
      connectReq.on('error', reject);
      connectReq.on('timeout', () => connectReq.destroy(new Error('proxy connect timed out')));
      connectReq.end();
    };

    function get(current) {
      let target;
      try { target = new URL(current); } catch (e) { return reject(e); }
      const proxy = resolveProxy(current, env);
      if (!proxy) return directGet(current, target);
      if (target.protocol === 'http:') return proxyGetHttp(current, target, proxy);
      return proxyGetHttps(current, target, proxy);
    }

    get(url);
  });
}

/** Is `pid` a live process on this host? ESRCH → dead; EPERM → alive but not ours. */
function _pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !!(err && err.code === 'EPERM');
  }
}

/** Stamp the lock dir with this process's identity (best-effort). */
function _writeLockOwner(lockDir, fs = fsDefault) {
  try {
    fs.writeFileSync(
      path.join(lockDir, LOCK_OWNER_FILE),
      JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() }),
    );
  } catch {
    /* best-effort: a missing owner file just falls back to mtime staleness */
  }
}

/** Read the lock's owner descriptor, or null if absent/unreadable. */
function _readLockOwner(lockDir, fs = fsDefault) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, LOCK_OWNER_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * A held lock is reclaimable when either:
 *   1. its owner process on THIS host is gone (the ^C / crash orphan case) — the
 *      common, fast path; reclaimed immediately rather than after 20 minutes; or
 *   2. it is older than LOCK_STALE_MS regardless of owner — the backstop for
 *      cross-host network caches and legacy locks with no owner descriptor.
 * A lock whose owner pid is still alive is NEVER stolen (a genuine in-flight
 * download), unless it also blows past the age backstop.
 */
function _lockIsStale(lockDir, fs = fsDefault) {
  const owner = _readLockOwner(lockDir, fs);
  if (owner && owner.host === os.hostname() && Number.isInteger(owner.pid) && owner.pid > 0) {
    if (!_pidAlive(owner.pid)) return true; // orphaned by a dead owner
  }
  try {
    const st = fs.statSync(lockDir);
    return Date.now() - st.mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function acquireLock(lockDir, fs = fsDefault) {
  try {
    fs.mkdirSync(lockDir);
    _writeLockOwner(lockDir, fs);
    return true;
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      if (_lockIsStale(lockDir, fs)) {
        try {
          fs.rmSync(lockDir, { recursive: true, force: true });
          fs.mkdirSync(lockDir);
          _writeLockOwner(lockDir, fs);
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
    return false;
  }
}

function releaseLock(lockDir, fs = fsDefault) {
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Ensure a sha256-pinned artifact is present in `cacheDir` and return its
 * absolute path. Downloads + verifies + atomically renames into place on a
 * cache miss; serializes concurrent downloads with a cross-process dir lock.
 *
 * THROWS on any failure — the caller decides whether to fail-soft.
 *
 * Resilience: accepts either a single `url` or an ordered `urls` mirror list, and
 * retries each candidate on transient failures (timeout/reset/5xx) with capped
 * exponential backoff before failing over to the next mirror. A checksum mismatch
 * or HTTP 4xx is terminal for a url and skips straight to the next mirror. Only
 * when every candidate is exhausted does it throw.
 *
 * @param {object} args
 * @param {string} args.cacheDir          destination cache directory
 * @param {string} args.filename          cached file name
 * @param {string} [args.url]             single resolved download URL
 * @param {string[]} [args.urls]          ordered mirror list (preferred over `url`)
 * @param {string} args.sha256            expected lowercase/uppercase hex digest
 * @param {(url: string, dest: string, opts?: object) => Promise<void>} [args.downloader] test seam
 * @param {object} [args.fs=require('fs')]
 * @param {number} [args.timeoutMs]
 * @param {number} [args.maxRetries]      per-url attempts (default DEFAULT_DOWNLOAD_RETRIES)
 * @param {number} [args.backoffBaseMs]   backoff base (default DEFAULT_BACKOFF_BASE_MS)
 * @param {(ms:number)=>Promise<void>} [args.sleep] backoff sleep seam (tests inject a no-op)
 * @param {object} [args.env]          env source for proxy resolution
 * @param {(p: {downloaded:number,total:number,done?:boolean}) => void} [args.onProgress]
 * @param {(msg: string) => void} [args.log]
 * @returns {Promise<string>} absolute path to the verified cached file
 */
async function ensurePinnedArtifact(args) {
  const {
    cacheDir,
    filename,
    url,
    urls,
    sha256,
    downloader,
    fs = fsDefault,
    timeoutMs,
    maxRetries,
    backoffBaseMs,
    sleep = _defaultSleep,
    env,
    onProgress,
    log = noop,
  } = args || {};

  if (!cacheDir || !filename) throw new Error('ensurePinnedArtifact: cacheDir and filename are required');
  const candidates = (Array.isArray(urls) && urls.length ? urls : [url]).filter(Boolean);
  if (!candidates.length || !sha256) throw new Error('ensurePinnedArtifact: url(s) and sha256 are required (artifact not pinned)');

  const cached = path.join(cacheDir, filename);
  if (fs.existsSync(cached)) {
    log(`using cached artifact: ${cached}`);
    return cached;
  }

  // Offline switch: a cache miss must NOT hit the network. Throw so callers that
  // fail-soft (builder/qemu provisioners, the ISO obtain rung) degrade to the
  // next cascade step instead of attempting a download.
  if (process.env.KHY_KHYOS_OFFLINE === '1') {
    throw new Error(`offline (KHY_KHYOS_OFFLINE=1): refusing to download ${filename}`);
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  const lockDir = path.join(cacheDir, `.${filename}.lock`);
  if (!acquireLock(lockDir, fs)) {
    throw new Error(`another download of ${filename} is already in progress`);
  }

  const tmpPath = path.join(cacheDir, `.${filename}.${process.pid}.partial`);
  const attempts = Math.max(1, maxRetries || DEFAULT_DOWNLOAD_RETRIES);
  const cleanupTmp = () => { try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ } };
  try {
    // Double-check after the lock — another process may have just finished.
    if (fs.existsSync(cached)) return cached;

    let lastErr = null;
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const isLastMirror = i === candidates.length - 1;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        cleanupTmp(); // never verify a stale partial from a prior attempt
        try {
          log(`downloading ${candidate}` + (attempt > 1 ? ` (重试 ${attempt}/${attempts})` : ''));
          await (downloader || httpsDownload)(candidate, tmpPath, { fs, timeoutMs, env, onProgress });

          const actual = sha256File(tmpPath, fs);
          if (actual.toLowerCase() !== String(sha256).toLowerCase()) {
            throw new Error(`SHA256 mismatch for ${filename} (expected ${sha256}, got ${actual})`);
          }
          log('sha256 verified');
          fs.renameSync(tmpPath, cached);
          return cached;
        } catch (err) {
          lastErr = err;
          const transient = isTransientDownloadError(err);
          if (transient && attempt < attempts) {
            const wait = backoffMs(attempt, backoffBaseMs);
            log(`${filename}: ${err && err.message ? err.message : err} — ${wait}ms 后重试`);
            await sleep(wait);
            continue; // retry same url
          }
          // terminal for this url (4xx / checksum / retries exhausted) → next mirror
          if (!isLastMirror) {
            log(`${filename}: ${candidate} 不可用，切换下一镜像`);
          }
          break;
        }
      }
    }
    throw lastErr || new Error(`failed to download ${filename}`);
  } finally {
    cleanupTmp();
    releaseLock(lockDir, fs);
  }
}

module.exports = {
  sha256File,
  resolveMirrorUrl,
  resolveArtifactUrls,
  resolveCnMirrors,
  resolveProxy,
  httpsDownload,
  acquireLock,
  releaseLock,
  _pidAlive,
  _lockIsStale,
  _writeLockOwner,
  _readLockOwner,
  ensurePinnedArtifact,
  isTransientDownloadError,
  backoffMs,
  LOCK_STALE_MS,
  LOCK_OWNER_FILE,
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_DOWNLOAD_RETRIES,
};
