'use strict';

/**
 * Unit tests for the native bare-Windows build-toolchain provisioner:
 *
 *   @khy/shared/runtime/khyos/toolchainProvisioner.ensureWindowsBuildToolchain
 *
 * It fetches clang+ld.lld (llvm), nasm, limine, xorriso, make, and busybox —
 * sha256-pinned public upstreams — and caches them under
 * ~/.khyquant/khyos/toolchain/<platform>-<arch>, then materializes an sh.exe
 * (BusyBox copy) so make's recipes get a POSIX shell on bare Windows.
 *
 * No real network or extraction is touched: the injected downloader writes known
 * bytes whose sha256 the manifest pins, and the injected spawnSync stands in for
 * `tar`, materializing each archive's expected binaries. Fail-soft contract: any
 * failure (offline / unpinned / sha-mismatch / extract error / missing bin) →
 * null, never throw.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  ensureWindowsBuildToolchain,
  REQUIRED_TOOLS,
  BUSYBOX_APPLETS,
} = require('@khy/shared/runtime/khyos/toolchainProvisioner');

const KEY = 'win32-x64';

let tmp;
let savedEnv;
const ISOLATED = ['KHY_KHYOS_OFFLINE', 'KHY_KHYOS_MANIFEST'];
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-tc-'));
  savedEnv = {};
  for (const k of ISOLATED) savedEnv[k] = process.env[k];
  for (const k of ISOLATED) delete process.env[k];
});
afterEach(() => {
  for (const k of ISOLATED) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Distinct bytes per tool so download basenames + checksums never collide.
const BYTES = {
  'llvm.zip': Buffer.from('llvm-mingw-archive'),
  'nasm.zip': Buffer.from('nasm-archive'),
  'limine.zip': Buffer.from('limine-archive'),
  'xorriso.zip': Buffer.from('xorriso-archive'),
  'make.zip': Buffer.from('make-archive'),
  'busybox.exe': Buffer.from('busybox-binary'),
};

/** A fully pinned win32-x64 toolchain manifest (sha256 matches BYTES). */
function goodManifest() {
  return {
    toolchain: {
      [KEY]: {
        llvm: {
          filename: 'llvm.zip', url: 'https://example.invalid/llvm.zip',
          sha256: sha256(BYTES['llvm.zip']), archive: true,
          ccRelPath: 'bin/clang.exe', ldRelPath: 'bin/ld.lld.exe',
        },
        nasm: {
          filename: 'nasm.zip', url: 'https://example.invalid/nasm.zip',
          sha256: sha256(BYTES['nasm.zip']), archive: true, binRelPath: 'nasm.exe',
        },
        limine: {
          filename: 'limine.zip', url: 'https://example.invalid/limine.zip',
          sha256: sha256(BYTES['limine.zip']), archive: true,
          dirRelPath: '.', binRelPath: 'limine.exe',
        },
        xorriso: {
          filename: 'xorriso.zip', url: 'https://example.invalid/xorriso.zip',
          sha256: sha256(BYTES['xorriso.zip']), archive: true, binRelPath: 'xorriso.exe',
        },
        make: {
          filename: 'make.zip', url: 'https://example.invalid/make.zip',
          sha256: sha256(BYTES['make.zip']), archive: true, binRelPath: 'make.exe',
        },
        busybox: {
          filename: 'busybox.exe', url: 'https://example.invalid/busybox.exe',
          sha256: sha256(BYTES['busybox.exe']), archive: false, binRelPath: 'busybox.exe',
        },
      },
    },
  };
}

/** Downloader that writes the bytes registered per URL basename into `dest`. */
function pinnedDownloader(overrides = {}) {
  const table = { ...BYTES, ...overrides };
  return async (url, dest) => {
    const name = path.basename(String(url));
    if (!(name in table)) throw new Error(`unexpected download: ${name}`);
    fs.writeFileSync(dest, table[name]);
  };
}

/**
 * Injected `tar` seam: materializes each archive's expected binaries into the
 * extraction dir. The tool is inferred from the cache dir layout
 * (<base>/<tool>/<sha12>), so one seam serves every archive.
 */
function tarSpawn({ fail = false } = {}) {
  const calls = [];
  const spawnSync = (exe, args) => {
    calls.push({ exe, args });
    if (fail) return { status: 1 };
    assert.equal(exe, 'tar');
    const dir = args[args.indexOf('-C') + 1];
    const tool = path.basename(path.dirname(dir));
    const write = (rel) => {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, `${tool}:${rel}`);
    };
    if (tool === 'llvm') { write('bin/clang.exe'); write('bin/ld.lld.exe'); }
    else if (tool === 'nasm') write('nasm.exe');
    else if (tool === 'limine') write('limine.exe');
    else if (tool === 'xorriso') write('xorriso.exe');
    else if (tool === 'make') write('make.exe');
    return { status: 0 };
  };
  return { spawnSync, calls };
}

describe('ensureWindowsBuildToolchain', () => {
  test('REQUIRED_TOOLS covers the six native build tools', () => {
    assert.deepEqual(
      [...REQUIRED_TOOLS].sort(),
      ['busybox', 'limine', 'llvm', 'make', 'nasm', 'xorriso'],
    );
  });

  test('null when offline, without touching the downloader', async () => {
    process.env.KHY_KHYOS_OFFLINE = '1';
    let called = false;
    const out = await ensureWindowsBuildToolchain({
      manifest: goodManifest(), platformKey: KEY, cacheDir: tmp,
      downloader: async () => { called = true; },
      spawnSync: tarSpawn().spawnSync,
    });
    assert.equal(out, null);
    assert.equal(called, false, 'offline must short-circuit before any download');
  });

  test('null when the manifest has no toolchain table', async () => {
    const out = await ensureWindowsBuildToolchain({
      manifest: {}, platformKey: KEY, cacheDir: tmp,
      downloader: pinnedDownloader(), spawnSync: tarSpawn().spawnSync,
    });
    assert.equal(out, null);
  });

  test('null when there is no entry for the platform key', async () => {
    const out = await ensureWindowsBuildToolchain({
      manifest: goodManifest(), platformKey: 'linux-x64', cacheDir: tmp,
      downloader: pinnedDownloader(), spawnSync: tarSpawn().spawnSync,
    });
    assert.equal(out, null);
  });

  test('null when any single tool is unpinned (all-or-nothing), no download', async () => {
    const m = goodManifest();
    m.toolchain[KEY].xorriso.url = ''; // one hole sinks the whole rung
    let called = false;
    const out = await ensureWindowsBuildToolchain({
      manifest: m, platformKey: KEY, cacheDir: tmp,
      downloader: async () => { called = true; },
      spawnSync: tarSpawn().spawnSync,
    });
    assert.equal(out, null);
    assert.equal(called, false, 'an unpinned tool must abort before touching the network');
  });

  test('null on sha256 mismatch (corrupt download)', async () => {
    const out = await ensureWindowsBuildToolchain({
      manifest: goodManifest(), platformKey: KEY, cacheDir: tmp,
      downloader: pinnedDownloader({ 'nasm.zip': Buffer.from('tampered') }),
      spawnSync: tarSpawn().spawnSync,
    });
    assert.equal(out, null);
  });

  test('null when extraction fails (spawnSync non-zero)', async () => {
    const out = await ensureWindowsBuildToolchain({
      manifest: goodManifest(), platformKey: KEY, cacheDir: tmp,
      downloader: pinnedDownloader(), spawnSync: tarSpawn({ fail: true }).spawnSync,
    });
    assert.equal(out, null);
  });

  test('null when an archive extracts but the expected binary is absent', async () => {
    // spawnSync succeeds yet materializes nothing → resolveBin fails → null.
    const out = await ensureWindowsBuildToolchain({
      manifest: goodManifest(), platformKey: KEY, cacheDir: tmp,
      downloader: pinnedDownloader(), spawnSync: () => ({ status: 0 }),
    });
    assert.equal(out, null);
  });

  test('happy path: downloads, extracts, returns absolute tool paths + sh.exe', async () => {
    const out = await ensureWindowsBuildToolchain({
      manifest: goodManifest(), platformKey: KEY, cacheDir: tmp,
      downloader: pinnedDownloader(), spawnSync: tarSpawn().spawnSync,
    });
    assert.ok(out, 'a fully pinned manifest should resolve');

    // Every resolved path is absolute, lives under the injected cache base, exists.
    for (const key of ['cc', 'ld', 'asm', 'xorriso', 'limineBin', 'make', 'shell']) {
      assert.ok(path.isAbsolute(out[key]), `${key} must be absolute: ${out[key]}`);
      assert.ok(out[key].startsWith(tmp), `${key} must live under the cache base`);
      assert.ok(fs.existsSync(out[key]), `${key} must exist on disk: ${out[key]}`);
    }
    assert.ok(out.cc.endsWith(path.join('bin', 'clang.exe')));
    assert.ok(out.ld.endsWith(path.join('bin', 'ld.lld.exe')));
    assert.ok(out.asm.endsWith('nasm.exe'));
    assert.ok(out.limineBin.endsWith('limine.exe'));
    assert.ok(out.make.endsWith('make.exe'));

    // BusyBox is materialized as sh.exe (make calls it as `sh`).
    assert.ok(out.shell.endsWith('sh.exe'));
    assert.equal(
      fs.readFileSync(out.shell, 'utf-8'),
      BYTES['busybox.exe'].toString(),
      'sh.exe must be a copy of the busybox binary',
    );

    // busyboxDir is returned so the caller can prepend it to the build PATH, and
    // EVERY coreutil the Makefile recipes exec directly (mkdir -p/cp/rm/…) is
    // materialized as an applet-named .exe copy of busybox there. Without these,
    // Windows make's CreateProcess of a simple recipe line finds no executable.
    assert.ok(out.busyboxDir, 'busyboxDir must be returned for the PATH prepend');
    assert.equal(out.busyboxDir, path.dirname(out.shell), 'sh.exe lives in busyboxDir');
    for (const applet of BUSYBOX_APPLETS) {
      const p = path.join(out.busyboxDir, `${applet}.exe`);
      assert.ok(fs.existsSync(p), `${applet}.exe applet must be materialized`);
      assert.equal(
        fs.readFileSync(p, 'utf-8'),
        BYTES['busybox.exe'].toString(),
        `${applet}.exe must be a copy of the busybox binary`,
      );
    }
    // The Makefile's actual recipe coreutils are covered by the applet set.
    for (const must of ['mkdir', 'cp', 'rm', 'sed', 'grep', 'find', 'tr', 'test', 'echo', 'true']) {
      assert.ok(BUSYBOX_APPLETS.includes(must), `BUSYBOX_APPLETS must include ${must}`);
    }

    // limineDir points at the limine cache dir (dirRelPath ".").
    assert.ok(fs.existsSync(out.limineDir));
    assert.ok(out.limineDir.startsWith(tmp));
  });

  test('log receives a reason when offline (transparent fall-through)', async () => {
    process.env.KHY_KHYOS_OFFLINE = '1';
    const reasons = [];
    const out = await ensureWindowsBuildToolchain({
      manifest: goodManifest(), platformKey: KEY, cacheDir: tmp,
      downloader: pinnedDownloader(), spawnSync: tarSpawn().spawnSync,
      log: (m) => reasons.push(m),
    });
    assert.equal(out, null);
    assert.ok(reasons.length >= 1, 'offline must log a reason');
    assert.match(reasons.join('\n'), /离线|OFFLINE/);
  });

  test('log receives a reason when a tool is unpinned', async () => {
    const m = goodManifest();
    m.toolchain[KEY].xorriso.sha256 = '';
    const reasons = [];
    const out = await ensureWindowsBuildToolchain({
      manifest: m, platformKey: KEY, cacheDir: tmp,
      downloader: pinnedDownloader(), spawnSync: tarSpawn().spawnSync,
      log: (m2) => reasons.push(m2),
    });
    assert.equal(out, null);
    assert.match(reasons.join('\n'), /xorriso/);
  });

  test('log receives a reason when a download fails (terminal HTTP 4xx)', async () => {
    // A 4xx is terminal (not retried), so this stays fast while still exercising
    // the failure → log path.
    const reasons = [];
    const out = await ensureWindowsBuildToolchain({
      manifest: goodManifest(), platformKey: KEY, cacheDir: tmp,
      downloader: async () => { throw new Error('HTTP 403 fetching asset'); },
      spawnSync: tarSpawn().spawnSync,
      log: (m) => reasons.push(m),
    });
    assert.equal(out, null);
    assert.match(reasons.join('\n'), /下载或校验失败/);
  });

  test('mirror failover: first url fails, second (mirror) succeeds', async () => {
    // Give nasm a mirror; the primary 404s, the mirror serves the right bytes.
    const m = goodManifest();
    m.toolchain[KEY].nasm.url = 'https://primary.invalid/nasm.zip';
    m.toolchain[KEY].nasm.mirrors = ['https://mirror.invalid/nasm.zip'];
    const downloader = async (url, dest) => {
      if (url.includes('primary.invalid')) throw new Error('HTTP 404 fetching');
      if (url.includes('mirror.invalid')) { fs.writeFileSync(dest, BYTES['nasm.zip']); return; }
      // every other tool resolves from its basename as usual
      const name = path.basename(String(url));
      if (!(name in BYTES)) throw new Error(`unexpected: ${url}`);
      fs.writeFileSync(dest, BYTES[name]);
    };
    const out = await ensureWindowsBuildToolchain({
      manifest: m, platformKey: KEY, cacheDir: tmp,
      downloader, spawnSync: tarSpawn().spawnSync,
    });
    assert.ok(out, 'a working mirror must rescue the build');
    assert.ok(out.asm.endsWith('nasm.exe'));
  });

  test('onProgress is invoked per tool, tagged with the tool name', async () => {
    // The provisioner forwards artifact byte-progress; the injected downloader
    // emits a couple of progress ticks so we can assert the tag is threaded.
    const seen = [];
    const progressingDownloader = async (url, dest, dlOpts = {}) => {
      const name = path.basename(String(url));
      const buf = BYTES[name];
      if (!buf) throw new Error(`unexpected download: ${name}`);
      if (dlOpts.onProgress) {
        dlOpts.onProgress({ downloaded: 0, total: buf.length });
        dlOpts.onProgress({ downloaded: buf.length, total: buf.length, done: true });
      }
      fs.writeFileSync(dest, buf);
    };
    const out = await ensureWindowsBuildToolchain({
      manifest: goodManifest(), platformKey: KEY, cacheDir: tmp,
      downloader: progressingDownloader, spawnSync: tarSpawn().spawnSync,
      onProgress: (p) => seen.push(p),
    });
    assert.ok(out, 'happy path should resolve');
    assert.ok(seen.length > 0, 'onProgress must fire');
    // Each progress event carries the tool tag the provisioner attached.
    assert.ok(seen.every((p) => typeof p.tool === 'string' && p.tool.length > 0));
    const tools = new Set(seen.map((p) => p.tool));
    for (const t of REQUIRED_TOOLS) {
      assert.ok(tools.has(t), `progress should be reported for ${t}`);
    }
  });

  test('idempotent: a second call reuses the cache without re-downloading', async () => {
    const dl = pinnedDownloader();
    let downloads = 0;
    const counting = async (url, dest) => { downloads += 1; return dl(url, dest); };
    const opts = {
      manifest: goodManifest(), platformKey: KEY, cacheDir: tmp,
      downloader: counting, spawnSync: tarSpawn().spawnSync,
    };
    const first = await ensureWindowsBuildToolchain(opts);
    assert.ok(first);
    const firstCount = downloads;
    const second = await ensureWindowsBuildToolchain(opts);
    assert.ok(second);
    assert.equal(downloads, firstCount, 'cached tools must not re-download');
    assert.deepEqual(second, first);
  });
});
