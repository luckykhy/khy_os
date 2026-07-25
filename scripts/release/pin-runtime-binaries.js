#!/usr/bin/env node
'use strict';

/**
 * Maintainer helper: pin SHA256 hashes for the on-demand inference runtimes.
 *
 * Reads services/backend/config/runtime-binaries.json, downloads each pinned
 * platform archive from its upstream `url`, computes the SHA256, and writes it
 * back into the manifest's `sha256` field. With an empty sha256 the runtime
 * provisioner refuses to fetch (it silently falls back to the system binary), so
 * running this script is what "arms" on-demand provisioning for a platform.
 *
 * This requires network access to the upstream hosts (GitHub releases). The CLI
 * sandbox cannot reach them, which is why pinning is a separate maintainer step
 * run in an environment that can.
 *
 * Usage:
 *   node scripts/release/pin-runtime-binaries.js                 Pin all runtimes/platforms
 *   node scripts/release/pin-runtime-binaries.js ollama-runner   Pin one runtime only
 *   node scripts/release/pin-runtime-binaries.js --check         Verify existing pins; exit 1 on mismatch (no writes)
 *   node scripts/release/pin-runtime-binaries.js --verify-layout Also extract and confirm the sentinel path
 *
 * Honors HTTPS_PROXY/HTTP_PROXY and KHY_RUNTIME_MIRROR_BASE (same as the
 * provisioner), so it can pin from a mirror as well.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'services', 'backend', 'config', 'runtime-binaries.json');

function requireAxios() {
  const axios = require(require.resolve('axios', {
    paths: [
      path.join(REPO_ROOT, 'node_modules'),
      path.join(REPO_ROOT, 'services', 'backend', 'node_modules'),
    ],
  }));
  return axios.default || axios;
}

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

async function download(url, destPath) {
  const axios = requireAxios();
  const response = await axios({
    method: 'get',
    url,
    responseType: 'stream',
    timeout: 30 * 60 * 1000,
    maxRedirects: 5,
    headers: { 'User-Agent': 'khy-runtime-pin' },
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
    ws.on('finish', () => { if (!settled) { settled = true; resolve(); } });
    response.data.pipe(ws);
  });
}

function resolveUrl(manifest, plat) {
  const envKey = manifest.mirrorBaseEnv || 'KHY_RUNTIME_MIRROR_BASE';
  const mirrorBase = String(process.env[envKey] || '').trim();
  if (mirrorBase) {
    const file = plat.filename || path.basename(plat.url || '');
    return `${mirrorBase.replace(/\/+$/, '')}/${file}`;
  }
  return plat.url;
}

/** Best-effort extraction + sentinel BFS, to confirm/suggest sourceSubdir. */
function probeLayout(archivePath, format, sentinel, tmpDir) {
  const staging = path.join(tmpDir, 'layout');
  fs.mkdirSync(staging, { recursive: true });
  let cmd;
  let args;
  if (format === 'zip') {
    cmd = 'unzip'; args = ['-q', '-o', archivePath, '-d', staging];
  } else {
    cmd = 'tar'; args = ['-xzf', archivePath, '-C', staging];
  }
  const r = spawnSync(cmd, args, { encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) return { ok: false, reason: (r.stderr || r.error?.message || 'extract failed').slice(0, 200) };

  const queue = [{ dir: staging, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (fs.existsSync(path.join(dir, sentinel))) {
      const rel = path.relative(staging, dir) || '.';
      return { ok: true, sourceSubdir: rel };
    }
    if (depth >= 5) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
  }
  return { ok: false, reason: `sentinel '${sentinel}' not located` };
}

async function main() {
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes('--check');
  const verifyLayout = argv.includes('--verify-layout');
  const nameFilter = argv.find((a) => !a.startsWith('--')) || null;

  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`Manifest not found: ${MANIFEST_PATH}`);
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-pin-'));
  let changed = false;
  let mismatches = 0;
  let processed = 0;

  try {
    for (const [rtName, rt] of Object.entries(manifest.runtimes || {})) {
      if (nameFilter && rtName !== nameFilter) continue;
      for (const [platKey, plat] of Object.entries(rt.platforms || {})) {
        if (!plat || !plat.url) continue; // null entry → no binary for this platform
        processed++;
        const url = resolveUrl(manifest, plat);
        const archive = path.join(tmpDir, `${rtName}-${platKey}-${path.basename(plat.url)}`);
        process.stdout.write(`[${rtName}/${platKey}] downloading ${url} ... `);
        try {
          await download(url, archive);
        } catch (err) {
          console.log(`FAILED (${err.message})`);
          mismatches++;
          continue;
        }
        const hash = sha256File(archive);
        console.log(hash);

        if (verifyLayout) {
          const layout = probeLayout(archive, plat.format, plat.sentinel || rt.sentinel, tmpDir);
          if (layout.ok) {
            if (plat.sourceSubdir && plat.sourceSubdir !== layout.sourceSubdir) {
              console.log(`    sourceSubdir: manifest='${plat.sourceSubdir}' actual='${layout.sourceSubdir}' (updating)`);
              plat.sourceSubdir = layout.sourceSubdir;
              changed = true;
            } else {
              console.log(`    sourceSubdir confirmed: '${layout.sourceSubdir}'`);
            }
          } else {
            console.log(`    layout probe: ${layout.reason}`);
          }
        }

        if (checkOnly) {
          if ((plat.sha256 || '').toLowerCase() !== hash.toLowerCase()) {
            console.log(`    MISMATCH: manifest='${plat.sha256 || '(empty)'}' computed='${hash}'`);
            mismatches++;
          }
        } else if (plat.sha256 !== hash) {
          plat.sha256 = hash;
          changed = true;
        }

        try { fs.rmSync(archive, { force: true }); } catch { /* ignore */ }
      }
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  if (processed === 0) {
    console.error(nameFilter ? `No pinnable platform entries for runtime '${nameFilter}'.` : 'No pinnable platform entries found.');
    process.exit(2);
  }

  if (checkOnly) {
    if (mismatches > 0) {
      console.error(`\n${mismatches} pin mismatch(es) found.`);
      process.exit(1);
    }
    console.log('\nAll pins match.');
    return;
  }

  if (changed) {
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    console.log(`\nManifest updated: ${MANIFEST_PATH}`);
    console.log('Review and commit the change.');
  } else {
    console.log('\nNo changes (manifest already up to date).');
  }
  if (mismatches > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
