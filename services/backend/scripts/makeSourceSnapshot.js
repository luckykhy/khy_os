#!/usr/bin/env node
'use strict';

/**
 * makeSourceSnapshot.js — build-time generator for the encrypted full-source
 * snapshot embedded into the pip wheel and the npm package.
 *
 * By default it captures the WORKING TREE (all tracked files at their current,
 * possibly-uncommitted content PLUS untracked-but-not-ignored files — original
 * layout, no .git / node_modules / .env). This is the carrier for a cloud-dev
 * machine that can only ship via pip/npm: everything the user has *right now*,
 * committed or not, survives a wipe and restores on Windows via `khy restore`.
 * Set KHY_SNAPSHOT_FROM=head to fall back to committed-only (`git archive HEAD`).
 *
 * It encrypts the resulting tar.gz with the owner secret and writes three files
 * into --out:
 *   - khy-os-source.tar.gz.enc   ciphertext
 *   - snapshot.json              metadata + crypto params
 *   - RESTORE_WINDOWS.md         rebuild instructions (copied from docs/)
 *
 * The restore side (khy restore / khy publish origin-code) consumes these.
 *
 * Source publishing is NOT password-gated: when no explicit secret is given the
 * snapshot is encrypted under the fixed DEFAULT_SOURCE_SECRET so real source
 * always ships and `khy restore` decrypts it with no user input. The only skip
 * condition is "not a git repo" — it never falls back to shipping plaintext.
 *
 * Usage:
 *   node services/backend/scripts/makeSourceSnapshot.js --out <dir> \
 *        [--root <repoRoot>] [--secret <s>] [--timestamp <iso>] [--require]
 *   env: KHY_SOURCE_PUBLISH_SECRET (or KHY_OWNER_SECRET) supplies the secret.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  SNAPSHOT_ENC_NAME,
  SNAPSHOT_META_NAME,
  RESTORE_DOC_NAME,
  resolveSourceSecret,
  encrypt,
  sha256Hex,
} = require('../src/services/sourceSnapshotCrypto');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--require') { out.require = true; continue; }
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if (val === undefined) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { val = next; i++; }
      else val = true;
    }
    out[key] = val;
  }
  return out;
}

function git(root, args, opts = {}) {
  return execFileSync('git', ['-C', root, ...args], {
    maxBuffer: 1024 * 1024 * 512, // 512MB: well above the ~13MB archive
    ...opts,
  });
}

function warn(msg) { process.stderr.write(`[source-snapshot] ${msg}\n`); }
function info(msg) { process.stdout.write(`[source-snapshot] ${msg}\n`); }

/**
 * Locate the RESTORE_WINDOWS.md rebuild guide under <root>/docs. Prefers the flat
 * docs/RESTORE_WINDOWS.md, then falls back to a shallow recursive scan. The doc may
 * have been refiled under a categorized subdir AND renamed with a category prefix
 * (e.g. docs/08_MGMT_项目管理/[MGMT-OTHER-001] RESTORE_WINDOWS.md), so an exact basename
 * match is preferred but a "...RESTORE_WINDOWS.md" suffix match is accepted as fallback.
 * Returns the absolute path or null.
 */
function findRestoreDoc(root) {
  const flat = path.join(root, 'docs', RESTORE_DOC_NAME);
  if (fs.existsSync(flat)) return flat;
  const docsDir = path.join(root, 'docs');
  const stack = [docsDir];
  let suffixMatch = null; // first "[CATEGORY-NNN] RESTORE_WINDOWS.md"-style hit
  // Bounded walk: docs/ is shallow; guard against runaway just in case.
  let budget = 5000;
  while (stack.length && budget-- > 0) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { stack.push(full); continue; }
      if (!ent.isFile()) continue;
      if (ent.name === RESTORE_DOC_NAME) return full;            // exact wins immediately
      if (!suffixMatch && ent.name.endsWith(RESTORE_DOC_NAME)) suffixMatch = full;
    }
  }
  return suffixMatch;
}

/** True when the working tree has any uncommitted change (modified/staged/untracked). */
function isWorkingTreeDirty(root) {
  try {
    return git(root, ['status', '--porcelain', '--untracked-files=all'])
      .toString('utf8').trim().length > 0;
  } catch {
    return false;
  }
}

/** Count files reachable from a tree-ish (HEAD or a written tree SHA). */
function countTreeFiles(root, treeish) {
  try {
    return git(root, ['ls-tree', '-r', '--name-only', treeish])
      .toString('utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

/**
 * Produce the plaintext tar.gz of the source to embed.
 *
 * Default ('working-tree'): stage the entire working tree — tracked files at
 * their current content (uncommitted edits included), additions, and deletions,
 * plus untracked-but-not-ignored files — into a THROWAWAY index (GIT_INDEX_FILE),
 * so the user's real `.git/index` and working tree are never touched. We then
 * `write-tree` and `git archive` that tree: the exact same deterministic,
 * original-layout, .gitignore-respecting tar.gz `git archive` always produced,
 * but reflecting the live working state rather than the last commit.
 *
 * 'head': committed-only, the historical `git archive HEAD` behavior.
 *
 * @returns {{ plaintext: Buffer, mode: string, treeish: string }}
 */
function captureSource(root) {
  const mode = String(process.env.KHY_SNAPSHOT_FROM || '').trim().toLowerCase() === 'head'
    ? 'head'
    : 'working-tree';

  if (mode === 'head') {
    info(`archiving HEAD of ${root} (committed only) ...`);
    return { plaintext: git(root, ['archive', '--format=tar.gz', 'HEAD']), mode, treeish: 'HEAD' };
  }

  info(`archiving WORKING TREE of ${root} (includes uncommitted changes) ...`);
  const tmpIndex = path.join(os.tmpdir(), `khy-snapshot-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    // Seed the throwaway index from HEAD so deletions are represented faithfully;
    // ignore failure on an unborn branch (a fresh repo with no commits yet).
    try { git(root, ['read-tree', 'HEAD'], { env }); } catch { /* unborn HEAD */ }
    // `git add -A` honors .gitignore (no .git/node_modules/.env/dist/bundled),
    // and records modifications, new untracked files, and deletions.
    git(root, ['add', '-A'], { env });
    const tree = git(root, ['write-tree'], { env }).toString('utf8').trim();
    if (!tree) throw new Error('write-tree produced an empty tree id');
    const plaintext = git(root, ['archive', '--format=tar.gz', tree]);
    return { plaintext, mode, treeish: tree };
  } finally {
    try { fs.unlinkSync(tmpIndex); } catch { /* best-effort cleanup */ }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const outDir = args.out ? path.resolve(String(args.out)) : null;
  if (!outDir) {
    warn('missing required --out <dir>');
    process.exit(args.require ? 1 : 0);
  }

  // Resolve repo root (default: the git toplevel of this script's location).
  let root = args.root ? path.resolve(String(args.root)) : null;
  try {
    if (!root) {
      root = git(path.join(__dirname, '..'), ['rev-parse', '--show-toplevel'])
        .toString('utf8').trim();
    } else {
      // Validate the explicitly given root is a git repo.
      git(root, ['rev-parse', '--is-inside-work-tree']);
    }
  } catch {
    warn('not a git repository — skipping source snapshot (nothing written).');
    process.exit(args.require ? 1 : 0);
  }

  // Source publishing is no longer password-gated. When no explicit secret is
  // supplied we fall back to the fixed DEFAULT_SOURCE_SECRET so the real source
  // is ALWAYS embedded (encrypted) and `khy restore` can decrypt it without any
  // user input. An explicit KHY_SOURCE_PUBLISH_SECRET / --secret still overrides.
  const explicit = args.secret && args.secret !== true
    ? String(args.secret)
    : (process.env.KHY_SOURCE_PUBLISH_SECRET || process.env.KHY_OWNER_SECRET || '');
  const secret = resolveSourceSecret(explicit);
  if (!explicit) {
    info('no explicit secret — embedding source under the password-free default key.');
  }

  // 1. archive → tar.gz buffer (working tree by default, original layout).
  const { plaintext, mode, treeish } = captureSource(root);
  const sha256 = sha256Hex(plaintext);

  // 2. metadata
  const dirty = isWorkingTreeDirty(root);
  const fileCount = countTreeFiles(root, treeish);
  let gitCommit = '';
  try { gitCommit = git(root, ['rev-parse', 'HEAD']).toString('utf8').trim(); } catch {}
  let version = '';
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, 'services', 'backend', 'package.json'), 'utf8')
    );
    version = pkg.version || '';
  } catch { /* optional */ }
  const createdAt = args.timestamp && args.timestamp !== true
    ? String(args.timestamp)
    : new Date().toISOString();

  // 3. encrypt
  const { ciphertext, crypto: cryptoMeta } = encrypt(plaintext, secret);

  // 4. write outputs
  fs.mkdirSync(outDir, { recursive: true });
  const encPath = path.join(outDir, SNAPSHOT_ENC_NAME);
  fs.writeFileSync(encPath, ciphertext);

  const header = {
    format: 'khy-source-snapshot',
    formatVersion: 1,
    layout: 'git-archive',
    captureMode: mode,                 // 'working-tree' (default) | 'head'
    includesUncommitted: mode === 'working-tree',
    dirty,                             // whether the working tree had uncommitted changes
    archive: SNAPSHOT_ENC_NAME,
    plaintextFormat: 'tar.gz',
    sha256,
    fileCount,
    version,
    gitCommit,
    createdAt,
    crypto: cryptoMeta,
    notes: mode === 'working-tree'
      ? 'Encrypted archive of the WORKING TREE (tracked + uncommitted + untracked-not-ignored). Restore with `khy restore`.'
      : 'Encrypted git archive of all tracked source at HEAD. Restore with `khy restore`.',
  };
  fs.writeFileSync(
    path.join(outDir, SNAPSHOT_META_NAME),
    JSON.stringify(header, null, 2) + '\n'
  );

  // 5. copy the rebuild guide alongside (best-effort), so a Windows user can read
  //    it WITHOUT extracting first. The doc was filed under a categorized subpath
  //    (docs/08_MGMT_.../[MGMT-OTHER-001] RESTORE_WINDOWS.md), so look there too.
  try {
    const doc = findRestoreDoc(root);
    if (doc) fs.copyFileSync(doc, path.join(outDir, RESTORE_DOC_NAME));
    else warn(`rebuild guide ${RESTORE_DOC_NAME} not found under docs/ — skipping sidecar copy.`);
  } catch { /* non-fatal */ }

  // 6. sanity: never leave a plaintext archive in the output dir.
  const stray = path.join(outDir, 'khy-os-source.tar.gz');
  if (fs.existsSync(stray)) {
    fs.unlinkSync(stray);
    warn('removed a stray plaintext archive from the output dir.');
  }

  const mb = (ciphertext.length / 1024 / 1024).toFixed(1);
  const modeLabel = mode === 'working-tree'
    ? (dirty ? 'working-tree (uncommitted changes included)' : 'working-tree (clean, == HEAD)')
    : 'HEAD (committed only)';
  info(`embedded encrypted snapshot [${modeLabel}]: ${fileCount} files, ${mb}MB → ${outDir}`);
  info(`  base commit ${gitCommit.slice(0, 12)} · sha256 ${sha256.slice(0, 12)}…`);
}

try {
  main();
} catch (err) {
  warn(`failed: ${err && err.message ? err.message : err}`);
  // Non-zero only when explicitly required; otherwise don't break the build.
  process.exit(process.argv.includes('--require') ? 1 : 0);
}
