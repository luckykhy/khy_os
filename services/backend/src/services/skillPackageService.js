'use strict';

/**
 * skillPackageService.js — skill import/export pipeline (A3).
 *
 * Import accepts three shapes and lands a skill under the user skills dir
 * (<dataHome>/skills/<name>), the same directory the manifest loader scans:
 *   - a single `.md`/`SKILL.md` file   → wrapped into <name>/SKILL.md
 *   - a folder                         → copied verbatim (manifest.json or SKILL.md)
 *   - a `.zip` archive                 → extracted (read-only node-stream-zip) then
 *                                        treated as a folder
 *
 * Export writes a skill out as a folder (default) or a single SKILL.md.
 *
 * Path safety is the core concern here: a skill name or a zip entry must never
 * escape the sandbox root. `_safeJoin` rejects absolute paths, `..` traversal,
 * and any resolved path that does not stay under the base (zip-slip).
 *
 * Dependency note: no zip *writer* is bundled, so export does NOT produce a
 * `.zip` — folder/md only. Import reads `.zip` via the existing
 * `node-stream-zip` dependency.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { getDataDir } = require('../utils/dataHome');
const skillLoader = require('../skills/skillLoader');

/** User skills root — the manifest loader's user dir. */
function _skillsRoot() {
  return getDataDir('skills');
}

/**
 * Join `entry` under `base`, guaranteeing the result stays inside `base`.
 * Rejects absolute entries and `..` traversal (zip-slip / path-traversal).
 * @param {string} base - absolute sandbox root
 * @param {string} entry - untrusted relative path
 * @returns {string} safe absolute path
 */
function _safeJoin(base, entry) {
  const normalizedEntry = String(entry || '').replace(/\\/g, '/');
  if (!normalizedEntry || normalizedEntry.startsWith('/') || path.isAbsolute(normalizedEntry)) {
    throw new Error(`Unsafe path (absolute not allowed): ${entry}`);
  }
  const resolvedBase = path.resolve(base);
  const target = path.resolve(resolvedBase, normalizedEntry);
  if (target !== resolvedBase && !target.startsWith(resolvedBase + path.sep)) {
    throw new Error(`Unsafe path (escapes sandbox): ${entry}`);
  }
  return target;
}

/**
 * Validate a skill name derived from an import source. Must be a single path
 * segment of safe characters — no separators, no dots-only, no traversal.
 * @param {string} name
 * @returns {string}
 */
function _sanitizeName(name) {
  const base = String(name || '').trim();
  if (!base || base === '.' || base === '..') {
    throw new Error(`Invalid skill name: "${name}"`);
  }
  if (/[\\/]/.test(base) || base.includes('..')) {
    throw new Error(`Invalid skill name (path separators not allowed): "${name}"`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(base)) {
    throw new Error(`Invalid skill name (allowed: letters, digits, . _ -): "${name}"`);
  }
  return base;
}

function _ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Recursively copy a directory tree into `destRoot`, validating every entry's
 * relative path with `_safeJoin` against `destRoot`.
 * @param {string} srcDir
 * @param {string} destRoot
 * @param {string} [rel='']
 */
function _copyTreeSafe(srcDir, destRoot, rel = '') {
  const entries = fs.readdirSync(path.join(srcDir, rel), { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..') continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    const target = _safeJoin(destRoot, relPath);
    if (entry.isDirectory()) {
      _ensureDir(target);
      _copyTreeSafe(srcDir, destRoot, relPath);
    } else if (entry.isFile()) {
      _ensureDir(path.dirname(target));
      fs.copyFileSync(path.join(srcDir, relPath), target);
    }
    // symlinks and other types are skipped (defensive)
  }
}

/**
 * Derive a skill name from a folder: prefer manifest.json `name`, else the
 * folder basename, else SKILL.md frontmatter name.
 * @param {string} dir
 * @returns {string}
 */
function _folderSkillName(dir) {
  const manifestPath = path.join(dir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      if (m && m.name) return _sanitizeName(m.name);
    } catch { /* fall through */ }
  }
  const skillMd = path.join(dir, 'SKILL.md');
  if (fs.existsSync(skillMd)) {
    try {
      const parsed = skillLoader.parseSkillFile(skillMd);
      if (parsed.meta && parsed.meta.name) return _sanitizeName(parsed.meta.name);
    } catch { /* fall through */ }
  }
  return _sanitizeName(path.basename(dir));
}

/**
 * Import a `.md` single file into <root>/<name>/SKILL.md.
 * @private
 */
function _importMarkdown(srcPath) {
  const parsed = skillLoader.parseSkillFile(srcPath);
  const name = _sanitizeName(
    (parsed.meta && parsed.meta.name) || path.basename(srcPath).replace(/\.md$/i, ''),
  );
  const destDir = _safeJoin(_skillsRoot(), name);
  _ensureDir(destDir);
  fs.copyFileSync(srcPath, path.join(destDir, 'SKILL.md'));
  return { name, dest: destDir };
}

/**
 * Import a folder into <root>/<name>, copying its tree safely.
 * @private
 */
function _importFolder(srcDir) {
  const name = _folderSkillName(srcDir);
  const destDir = _safeJoin(_skillsRoot(), name);
  _ensureDir(destDir);
  _copyTreeSafe(srcDir, destDir);
  return { name, dest: destDir };
}

/**
 * Import a `.zip` archive: extract to a temp dir (validating every entry with
 * _safeJoin against the temp root → zip-slip safe), then import as a folder.
 * @private
 */
async function _importZip(srcPath) {
  const StreamZip = require('node-stream-zip');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-skill-import-'));
  const zip = new StreamZip.async({ file: srcPath });
  try {
    const entries = await zip.entries();
    for (const entry of Object.values(entries)) {
      if (entry.isDirectory) {
        _ensureDir(_safeJoin(tmpRoot, entry.name));
        continue;
      }
      const target = _safeJoin(tmpRoot, entry.name); // throws on zip-slip
      _ensureDir(path.dirname(target));
      await zip.extract(entry.name, target);
    }
  } finally {
    await zip.close();
  }

  // If the archive wrapped everything in a single top-level folder, descend
  // into it so the skill name comes from the real skill dir, not the wrapper.
  let importDir = tmpRoot;
  const top = fs.readdirSync(tmpRoot, { withFileTypes: true }).filter(e => e.name !== '.' && e.name !== '..');
  if (top.length === 1 && top[0].isDirectory()) {
    importDir = path.join(tmpRoot, top[0].name);
  }

  try {
    return _importFolder(importDir);
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * Import a skill from a `.md` file, a folder, or a `.zip` archive.
 * @param {string} srcPath
 * @param {object} [opts]
 * @returns {Promise<{ name: string, dest: string }>}
 */
async function importSkill(srcPath, opts = {}) {
  if (!srcPath) throw new Error('importSkill requires a source path');
  const resolved = path.resolve(srcPath);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`Source not found: ${srcPath}`);
  }

  if (stat.isDirectory()) {
    return _importFolder(resolved);
  }
  if (/\.zip$/i.test(resolved)) {
    return _importZip(resolved);
  }
  if (/\.md$/i.test(resolved)) {
    return _importMarkdown(resolved);
  }
  throw new Error(`Unsupported import source (expected .md, folder, or .zip): ${srcPath}`);
}

/**
 * Locate a skill's on-disk directory by name via the manifest registry.
 * @private
 * @returns {{ name: string, dir: string, promptPath: string|null }}
 */
function _resolveSkillDir(name) {
  const registry = require('../skills');
  const skill = registry.findSkill(name);
  if (!skill) throw new Error(`Skill "${name}" not found.`);
  if (!skill.dir) throw new Error(`Skill "${name}" has no on-disk directory to export.`);
  return skill;
}

/**
 * Export a skill as a folder (default) or a single SKILL.md.
 * @param {string} name
 * @param {string} destDir
 * @param {object} [opts]
 * @param {'folder'|'md'} [opts.format='folder']
 * @returns {Promise<{ dest: string, format: string }>}
 */
async function exportSkill(name, destDir, opts = {}) {
  const format = opts.format || 'folder';
  const skill = _resolveSkillDir(name);
  const outBase = path.resolve(destDir || process.cwd());
  _ensureDir(outBase);

  if (format === 'md') {
    // Prefer an existing SKILL.md / prompt.md / legacy body.
    const candidates = [
      path.join(skill.dir, 'SKILL.md'),
      skill.promptPath,
    ].filter(Boolean);
    let content = null;
    for (const c of candidates) {
      if (fs.existsSync(c)) { content = fs.readFileSync(c, 'utf-8'); break; }
    }
    if (content == null && skill._legacyBody) content = skill._legacyBody;
    if (content == null) throw new Error(`Skill "${name}" has no markdown body to export.`);
    const safeName = _sanitizeName(skill.name);
    const out = _safeJoin(outBase, `${safeName}.md`);
    fs.writeFileSync(out, content, 'utf-8');
    return { dest: out, format };
  }

  if (format === 'folder') {
    const safeName = _sanitizeName(skill.name);
    const out = _safeJoin(outBase, safeName);
    _ensureDir(out);
    _copyTreeSafe(skill.dir, out);
    return { dest: out, format };
  }

  throw new Error(`Unknown export format "${format}" (expected folder|md).`);
}

module.exports = {
  importSkill,
  exportSkill,
  _safeJoin,       // exposed for tests
  _sanitizeName,   // exposed for tests
};
