'use strict';

/**
 * Tests for `khy os build` (kernelBuild) — the one-command self-kernel ISO
 * restore path for pip installs. The real build needs nasm/gcc/ld/grub/moon, so
 * these exercise the orchestration via an injected spawnSync seam (test seam),
 * a throwaway kernel dir, and a forced platform. No real toolchain is invoked.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const crypto = require('crypto');

const {
  kernelBuild, provision, _winToWslPath, _wslHasDistro, _qemuBuilderImage,
  _buildViaNativeToolchain, _unixToolchainBuild,
  _looksLikeIso, _printBuildFailureReport, _windowsKernelBuild,
} = require('../src/cli/handlers/khyos');

const ISO_NAME = 'khy-os-kernel.iso';

let tmp;
// Saved env we neutralize per-test so the obtain rung (ensureKhyosIso) is
// deterministic and never resolves the dev repo's real kernel/build ISO.
const ISOLATED_ENV = ['KHY_KERNEL_SRC_DIR', 'KHY_KHYOS_CACHE_DIR', 'KHY_KHYOS_MANIFEST', 'KHY_KERNEL_ISO', 'KHY_KHYOS_OFFLINE'];
let savedIsoEnv;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-build-'));
  savedIsoEnv = {};
  for (const k of ISOLATED_ENV) savedIsoEnv[k] = process.env[k];
  // Pin discovery to the throwaway dir: repoKernelIso() honors KHY_KERNEL_SRC_DIR
  // and probes ONLY <src>/build/<ISO>, and the cache lookup uses
  // KHY_KHYOS_CACHE_DIR — both inside tmp, so nothing leaks from the real repo.
  process.env.KHY_KERNEL_SRC_DIR = tmp;
  process.env.KHY_KHYOS_CACHE_DIR = path.join(tmp, 'cache');
  delete process.env.KHY_KHYOS_MANIFEST;
  delete process.env.KHY_KERNEL_ISO;
  delete process.env.KHY_KHYOS_OFFLINE;
});
afterEach(() => {
  for (const k of ISOLATED_ENV) {
    if (savedIsoEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedIsoEnv[k];
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** sha256 hex of a Buffer (matches _artifact.sha256File over the same bytes). */
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Write a structurally-valid fake ISO so _verifyIso's shape check (_looksLikeIso)
 * accepts it: ≥64 KiB and the ISO9660 'CD001' Primary Volume Descriptor identifier
 * at byte offset 0x8001 (sector 16). The bytes are otherwise meaningless — these
 * tests never boot the image, they only assert the build orchestration reached a
 * verified-output state.
 */
function writeFakeIso(isoPath) {
  fs.mkdirSync(path.dirname(isoPath), { recursive: true });
  const buf = Buffer.alloc(72 * 1024); // > 64 KiB floor, covers the descriptor offset
  buf.write('CD001', 0x8001, 'ascii');
  fs.writeFileSync(isoPath, buf);
}

/**
 * Write a temp khyos manifest and point KHY_KHYOS_MANIFEST at it. `extra` merges
 * over the inert defaults (empty url/sha256). Returns the manifest path.
 */
function writeManifest(extra = {}) {
  const m = Object.assign(
    { filename: ISO_NAME, version: '0.0.0', url: '', sha256: '' },
    extra,
  );
  const p = path.join(tmp, 'khyos-manifest.json');
  fs.writeFileSync(p, JSON.stringify(m));
  process.env.KHY_KHYOS_MANIFEST = p;
  return p;
}

/**
 * Fake pinned downloader: writes the bytes registered for the requested URL's
 * basename into `dest`. Matches the (url, dest, opts) signature ensurePinnedArtifact
 * invokes. Unknown artifacts get a deterministic stub (sha won't match → reject).
 */
function pinnedDownloader(byBasename) {
  return async (url, dest) => {
    const name = path.basename(String(url));
    const buf = byBasename[name] || Buffer.from('unregistered');
    fs.writeFileSync(dest, buf);
  };
}

function withMakefile() {
  fs.writeFileSync(path.join(tmp, 'Makefile'), 'iso:\n\techo build\n');
  return tmp;
}

/**
 * Write the committed prebuilt MoonBit C (kernel/vendor/moonbit/moonbit_gen.c) that
 * the wheel ships, so `make` can build WITHOUT the `moon` toolchain. Its mere
 * presence is what flips kernelBuild into prebuilt mode when `moon` is absent.
 */
function withVendoredMoonC() {
  const dir = path.join(tmp, 'vendor', 'moonbit');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'moonbit_gen.c'), '/* prebuilt generated C */\n');
  return dir;
}

/** Build a spawnSync seam. `present` = all tools found; `onBuild` runs for `make -C … iso`. */
function makeSpawn({ missing = [], onBuild } = {}) {
  const calls = { detect: [], build: 0 };
  const spawnSync = (exe, args) => {
    if (Array.isArray(args) && args[0] === '-C' && args.includes('iso')) {
      calls.build += 1;
      return onBuild ? onBuild(exe, args) : { status: 0 };
    }
    calls.detect.push(exe);
    // ENOENT for any exe whose name matches a missing entry (substring match on
    // the resolved binary name), else "present".
    if (missing.some((m) => String(exe).includes(m))) {
      return { error: Object.assign(new Error('not found'), { code: 'ENOENT' }) };
    }
    return { status: 0, stdout: 'x version 1.0' };
  };
  return { spawnSync, calls };
}

/** Run fn with env overlaid (undefined deletes the key), restoring afterwards.
 *  Awaits async fns so the restore in `finally` does not race the build. */
async function withEnv(overlay, fn) {
  const saved = {};
  for (const k of Object.keys(overlay)) {
    saved[k] = process.env[k];
    if (overlay[k] === undefined) delete process.env[k];
    else process.env[k] = overlay[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(overlay)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/**
 * Windows-aware spawnSync seam covering the WSL2 / Docker delegation paths.
 *  - wsl ['-l','-q'] / docker ['--version'] → backend availability probes.
 *  - wsl ['wslpath','-u',dir]              → returns a fake /mnt/c unix path.
 *  - wsl ['make',…,'iso'] / docker ['run',…,'iso'] → the delegated build.
 *  - docker ['build',…]                   → toolchain image build.
 *  - make ['-C',…,'iso']                  → native host build.
 * `wslMissing`/`dockerMissing` force ENOENT on the respective probe; `onBuild`
 * runs for whichever path actually performs the kernel build.
 */
function makeWinSpawn({ wslMissing = false, wslNoDistro = false, dockerMissing = false, qemuMissing = false, missing = [], onBuild, imageBuildStatus = 0, psInstallStatus = 0, qemuStatus = 0 } = {}) {
  const calls = { detect: [], build: 0, imageBuild: 0, via: null, psInstall: 0 };
  const spawnSync = (exe, args = []) => {
    const a = Array.isArray(args) ? args : [];
    if (exe === 'wsl' && a[0] === '-l') {
      calls.detect.push('wsl');
      if (wslMissing) return { error: Object.assign(new Error('no wsl'), { code: 'ENOENT' }) };
      // `wsl -l -q` lists installed distros; empty stdout = wsl.exe present but
      // no distro installed (the case that should NOT route to WSL).
      return { status: 0, stdout: wslNoDistro ? '' : 'Ubuntu\n' };
    }
    if (exe === 'docker' && a[0] === '--version') {
      calls.detect.push('docker');
      return dockerMissing ? { error: Object.assign(new Error('no docker'), { code: 'ENOENT' }) } : { status: 0 };
    }
    if (String(exe).includes('qemu-system') && a[0] === '--version') {
      calls.detect.push('qemu');
      return qemuMissing ? { error: Object.assign(new Error('no qemu'), { code: 'ENOENT' }) } : { status: 0, stdout: 'QEMU emulator version 8.0' };
    }
    if (exe === 'wsl' && a[0] === 'wslpath') {
      return { status: 0, stdout: '/mnt/c/kernel\n' };
    }
    if (exe === 'powershell' && a.includes('-Command') && a.some((x) => /Start-Process/.test(String(x)))) {
      calls.psInstall += 1;
      return { status: psInstallStatus };
    }
    if (exe === 'docker' && a[0] === 'build') {
      calls.imageBuild += 1;
      return { status: imageBuildStatus };
    }
    // QEMU builder-VM build: qemu-system-* booting the appliance (has -append/-drive).
    if (String(exe).includes('qemu-system') && (a.includes('-append') || a.includes('-drive'))) {
      calls.build += 1;
      calls.via = 'qemu';
      return onBuild ? onBuild(exe, a) : { status: qemuStatus };
    }
    // Any invocation that asks make for the iso target is "the build".
    if (a.includes('iso') && (a.includes('-C') || exe === 'wsl' || exe === 'docker')) {
      calls.build += 1;
      calls.via = exe === 'wsl' ? 'wsl' : exe === 'docker' ? 'docker' : 'native';
      return onBuild ? onBuild(exe, a) : { status: 0 };
    }
    calls.detect.push(exe);
    if (missing.some((m) => String(exe).includes(m))) {
      return { error: Object.assign(new Error('not found'), { code: 'ENOENT' }) };
    }
    return { status: 0, stdout: 'x version 1.0' };
  };
  return { spawnSync, calls };
}

/** Write a throwaway Dockerfile.kernel-build next to the Makefile (docker path probes it). */
function withDockerfile(dir) {
  fs.writeFileSync(path.join(dir, 'Dockerfile.kernel-build'), 'FROM debian:bookworm-slim\n');
  return dir;
}

/** Make `onBuild` that materializes the expected ISO so _verifyIso passes. */
function isoWriter(dir) {
  return () => {
    writeFakeIso(path.join(dir, 'build', ISO_NAME));
    return { status: 0 };
  };
}

describe('khy os build (kernelBuild)', () => {
  test('returns false when kernel Makefile is missing (no source)', async () => {
    const { spawnSync, calls } = makeSpawn();
    const ok = await kernelBuild({ kernelDir: tmp, platform: 'linux', spawnSync });
    assert.equal(ok, false);
    assert.equal(calls.build, 0, 'must not invoke make without a Makefile');
    assert.equal(calls.detect.length, 0, 'must not probe toolchain without a Makefile');
  });

  test('returns false and never builds when a toolchain tool is missing', async () => {
    withMakefile();
    const { spawnSync, calls } = makeSpawn({ missing: ['nasm'] });
    const ok = await kernelBuild({ kernelDir: tmp, platform: 'linux', spawnSync });
    assert.equal(ok, false);
    assert.equal(calls.build, 0, 'fail-soft: must not start make when a tool is missing');
    assert.ok(calls.detect.length >= 1, 'should probe at least one tool');
  });

  test('builds and returns true when toolchain present and ISO is produced', async () => {
    withMakefile();
    const { spawnSync, calls } = makeSpawn({
      onBuild: () => {
        writeFakeIso(path.join(tmp, 'build', ISO_NAME));
        return { status: 0 };
      },
    });
    const ok = await kernelBuild({ kernelDir: tmp, platform: 'linux', spawnSync });
    assert.equal(ok, true);
    assert.equal(calls.build, 1, 'should run make exactly once');
    assert.ok(fs.existsSync(path.join(tmp, 'build', ISO_NAME)), 'ISO must exist on success');
  });

  test('forwards a version stamp to make so the boot banner tracks the release', async () => {
    withMakefile();
    let buildArgs = null;
    const { spawnSync } = makeSpawn({
      onBuild: (_exe, args) => {
        buildArgs = args;
        writeFakeIso(path.join(tmp, 'build', ISO_NAME));
        return { status: 0 };
      },
    });
    await withEnv({ KHY_VERSION: '9.9.9' }, async () => {
      const ok = await kernelBuild({ kernelDir: tmp, platform: 'linux', spawnSync });
      assert.equal(ok, true);
    });
    assert.ok(buildArgs, 'make must have been invoked');
    assert.ok(
      buildArgs.includes('KHY_VERSION=9.9.9'),
      `explicit KHY_VERSION must be forwarded to make; got ${JSON.stringify(buildArgs)}`,
    );
  });

  test('returns false when make succeeds but no ISO appears', async () => {
    withMakefile();
    const { spawnSync } = makeSpawn({ onBuild: () => ({ status: 0 }) }); // no ISO written
    const ok = await kernelBuild({ kernelDir: tmp, platform: 'linux', spawnSync });
    assert.equal(ok, false);
  });

  test('returns false when make exits non-zero', async () => {
    withMakefile();
    const { spawnSync } = makeSpawn({ onBuild: () => ({ status: 2 }) });
    const ok = await kernelBuild({ kernelDir: tmp, platform: 'linux', spawnSync });
    assert.equal(ok, false);
  });

  // --- MoonBit prebuilt-vs-source resolution (the bare-pip "really build" path) ---

  test('vendored prebuilt C + no `moon` → builds anyway, forwarding MOONBIT_PREBUILT=1', async () => {
    withMakefile();
    withVendoredMoonC();
    let buildArgs = null;
    const { spawnSync, calls } = makeSpawn({
      missing: ['moon'], // `moon` is absent on this host
      onBuild: (_exe, args) => {
        buildArgs = args;
        writeFakeIso(path.join(tmp, 'build', ISO_NAME));
        return { status: 0 };
      },
    });
    await withEnv({ KHY_MOONBIT_PREBUILT: undefined }, async () => {
      const ok = await kernelBuild({ kernelDir: tmp, platform: 'linux', spawnSync });
      assert.equal(ok, true, 'prebuilt C lets the build succeed without moon');
    });
    assert.equal(calls.build, 1, 'make runs once');
    assert.ok(buildArgs, 'make must have been invoked');
    assert.ok(
      buildArgs.includes('MOONBIT_PREBUILT=1'),
      `prebuilt mode must forward MOONBIT_PREBUILT=1; got ${JSON.stringify(buildArgs)}`,
    );
  });

  test('vendored prebuilt C + `moon` present → from-source mode, MOONBIT_PREBUILT not forwarded', async () => {
    withMakefile();
    withVendoredMoonC();
    let buildArgs = null;
    const { spawnSync } = makeSpawn({
      // `moon` present (default), capture the make var line.
      onBuild: (_exe, args) => {
        buildArgs = args;
        writeFakeIso(path.join(tmp, 'build', ISO_NAME));
        return { status: 0 };
      },
    });
    await withEnv({ KHY_MOONBIT_PREBUILT: undefined }, async () => {
      const ok = await kernelBuild({ kernelDir: tmp, platform: 'linux', spawnSync });
      assert.equal(ok, true);
    });
    assert.ok(buildArgs, 'make must have been invoked');
    assert.ok(
      !buildArgs.some((a) => String(a).startsWith('MOONBIT_PREBUILT=')),
      `a dev with moon installed must build from source (no MOONBIT_PREBUILT); got ${JSON.stringify(buildArgs)}`,
    );
  });

  test('explicit KHY_MOONBIT_PREBUILT=1 forces prebuilt with no vendored C and no moon', async () => {
    withMakefile(); // note: NO withVendoredMoonC()
    let buildArgs = null;
    const { spawnSync, calls } = makeSpawn({
      missing: ['moon'],
      onBuild: (_exe, args) => {
        buildArgs = args;
        writeFakeIso(path.join(tmp, 'build', ISO_NAME));
        return { status: 0 };
      },
    });
    await withEnv({ KHY_MOONBIT_PREBUILT: '1' }, async () => {
      const ok = await kernelBuild({ kernelDir: tmp, platform: 'linux', spawnSync });
      assert.equal(ok, true, 'explicit prebuilt wins regardless of vendored-C presence');
    });
    assert.ok(buildArgs && buildArgs.includes('MOONBIT_PREBUILT=1'));
    assert.ok(!calls.detect.includes('moon'), 'forced prebuilt must never probe moon');
  });

  test('explicit KHY_MOONBIT_PREBUILT=0 forces from-source even with vendored C → fails when moon is missing', async () => {
    withMakefile();
    withVendoredMoonC(); // present, but the explicit 0 overrides the auto-detect
    const { spawnSync, calls } = makeSpawn({ missing: ['moon'] });
    await withEnv({ KHY_MOONBIT_PREBUILT: '0' }, async () => {
      const ok = await kernelBuild({ kernelDir: tmp, platform: 'linux', spawnSync });
      assert.equal(ok, false, 'from-source mode requires moon; missing moon fails the build');
    });
    assert.equal(calls.build, 0, 'fail-soft: make never starts when moon is required but absent');
  });

});

describe('khy os build — structured breadcrumb (Option B)', () => {
  // Every kernelBuild() outcome must drop one kernel-build-result.json into the
  // shared khyos cache dir (KHY_KHYOS_CACHE_DIR=tmp/cache here) so the detached
  // pip launcher can surface a background build's real result on the next command.
  const breadcrumbPath = () => path.join(tmp, 'cache', 'kernel-build-result.json');
  const readBreadcrumb = () => JSON.parse(fs.readFileSync(breadcrumbPath(), 'utf-8'));

  test('success writes result=success with the produced ISO path and no errorType', async () => {
    withMakefile();
    const { spawnSync } = makeSpawn({
      onBuild: () => {
        writeFakeIso(path.join(tmp, 'build', ISO_NAME));
        return { status: 0 };
      },
    });
    const ok = await kernelBuild({ kernelDir: tmp, platform: 'linux', spawnSync });
    assert.equal(ok, true);
    const bc = readBreadcrumb();
    assert.equal(bc.result, 'success');
    assert.equal(bc.errorType, null, 'success carries no errorType');
    assert.equal(bc.isoPath, path.join(tmp, 'build', ISO_NAME));
    assert.equal(bc.platform, 'linux');
    assert.ok(typeof bc.ts === 'number' && bc.ts > 0, 'breadcrumb is timestamped');
    assert.ok(bc.logPath.endsWith('kernel-build.log'), 'points the user at the build log');
  });

  test('no-source writes result=failure with errorType=no-source + a hint', async () => {
    // No Makefile in tmp → the earliest failure rung.
    const { spawnSync } = makeSpawn();
    const ok = await kernelBuild({ kernelDir: tmp, platform: 'linux', spawnSync });
    assert.equal(ok, false);
    const bc = readBreadcrumb();
    assert.equal(bc.result, 'failure');
    assert.equal(bc.errorType, 'no-source');
    assert.ok(bc.hint && bc.hint.length > 0, 'failure breadcrumb explains itself');
  });

  test('missing toolchain writes result=failure with errorType=missing-toolchain', async () => {
    withMakefile();
    const { spawnSync } = makeSpawn({ missing: ['nasm'] });
    const ok = await kernelBuild({ kernelDir: tmp, platform: 'linux', spawnSync });
    assert.equal(ok, false);
    const bc = readBreadcrumb();
    assert.equal(bc.result, 'failure');
    assert.equal(bc.errorType, 'missing-toolchain');
  });

  test('make failure writes result=failure with errorType=make-failed', async () => {
    withMakefile();
    const { spawnSync } = makeSpawn({ onBuild: () => ({ status: 2 }) });
    const ok = await kernelBuild({ kernelDir: tmp, platform: 'linux', spawnSync });
    assert.equal(ok, false);
    const bc = readBreadcrumb();
    assert.equal(bc.result, 'failure');
    assert.equal(bc.errorType, 'make-failed');
  });

  test('make succeeds but no ISO appears writes errorType=no-iso', async () => {
    withMakefile();
    const { spawnSync } = makeSpawn({ onBuild: () => ({ status: 0 }) }); // no ISO written
    const ok = await kernelBuild({ kernelDir: tmp, platform: 'linux', spawnSync });
    assert.equal(ok, false);
    const bc = readBreadcrumb();
    assert.equal(bc.result, 'failure');
    assert.equal(bc.errorType, 'no-iso');
  });

  test('a fresh build overwrites a stale breadcrumb (resetting any announced flag)', async () => {
    // Pre-seed a previously-announced failure breadcrumb.
    fs.mkdirSync(path.join(tmp, 'cache'), { recursive: true });
    fs.writeFileSync(breadcrumbPath(), JSON.stringify({
      result: 'failure', errorType: 'make-failed', announced: true, ts: 1,
    }));
    withMakefile();
    const { spawnSync } = makeSpawn({
      onBuild: () => {
        writeFakeIso(path.join(tmp, 'build', ISO_NAME));
        return { status: 0 };
      },
    });
    const ok = await kernelBuild({ kernelDir: tmp, platform: 'linux', spawnSync });
    assert.equal(ok, true);
    const bc = readBreadcrumb();
    assert.equal(bc.result, 'success');
    assert.equal(bc.announced, undefined, 'overwrite clears the stale announced flag');
  });
});

describe('khy os build — Windows cross-platform delegation', () => {
  test('auto: no WSL distro and no Docker → offers nothing unattended, returns false, never builds', async () => {
    withMakefile();
    await withEnv({ KHY_KERNEL_BUILD_BACKEND: undefined, KHY_FORCE_KERNEL_BUILD: undefined }, async () => {
      const { spawnSync, calls } = makeWinSpawn({ wslMissing: true, dockerMissing: true });
      // isInteractive:false → unattended → must not elevate, only guide.
      const ok = await kernelBuild({ kernelDir: tmp, platform: 'win32', spawnSync, isInteractive: false });
      assert.equal(ok, false);
      assert.equal(calls.build, 0, 'no backend → must not build');
      assert.equal(calls.imageBuild, 0);
      assert.equal(calls.psInstall, 0, 'unattended must never elevate/install');
    });
  });

  test('auto: prefers WSL2 when a distro is installed and delegates the unchanged make iso', async () => {
    withMakefile();
    await withEnv({ KHY_KERNEL_BUILD_BACKEND: undefined, KHY_FORCE_KERNEL_BUILD: undefined }, async () => {
      const { spawnSync, calls } = makeWinSpawn({ dockerMissing: true, onBuild: isoWriter(tmp) });
      const ok = await kernelBuild({ kernelDir: tmp, platform: 'win32', spawnSync });
      assert.equal(ok, true);
      assert.equal(calls.via, 'wsl', 'auto must route through WSL when a distro is present');
      assert.equal(calls.build, 1);
    });
  });

  test('auto: wsl.exe present but NO distro → does not route to WSL', async () => {
    withMakefile();
    await withEnv({ KHY_KERNEL_BUILD_BACKEND: undefined, KHY_FORCE_KERNEL_BUILD: undefined }, async () => {
      // No distro + docker present → should fall through to docker, not WSL.
      const { spawnSync, calls } = makeWinSpawn({ wslNoDistro: true, onBuild: isoWriter(tmp) });
      withDockerfile(tmp);
      const ok = await kernelBuild({ kernelDir: tmp, platform: 'win32', spawnSync });
      assert.equal(calls.via, 'docker', 'bare wsl.exe with no distro must not be used');
      assert.equal(ok, true);
    });
  });

  test('backend=wsl: delegates via wsl and succeeds when ISO appears', async () => {
    withMakefile();
    await withEnv({ KHY_KERNEL_BUILD_BACKEND: 'wsl' }, async () => {
      const { spawnSync, calls } = makeWinSpawn({ onBuild: isoWriter(tmp) });
      const ok = await kernelBuild({ kernelDir: tmp, platform: 'win32', spawnSync });
      assert.equal(ok, true);
      assert.equal(calls.via, 'wsl');
      assert.ok(fs.existsSync(path.join(tmp, 'build', ISO_NAME)));
    });
  });

  test('backend=wsl: returns false when the WSL build fails (no ISO)', async () => {
    withMakefile();
    await withEnv({ KHY_KERNEL_BUILD_BACKEND: 'wsl' }, async () => {
      const { spawnSync } = makeWinSpawn({ onBuild: () => ({ status: 2 }) });
      const ok = await kernelBuild({ kernelDir: tmp, platform: 'win32', spawnSync });
      assert.equal(ok, false);
    });
  });

  test('backend=docker: builds the toolchain image then runs make iso in the container', async () => {
    withMakefile();
    withDockerfile(tmp);
    await withEnv({ KHY_KERNEL_BUILD_BACKEND: 'docker', KHY_KERNEL_BUILD_IMAGE: undefined }, async () => {
      const { spawnSync, calls } = makeWinSpawn({ onBuild: isoWriter(tmp) });
      const ok = await kernelBuild({ kernelDir: tmp, platform: 'win32', spawnSync });
      assert.equal(ok, true);
      assert.equal(calls.via, 'docker');
      assert.equal(calls.imageBuild, 1, 'should build the toolchain image once');
    });
  });

  test('backend=docker: prebuilt KHY_KERNEL_BUILD_IMAGE skips the image build', async () => {
    withMakefile();
    await withEnv({ KHY_KERNEL_BUILD_BACKEND: 'docker', KHY_KERNEL_BUILD_IMAGE: 'acme/khyos:1' }, async () => {
      const { spawnSync, calls } = makeWinSpawn({ onBuild: isoWriter(tmp) });
      const ok = await kernelBuild({ kernelDir: tmp, platform: 'win32', spawnSync });
      assert.equal(ok, true);
      assert.equal(calls.imageBuild, 0, 'prebuilt image must not be rebuilt');
    });
  });

  test('KHY_FORCE_KERNEL_BUILD=1: native host build probes the Unix toolchain', async () => {
    withMakefile();
    await withEnv({ KHY_KERNEL_BUILD_BACKEND: undefined, KHY_FORCE_KERNEL_BUILD: '1' }, async () => {
      const { spawnSync, calls } = makeWinSpawn({ onBuild: isoWriter(tmp) });
      const ok = await kernelBuild({ kernelDir: tmp, platform: 'win32', spawnSync });
      assert.equal(ok, true);
      assert.equal(calls.via, 'native', 'forced native build must use the host toolchain');
      assert.ok(calls.detect.length >= 1, 'native path should probe the toolchain');
    });
  });

  test('backend=native: missing toolchain → fail-soft, no build', async () => {
    withMakefile();
    await withEnv({ KHY_KERNEL_BUILD_BACKEND: 'native' }, async () => {
      const { spawnSync, calls } = makeWinSpawn({ missing: ['nasm'] });
      const ok = await kernelBuild({ kernelDir: tmp, platform: 'win32', spawnSync });
      assert.equal(ok, false);
      assert.equal(calls.build, 0);
    });
  });
});

describe('khy os build — WSL2 auto-setup', () => {
  test('auto + interactive + consent → elevates via PowerShell, prompts reboot, returns false', async () => {
    withMakefile();
    await withEnv({ KHY_KERNEL_BUILD_BACKEND: undefined, KHY_FORCE_KERNEL_BUILD: undefined }, async () => {
      const { spawnSync, calls } = makeWinSpawn({ wslNoDistro: true, dockerMissing: true });
      const ok = await kernelBuild({
        kernelDir: tmp, platform: 'win32', spawnSync,
        isInteractive: true, confirm: async () => true,
      });
      assert.equal(calls.psInstall, 1, 'consent must trigger one elevated install');
      assert.equal(ok, false, 'install succeeds but cannot build until reboot');
      assert.equal(calls.build, 0);
    });
  });

  test('auto + interactive + declined → no install, no build', async () => {
    withMakefile();
    await withEnv({ KHY_KERNEL_BUILD_BACKEND: undefined, KHY_FORCE_KERNEL_BUILD: undefined }, async () => {
      const { spawnSync, calls } = makeWinSpawn({ wslNoDistro: true, dockerMissing: true });
      const ok = await kernelBuild({
        kernelDir: tmp, platform: 'win32', spawnSync,
        isInteractive: true, confirm: async () => false,
      });
      assert.equal(calls.psInstall, 0, 'declined consent must not install');
      assert.equal(ok, false);
    });
  });

  test('non-interactive (no TTY) never elevates, even with no backend', async () => {
    withMakefile();
    await withEnv({ KHY_KERNEL_BUILD_BACKEND: undefined, KHY_FORCE_KERNEL_BUILD: undefined }, async () => {
      const { spawnSync, calls } = makeWinSpawn({ wslMissing: true, dockerMissing: true });
      let asked = false;
      const ok = await kernelBuild({
        kernelDir: tmp, platform: 'win32', spawnSync,
        isInteractive: false, confirm: async () => { asked = true; return true; },
      });
      assert.equal(asked, false, 'must not even prompt unattended');
      assert.equal(calls.psInstall, 0, 'must never elevate unattended');
      assert.equal(ok, false);
    });
  });

  test('--setup-wsl forces install even without a TTY (explicit request)', async () => {
    withMakefile();
    await withEnv({ KHY_KERNEL_BUILD_BACKEND: undefined, KHY_FORCE_KERNEL_BUILD: undefined }, async () => {
      const { spawnSync, calls } = makeWinSpawn({ wslNoDistro: true });
      let asked = false;
      const ok = await kernelBuild({
        kernelDir: tmp, platform: 'win32', spawnSync, setupWsl: true,
        isInteractive: false, confirm: async () => { asked = true; return true; },
      });
      assert.equal(asked, false, 'explicit --setup-wsl skips the confirm prompt');
      assert.equal(calls.psInstall, 1, 'explicit request installs unconditionally');
      assert.equal(ok, false);
    });
  });

  test('install failure / UAC denied → returns false and never builds', async () => {
    withMakefile();
    await withEnv({ KHY_KERNEL_BUILD_BACKEND: undefined, KHY_FORCE_KERNEL_BUILD: undefined }, async () => {
      const { spawnSync, calls } = makeWinSpawn({ wslNoDistro: true, dockerMissing: true, psInstallStatus: 1 });
      const ok = await kernelBuild({
        kernelDir: tmp, platform: 'win32', spawnSync,
        isInteractive: true, confirm: async () => true,
      });
      assert.equal(calls.psInstall, 1);
      assert.equal(ok, false);
      assert.equal(calls.build, 0);
    });
  });
});

describe('khy os build — QEMU builder-VM backend (no WSL needed)', () => {
  /** Create a throwaway appliance image file and return its path. */
  function fakeAppliance(dir) {
    const img = path.join(dir, 'khyos-builder.qcow2');
    fs.writeFileSync(img, 'qcow2-bytes');
    return img;
  }

  test('backend=qemu: boots the appliance, shares kernel dir, ISO appears → true', async () => {
    withMakefile();
    const img = fakeAppliance(tmp);
    await withEnv({ KHY_KERNEL_BUILD_BACKEND: 'qemu', KHY_KERNEL_BUILD_VM: img }, async () => {
      const { spawnSync, calls } = makeWinSpawn({ onBuild: isoWriter(tmp) });
      const ok = await kernelBuild({ kernelDir: tmp, platform: 'win32', spawnSync });
      assert.equal(ok, true);
      assert.equal(calls.via, 'qemu', 'must build through the QEMU appliance');
      assert.equal(calls.build, 1);
    });
  });

  test('backend=qemu: appliance missing → fail-soft, never boots QEMU', async () => {
    withMakefile();
    await withEnv({ KHY_KERNEL_BUILD_BACKEND: 'qemu', KHY_KERNEL_BUILD_VM: undefined, KHY_KHYOS_CACHE_DIR: tmp }, async () => {
      const { spawnSync, calls } = makeWinSpawn({ onBuild: isoWriter(tmp) });
      const ok = await kernelBuild({ kernelDir: tmp, platform: 'win32', spawnSync });
      assert.equal(ok, false, 'no appliance → cannot build');
      assert.equal(calls.build, 0, 'must not boot QEMU without an appliance');
    });
  });

  test('backend=qemu: QEMU missing → fail-soft with guidance, no build', async () => {
    withMakefile();
    const img = fakeAppliance(tmp);
    await withEnv({ KHY_KERNEL_BUILD_BACKEND: 'qemu', KHY_KERNEL_BUILD_VM: img }, async () => {
      const { spawnSync, calls } = makeWinSpawn({ qemuMissing: true, onBuild: isoWriter(tmp) });
      const ok = await kernelBuild({ kernelDir: tmp, platform: 'win32', spawnSync });
      assert.equal(ok, false);
      assert.equal(calls.build, 0);
    });
  });

  test('backend=qemu: QEMU boots but no ISO produced → false', async () => {
    withMakefile();
    const img = fakeAppliance(tmp);
    await withEnv({ KHY_KERNEL_BUILD_BACKEND: 'qemu', KHY_KERNEL_BUILD_VM: img }, async () => {
      const { spawnSync, calls } = makeWinSpawn({ onBuild: () => ({ status: 0 }) }); // no ISO
      const ok = await kernelBuild({ kernelDir: tmp, platform: 'win32', spawnSync });
      assert.equal(ok, false);
      assert.equal(calls.build, 1, 'QEMU was booted once');
    });
  });

  test('auto cascade: no WSL distro, no Docker, but QEMU + appliance present → routes to QEMU', async () => {
    withMakefile();
    const img = fakeAppliance(tmp);
    await withEnv({
      KHY_KERNEL_BUILD_BACKEND: undefined, KHY_FORCE_KERNEL_BUILD: undefined, KHY_KERNEL_BUILD_VM: img,
    }, async () => {
      const { spawnSync, calls } = makeWinSpawn({ wslNoDistro: true, dockerMissing: true, onBuild: isoWriter(tmp) });
      const ok = await kernelBuild({ kernelDir: tmp, platform: 'win32', spawnSync, isInteractive: false });
      assert.equal(calls.via, 'qemu', 'auto must fall through to the WSL-free QEMU backend');
      assert.equal(ok, true);
      assert.equal(calls.psInstall, 0, 'a working QEMU backend means no WSL install offer');
    });
  });

  test('auto cascade: QEMU present but appliance absent/undownloadable → QEMU no-ops, falls to guide', async () => {
    withMakefile();
    await withEnv({
      KHY_KERNEL_BUILD_BACKEND: undefined, KHY_FORCE_KERNEL_BUILD: undefined,
      KHY_KERNEL_BUILD_VM: undefined, KHY_KHYOS_CACHE_DIR: tmp,
    }, async () => {
      // No pinned appliance/ISO (manifest stays inert) → the QEMU rung tries to
      // auto-provision, finds nothing, and the trailing obtain rung also resolves
      // nothing, so the cascade ends at the guide without ever booting QEMU.
      const { spawnSync, calls } = makeWinSpawn({ wslMissing: true, dockerMissing: true, onBuild: isoWriter(tmp) });
      const ok = await kernelBuild({ kernelDir: tmp, platform: 'win32', spawnSync, isInteractive: false });
      assert.equal(calls.build, 0, 'no appliance → QEMU is never booted');
      assert.equal(ok, false);
    });
  });

  test('_qemuBuilderImage: env override wins, missing override → null', () => {
    const img = fakeAppliance(tmp);
    const fsMod = require('fs');
    const ctx = { fs: fsMod, khyos: { khyosCacheDir: () => tmp } };
    return withEnv({ KHY_KERNEL_BUILD_VM: img }, async () => {
      assert.equal(_qemuBuilderImage(ctx), img);
    }).then(() => withEnv({ KHY_KERNEL_BUILD_VM: path.join(tmp, 'nope.qcow2') }, async () => {
      assert.equal(_qemuBuilderImage(ctx), null, 'non-existent override → null');
    }));
  });

  test('_qemuBuilderImage: falls back to <cacheDir>/builder/khyos-builder.qcow2', () => {
    const builderDir = path.join(tmp, 'builder');
    fs.mkdirSync(builderDir, { recursive: true });
    fs.writeFileSync(path.join(builderDir, 'khyos-builder.qcow2'), 'x');
    const ctx = { fs: require('fs'), khyos: { khyosCacheDir: () => tmp } };
    return withEnv({ KHY_KERNEL_BUILD_VM: undefined }, async () => {
      assert.equal(_qemuBuilderImage(ctx), path.join(builderDir, 'khyos-builder.qcow2'));
    });
  });
});

describe('khy os build — obtain-first cascade (bare Windows, no WSL/Docker)', () => {
  /** Create a throwaway appliance image file and return its path. */
  function fakeAppliance(dir) {
    const img = path.join(dir, 'khyos-builder.qcow2');
    fs.writeFileSync(img, 'qcow2-bytes');
    return img;
  }

  test('preferObtain: a resolvable ISO short-circuits BEFORE any compile backend', async () => {
    withMakefile();
    // A local build ISO exists under the (isolated) KHY_KERNEL_SRC_DIR → the
    // obtain rung resolves it immediately; no WSL/Docker/QEMU is ever probed.
    writeFakeIso(path.join(tmp, 'build', ISO_NAME));
    await withEnv({ KHY_KERNEL_BUILD_BACKEND: undefined, KHY_FORCE_KERNEL_BUILD: undefined }, async () => {
      const { spawnSync, calls } = makeWinSpawn({ onBuild: isoWriter(tmp) });
      const ok = await kernelBuild({ kernelDir: tmp, platform: 'win32', spawnSync, preferObtain: true, isInteractive: false });
      assert.equal(ok, true, 'obtained a prebuilt ISO');
      assert.equal(calls.build, 0, 'obtain-first must not run any compile backend');
      assert.equal(calls.via, null, 'no build backend was used');
    });
  });

  test('auto: no WSL/Docker, QEMU present + pinned appliance → auto-downloads it, builds via QEMU', async () => {
    withMakefile();
    const applianceBytes = Buffer.from('khyos-builder-appliance-qcow2');
    writeManifest({
      builderAppliance: {
        filename: 'khyos-builder.qcow2',
        url: 'https://example.invalid/khyos-builder.qcow2',
        sha256: sha256(applianceBytes),
      },
    });
    await withEnv({
      KHY_KERNEL_BUILD_BACKEND: undefined, KHY_FORCE_KERNEL_BUILD: undefined, KHY_KERNEL_BUILD_VM: undefined,
    }, async () => {
      const { spawnSync, calls } = makeWinSpawn({ wslNoDistro: true, dockerMissing: true, onBuild: isoWriter(tmp) });
      const downloader = pinnedDownloader({ 'khyos-builder.qcow2': applianceBytes });
      const ok = await kernelBuild({ kernelDir: tmp, platform: 'win32', spawnSync, downloader, isInteractive: false });
      assert.equal(ok, true);
      assert.equal(calls.via, 'qemu', 'must build through the auto-provisioned QEMU appliance');
      assert.equal(calls.build, 1);
      // The appliance is now cached for reuse.
      assert.ok(
        fs.existsSync(path.join(tmp, 'cache', 'builder', 'khyos-builder.qcow2')),
        'downloaded appliance must be cached',
      );
    });
  });

  test('explicit build: all compile backends fail, pinned ISO → obtain rung fires AFTER QEMU', async () => {
    withMakefile();
    const isoBytes = Buffer.from('downloaded-prebuilt-kernel-iso');
    writeManifest({ url: 'https://example.invalid/khy-os-kernel.iso', sha256: sha256(isoBytes) });
    await withEnv({
      KHY_KERNEL_BUILD_BACKEND: undefined, KHY_FORCE_KERNEL_BUILD: undefined, KHY_KERNEL_BUILD_VM: undefined,
    }, async () => {
      // No WSL, no Docker, QEMU present but no appliance → QEMU rung no-ops; the
      // trailing obtain rung downloads the pinned ISO (preferObtain defaults false).
      const { spawnSync, calls } = makeWinSpawn({ wslMissing: true, dockerMissing: true, onBuild: isoWriter(tmp) });
      const downloader = pinnedDownloader({ 'khy-os-kernel.iso': isoBytes });
      const ok = await kernelBuild({ kernelDir: tmp, platform: 'win32', spawnSync, downloader, isInteractive: false });
      assert.equal(ok, true, 'obtain rung salvages the build after compile backends fail');
      assert.equal(calls.build, 0, 'no compile backend produced an ISO');
      assert.ok(
        fs.existsSync(path.join(tmp, 'cache', ISO_NAME)),
        'downloaded ISO must be cached',
      );
    });
  });

  test('offline: KHY_KHYOS_OFFLINE=1 disables every download rung → guide, never builds', async () => {
    withMakefile();
    // Pin BOTH appliance and ISO; offline must still refuse to fetch either.
    const applianceBytes = Buffer.from('appliance');
    const isoBytes = Buffer.from('iso');
    writeManifest({
      url: 'https://example.invalid/khy-os-kernel.iso', sha256: sha256(isoBytes),
      builderAppliance: { filename: 'khyos-builder.qcow2', url: 'https://example.invalid/khyos-builder.qcow2', sha256: sha256(applianceBytes) },
    });
    await withEnv({
      KHY_KERNEL_BUILD_BACKEND: undefined, KHY_FORCE_KERNEL_BUILD: undefined,
      KHY_KERNEL_BUILD_VM: undefined, KHY_KHYOS_OFFLINE: '1',
    }, async () => {
      let downloaded = false;
      const downloader = async () => { downloaded = true; };
      const { spawnSync, calls } = makeWinSpawn({ wslMissing: true, dockerMissing: true, onBuild: isoWriter(tmp) });
      const ok = await kernelBuild({ kernelDir: tmp, platform: 'win32', spawnSync, downloader, isInteractive: false });
      assert.equal(ok, false, 'offline + no local backend → guided stop');
      assert.equal(calls.build, 0);
      // The appliance download honors offline; the ISO obtain still throws on its
      // own (no local/cached ISO) without hitting the network for the appliance.
      assert.equal(downloaded, false, 'offline must not invoke the downloader for the appliance/QEMU rungs');
    });
  });

  test('backend=qemu: system QEMU ENOENT + no portable QEMU pinned → fail-soft guide, no boot', async () => {
    withMakefile();
    const img = fakeAppliance(tmp);
    // Appliance present (override), but system qemu missing and no pinned portable
    // QEMU in the manifest → cannot run; must fail-soft without booting anything.
    await withEnv({ KHY_KERNEL_BUILD_BACKEND: 'qemu', KHY_KERNEL_BUILD_VM: img }, async () => {
      const { spawnSync, calls } = makeWinSpawn({ qemuMissing: true, onBuild: isoWriter(tmp) });
      const ok = await kernelBuild({ kernelDir: tmp, platform: 'win32', spawnSync, downloader: pinnedDownloader({}) });
      assert.equal(ok, false);
      assert.equal(calls.build, 0, 'no QEMU → must not boot the appliance');
    });
  });
});

describe('khy os provision — first-run obtain-first fallback', () => {
  test('falls into the obtain-first cascade when ensureKhyosIso cannot resolve', async () => {
    // Isolated env (no local ISO, empty cache, inert manifest) → ensureKhyosIso
    // throws → provision() must invoke kernelBuild({preferObtain:true}).
    writeManifest({});
    let calledWith = null;
    const fakeBuild = async (opts) => { calledWith = opts; return true; };
    const ok = await provision({ kernelBuild: fakeBuild, downloader: pinnedDownloader({}) });
    assert.equal(ok, true, 'a successful cascade makes provision succeed');
    assert.ok(calledWith, 'provision must fall through to the build cascade');
    assert.equal(calledWith.preferObtain, true, 'first-run provision is obtain-first');
  });

  test('returns false (guided stop) when the cascade also cannot obtain/build', async () => {
    writeManifest({});
    const fakeBuild = async () => false; // cascade printed a guide and gave up
    const ok = await provision({ kernelBuild: fakeBuild });
    assert.equal(ok, false, 'a false cascade result is a guided stop, not a crash');
  });

  test('resolves directly without the cascade when an ISO already exists', async () => {
    // A local build ISO exists under the isolated KHY_KERNEL_SRC_DIR.
    writeFakeIso(path.join(tmp, 'build', ISO_NAME));
    let buildCalled = false;
    const ok = await provision({ kernelBuild: async () => { buildCalled = true; return true; } });
    assert.equal(ok, true);
    assert.equal(buildCalled, false, 'an existing ISO must not trigger the cascade');
  });
});

describe('khy os build — _wslHasDistro detection', () => {
  const ctx = (stdout, status = 0, error = null) => ({
    childEnv: {},
    spawnSync: () => (error ? { error } : { status, stdout }),
  });
  test('true when wsl -l -q lists a distro (UTF-16 NUL bytes stripped)', () => {
    // Simulate UTF-16LE → utf8 decoding artifact: NUL between chars.
    assert.equal(_wslHasDistro(ctx('U\x00b\x00u\x00n\x00t\x00u\x00\n')), true);
    assert.equal(_wslHasDistro(ctx('Ubuntu\n')), true);
  });
  test('false when no distro / empty output', () => {
    assert.equal(_wslHasDistro(ctx('')), false);
    assert.equal(_wslHasDistro(ctx('\x00\x00\n  \n')), false);
  });
  test('false when wsl.exe missing or errors', () => {
    assert.equal(_wslHasDistro(ctx('Ubuntu', 1)), false);
    assert.equal(_wslHasDistro(ctx('', 0, Object.assign(new Error('x'), { code: 'ENOENT' }))), false);
  });
});

describe('khy os build — _winToWslPath fallback mapping', () => {
  test('maps a drive-letter Windows path to /mnt/<drive>/…', () => {
    assert.equal(_winToWslPath('C:\\Users\\dev\\kernel'), '/mnt/c/Users/dev/kernel');
    assert.equal(_winToWslPath('D:/work/khy-os/kernel'), '/mnt/d/work/khy-os/kernel');
  });
  test('returns null for paths it cannot safely map (UNC / no drive)', () => {
    assert.equal(_winToWslPath('\\\\server\\share\\kernel'), null);
    assert.equal(_winToWslPath('/already/unix'), null);
    assert.equal(_winToWslPath(''), null);
  });
});

describe('khy os build — native LLVM/Limine rung (no Docker/WSL)', () => {
  const noop = () => {};
  // A resolved toolchain as ensureWindowsBuildToolchain would return it.
  const TC = {
    cc: 'C:\\tc\\clang.exe', ld: 'C:\\tc\\ld.lld.exe', asm: 'C:\\tc\\nasm.exe',
    xorriso: 'C:\\tc\\xorriso.exe', limineBin: 'C:\\tc\\limine.exe',
    limineDir: 'C:\\tc\\limine', make: 'C:\\tc\\make.exe',
    shell: 'C:\\tc\\busybox\\sh.exe', busyboxDir: 'C:\\tc\\busybox',
  };

  /** Build a native-rung ctx with an injected fake provisioner + recording spawn. */
  function nativeCtx({ toolchain = TC, missing = [], onBuild } = {}) {
    const calls = { detect: [], build: 0, buildArgs: null, buildExe: null, buildEnv: null };
    const spawnSync = (exe, args = [], opts = {}) => {
      const a = Array.isArray(args) ? args : [];
      // The make build is the call carrying the iso-limine target.
      if (a.includes('iso-limine')) {
        calls.build += 1;
        calls.buildArgs = a;
        calls.buildExe = exe;
        calls.buildEnv = opts && opts.env ? opts.env : null;
        return onBuild ? onBuild(exe, a) : { status: 0 };
      }
      calls.detect.push(String(exe));
      if (missing.some((m) => String(exe).includes(m))) {
        return { error: Object.assign(new Error('not found'), { code: 'ENOENT' }) };
      }
      return { status: 0, stdout: 'x version 1.0' };
    };
    const ctx = {
      kernelDir: tmp,
      expectedIso: path.join(tmp, 'build', ISO_NAME),
      fs, os, spawnSync,
      childEnv: { PATH: process.env.PATH || '' },
      khyos: { ensureWindowsBuildToolchain: async () => toolchain },
      printInfo: noop, printSuccess: noop, printError: noop, printWarn: noop,
    };
    return { ctx, calls };
  }

  test('degrades (false) when the toolchain is not provisionable — no probe, no build', async () => {
    const { ctx, calls } = nativeCtx({ toolchain: null });
    const ok = await _buildViaNativeToolchain(ctx);
    assert.equal(ok, false, 'null toolchain → cascade must continue to WSL/Docker');
    assert.equal(calls.build, 0, 'must not build');
    assert.equal(calls.detect.length, 0, 'must return BEFORE probing any PATH tool');
  });

  test('happy path forwards Limine + prebuilt-MoonBit make vars and the iso-limine target', async () => {
    const { ctx, calls } = nativeCtx({ onBuild: isoWriter(tmp) });
    const ok = await _buildViaNativeToolchain(ctx);
    assert.equal(ok, true);
    assert.equal(calls.build, 1, 'should run make exactly once');
    assert.equal(calls.buildExe, TC.make, 'must invoke the provisioned make.exe');

    const args = calls.buildArgs;
    assert.ok(args.includes('iso-limine'), `target must be iso-limine; got ${JSON.stringify(args)}`);
    assert.ok(args.includes('MOONBIT_PREBUILT=1'), 'must build with the vendored MoonBit artifacts');
    assert.ok(args.includes(`CC=${TC.cc}`), 'clang override forwarded');
    assert.ok(args.includes(`LD=${TC.ld}`), 'ld.lld override forwarded');
    assert.ok(args.includes(`ASM=${TC.asm}`), 'nasm override forwarded');
    assert.ok(args.includes(`XORRISO=${TC.xorriso}`), 'xorriso override forwarded');
    assert.ok(args.includes(`LIMINE=${TC.limineBin}`), 'limine override forwarded');
    assert.ok(args.includes(`LIMINE_DIR=${TC.limineDir}`), 'limine dir forwarded');
    assert.ok(args.includes(`SHELL=${TC.shell}`), 'BusyBox SHELL forwarded for POSIX recipes');
    // llvm-mingw's clang defaults to a Windows target (COFF objects + _WIN32). The
    // kernel is ELF, so the native path must force a bare-metal ELF target — this is
    // what makes ld.lld accept the C objects AND compiles out the moonbit windows.h
    // branches. Lock the forwarding in so it can never silently regress.
    assert.ok(
      args.includes('EXTRA_CFLAGS=--target=x86_64-elf'),
      `must force clang to emit x86_64 ELF (not Windows COFF); got ${JSON.stringify(args)}`,
    );
    // No grub var on the Limine path.
    assert.ok(!args.some((x) => x.startsWith('GRUB_MKRESCUE=')), 'grub must not appear on the Limine path');
  });

  test('prepends busyboxDir to the build PATH so make resolves mkdir/cp/rm directly', async () => {
    // On bare Windows, make CreateProcess-execs simple recipe lines (mkdir -p build)
    // by their first word. The applet-named .exe copies live in busyboxDir, so it
    // MUST lead the build subprocess PATH for those direct execs to resolve.
    const { ctx, calls } = nativeCtx({ onBuild: isoWriter(tmp) });
    const ok = await _buildViaNativeToolchain(ctx);
    assert.equal(ok, true);
    assert.ok(calls.buildEnv, 'the build spawn must receive an env');
    const pathKey = Object.keys(calls.buildEnv).find((k) => k.toLowerCase() === 'path');
    assert.ok(pathKey, 'build env must carry a PATH');
    // NB: drive-letter Windows paths contain ':', which collides with the host's
    // path.delimiter when this test runs on POSIX — so assert via the prefix the
    // implementation builds (busyboxDir + delimiter) rather than splitting.
    const built = String(calls.buildEnv[pathKey]);
    assert.ok(
      built.startsWith(TC.busyboxDir + path.delimiter),
      `busyboxDir must lead the build PATH; got ${built}`,
    );
    assert.ok(
      built.length > (TC.busyboxDir + path.delimiter).length,
      'the original PATH must be preserved after busyboxDir',
    );
  });

  test('Limine mode probes clang + xorriso + limine, never grub-mkrescue or moon', async () => {
    const { ctx, calls } = nativeCtx({ onBuild: isoWriter(tmp) });
    const ok = await _buildViaNativeToolchain(ctx);
    assert.equal(ok, true);
    const probed = calls.detect.join(' ');
    assert.ok(probed.includes('clang'), 'must probe clang (not gcc) on the Limine path');
    assert.ok(probed.includes('xorriso'), 'must probe xorriso');
    assert.ok(probed.includes('limine'), 'must probe the limine host tool');
    assert.ok(!probed.includes('gcc'), 'gcc must not be probed on the Limine path');
    assert.ok(!probed.includes('grub-mkrescue'), 'grub-mkrescue has no native-Windows port');
    assert.ok(!/\bmoon\b/.test(probed), 'prebuilt-MoonBit mode must not require the moon toolchain');
  });

  test('fail-soft: returns false when the provisioner throws', async () => {
    const { ctx, calls } = nativeCtx();
    ctx.khyos.ensureWindowsBuildToolchain = async () => { throw new Error('boom'); };
    const ok = await _buildViaNativeToolchain(ctx);
    assert.equal(ok, false);
    assert.equal(calls.build, 0);
  });

  test('returns false when make succeeds but the ISO never appears', async () => {
    const { ctx, calls } = nativeCtx({ onBuild: () => ({ status: 0 }) });
    const ok = await _buildViaNativeToolchain(ctx);
    assert.equal(ok, false, 'a build that yields no ISO must not report success');
    assert.equal(calls.build, 1);
  });
});

describe('_looksLikeIso — bootable-shape verification', () => {
  test('accepts a ≥64 KiB file carrying the ISO9660 CD001 magic at 0x8001', () => {
    const p = path.join(tmp, 'good.iso');
    writeFakeIso(p);
    assert.deepEqual(_looksLikeIso(fs, p), { ok: true });
  });

  test('rejects a truncated/tiny file (download cut short)', () => {
    const p = path.join(tmp, 'tiny.iso');
    fs.writeFileSync(p, 'iso-bytes'); // the old fake — 9 bytes
    const r = _looksLikeIso(fs, p);
    assert.equal(r.ok, false);
    assert.match(r.reason, /过小/);
  });

  test('rejects a ≥64 KiB file missing the CD001 identifier (not an ISO)', () => {
    const p = path.join(tmp, 'notiso.iso');
    fs.writeFileSync(p, Buffer.alloc(72 * 1024)); // big enough, but all zeros
    const r = _looksLikeIso(fs, p);
    assert.equal(r.ok, false);
    assert.match(r.reason, /CD001/);
  });

  test('fail-soft: an unreadable path is treated as present (ok), not a hard error', () => {
    const r = _looksLikeIso(fs, path.join(tmp, 'does-not-exist.iso'));
    assert.equal(r.ok, true, 'a stat/read error must not block a build that produced output');
  });
});

describe('_windowsKernelBuild — consolidated failure report', () => {
  /** Capture printInfo/printWarn lines so we can assert the single summary block. */
  function reportCtx() {
    const lines = [];
    const ctx = {
      kernelDir: tmp,
      expectedIso: path.join(tmp, 'build', ISO_NAME),
      fs, os,
      // No WSL distro, no docker, no QEMU, inert obtain → every rung fails.
      spawnSync: (exe) => {
        if (String(exe).includes('wsl')) return { status: 0, stdout: '' };
        return { error: Object.assign(new Error('not found'), { code: 'ENOENT' }) };
      },
      childEnv: { PATH: '' },
      isInteractive: false, // unattended → _offerWslAutoSetup only prints a guide
      confirm: async () => false,
      // Native rung degrades immediately (no provisioner) before probing PATH.
      khyos: {
        ensureWindowsBuildToolchain: async () => null,
        ensureKhyosIso: async () => { throw new Error('no pinned ISO'); },
        ensurePortableQemu: async () => null,
        ensureBuilderAppliance: async () => null,
        khyosCacheDir: () => path.join(tmp, 'cache'),
      },
      printInfo: (m) => lines.push(['info', m]),
      printSuccess: (m) => lines.push(['ok', m]),
      printWarn: (m) => lines.push(['warn', m]),
      printError: (m) => lines.push(['err', m]),
    };
    return { ctx, lines };
  }

  test('every rung failing prints ONE summary naming each rung + a fix list', async () => {
    const { ctx, lines } = reportCtx();
    await withEnv(
      { KHY_KERNEL_BUILD_BACKEND: undefined, KHY_FORCE_KERNEL_BUILD: undefined, KHY_KHYOS_OFFLINE: undefined },
      async () => {
        const ok = await _windowsKernelBuild({ ...ctx, preferObtain: true });
        assert.equal(ok, false, 'no backend → guided stop');
      },
    );
    const text = lines.map((l) => l[1]).join('\n');
    // Consolidated header + each rung named with a reason.
    assert.match(text, /各方式失败原因汇总/);
    assert.match(text, /原生工具链构建/);
    assert.match(text, /WSL2 构建.*未安装 WSL2 发行版|未安装 WSL2 发行版/s);
    assert.match(text, /Docker 构建.*未检测到 docker|未检测到 docker/s);
    assert.match(text, /QEMU 构建虚拟机/);
    // The QEMU rung degrades QUIETLY in the auto cascade: it must NOT present QEMU
    // as a missing build prerequisite — QEMU is a run-time requirement only. (Goal:
    // a bare pip-install Windows build never reports a missing-QEMU error.)
    assert.doesNotMatch(text, /QEMU 未安装/);
    assert.match(text, /QEMU 仅用于运行内核/);
    // Actionable next-step block points at the most stable fix first.
    assert.match(text, /KHY_KERNEL_ISO_URL/);
    assert.match(text, /KHY_KERNEL_ISO_SHA256/);
    assert.match(text, /HTTPS_PROXY/);
    assert.match(text, /khy os setup-wsl/);
  });

  test('_printBuildFailureReport is a no-op on an empty ledger', () => {
    const lines = [];
    _printBuildFailureReport(
      { printWarn: (m) => lines.push(m), printInfo: (m) => lines.push(m) },
      [],
    );
    assert.equal(lines.length, 0, 'nothing to report → print nothing');
  });
});

describe('_windowsKernelBuild — QEMU is run-time, not a build prerequisite', () => {
  // A ctx whose every backend probe fails (qemu/wsl/docker missing) and whose
  // provisioners resolve nothing, capturing the print stream so we can assert on
  // the QEMU-missing wording. Mirrors the consolidated-report ctx.
  function bareCtx() {
    const lines = [];
    const ctx = {
      kernelDir: tmp,
      expectedIso: path.join(tmp, 'build', ISO_NAME),
      fs, os,
      // wsl.exe present but no distro; everything else (qemu/docker/toolchain) ENOENT.
      spawnSync: (exe) => {
        if (String(exe).includes('wsl')) return { status: 0, stdout: '' };
        return { error: Object.assign(new Error('not found'), { code: 'ENOENT' }) };
      },
      childEnv: { PATH: '' },
      isInteractive: false,
      confirm: async () => false,
      khyos: {
        ensureWindowsBuildToolchain: async () => null,
        ensureKhyosIso: async () => { throw new Error('no pinned ISO'); },
        ensurePortableQemu: async () => null,
        ensureBuilderAppliance: async () => null,
        khyosCacheDir: () => path.join(tmp, 'cache'),
      },
      printInfo: (m) => lines.push(['info', m]),
      printSuccess: (m) => lines.push(['ok', m]),
      printWarn: (m) => lines.push(['warn', m]),
      printError: (m) => lines.push(['err', m]),
    };
    return { ctx, lines };
  }

  test('auto cascade (bare pip install): QEMU missing → never prints a missing-QEMU error', async () => {
    withMakefile();
    const { ctx, lines } = bareCtx();
    await withEnv(
      { KHY_KERNEL_BUILD_BACKEND: undefined, KHY_FORCE_KERNEL_BUILD: undefined, KHY_KHYOS_OFFLINE: undefined },
      async () => {
        const ok = await _windowsKernelBuild({ ...ctx, preferObtain: true });
        assert.equal(ok, false, 'no backend → guided stop');
      },
    );
    const errText = lines.filter((l) => l[0] === 'err').map((l) => l[1]).join('\n');
    // The whole point of the goal: the auto build must not surface QEMU as missing.
    assert.doesNotMatch(errText, /QEMU 未安装/);
    assert.doesNotMatch(errText, /无法经构建虚拟机构建内核 ISO/);
  });

  test('explicit backend=qemu: still surfaces the loud missing-QEMU guidance', async () => {
    withMakefile();
    const { ctx, lines } = bareCtx();
    await withEnv({ KHY_KERNEL_BUILD_BACKEND: 'qemu' }, async () => {
      const ok = await _windowsKernelBuild({ ...ctx });
      assert.equal(ok, false);
    });
    const errText = lines.filter((l) => l[0] === 'err').map((l) => l[1]).join('\n');
    // The user explicitly chose the QEMU builder-VM backend → the missing QEMU IS
    // the actionable cause and must be reported.
    assert.match(errText, /QEMU 未安装/);
  });
});
