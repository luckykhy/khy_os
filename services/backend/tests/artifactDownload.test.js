'use strict';

/**
 * Unit tests for the shared pinned-artifact download primitive's proxy support
 * and byte-progress reporting:
 *
 *   @khy/shared/runtime/khyos/_artifact.{resolveProxy, httpsDownload}
 *
 * These are the two additions that let the native bare-Windows toolchain download
 * succeed on a proxied CN network (e.g. Clash) and surface progress to the user.
 *
 * `resolveProxy` is tested as a pure function over an injected env matrix (no
 * network). `httpsDownload` is exercised against loopback HTTP servers only — a
 * direct origin (progress assertions) and an HTTP forward proxy (absolute-URI
 * request line). The CONNECT-tunnel HTTPS-via-proxy path needs real TLS and is
 * covered by the env-matrix + manual end-to-end, not here.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveProxy,
  resolveArtifactUrls,
  resolveCnMirrors,
  httpsDownload,
  ensurePinnedArtifact,
  isTransientDownloadError,
  acquireLock,
  _pidAlive,
  _readLockOwner,
  LOCK_OWNER_FILE,
} = require('@khy/shared/runtime/khyos/_artifact');
const crypto = require('crypto');

// A pid guaranteed to be out of range on every supported platform (Linux
// pid_max defaults to 4194304; macOS/BSD are similar) → process.kill(pid, 0)
// reports ESRCH, so _pidAlive treats it as dead. Used to simulate an orphaned
// lock left by a process that has exited.
const DEAD_PID = 2147483646;

describe('resolveProxy', () => {
  test('returns null when no proxy env is set', () => {
    assert.equal(resolveProxy('http://example.invalid/x', {}), null);
    assert.equal(resolveProxy('https://example.invalid/x', {}), null);
  });

  test('https origin honors HTTPS_PROXY', () => {
    const p = resolveProxy('https://example.invalid/x', { HTTPS_PROXY: 'http://127.0.0.1:7890' });
    assert.ok(p);
    assert.equal(p.hostname, '127.0.0.1');
    assert.equal(p.port, '7890');
  });

  test('http origin honors HTTP_PROXY but NOT HTTPS_PROXY', () => {
    const env = { HTTP_PROXY: 'http://10.0.0.1:1080', HTTPS_PROXY: 'http://nope:9' };
    const p = resolveProxy('http://example.invalid/x', env);
    assert.ok(p);
    assert.equal(p.hostname, '10.0.0.1');
    assert.equal(p.port, '1080');
  });

  test('ALL_PROXY is a fallback for both schemes', () => {
    const env = { ALL_PROXY: 'socks-or-http://1.2.3.4:3128' };
    // Bare scheme parses; we only assert host/port resolution.
    const httpsP = resolveProxy('https://example.invalid/x', { ALL_PROXY: 'http://1.2.3.4:3128' });
    assert.equal(httpsP.hostname, '1.2.3.4');
    const httpP = resolveProxy('http://example.invalid/x', { ALL_PROXY: 'http://1.2.3.4:3128' });
    assert.equal(httpP.hostname, '1.2.3.4');
    assert.ok(env); // keep lint quiet about unused destructure intent
  });

  test('lowercase env names are honored', () => {
    const p = resolveProxy('https://example.invalid/x', { https_proxy: 'http://127.0.0.1:8888' });
    assert.ok(p);
    assert.equal(p.port, '8888');
  });

  test('bare host:port defaults to http://', () => {
    const p = resolveProxy('https://example.invalid/x', { HTTPS_PROXY: '127.0.0.1:7890' });
    assert.ok(p);
    assert.equal(p.protocol, 'http:');
    assert.equal(p.hostname, '127.0.0.1');
    assert.equal(p.port, '7890');
  });

  test('NO_PROXY=* disables all proxying', () => {
    const env = { HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: '*' };
    assert.equal(resolveProxy('https://example.invalid/x', env), null);
  });

  test('NO_PROXY suffix match disables proxying for that host', () => {
    const env = { HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'example.invalid' };
    assert.equal(resolveProxy('https://api.example.invalid/x', env), null);
    // A different host still uses the proxy.
    assert.ok(resolveProxy('https://other.test/x', env));
  });

  test('userinfo in the proxy URL is preserved for Basic auth', () => {
    const p = resolveProxy('https://example.invalid/x', { HTTPS_PROXY: 'http://user:pa%40ss@127.0.0.1:7890' });
    assert.ok(p);
    assert.equal(p.username, 'user');
    // password is percent-encoded in the URL; decoding happens at header build time.
    assert.equal(p.password, 'pa%40ss');
  });

  test('returns null for an unparseable target URL', () => {
    assert.equal(resolveProxy('not a url', { HTTPS_PROXY: 'http://127.0.0.1:7890' }), null);
  });
});

describe('httpsDownload (loopback)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-dl-')); });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

  function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  }
  function close(server) {
    return new Promise((resolve) => server.close(() => resolve()));
  }

  test('direct HTTP origin downloads bytes and reports progress to completion', async () => {
    const payload = Buffer.from('a'.repeat(4096));
    const origin = http.createServer((req, res) => {
      res.writeHead(200, { 'content-length': String(payload.length) });
      // Split into two writes so progress ticks more than once.
      res.write(payload.subarray(0, 2048));
      res.end(payload.subarray(2048));
    });
    const port = await listen(origin);
    try {
      const dest = path.join(tmp, 'out.bin');
      const events = [];
      await httpsDownload(`http://127.0.0.1:${port}/file`, dest, {
        env: {}, // no proxy
        onProgress: (p) => events.push(p),
      });
      assert.deepEqual(fs.readFileSync(dest), payload);
      assert.ok(events.length >= 1, 'progress must fire');
      const last = events[events.length - 1];
      assert.equal(last.done, true, 'final progress event marks done');
      assert.equal(last.downloaded, payload.length);
      assert.equal(last.total, payload.length);
    } finally {
      await close(origin);
    }
  });

  test('rejects on non-200 origin response', async () => {
    const origin = http.createServer((req, res) => { res.writeHead(404); res.end('nope'); });
    const port = await listen(origin);
    try {
      await assert.rejects(
        httpsDownload(`http://127.0.0.1:${port}/missing`, path.join(tmp, 'x.bin'), { env: {} }),
        /HTTP 404/,
      );
    } finally {
      await close(origin);
    }
  });

  test('HTTP origin via HTTP proxy uses an absolute-URI request line', async () => {
    const payload = Buffer.from('proxied-body');
    let sawAbsoluteUri = false;
    let sawHostHeader = '';
    const proxy = http.createServer((req, res) => {
      // A forward proxy receives the full absolute URI as the request target.
      sawAbsoluteUri = /^http:\/\//i.test(req.url);
      sawHostHeader = req.headers.host || '';
      res.writeHead(200, { 'content-length': String(payload.length) });
      res.end(payload);
    });
    const port = await listen(proxy);
    try {
      const dest = path.join(tmp, 'p.bin');
      await httpsDownload('http://upstream.invalid/asset.bin', dest, {
        env: { HTTP_PROXY: `http://127.0.0.1:${port}` },
      });
      assert.deepEqual(fs.readFileSync(dest), payload);
      assert.ok(sawAbsoluteUri, 'proxy must receive an absolute-URI request line');
      assert.equal(sawHostHeader, 'upstream.invalid', 'Host header targets the origin');
    } finally {
      await close(proxy);
    }
  });
});

describe('resolveArtifactUrls', () => {
  const SAVED = process.env.KHY_KHYOS_MIRROR_BASE;
  afterEach(() => {
    if (SAVED === undefined) delete process.env.KHY_KHYOS_MIRROR_BASE;
    else process.env.KHY_KHYOS_MIRROR_BASE = SAVED;
  });

  test('primary url first when no mirrors / no mirror base', () => {
    delete process.env.KHY_KHYOS_MIRROR_BASE;
    assert.deepEqual(resolveArtifactUrls({ url: 'https://a.invalid/x.zip' }), ['https://a.invalid/x.zip']);
  });

  test('appends declared mirrors in order, deduped', () => {
    delete process.env.KHY_KHYOS_MIRROR_BASE;
    const out = resolveArtifactUrls({
      url: 'https://a.invalid/x.zip',
      mirrors: ['https://b.invalid/x.zip', 'https://a.invalid/x.zip'], // dup of primary
    });
    assert.deepEqual(out, ['https://a.invalid/x.zip', 'https://b.invalid/x.zip']);
  });

  test('mirror base rehost wins first position', () => {
    process.env.KHY_KHYOS_MIRROR_BASE = 'https://mirror.example/base/';
    const out = resolveArtifactUrls({ url: 'https://a.invalid/x.zip', filename: 'x.zip' }, {
      KHY_KHYOS_MIRROR_BASE: 'https://mirror.example/base/',
    });
    assert.equal(out[0], 'https://mirror.example/base/x.zip');
    assert.ok(out.includes('https://a.invalid/x.zip'));
  });

  test('non-github primary gets NO CN fallback', () => {
    const out = resolveArtifactUrls({ url: 'https://a.invalid/x.zip' }, {});
    assert.deepEqual(out, ['https://a.invalid/x.zip']);
  });

  test('github primary appends CN ghproxy fallbacks AFTER the upstream by default', () => {
    const out = resolveArtifactUrls(
      { url: 'https://github.com/o/r/releases/download/v1/x.zip' },
      { KHY_KHYOS_CN_MIRRORS: 'https://m.test' },
    );
    assert.deepEqual(out, [
      'https://github.com/o/r/releases/download/v1/x.zip',
      'https://m.test/https://github.com/o/r/releases/download/v1/x.zip',
    ]);
  });

  test('KHY_KHYOS_PREFER_CN=1 front-loads CN mirrors before the upstream', () => {
    const out = resolveArtifactUrls(
      { url: 'https://github.com/o/r/x.zip' },
      { KHY_KHYOS_PREFER_CN: '1', KHY_KHYOS_CN_MIRRORS: 'https://m.test' },
    );
    assert.deepEqual(out, [
      'https://m.test/https://github.com/o/r/x.zip',
      'https://github.com/o/r/x.zip',
    ]);
  });

  test('operator mirror base still wins position 0 even with PREFER_CN', () => {
    const out = resolveArtifactUrls(
      { url: 'https://github.com/o/r/x.zip', filename: 'x.zip' },
      { KHY_KHYOS_MIRROR_BASE: 'https://op.example/b/', KHY_KHYOS_PREFER_CN: '1', KHY_KHYOS_CN_MIRRORS: 'https://m.test' },
    );
    assert.equal(out[0], 'https://op.example/b/x.zip');
    assert.deepEqual(out, [
      'https://op.example/b/x.zip',
      'https://m.test/https://github.com/o/r/x.zip',
      'https://github.com/o/r/x.zip',
    ]);
  });
});

describe('resolveCnMirrors', () => {
  test('github release asset gets ghproxy-prefixed fallbacks (default list)', () => {
    const out = resolveCnMirrors('https://github.com/o/r/releases/download/v1/x.zip', {});
    assert.ok(out.length >= 1, 'at least one default CN prefix');
    assert.ok(out.every((u) => u.endsWith('/https://github.com/o/r/releases/download/v1/x.zip')));
    assert.ok(out.every((u) => /^https:\/\//.test(u)));
  });

  test('githubusercontent / codeload hosts are also rehosted', () => {
    assert.ok(resolveCnMirrors('https://raw.githubusercontent.com/o/r/main/f', {}).length >= 1);
    assert.ok(resolveCnMirrors('https://objects.githubusercontent.com/x', {}).length >= 1);
    assert.ok(resolveCnMirrors('https://codeload.github.com/o/r/zip/refs/x', {}).length >= 1);
  });

  test('non-github hosts yield no CN mirrors (nasm/sourceforge/frippery)', () => {
    assert.deepEqual(resolveCnMirrors('https://www.nasm.us/pub/x.zip', {}), []);
    assert.deepEqual(resolveCnMirrors('https://master.dl.sourceforge.net/x.zip', {}), []);
    assert.deepEqual(resolveCnMirrors('https://frippery.org/files/busybox/b.exe', {}), []);
  });

  test('KHY_KHYOS_NO_CN_MIRROR=1 disables CN fallbacks', () => {
    assert.deepEqual(resolveCnMirrors('https://github.com/o/r/x.zip', { KHY_KHYOS_NO_CN_MIRROR: '1' }), []);
  });

  test('KHY_KHYOS_CN_MIRRORS overrides the prefix list (comma-separated, trailing slash trimmed)', () => {
    const out = resolveCnMirrors('https://github.com/o/r/x.zip', {
      KHY_KHYOS_CN_MIRRORS: 'https://m1.test, https://m2.test/',
    });
    assert.deepEqual(out, [
      'https://m1.test/https://github.com/o/r/x.zip',
      'https://m2.test/https://github.com/o/r/x.zip',
    ]);
  });

  test('unparseable / empty url yields none', () => {
    assert.deepEqual(resolveCnMirrors('', {}), []);
    assert.deepEqual(resolveCnMirrors('not a url', {}), []);
  });
});

describe('isTransientDownloadError', () => {
  test('timeouts / resets / 5xx are transient', () => {
    assert.equal(isTransientDownloadError(new Error('download timed out')), true);
    assert.equal(isTransientDownloadError(new Error('socket hang up ECONNRESET')), true);
    assert.equal(isTransientDownloadError(new Error('HTTP 503 fetching x')), true);
  });
  test('4xx and checksum mismatch are terminal', () => {
    assert.equal(isTransientDownloadError(new Error('HTTP 404 fetching x')), false);
    assert.equal(isTransientDownloadError(new Error('SHA256 mismatch for x')), false);
    assert.equal(isTransientDownloadError(new Error('too many redirects')), false);
  });
});

describe('ensurePinnedArtifact — retry + mirror failover', () => {
  let tmp;
  const noSleep = () => Promise.resolve(); // skip real backoff in tests
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-pin-')); });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

  test('retries a transient failure on the same url, then succeeds', async () => {
    const payload = Buffer.from('hello-artifact');
    let calls = 0;
    const downloader = async (url, dest) => {
      calls += 1;
      if (calls < 3) throw new Error('ECONNRESET'); // transient twice
      fs.writeFileSync(dest, payload);
    };
    const out = await ensurePinnedArtifact({
      cacheDir: tmp, filename: 'a.bin', url: 'https://x.invalid/a.bin',
      sha256: sha(payload), downloader, sleep: noSleep, maxRetries: 3,
    });
    assert.equal(calls, 3);
    assert.deepEqual(fs.readFileSync(out), payload);
  });

  test('fails over to a mirror when the primary is terminally down', async () => {
    const payload = Buffer.from('mirror-bytes');
    const downloader = async (url, dest) => {
      if (url.includes('primary')) throw new Error('HTTP 404'); // terminal → next mirror
      fs.writeFileSync(dest, payload);
    };
    const out = await ensurePinnedArtifact({
      cacheDir: tmp, filename: 'b.bin',
      urls: ['https://primary.invalid/b.bin', 'https://mirror.invalid/b.bin'],
      sha256: sha(payload), downloader, sleep: noSleep,
    });
    assert.deepEqual(fs.readFileSync(out), payload);
  });

  test('a checksum mismatch on the primary fails over to a clean mirror', async () => {
    const good = Buffer.from('good-bytes');
    const downloader = async (url, dest) => {
      fs.writeFileSync(dest, url.includes('primary') ? Buffer.from('tampered') : good);
    };
    const out = await ensurePinnedArtifact({
      cacheDir: tmp, filename: 'c.bin',
      urls: ['https://primary.invalid/c.bin', 'https://mirror.invalid/c.bin'],
      sha256: sha(good), downloader, sleep: noSleep,
    });
    assert.deepEqual(fs.readFileSync(out), good);
  });

  test('throws when every mirror is exhausted; leaves no partial behind', async () => {
    const downloader = async () => { throw new Error('HTTP 404'); };
    await assert.rejects(
      ensurePinnedArtifact({
        cacheDir: tmp, filename: 'd.bin',
        urls: ['https://a.invalid/d.bin', 'https://b.invalid/d.bin'],
        sha256: 'deadbeef', downloader, sleep: noSleep,
      }),
      /HTTP 404/,
    );
    // No partial / no cached file left.
    assert.equal(fs.existsSync(path.join(tmp, 'd.bin')), false);
    assert.deepEqual(fs.readdirSync(tmp).filter((f) => !f.startsWith('.')), []);
  });
});

describe('download-lock reclamation (orphaned-lock self-heal)', () => {
  let tmp;
  const noSleep = () => Promise.resolve();
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-lock-')); });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

  // Pre-create a held lock dir for `filename` stamped with `pid`, optionally aged.
  function plantLock(filename, pid, { ageMs = 0 } = {}) {
    const lockDir = path.join(tmp, `.${filename}.lock`);
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, LOCK_OWNER_FILE),
      JSON.stringify({ pid, host: os.hostname(), at: Date.now() - ageMs }),
    );
    if (ageMs > 0) {
      const t = new Date(Date.now() - ageMs);
      fs.utimesSync(lockDir, t, t);
    }
    return lockDir;
  }

  test('_pidAlive: own pid is alive, an out-of-range pid is dead', () => {
    assert.equal(_pidAlive(process.pid), true);
    assert.equal(_pidAlive(DEAD_PID), false);
  });

  test('acquireLock stamps an owner descriptor with this pid', () => {
    const lockDir = path.join(tmp, '.a.lock');
    assert.equal(acquireLock(lockDir), true);
    const owner = _readLockOwner(lockDir);
    assert.ok(owner);
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.host, os.hostname());
  });

  test('a lock held by a LIVE process is NOT stolen', () => {
    const lockDir = plantLock('b.bin', process.pid); // alive owner, fresh
    assert.equal(acquireLock(lockDir), false);
  });

  test('a lock orphaned by a DEAD owner is reclaimed immediately', () => {
    const lockDir = plantLock('c.bin', DEAD_PID); // dead owner, fresh mtime
    assert.equal(acquireLock(lockDir), true);
    // Reclaim rewrites the owner descriptor to the current process.
    assert.equal(_readLockOwner(lockDir).pid, process.pid);
  });

  test('an ownerless legacy lock is reclaimed only past the age backstop', () => {
    // No owner.json, fresh → held.
    const fresh = path.join(tmp, '.legacy-fresh.lock');
    fs.mkdirSync(fresh);
    assert.equal(acquireLock(fresh), false);
    // No owner.json, aged past LOCK_STALE_MS (20 min) → reclaimed.
    const old = path.join(tmp, '.legacy-old.lock');
    fs.mkdirSync(old);
    const t = new Date(Date.now() - 21 * 60 * 1000);
    fs.utimesSync(old, t, t);
    assert.equal(acquireLock(old), true);
  });

  test('ensurePinnedArtifact reclaims a dead-owner lock and downloads', async () => {
    const payload = Buffer.from('reclaimed-bytes');
    plantLock('e.bin', DEAD_PID); // orphaned by a ^C'd prior run
    let called = 0;
    const downloader = async (url, dest) => { called += 1; fs.writeFileSync(dest, payload); };
    const out = await ensurePinnedArtifact({
      cacheDir: tmp, filename: 'e.bin', url: 'https://x.invalid/e.bin',
      sha256: sha(payload), downloader, sleep: noSleep,
    });
    assert.equal(called, 1);
    assert.deepEqual(fs.readFileSync(out), payload);
  });

  test('ensurePinnedArtifact refuses while a LIVE owner holds the lock', async () => {
    plantLock('f.bin', process.pid); // a genuine concurrent download
    let called = 0;
    const downloader = async (url, dest) => { called += 1; fs.writeFileSync(dest, Buffer.from('x')); };
    await assert.rejects(
      ensurePinnedArtifact({
        cacheDir: tmp, filename: 'f.bin', url: 'https://x.invalid/f.bin',
        sha256: sha(Buffer.from('x')), downloader, sleep: noSleep,
      }),
      /another download of f\.bin is already in progress/,
    );
    assert.equal(called, 0, 'must not download while a live owner holds the lock');
  });
});
