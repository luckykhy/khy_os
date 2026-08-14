#!/usr/bin/env node
'use strict';

/**
 * Maintainer helper: pin / re-pin the native bare-Windows build toolchain in
 * platform/packages/shared/src/runtime/khyos/khyos-manifest.json (the `toolchain`
 * table). Downloads each tool, computes its SHA256, and writes it back. Reuses the
 * provisioner's own proxy-aware downloader so it pins through the same network
 * path the runtime uses (HTTPS_PROXY / HTTP_PROXY / KHY_KHYOS_MIRROR_BASE honored).
 *
 * It also REMOVES the single biggest stability hazard: a GitHub *branch* archive
 * (`/archive/refs/heads/<branch>.zip`) is regenerated whenever the branch moves,
 * so its sha256 drifts and the pinned download starts failing with no code change.
 * For such URLs this resolves the branch's current commit via the GitHub API and
 * rewrites the URL to the immutable `/archive/<commit>.zip` form — byte-identical
 * to the branch tip at pin time, but frozen, so the sha never drifts again.
 *
 * Network access to the upstream hosts (and api.github.com) is required; the CLI
 * sandbox cannot reach them, which is why pinning is a separate maintainer step.
 *
 * Usage:
 *   node scripts/release/pin-khyos-toolchain.js                Pin/re-pin all tools (win32-x64)
 *   node scripts/release/pin-khyos-toolchain.js xorriso        Pin one tool only
 *   node scripts/release/pin-khyos-toolchain.js --check        Verify pins; exit 1 on mismatch
 *                                                              OR any remaining branch-archive URL
 *   node scripts/release/pin-khyos-toolchain.js --lint         Network-FREE release gate: exit 1 on
 *                                                              any missing/branch-archive/bad-format pin
 *   node scripts/release/pin-khyos-toolchain.js --platform win32-x64
 *   node scripts/release/pin-khyos-toolchain.js --qemu         Pin the portable QEMU zip
 *                                                              (manifest.qemu[platform]: sha256 + size)
 *                                                              from its already-set url. RUN-path
 *                                                              prerequisite; optional (degrades
 *                                                              gracefully when unpinned).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST_PATH = path.join(
  REPO_ROOT,
  'platform', 'packages', 'shared', 'src', 'runtime', 'khyos', 'khyos-manifest.json',
);

// Reuse the runtime's proxy-aware download + hashing primitives (single path).
const { httpsDownload, sha256File } = require(path.join(
  REPO_ROOT, 'platform', 'packages', 'shared', 'src', 'runtime', 'khyos', '_artifact',
));
// The authoritative list of tools the native rung needs (all-or-nothing).
const { REQUIRED_TOOLS } = require(path.join(
  REPO_ROOT, 'platform', 'packages', 'shared', 'src', 'runtime', 'khyos', 'toolchainProvisioner',
));

const BRANCH_ARCHIVE_RE =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/archive\/refs\/heads\/([^/]+)\.(zip|tar\.gz)$/i;

function isBranchArchive(url) {
  return BRANCH_ARCHIVE_RE.test(String(url || ''));
}

/** Resolve a GitHub branch archive URL to an immutable per-commit archive URL. */
async function resolveBranchToCommit(url, tmpDir) {
  const m = BRANCH_ARCHIVE_RE.exec(url);
  if (!m) return url;
  const [, owner, repo, branch, ext] = m;
  const api = `https://api.github.com/repos/${owner}/${repo}/branches/${branch}`;
  const dest = path.join(tmpDir, 'branch.json');
  await httpsDownload(api, dest, { env: process.env });
  const sha = JSON.parse(fs.readFileSync(dest, 'utf-8')).commit.sha;
  fs.rmSync(dest, { force: true });
  // Per-commit archives are immutable and byte-identical to the branch tip.
  return `https://github.com/${owner}/${repo}/archive/${sha}.${ext}`;
}

function isHex64(s) {
  return typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s);
}

/**
 * Network-free release lint: assert every required tool is *stably* pinned, so a
 * wheel carrying a drift-prone pin can never be published. This is the release-time
 * half of the "strict-pin + graceful-degrade" posture — it blocks the hazard at
 * its source instead of trusting a recomputed sha at install time (which would
 * defeat the pin). Returns an array of human-readable problems (empty == clean).
 *
 * Unlike --check it performs NO downloads, so it runs in any CI step (and offline):
 *   - missing entry / non-http(s) url / empty-or-malformed sha256  → hard problem
 *   - GitHub *branch* archive url (sha drifts when the branch moves) → hard problem,
 *     with the exact re-pin command. There is no PENDING_REPIN grace here: at
 *     release, zero drift hazards may remain (the unit test tracks dev-time debt;
 *     the release gate tolerates none).
 */
function lintPins(table) {
  const problems = [];
  for (const name of REQUIRED_TOOLS) {
    const e = table[name];
    if (!e || !e.url) { problems.push(`${name}: 缺少 url（未固定）`); continue; }
    if (!/^https?:\/\//i.test(e.url)) problems.push(`${name}: url 非 http(s): ${e.url}`);
    if (isBranchArchive(e.url)) {
      problems.push(
        `${name}: 使用 GitHub 分支归档，sha256 会随分支移动漂移 — 重新固定为不可变 commit: ` +
        `node scripts/release/pin-khyos-toolchain.js ${name}`,
      );
    }
    if (!isHex64(e.sha256)) problems.push(`${name}: sha256 缺失或非 64 位十六进制`);
    if (e.mirrors !== undefined) {
      if (!Array.isArray(e.mirrors)) problems.push(`${name}: mirrors 必须是数组`);
      else for (const u of e.mirrors) {
        if (!/^https?:\/\//i.test(u)) problems.push(`${name}: mirror 非 http(s): ${u}`);
      }
    }
  }
  return problems;
}

/**
 * Pin the run-path portable QEMU zip: download `manifest.qemu[platformKey].url`,
 * compute its sha256 + byte size, and write both back. Unlike the toolchain table
 * this is OPTIONAL — an unpinned entry simply degrades to the "install QEMU" hint
 * at runtime (ensurePortableQemu returns null), so it is intentionally NOT part of
 * the release `--lint` gate. The url is authored by the maintainer (a self-hosted
 * GitHub Release asset); this only fills the integrity fields.
 *
 * @param {object} manifest    parsed khyos-manifest.json (mutated on pin)
 * @param {string} platformKey e.g. 'win32-x64'
 * @param {{checkOnly?: boolean}} [opts]
 */
async function pinQemu(manifest, platformKey, opts = {}) {
  const { checkOnly = false } = opts;
  const entry = manifest.qemu && manifest.qemu[platformKey];
  if (!entry) {
    console.error(`No qemu entry for platform '${platformKey}'.`);
    process.exit(2);
  }
  if (!entry.url) {
    console.error(
      `qemu[${platformKey}].url is empty — set it to the portable QEMU zip URL ` +
      '(a self-hosted GitHub Release asset) before pinning.',
    );
    process.exit(2);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-qemu-pin-'));
  try {
    const archive = path.join(tmpDir, path.basename(entry.url) || 'qemu.zip');
    process.stdout.write(`[qemu] downloading ${entry.url} ... `);
    await httpsDownload(entry.url, archive, { env: process.env });
    const hash = sha256File(archive);
    const size = fs.statSync(archive).size;
    console.log(`${hash} (${size} bytes)`);

    if (checkOnly) {
      let problems = 0;
      if ((entry.sha256 || '').toLowerCase() !== hash.toLowerCase()) {
        console.log(`    MISMATCH sha256: manifest='${entry.sha256 || '(empty)'}' computed='${hash}'`);
        problems++;
      }
      if (Number(entry.size) !== size) {
        console.log(`    MISMATCH size: manifest='${entry.size}' computed='${size}'`);
        problems++;
      }
      if (problems > 0) { console.error(`\n${problems} qemu pin problem(s).`); process.exit(1); }
      console.log('\nqemu pin matches.');
      return;
    }

    if (entry.sha256 !== hash || Number(entry.size) !== size) {
      entry.sha256 = hash;
      entry.size = size;
      fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
      console.log(`\nManifest updated: ${MANIFEST_PATH}`);
      console.log('Review and commit the change.');
    } else {
      console.log('\nNo changes (qemu already pinned).');
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes('--check');
  const lintOnly = argv.includes('--lint');
  const qemuOnly = argv.includes('--qemu');
  const platIdx = argv.indexOf('--platform');
  const platformKey = platIdx >= 0 ? argv[platIdx + 1] : 'win32-x64';
  const nameFilter = argv.find((a) => !a.startsWith('--') && a !== platformKey) || null;

  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`Manifest not found: ${MANIFEST_PATH}`);
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));

  // --qemu: pin the run-path portable QEMU zip (separate table from `toolchain`).
  if (qemuOnly) {
    await pinQemu(manifest, platformKey, { checkOnly });
    return;
  }

  const table = manifest.toolchain && manifest.toolchain[platformKey];
  if (!table) {
    console.error(`No toolchain table for platform '${platformKey}'.`);
    process.exit(2);
  }

  // --lint: network-free release gate. Block publishing any drift-prone pin.
  if (lintOnly) {
    const problems = lintPins(table);
    if (problems.length) {
      console.error(`khyos 工具链固定校验失败（${platformKey}）：`);
      for (const p of problems) console.error(`  ✗ ${p}`);
      console.error('\n带漂移隐患的清单不可发布。请在联网机上重新固定后再发布。');
      process.exit(1);
    }
    console.log(`khyos 工具链固定校验通过（${platformKey}）：全部已稳定固定，无分支归档。`);
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-tc-pin-'));
  let changed = false;
  let problems = 0;
  let processed = 0;

  try {
    for (const [name, entry] of Object.entries(table)) {
      if (nameFilter && name !== nameFilter) continue;
      if (!entry || !entry.url) { console.log(`[${name}] no url — skipped`); continue; }
      processed++;

      // --check: refuse any remaining branch-archive URL (drift hazard).
      if (isBranchArchive(entry.url)) {
        if (checkOnly) {
          console.log(`[${name}] BRANCH-ARCHIVE URL (unstable, sha will drift): ${entry.url}`);
          problems++;
          continue;
        }
        try {
          const stable = await resolveBranchToCommit(entry.url, tmpDir);
          console.log(`[${name}] branch → commit pin: ${stable}`);
          entry.url = stable;
          changed = true;
        } catch (err) {
          console.log(`[${name}] failed to resolve branch commit: ${err.message}`);
          problems++;
          continue;
        }
      }

      const archive = path.join(tmpDir, `${name}-${path.basename(entry.url)}`);
      process.stdout.write(`[${name}] downloading ${entry.url} ... `);
      try {
        await httpsDownload(entry.url, archive, { env: process.env });
      } catch (err) {
        console.log(`FAILED (${err.message})`);
        problems++;
        continue;
      }
      const hash = sha256File(archive);
      console.log(hash);
      fs.rmSync(archive, { force: true });

      if (checkOnly) {
        if ((entry.sha256 || '').toLowerCase() !== hash.toLowerCase()) {
          console.log(`    MISMATCH: manifest='${entry.sha256 || '(empty)'}' computed='${hash}'`);
          problems++;
        }
      } else if (entry.sha256 !== hash) {
        entry.sha256 = hash;
        changed = true;
      }
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  if (processed === 0) {
    console.error(nameFilter ? `No tool '${nameFilter}' in ${platformKey}.` : 'No pinnable tools found.');
    process.exit(2);
  }

  if (checkOnly) {
    if (problems > 0) {
      console.error(`\n${problems} toolchain pin problem(s) found.`);
      process.exit(1);
    }
    console.log('\nAll toolchain pins match and none use a branch archive.');
    return;
  }

  if (changed) {
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    console.log(`\nManifest updated: ${MANIFEST_PATH}`);
    console.log('Review and commit the change.');
  } else {
    console.log('\nNo changes (toolchain already pinned and stable).');
  }
  if (problems > 0) process.exit(1);
}

module.exports = { isBranchArchive, BRANCH_ARCHIVE_RE, lintPins, pinQemu };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message || String(err));
    process.exit(1);
  });
}
