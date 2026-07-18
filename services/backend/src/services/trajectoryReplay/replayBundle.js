'use strict';

/**
 * replayBundle.js — self-contained, portable replay bundle (DESIGN-ARCH-048 PHASE 3).
 *
 * Packages a recorded trajectory into a single directory that can reproduce its
 * file artifacts later — even after the originals are deleted — with no AI and no
 * dependency on the live session store. Layout:
 *
 *   <out>/<sessionId>.replaybundle/
 *     ├─ manifest.json        bundle metadata + steps (ledger entries by seq) + integrity
 *     ├─ ledger.jsonl         verbatim copy of the replay ledger (append-only source)
 *     ├─ env.json             environment fingerprint captured at export
 *     ├─ content/<sha256>     FILE-tier after-bytes, content-addressed & de-duplicated
 *     └─ chain.json           (optional) copy of the tamper-evident trace chain
 *
 * Content is addressed by sha256 so identical bytes are stored once. NETWORK_AI
 * steps are preserved in the manifest but counted as `skipped` (not reproducible).
 * Every export/read/verify is total: failures surface as a structured result,
 * never an uncaught throw.
 */

const fs = require('fs');
const path = require('path');

const replayLedger = require('./replayLedger');
const envFingerprint = require('./envFingerprint');
const artifactHash = require('./artifactHash');
const tierRegistry = require('./tierRegistry');

const BUNDLE_VERSION = 1;
const BUNDLE_KIND = 'khyos-replay-bundle';
const BUNDLE_DIR_SUFFIX = '.replaybundle';

function _captureContentEnabled() {
  const v = String(process.env.KHY_REPLAY_CAPTURE_CONTENT || 'on').toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

/** Default export root for a session's bundle. */
function _defaultOutDir(sessionId) {
  const { getProjectDataDir } = require('../../utils/dataHome');
  return getProjectDataDir('trajectory_replay', String(sessionId));
}

/** The bundle directory path for a session under a given root. */
function bundleDirFor(sessionId, outDir) {
  const root = outDir || _defaultOutDir(sessionId);
  return path.join(root, `${String(sessionId)}${BUNDLE_DIR_SUFFIX}`);
}

/** Tally steps by tier and count reproducible artifacts. */
function _summarize(steps) {
  const byTier = { FILE: 0, SHELL: 0, NETWORK_AI: 0 };
  let artifacts = 0;
  for (const s of steps) {
    const tier = s.tier && byTier[s.tier] != null ? s.tier : 'SHELL';
    byTier[tier] += 1;
    if (Array.isArray(s.artifacts)) artifacts += s.artifacts.length;
  }
  return { total: steps.length, byTier, artifacts };
}

/** Collect the set of after-content sha256 hashes referenced by FILE steps. */
function _referencedHashes(steps) {
  const set = new Set();
  for (const s of steps) {
    if (!Array.isArray(s.artifacts)) continue;
    for (const a of s.artifacts) {
      if (a && typeof a.sha256 === 'string' && a.sha256) set.add(a.sha256);
    }
  }
  return set;
}

/**
 * Export a session's recorded trajectory into a self-contained bundle directory.
 * @param {string} sessionId
 * @param {object} [opts]
 * @param {string} [opts.outDir]            export root (default: project data dir)
 * @param {boolean} [opts.includeContent]   copy FILE after-bytes (default: on, gated by KHY_REPLAY_CAPTURE_CONTENT)
 * @param {string} [opts.manifestPath]      project manifest to hash into the env fingerprint
 * @returns {{ok:boolean, bundleDir?:string, manifest?:object, error?:string}}
 */
function exportBundle(sessionId, opts = {}) {
  try {
    if (sessionId == null) return { ok: false, error: 'missing sessionId' };
    const sp = require('../sessionPersistence');
    const jsonlPath = sp.jsonlPathFor(sessionId);
    const ledgerPath = replayLedger.ledgerPathFor(jsonlPath);
    const steps = replayLedger.read(ledgerPath);

    const bundleDir = bundleDirFor(sessionId, opts.outDir);
    const contentDir = path.join(bundleDir, 'content');
    fs.mkdirSync(contentDir, { recursive: true });

    // 1. Verbatim ledger copy (the append-only source of truth).
    const ledgerRaw = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf-8') : '';
    fs.writeFileSync(path.join(bundleDir, 'ledger.jsonl'), ledgerRaw);
    const ledgerHash = artifactHash.hashString(ledgerRaw);

    // 2. Content store: copy referenced after-bytes (content-addressed dedup).
    const contentManifest = {};
    const includeContent = opts.includeContent != null ? !!opts.includeContent : _captureContentEnabled();
    if (includeContent) {
      const srcDir = replayLedger._contentStoreDir(sessionId);
      for (const sha of _referencedHashes(steps)) {
        const src = path.join(srcDir, sha);
        try {
          if (!fs.existsSync(src)) continue;
          const bytes = fs.readFileSync(src);
          fs.writeFileSync(path.join(contentDir, sha), bytes);
          contentManifest[sha] = { bytes: bytes.length };
        } catch { /* a missing blob is surfaced later by verifyBundle */ }
      }
    }

    // 3. Environment fingerprint.
    const env = envFingerprint.capture({ manifestPath: opts.manifestPath });
    fs.writeFileSync(path.join(bundleDir, 'env.json'), JSON.stringify(env, null, 2));

    // 4. Optional tamper-evident chain copy.
    let chainStatus = { available: false };
    try {
      const traceChain = require('../trajectoryProvenance/traceChain');
      const chainPath = traceChain.chainPathFor(jsonlPath);
      if (fs.existsSync(chainPath)) {
        fs.copyFileSync(chainPath, path.join(bundleDir, 'chain.json'));
        chainStatus = { available: true };
      }
    } catch { chainStatus = { available: false }; }

    // 5. Manifest.
    const manifest = {
      v: BUNDLE_VERSION,
      kind: BUNDLE_KIND,
      sessionId: String(sessionId),
      createdAt: Date.now(),
      producer: 'khyos',
      env,
      steps,
      contentManifest,
      summary: _summarize(steps),
      integrity: { ledgerHash, chainStatus },
    };
    fs.writeFileSync(path.join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    return { ok: true, bundleDir, manifest };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/**
 * Read a bundle directory back into memory.
 * @param {string} bundleDir
 * @returns {{ok:boolean, manifest?:object, bundleDir?:string, error?:string}}
 */
function readBundle(bundleDir) {
  try {
    const manifestPath = path.join(bundleDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return { ok: false, error: 'manifest.json 不存在' };
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    return { ok: true, manifest, bundleDir };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/** Resolve the path of a content blob inside a bundle. */
function contentPath(bundleDir, sha256) {
  return path.join(bundleDir, 'content', sha256);
}

/**
 * Verify a bundle's structural and cryptographic integrity:
 *   - manifest schema (version/kind/steps),
 *   - ledger.jsonl hash matches manifest.integrity.ledgerHash,
 *   - every referenced FILE after-hash has a content blob whose bytes hash back,
 *   - NETWORK_AI steps are accounted as skipped.
 * @returns {{ok:boolean, errors:string[], skipped:number, verifiedBlobs:number}}
 */
function verifyBundle(bundleDir) {
  const errors = [];
  let skipped = 0;
  let verifiedBlobs = 0;
  try {
    const read = readBundle(bundleDir);
    if (!read.ok) return { ok: false, errors: [read.error], skipped, verifiedBlobs };
    const m = read.manifest;

    if (m.v !== BUNDLE_VERSION) errors.push(`版本不符：期望 ${BUNDLE_VERSION} 实为 ${m.v}`);
    if (m.kind !== BUNDLE_KIND) errors.push(`类型不符：期望 ${BUNDLE_KIND} 实为 ${m.kind}`);
    if (!Array.isArray(m.steps)) errors.push('manifest.steps 缺失或非数组');

    // Ledger hash.
    const ledgerPath = path.join(bundleDir, 'ledger.jsonl');
    if (!fs.existsSync(ledgerPath)) {
      errors.push('ledger.jsonl 不存在');
    } else {
      const raw = fs.readFileSync(ledgerPath, 'utf-8');
      const h = artifactHash.hashString(raw);
      if (m.integrity && m.integrity.ledgerHash && h !== m.integrity.ledgerHash) {
        errors.push('ledger.jsonl 哈希与 manifest 不符（账本被篡改）');
      }
    }

    // Per-step artifact blobs.
    for (const step of (Array.isArray(m.steps) ? m.steps : [])) {
      const tier = step.tier || tierRegistry.effectiveTier(step.name);
      if (tier === 'NETWORK_AI') { skipped += 1; continue; }
      for (const a of (Array.isArray(step.artifacts) ? step.artifacts : [])) {
        if (!a || a.op === 'delete' || !a.sha256) continue;
        const blob = contentPath(bundleDir, a.sha256);
        if (!fs.existsSync(blob)) {
          errors.push(`seq ${step.seq}: 缺内容 blob ${a.sha256}（无法复现 ${a.path}）`);
          continue;
        }
        const actual = artifactHash.hashFile(blob);
        if (actual !== a.sha256) {
          errors.push(`seq ${step.seq}: 内容 blob 哈希不符 ${a.sha256}（blob 被篡改）`);
        } else {
          verifiedBlobs += 1;
        }
      }
    }

    return { ok: errors.length === 0, errors, skipped, verifiedBlobs };
  } catch (e) {
    errors.push(e && e.message ? e.message : String(e));
    return { ok: false, errors, skipped, verifiedBlobs };
  }
}

module.exports = {
  BUNDLE_VERSION,
  BUNDLE_KIND,
  BUNDLE_DIR_SUFFIX,
  bundleDirFor,
  contentPath,
  exportBundle,
  readBundle,
  verifyBundle,
};
