'use strict';

/**
 * Offline guard for the khyos manifest's native-Windows build toolchain pins.
 *
 * Runs in CI without network: it protects against two regressions that would
 * silently break the post-pip Windows kernel build —
 *   1. a tool losing its pin (empty/!64-hex sha256, or empty url) — the whole
 *      native rung is all-or-nothing, so one hole sinks it;
 *   2. a tool pinned to a GitHub *branch* archive (`/archive/refs/heads/…`), whose
 *      sha256 drifts whenever the branch moves, breaking the build with no code
 *      change. Any such URL MUST be tracked in PENDING_REPIN and re-pinned to an
 *      immutable per-commit URL via `scripts/release/pin-khyos-toolchain.js`.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { isBranchArchive, lintPins } = require('../../../scripts/release/pin-khyos-toolchain');

// Resolve the manifest next to the provisioner module (works in dev + vendored).
const MANIFEST_PATH = path.join(
  path.dirname(require.resolve('@khy/shared/runtime/khyos/toolchainProvisioner')),
  'khyos-manifest.json',
);
const { REQUIRED_TOOLS } = require('@khy/shared/runtime/khyos/toolchainProvisioner');

/**
 * Tools currently pinned to an unstable branch archive, pending a network-machine
 * re-pin to an immutable commit URL. Empty this as each is re-pinned; the test
 * fails if a NEW branch-archive pin appears, or if an entry here is stale.
 */
const PENDING_REPIN = new Set([]);

function loadTable() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
  const table = manifest.toolchain && manifest.toolchain['win32-x64'];
  assert.ok(table, 'manifest must carry a win32-x64 toolchain table');
  return table;
}

describe('khyos toolchain manifest pins', () => {
  test('every required tool is pinned (url + 64-hex sha256)', () => {
    const table = loadTable();
    for (const name of REQUIRED_TOOLS) {
      const e = table[name];
      assert.ok(e, `missing toolchain entry: ${name}`);
      assert.ok(e.url && /^https?:\/\//i.test(e.url), `${name}: url must be a real http(s) URL`);
      assert.match(e.sha256 || '', /^[0-9a-f]{64}$/i, `${name}: sha256 must be 64 hex chars`);
    }
  });

  test('branch-archive URLs are exactly the tracked PENDING_REPIN set', () => {
    const table = loadTable();
    const branchTools = new Set();
    for (const name of REQUIRED_TOOLS) {
      if (isBranchArchive(table[name] && table[name].url)) branchTools.add(name);
    }
    // Any branch-archive pin not yet tracked is a NEW hazard → fail loudly.
    for (const name of branchTools) {
      assert.ok(
        PENDING_REPIN.has(name),
        `${name} uses an unstable branch-archive URL but is not tracked in PENDING_REPIN — ` +
        `re-pin it with: node scripts/release/pin-khyos-toolchain.js ${name}`,
      );
    }
    // No stale tracking: every PENDING_REPIN entry must still be a branch archive.
    for (const name of PENDING_REPIN) {
      assert.ok(
        branchTools.has(name),
        `${name} is in PENDING_REPIN but no longer uses a branch archive — remove it from the set`,
      );
    }
  });

  test('mirrors, when present, are an array of http(s) URLs', () => {
    const table = loadTable();
    for (const name of REQUIRED_TOOLS) {
      const m = table[name] && table[name].mirrors;
      if (m === undefined) continue;
      assert.ok(Array.isArray(m), `${name}: mirrors must be an array`);
      for (const u of m) assert.match(u, /^https?:\/\//i, `${name}: mirror must be http(s)`);
    }
  });
});

describe('lintPins — network-free release gate', () => {
  // A fully-stable table: every required tool pinned to an immutable url + sha.
  const goodSha = 'a'.repeat(64);
  function stableTable() {
    const t = {};
    for (const name of REQUIRED_TOOLS) {
      t[name] = { url: `https://example.invalid/${name}.zip`, sha256: goodSha };
    }
    return t;
  }

  test('clean on a fully-stable table', () => {
    assert.deepEqual(lintPins(stableTable()), []);
  });

  test('flags a GitHub branch-archive pin (the drift hazard)', () => {
    const t = stableTable();
    t.xorriso.url = 'https://github.com/o/r/archive/refs/heads/master.zip';
    const problems = lintPins(t);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /xorriso/);
    assert.match(problems[0], /分支归档|branch/i);
  });

  test('flags a missing entry, a bad url, and a malformed sha', () => {
    const t = stableTable();
    delete t.nasm;                       // missing
    t.make.url = 'ftp://example.invalid/make.zip'; // non-http(s)
    t.busybox.sha256 = 'not-a-sha';      // malformed
    const problems = lintPins(t).join('\n');
    assert.match(problems, /nasm/);
    assert.match(problems, /make/);
    assert.match(problems, /busybox/);
  });

  test('flags a non-array / non-http(s) mirror', () => {
    const t = stableTable();
    t.limine.mirrors = 'https://m.invalid/x.zip'; // string, not array
    t.llvm.mirrors = ['ftp://m.invalid/x.zip'];   // bad scheme
    const problems = lintPins(t).join('\n');
    assert.match(problems, /limine: mirrors 必须是数组/);
    assert.match(problems, /llvm: mirror 非 http/);
  });
});
