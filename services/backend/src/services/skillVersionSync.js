'use strict';

/**
 * skillVersionSync.js — Built-in skill content fingerprint + version-based upgrade
 *
 * Aligns with ycode's builtin-skill sync model ([DESIGN-ARCH-096] §D):
 *   - Every built-in skill directory has a content fingerprint (location
 *     independent, byte sensitive).
 *   - The first sync RELEASES a copy of each built-in skill into the user
 *     skills dir and records name + fingerprint in builtin_released.json.
 *   - On khy version change: unmodified copies are atomically upgraded to
 *     the shipped version; user-modified copies are preserved and marked
 *     user_modified; copies the user deleted are tombstoned and never
 *     resurrected by future syncs.
 *   - `restoreBuiltinSkill(name)` re-copies the shipped version over the
 *     released copy — the explicit escape hatch from both protections.
 *
 * All paths are injectable so tests run against tmp dirs only; production
 * wiring comes from defaultSyncOptions() (dataHome-based, zero hardcoding).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const INDEX_VERSION = 1;
const INDEX_FILENAME = 'builtin_released.json';
const STAGING_DIR = '.tmp-sync'; // same-volume staging for atomic swaps
const SWAP_DIR = '.tmp-old'; // parking spot for the copy being replaced
const GATE_ENV = 'KHY_SKILL_VERSION_SYNC';

// Fingerprint algorithm version, recorded in the index as `fingerprintAlgo`.
// The skip set below is part of the hashing algorithm itself: change it and
// every fingerprint changes, so a record written under an older algorithm is
// not comparable with a fingerprint computed now. Kept on its own axis instead
// of bumping INDEX_VERSION because this is an additive field — old readers
// ignore unknown fields and new readers tolerate its absence, so the index
// layout is unchanged.
//   1 = hash over the full file set        2 = hash over the pruned file set
const FP_ALGO_VERSION = 2;

// Dependency and build artifacts are not part of a skill's body. Pruned before the
// recursion descends, not filtered afterwards, so a skill that vendors
// `scripts/node_modules` cannot inflate a cold-start scan by two orders of
// magnitude. This also keeps a user running `npm install` inside a skill from
// poisoning the fingerprint and permanently blocking the auto-upgrade.
const _SKIP_DIR_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  '.venv',
  'venv',
  '.next',
  '__pycache__',
  '.pytest_cache',
  '.git',
]);
const _SKIP_FILE_SUFFIXES = ['.pyc'];

// ── Fingerprint ──────────────────────────────────────────────────────────────

/**
 * Compute a content fingerprint of a skill directory: recursively hash every
 * file's bytes plus its repo-relative path, then hash the sorted list.
 * Dependency and build directories are pruned before descent (see
 * _SKIP_DIR_SEGMENTS), so they neither enter the fingerprint nor cost I/O.
 * Stable across reads, identical for byte-identical copies at other locations,
 * and sensitive to any content or file-set change of the skill body.
 * Timestamps are ignored.
 * @param {string} dir
 * @returns {string} sha256 hex digest
 */
function computeDirFingerprint(dir) {
  const files = [];
  _collectRelativeFiles(dir, '', files);
  files.sort();
  const combined = crypto.createHash('sha256');
  for (const rel of files) {
    const content = fs.readFileSync(path.join(dir, rel));
    const fileHash = crypto.createHash('sha256').update(content).digest('hex');
    combined.update(rel + '\0' + fileHash + '\n');
  }
  return combined.digest('hex');
}

/**
 * Collect repo-relative file paths of a skill directory, pruning dependency and
 * build subtrees before descending into them. Segment names are matched at any
 * depth, so `scripts/node_modules` and `.venv` nested several levels down are
 * skipped identically.
 */
function _collectRelativeFiles(base, rel, out) {
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (_SKIP_DIR_SEGMENTS.has(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      _collectRelativeFiles(path.join(base, entry.name), childRel, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (_SKIP_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
    out.push(rel ? `${rel}/${entry.name}` : entry.name);
  }
}

// ── Scanning helpers ─────────────────────────────────────────────────────────

/** Scan the shipped built-in dir: one level of skill dirs with manifest.json. */
function _scanBuiltinSkills(builtinDir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(builtinDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(builtinDir, entry.name);
    const name = _readManifestName(dir);
    if (!name) continue;
    out.push({ name, dirName: entry.name, dir, fingerprint: computeDirFingerprint(dir) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Manifest skill name of a dir, or null (missing/broken manifest). */
function _readManifestName(skillDir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(skillDir, 'manifest.json'), 'utf8'));
    return manifest && typeof manifest.name === 'string' && manifest.name ? manifest.name : null;
  } catch {
    return null;
  }
}

/** All skill names currently materialized in the user skills dir. */
function _scanUserSkillNames(userSkillsDir) {
  const names = new Set();
  let entries;
  try {
    entries = fs.readdirSync(userSkillsDir, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const name = _readManifestName(path.join(userSkillsDir, entry.name));
    if (name) names.add(name);
  }
  return names;
}

// ── Atomic directory swap ────────────────────────────────────────────────────

/**
 * Replace targetDir with a copy of srcDir atomically: stage the new content
 * under the same-volume STAGING_DIR, park the old copy under SWAP_DIR, then
 * rename the staging dir into place. Crash mid-way leaves only sweepable
 * leftovers under the two dot-dirs — never a half-written skill.
 */
function _atomicReplaceDir(srcDir, targetDir, userSkillsDir) {
  const stagingRoot = path.join(userSkillsDir, STAGING_DIR);
  fs.mkdirSync(stagingRoot, { recursive: true });
  const staging = fs.mkdtempSync(path.join(stagingRoot, `${path.basename(targetDir)}-`));
  fs.cpSync(srcDir, staging, { recursive: true });

  let parked = null;
  if (fs.existsSync(targetDir)) {
    const swapRoot = path.join(userSkillsDir, SWAP_DIR);
    fs.mkdirSync(swapRoot, { recursive: true });
    // Non-existent destination so rename works on Windows too
    parked = path.join(
      swapRoot,
      `${path.basename(targetDir)}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    );
    fs.renameSync(targetDir, parked);
  }
  fs.renameSync(staging, targetDir);
  if (parked) fs.rmSync(parked, { recursive: true, force: true });
}

/** Remove crash-leftover staging/swap roots (called at sync start and end). */
function _sweepTmpRoots(userSkillsDir) {
  for (const root of [STAGING_DIR, SWAP_DIR]) {
    const p = path.join(userSkillsDir, root);
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  }
}

// ── Index ────────────────────────────────────────────────────────────────────

function _readIndexFile(indexFile) {
  if (!fs.existsSync(indexFile)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  } catch {
    return { corrupt: true };
  }
  return parsed;
}

function _writeIndexAtomic(indexFile, data) {
  const tmp = `${indexFile}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, indexFile);
}

// ── Sync ─────────────────────────────────────────────────────────────────────

/**
 * Sync built-in skills into the user skills dir.
 * @param {object} opts
 * @param {object}  opts.env             Environment (gate: KHY_SKILL_VERSION_SYNC=0)
 * @param {string}  opts.currentVersion   Current khy package version
 * @param {string}  opts.builtinDir      Shipped built-in skills dir
 * @param {string}  opts.userSkillsDir   User skills dir (released copies live here)
 * @param {string}  opts.indexFile       Path of builtin_released.json
 * @param {boolean} [opts.force]         Bypass gate + unchanged-version fast path
 * @returns {object} report (skipped:{true,reason} | per-category name arrays)
 */
function syncBuiltinSkills(opts) {
  const { env = {}, currentVersion, builtinDir, userSkillsDir, indexFile, force = false } = opts;

  // Gate: user opted out; --force is the explicit override
  if (!force && env[GATE_ENV] === '0') {
    return {
      skipped: true,
      reason: `内置技能版本同步被门控关闭（${GATE_ENV}=0）：如需执行请运行 khy skill sync --force`,
    };
  }

  if (!fs.existsSync(builtinDir)) {
    throw new Error(`内置技能目录不存在（${builtinDir}）：请重新安装 khy-os 或运行 khy doctor 检查`);
  }

  const index = _readIndexFile(indexFile);

  // Schema guard: an index from a newer/unknown layout is never touched
  if (index && (index.corrupt || typeof index.version !== 'number' || index.version !== INDEX_VERSION)) {
    const found = index.corrupt ? '文件损坏' : `索引 v${index.version}`;
    return {
      skipped: true,
      reason:
        `内置技能索引 schema 不兼容（${found}，当前支持 v${INDEX_VERSION}）：已跳过同步且未改动任何文件。` +
        `如需重建，请删除 ${INDEX_FILENAME} 后重启 khy`,
    };
  }

  // Fast path: same khy version, index already settled — nothing to do
  if (index && !force && index.khyVersion === currentVersion) {
    return {
      skipped: true,
      reason: `khy 版本未变（${currentVersion}）：跳过内置技能同步`,
    };
  }

  fs.mkdirSync(userSkillsDir, { recursive: true });
  _sweepTmpRoots(userSkillsDir);

  const report = {
    khyVersion: currentVersion,
    releasedNew: [],
    upgraded: [],
    userModified: [],
    tombstoned: [],
    orphaned: [],
    conflicts: [],
    preservedUserOwn: [],
  };

  const builtins = _scanBuiltinSkills(builtinDir);
  const builtinByName = new Map(builtins.map((b) => [b.name, b]));

  const released = index && index.released ? { ...index.released } : {};
  const userModified = new Set(index && index.userModified ? index.userModified : []);
  const deleted = new Set(index && index.deleted ? index.deleted : []);

  // Fingerprint-algorithm migration. A changed skip set is a changed hashing
  // algorithm, so records written under an older algorithm are not comparable
  // with the fingerprints computed now. Left unmigrated, an unmodified copy
  // would look user-modified and silently block its auto-upgrade forever — worse
  // than the original defect, because it never reports. Re-derive every entry
  // against the shipped source under the current algorithm: a match proves the
  // copy is untouched and the record is refreshed in place; a mismatch cannot
  // distinguish a user edit from algorithm drift, so it is conservatively
  // treated as user-modified (preserved verbatim, never overwritten). No record
  // is ever deleted here. Runs after the fast path: with the khy version
  // unchanged no shipped content moved, so there is nothing to re-derive.
  if (index && index.fingerprintAlgo !== FP_ALGO_VERSION) {
    for (const name of Object.keys(released).sort()) {
      const entry = released[name];
      const b = builtinByName.get(name);
      if (!b) continue; // upstream removal — Pass 1 owns the orphan decision
      if (deleted.has(name)) continue; // tombstone — Pass 1 owns it
      const targetDir = path.join(userSkillsDir, entry.dir);
      if (!fs.existsSync(targetDir)) continue;
      if (computeDirFingerprint(targetDir) === b.fingerprint) {
        entry.fingerprint = b.fingerprint;
      } else {
        userModified.add(name);
      }
    }
  }

  // Pass 1: skills already released (identity = manifest name, storage = recorded dir)
  for (const name of Object.keys(released).sort()) {
    const entry = released[name];
    const b = builtinByName.get(name);

    if (!b) {
      // Upstream removed the skill: keep the user copy as a plain skill, stop managing it
      delete released[name];
      userModified.delete(name);
      deleted.delete(name);
      report.orphaned.push(name);
      continue;
    }

    const targetDir = path.join(userSkillsDir, entry.dir);
    if (!fs.existsSync(targetDir)) {
      // User deleted their copy: tombstone, never resurrect on any later sync
      if (!deleted.has(name)) {
        deleted.add(name);
        report.tombstoned.push(name);
      }
      continue;
    }
    if (deleted.has(name)) continue; // stays tombstoned even if a dir reappeared

    if (computeDirFingerprint(targetDir) !== entry.fingerprint) {
      // User-modified: preserve verbatim, remember the mark
      if (!userModified.has(name)) {
        userModified.add(name);
      }
      report.userModified.push(name);
      continue;
    }

    // Unmodified copy: upgrade if the shipped content changed with the version
    if (b.fingerprint !== entry.fingerprint) {
      _atomicReplaceDir(b.dir, targetDir, userSkillsDir);
      entry.fingerprint = b.fingerprint;
      report.upgraded.push(name);
    }
  }

  // Pass 2: skills not yet released (first sync = all of them)
  const existingUserNames = _scanUserSkillNames(userSkillsDir);
  for (const b of builtins) {
    if (Object.prototype.hasOwnProperty.call(released, b.name) || deleted.has(b.name)) continue;

    const targetDir = path.join(userSkillsDir, b.dirName);
    if (fs.existsSync(targetDir)) {
      // Target path occupied by something we never released — never overwrite
      report.conflicts.push(b.name);
      continue;
    }
    if (existingUserNames.has(b.name)) {
      // A user-authored skill already owns this name — the user's wins
      report.preservedUserOwn.push(b.name);
      continue;
    }

    _atomicReplaceDir(b.dir, targetDir, userSkillsDir);
    released[b.name] = { fingerprint: b.fingerprint, dir: b.dirName, releasedAt: currentVersion };
    report.releasedNew.push(b.name);
  }

  _writeIndexAtomic(indexFile, {
    version: INDEX_VERSION,
    khyVersion: currentVersion,
    fingerprintAlgo: FP_ALGO_VERSION,
    released,
    userModified: [...userModified].sort(),
    deleted: [...deleted].sort(),
  });
  _sweepTmpRoots(userSkillsDir);

  // Released copies live in the user skills dir — drop the loader cache so the
  // next discovery sees the new content instead of stale entries
  try {
    require('../skills').invalidateCache();
  } catch {
    /* optional — never fails the sync */
  }

  return report;
}

// ── Restore ──────────────────────────────────────────────────────────────────

/**
 * Explicitly restore the shipped built-in version of a released skill,
 * overwriting user modifications and clearing tombstone/user_modified marks.
 * Guards: name must be a current built-in AND once released by us.
 * @returns {{ name: string, dir: string, fingerprint: string, path: string }}
 */
function restoreBuiltinSkill(name, opts) {
  const { builtinDir, userSkillsDir, indexFile } = opts;

  const builtins = _scanBuiltinSkills(builtinDir);
  const b = builtins.find((x) => x.name === name);
  if (!b) {
    throw new Error(`恢复失败：${name} 不是当前版本的内置技能。运行 khy skill list 查看可用技能名`);
  }

  const index = _readIndexFile(indexFile);
  const entry = index && !index.corrupt && index.released ? index.released[name] : null;
  if (!entry) {
    throw new Error(
      `恢复失败：${name} 从未释放过内置版（同名技能是用户自建的）。无需恢复，可直接编辑用户技能目录`
    );
  }

  const targetDir = path.join(userSkillsDir, entry.dir);
  const occupant = _readManifestName(targetDir);
  if (occupant && occupant !== name) {
    throw new Error(`恢复失败：目录 ${entry.dir} 已被技能「${occupant}」占用。请先移动该技能再恢复`);
  }

  _atomicReplaceDir(b.dir, targetDir, userSkillsDir);

  const userModified = new Set(index.userModified || []);
  const deleted = new Set(index.deleted || []);
  userModified.delete(name);
  deleted.delete(name);
  _writeIndexAtomic(indexFile, {
    ...index,
    userModified: [...userModified].sort(),
    deleted: [...deleted].sort(),
  });
  _sweepTmpRoots(userSkillsDir);

  try {
    require('../skills').invalidateCache();
  } catch {
    /* optional */
  }

  return { name, dir: entry.dir, fingerprint: b.fingerprint, path: targetDir };
}

// ── Startup wrapper ──────────────────────────────────────────────────────────

/** Set once the first startup sync attempt finishes (per process). */
let _startupRanThisProcess = false;

/**
 * Run the built-in skill sync at most once per process, fail-soft: a throwing
 * sync returns a skip report instead of ever breaking startup.
 */
function runStartupSkillSync(opts) {
  if (_startupRanThisProcess) {
    return { skipped: true, reason: '本进程已执行过启动同步：跳过' };
  }
  _startupRanThisProcess = true;
  try {
    return syncBuiltinSkills(opts);
  } catch (err) {
    return { skipped: true, reason: `启动内置技能同步失败（${err.message}）：已跳过，不影响启动` };
  }
}

// ── Production wiring ────────────────────────────────────────────────────────

/**
 * Build sync options from the installed package: shipped built-in dir as the
 * fingerprint baseline, dataHome skills dir for released copies, index next
 * to them, version from the backend package.json single source of truth.
 */
function defaultSyncOptions(env = process.env) {
  const { getDataHome } = require('../utils/dataHome');
  const userSkillsDir = path.join(getDataHome(), 'skills');
  const pkg = require('../../package.json');
  return {
    env,
    currentVersion: pkg.version,
    builtinDir: path.resolve(__dirname, '..', 'skills', 'built-in'),
    userSkillsDir,
    indexFile: path.join(userSkillsDir, INDEX_FILENAME),
  };
}

module.exports = {
  INDEX_VERSION,
  INDEX_FILENAME,
  FP_ALGO_VERSION,
  computeDirFingerprint,
  syncBuiltinSkills,
  restoreBuiltinSkill,
  runStartupSkillSync,
  defaultSyncOptions,
};
