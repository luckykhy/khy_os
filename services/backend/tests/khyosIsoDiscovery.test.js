'use strict';

/**
 * Regression tests for kernel-ISO auto-discovery (isoProvisioner.repoKernelIso).
 *
 * Root cause this guards against: @khy/shared ships at TWO depths in the pip
 * wheel — platform/packages/shared (kernel root 6 levels up) and
 * services/backend/vendor/shared (kernel root 7 levels up). The backend resolves
 * the vendor copy via `file:./vendor/shared`. A hardcoded 6-level `..` jump from
 * the vendor copy landed in `<bundle>/services/`, so an ISO that `khy os build`
 * correctly wrote to `<bundle>/kernel/build/khy-os-kernel.iso` was never found —
 * surfacing as "No KHY OS ISO available" even right after a successful build.
 *
 * The fix walks upward from the module dir to the first `kernel/build/<ISO>`,
 * which resolves BOTH wheel depths (and the symlinked dev layout) without
 * guessing. These tests synthesize a wheel-shaped bundle on disk and assert the
 * ISO is discovered from each shared-copy location.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  repoKernelIso,
} = require('@khy/shared/runtime/khyos');

const ISO_NAME = 'khy-os-kernel.iso';

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-iso-discovery-'));
});
afterEach(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** Run fn with env overlaid (undefined deletes the key), restoring afterwards. */
function withEnv(overlay, fn) {
  const saved = {};
  for (const k of Object.keys(overlay)) {
    saved[k] = process.env[k];
    if (overlay[k] === undefined) delete process.env[k];
    else process.env[k] = overlay[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/**
 * Build a wheel-shaped bundle under `tmp`:
 *   <bundle>/kernel/build/khy-os-kernel.iso   (where `khy os build` lands it)
 *   <bundle>/platform/packages/shared/src/runtime/khyos      (6 levels up)
 *   <bundle>/services/backend/vendor/shared/src/runtime/khyos (7 levels up)
 * Returns the two module dirs and the ISO path. `withIso=false` omits the ISO.
 */
function makeBundle({ withIso = true } = {}) {
  const bundle = path.join(tmp, 'bundle');
  const isoDir = path.join(bundle, 'kernel', 'build');
  fs.mkdirSync(isoDir, { recursive: true });
  const isoPath = path.join(isoDir, ISO_NAME);
  if (withIso) fs.writeFileSync(isoPath, 'FAKE-ISO');

  const platformDir = path.join(
    bundle, 'platform', 'packages', 'shared', 'src', 'runtime', 'khyos'
  );
  const vendorDir = path.join(
    bundle, 'services', 'backend', 'vendor', 'shared', 'src', 'runtime', 'khyos'
  );
  fs.mkdirSync(platformDir, { recursive: true });
  fs.mkdirSync(vendorDir, { recursive: true });

  return { bundle, isoPath, platformDir, vendorDir };
}

describe('repoKernelIso — wheel-shaped discovery', () => {
  test('discovers the ISO from the platform/packages/shared copy (6 levels up)', () => {
    const { isoPath, platformDir } = makeBundle();
    withEnv({ KHY_KERNEL_SRC_DIR: undefined }, () => {
      assert.equal(repoKernelIso(platformDir), isoPath);
    });
  });

  test('discovers the ISO from the services/backend/vendor/shared copy (7 levels up)', () => {
    // This is the copy the backend actually loads — the bug case.
    const { isoPath, vendorDir } = makeBundle();
    withEnv({ KHY_KERNEL_SRC_DIR: undefined }, () => {
      assert.equal(repoKernelIso(vendorDir), isoPath);
    });
  });

  test('returns null when no ISO has been built (both copies)', () => {
    const { platformDir, vendorDir } = makeBundle({ withIso: false });
    withEnv({ KHY_KERNEL_SRC_DIR: undefined }, () => {
      assert.equal(repoKernelIso(platformDir), null);
      assert.equal(repoKernelIso(vendorDir), null);
    });
  });

  test('KHY_KERNEL_SRC_DIR override points discovery at a custom build dir', () => {
    const { vendorDir } = makeBundle({ withIso: false });
    const customSrc = path.join(tmp, 'custom-kernel');
    const customBuild = path.join(customSrc, 'build');
    fs.mkdirSync(customBuild, { recursive: true });
    const customIso = path.join(customBuild, ISO_NAME);
    fs.writeFileSync(customIso, 'FAKE');
    withEnv({ KHY_KERNEL_SRC_DIR: customSrc }, () => {
      assert.equal(repoKernelIso(vendorDir), customIso);
    });
  });

  test('KHY_KERNEL_SRC_DIR override returns null when that dir has no ISO', () => {
    const { vendorDir } = makeBundle(); // bundle HAS an ISO...
    const emptySrc = path.join(tmp, 'empty-kernel');
    fs.mkdirSync(emptySrc, { recursive: true });
    // ...but the explicit override wins and finds none there.
    withEnv({ KHY_KERNEL_SRC_DIR: emptySrc }, () => {
      assert.equal(repoKernelIso(vendorDir), null);
    });
  });

  test('does not walk above the filesystem root for an orphan module dir', () => {
    const orphan = path.join(tmp, 'no', 'kernel', 'anywhere', 'here');
    fs.mkdirSync(orphan, { recursive: true });
    withEnv({ KHY_KERNEL_SRC_DIR: undefined }, () => {
      assert.equal(repoKernelIso(orphan), null);
    });
  });
});
