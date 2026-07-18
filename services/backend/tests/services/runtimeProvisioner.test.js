const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * Unit tests for runtimeProvisioner.
 *
 * No network and no child_process mock: extraction runs through the real system
 * `tar`, the download step is replaced by an injected `downloader`, and the
 * backend root / manifest path are redirected into a temp dir via the
 * KHY_RUNTIME_ROOT / KHY_RUNTIME_MANIFEST env seams. Each test re-requires the
 * module after setting env so its load-time path constants re-resolve.
 */
describe('runtimeProvisioner.ensureRuntime', () => {
  let tmpRoot;
  let manifestPath;

  beforeEach(() => {
    jest.resetModules();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-provision-test-'));
    manifestPath = path.join(tmpRoot, 'manifest.json');
    process.env.KHY_RUNTIME_ROOT = tmpRoot;
    process.env.KHY_RUNTIME_MANIFEST = manifestPath;
  });

  afterEach(() => {
    delete process.env.KHY_RUNTIME_ROOT;
    delete process.env.KHY_RUNTIME_MANIFEST;
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // Build a real .tar.gz containing `bin/run` (an executable stub) plus a lib
  // file, and return its path + SHA256. Uses the system tar, same tool the
  // provisioner extracts with.
  function buildArchive(label) {
    const payload = path.join(tmpRoot, `payload-${label}`);
    fs.mkdirSync(path.join(payload, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(payload, 'bin', 'run'), '#!/bin/sh\necho ok\n');
    fs.mkdirSync(path.join(payload, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(payload, 'lib', 'libdemo.so'), 'binary');

    const archive = path.join(tmpRoot, `${label}.tar.gz`);
    const r = spawnSync('tar', ['-czf', archive, '-C', payload, '.'], { encoding: 'utf-8' });
    if (r.status !== 0) throw new Error(`fixture tar failed: ${r.stderr || r.error}`);

    const crypto = require('crypto');
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    return { archive, sha256 };
  }

  function writeManifest(platformEntry, { name = 'demo' } = {}) {
    const prov = require('../../src/services/runtimeProvisioner');
    const platKey = prov.detectPlatformKey();
    const manifest = {
      schemaVersion: 1,
      mirrorBaseEnv: 'KHY_RUNTIME_MIRROR_BASE',
      runtimes: {
        [name]: {
          description: 'test runtime',
          targetDir: 'bin/demo',
          sentinel: 'bin/run',
          version: 'test',
          platforms: { [platKey]: platformEntry },
        },
      },
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    return { prov, platKey, name };
  }

  test('returns present (zero network) when the sentinel already exists', async () => {
    const { prov } = writeManifest({
      url: 'http://example.invalid/demo.tar.gz',
      filename: 'demo.tar.gz',
      sha256: 'deadbeef',
      format: 'tar.gz',
      sourceSubdir: '.',
      chmod: ['bin/run'],
    });

    // Pre-create the sentinel so the fast-path short-circuits.
    fs.mkdirSync(path.join(tmpRoot, 'bin', 'demo', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'bin', 'demo', 'bin', 'run'), 'preexisting');

    const downloader = jest.fn(async () => { throw new Error('should not download'); });
    const res = await prov.ensureRuntime('demo', { downloader });

    expect(res.status).toBe('present');
    expect(downloader).not.toHaveBeenCalled();
  });

  test('downloads, verifies SHA256, extracts and chmods → provisioned', async () => {
    const { archive, sha256 } = buildArchive('good');
    const { prov } = writeManifest({
      url: 'http://example.invalid/demo.tar.gz',
      filename: 'demo.tar.gz',
      sha256,
      format: 'tar.gz',
      sourceSubdir: '.',
      chmod: ['bin/run'],
    });

    const downloader = jest.fn(async (url, dest) => { fs.copyFileSync(archive, dest); });
    const res = await prov.ensureRuntime('demo', { downloader });

    expect(downloader).toHaveBeenCalledTimes(1);
    expect(res.status).toBe('provisioned');

    const sentinel = path.join(tmpRoot, 'bin', 'demo', 'bin', 'run');
    expect(fs.existsSync(sentinel)).toBe(true);
    // lib payload relocated too
    expect(fs.existsSync(path.join(tmpRoot, 'bin', 'demo', 'lib', 'libdemo.so'))).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(sentinel).mode & 0o111).not.toBe(0); // executable bit set
    }
  });

  test('SHA256 mismatch → failed, target is not created', async () => {
    const { archive } = buildArchive('bad');
    const { prov } = writeManifest({
      url: 'http://example.invalid/demo.tar.gz',
      filename: 'demo.tar.gz',
      sha256: '0000000000000000000000000000000000000000000000000000000000000000',
      format: 'tar.gz',
      sourceSubdir: '.',
      chmod: ['bin/run'],
    });

    const downloader = jest.fn(async (url, dest) => { fs.copyFileSync(archive, dest); });
    const res = await prov.ensureRuntime('demo', { downloader });

    expect(res.status).toBe('failed');
    expect(String(res.error)).toMatch(/SHA256/i);
    // Corrupt download must never land at the target path.
    expect(fs.existsSync(path.join(tmpRoot, 'bin', 'demo', 'bin', 'run'))).toBe(false);
  });

  test('no manifest entry for the current platform → unsupported-platform (no download)', async () => {
    const prov = require('../../src/services/runtimeProvisioner');
    const manifest = {
      schemaVersion: 1,
      mirrorBaseEnv: 'KHY_RUNTIME_MIRROR_BASE',
      runtimes: {
        demo: {
          targetDir: 'bin/demo',
          sentinel: 'bin/run',
          platforms: { 'no-such-platform-x99': { url: 'http://x.invalid/a', sha256: 'x', format: 'tar.gz' } },
        },
      },
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const downloader = jest.fn(async () => { throw new Error('should not download'); });
    const res = await prov.ensureRuntime('demo', { downloader });

    expect(res.status).toBe('unsupported-platform');
    expect(downloader).not.toHaveBeenCalled();
  });

  test('platform entry present but unpinned (empty sha256) → no-source (no download)', async () => {
    const { prov } = writeManifest({
      url: 'http://example.invalid/demo.tar.gz',
      filename: 'demo.tar.gz',
      sha256: '',
      format: 'tar.gz',
      sourceSubdir: '.',
      chmod: ['bin/run'],
    });

    const downloader = jest.fn(async () => { throw new Error('should not download'); });
    const res = await prov.ensureRuntime('demo', { downloader });

    expect(res.status).toBe('no-source');
    expect(downloader).not.toHaveBeenCalled();
  });

  test('inspect() reports per-runtime present/supported/pinned for the current platform', () => {
    const { prov } = writeManifest({
      url: 'http://example.invalid/demo.tar.gz',
      filename: 'demo.tar.gz',
      sha256: 'abc123',
      format: 'tar.gz',
      sourceSubdir: '.',
      chmod: ['bin/run'],
    });

    const report = prov.inspect();
    expect(report.platform).toBe(prov.detectPlatformKey());
    const demo = report.runtimes.find((r) => r.name === 'demo');
    expect(demo).toBeTruthy();
    expect(demo.present).toBe(false);
    expect(demo.supported).toBe(true);
    expect(demo.pinned).toBe(true);
  });

  // --- Per-platform sentinel override (Windows/darwin lay the binary outside bin/) ---

  // Build a .tar.gz whose executable sits at the ROOT (no bin/ prefix), mirroring
  // the Windows zip / darwin tgz layout where the binary is not under bin/.
  function buildRootArchive(label, binaryName) {
    const payload = path.join(tmpRoot, `payload-${label}`);
    fs.mkdirSync(path.join(payload, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(payload, binaryName), '#!/bin/sh\necho ok\n');
    fs.writeFileSync(path.join(payload, 'lib', 'libdemo.so'), 'binary');
    const archive = path.join(tmpRoot, `${label}.tar.gz`);
    const r = spawnSync('tar', ['-czf', archive, '-C', payload, '.'], { encoding: 'utf-8' });
    if (r.status !== 0) throw new Error(`fixture tar failed: ${r.stderr || r.error}`);
    const crypto = require('crypto');
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    return { archive, sha256 };
  }

  // Manifest whose runtime-level sentinel deliberately differs from the platform
  // override, so the test exercises `plat.sentinel || runtime.sentinel` resolution.
  function writeManifestWithSentinels(platformEntry, runtimeSentinel) {
    const prov = require('../../src/services/runtimeProvisioner');
    const platKey = prov.detectPlatformKey();
    const manifest = {
      schemaVersion: 1,
      mirrorBaseEnv: 'KHY_RUNTIME_MIRROR_BASE',
      runtimes: {
        demo: {
          description: 'test runtime',
          targetDir: 'bin/demo',
          sentinel: runtimeSentinel,
          version: 'test',
          platforms: { [platKey]: platformEntry },
        },
      },
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    return { prov, platKey };
  }

  test('per-platform sentinel override drives the fast-path (root-level binary)', async () => {
    const { prov } = writeManifestWithSentinels({
      url: 'http://example.invalid/demo.tgz',
      filename: 'demo.tgz',
      sha256: 'deadbeef',
      format: 'tar.gz',
      sourceSubdir: '.',
      sentinel: 'demo.exe',
      chmod: [],
    }, 'bin/run'); // runtime-level sentinel would NOT match a root binary

    // Pre-create ONLY the per-platform sentinel at the runner root.
    fs.mkdirSync(path.join(tmpRoot, 'bin', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'bin', 'demo', 'demo.exe'), 'preexisting');

    const downloader = jest.fn(async () => { throw new Error('should not download'); });
    const res = await prov.ensureRuntime('demo', { downloader });

    expect(res.status).toBe('present');
    expect(downloader).not.toHaveBeenCalled();
  });

  test('per-platform sentinel override provisions a root-level binary', async () => {
    const { archive, sha256 } = buildRootArchive('rooted', 'demo.exe');
    const { prov } = writeManifestWithSentinels({
      url: 'http://example.invalid/demo.tgz',
      filename: 'demo.tgz',
      sha256,
      format: 'tar.gz',
      sourceSubdir: '.',
      sentinel: 'demo.exe',
      chmod: [],
    }, 'bin/run'); // runtime-level sentinel deliberately wrong for this archive

    const downloader = jest.fn(async (url, dest) => { fs.copyFileSync(archive, dest); });
    const res = await prov.ensureRuntime('demo', { downloader });

    expect(res.status).toBe('provisioned');
    // Binary landed at the runner root (no bin/ prefix), lib relocated alongside.
    expect(fs.existsSync(path.join(tmpRoot, 'bin', 'demo', 'demo.exe'))).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, 'bin', 'demo', 'lib', 'libdemo.so'))).toBe(true);
  });

  test('inspect() reports the per-platform sentinel and its presence', () => {
    const { prov } = writeManifestWithSentinels({
      url: 'http://example.invalid/demo.tgz',
      filename: 'demo.tgz',
      sha256: 'abc123',
      format: 'tar.gz',
      sourceSubdir: '.',
      sentinel: 'demo.exe',
      chmod: [],
    }, 'bin/run');

    let demo = prov.inspect().runtimes.find((r) => r.name === 'demo');
    expect(demo.sentinel).toBe('demo.exe');
    expect(demo.present).toBe(false);

    fs.mkdirSync(path.join(tmpRoot, 'bin', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'bin', 'demo', 'demo.exe'), 'x');
    demo = prov.inspect().runtimes.find((r) => r.name === 'demo');
    expect(demo.present).toBe(true);
  });
});

describe('runtime-binaries.json — ollama-runner cross-platform coverage', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../config/runtime-binaries.json'), 'utf-8')
  );
  const ollama = manifest.runtimes['ollama-runner'];

  test('every target platform has a non-null, pinnable entry', () => {
    const expected = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64', 'win32-x64'];
    for (const key of expected) {
      const plat = ollama.platforms[key];
      expect(plat).toBeTruthy();
      expect(plat.url).toMatch(/^https:\/\/github\.com\/ollama\/ollama\/releases\//);
      expect(typeof plat.filename).toBe('string');
      expect(['tar.gz', 'tgz', 'zip', 'tar']).toContain(plat.format);
      // sha256 intentionally empty until armed by scripts/release/pin-runtime-binaries.js.
      expect(plat).toHaveProperty('sha256');
    }
  });

  test('the Windows entry overrides the sentinel to ollama.exe and is a zip', () => {
    const win = ollama.platforms['win32-x64'];
    expect(win.format).toBe('zip');
    expect(win.sentinel).toBe('ollama.exe');
  });

  test('POSIX entries inherit the runtime-level bin/ollama sentinel', () => {
    expect(ollama.sentinel).toBe('bin/ollama');
    for (const key of ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64']) {
      expect(ollama.platforms[key].sentinel).toBeUndefined();
    }
  });
});
