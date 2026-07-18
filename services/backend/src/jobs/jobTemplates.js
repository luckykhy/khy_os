'use strict';

/**
 * jobTemplates.js — discover & load user-authored markdown task templates.
 *
 * Claude Code alignment: mirrors claude-code's `jobs/templates.ts`, the data
 * half of the `/job` command. A "template" is a `.md` file (optionally with
 * YAML-ish frontmatter) living in a `templates/` directory:
 *
 *   - project-level:  <projectDataHome>/templates/*.md
 *   - user-level:     <dataHome>/templates/*.md   (default ~/.khy/templates)
 *
 * Templates are the reusable, parameterizable prompt/task skeletons that a job
 * is instantiated from (see jobStore.js for the per-job runtime state). khy
 * already ships `localTemplates.js` (canned no-model output skeletons) and
 * `/cron` (scheduled prompts), but had no user-authored template→job concept;
 * this closes that gap without touching either.
 *
 * Pure/injectable: `listTemplates`/`loadTemplate` accept `{ fs, dirs }` so tests
 * can point at a temp directory with no real ~/.khy side effects. fail-soft:
 * unreadable dirs/files are skipped, never thrown.
 */
const fs = require('fs');
const path = require('path');

/**
 * Parse a minimal `---\nkey: value\n---\nbody` frontmatter block.
 * Deliberately tiny (no YAML dependency): one `key: value` per line, optional
 * surrounding quotes stripped. Anything that isn't a well-formed leading block
 * is treated as pure content with empty frontmatter.
 *
 * @param {string} raw
 * @returns {{ frontmatter: Record<string,string>, content: string }}
 */
function parseFrontmatter(raw) {
  const text = String(raw == null ? '' : raw);
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { frontmatter: {}, content: text };
  const frontmatter = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    let val = line.slice(idx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"'))
      || (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    frontmatter[key] = val;
  }
  return { frontmatter, content: m[2] || '' };
}

/** First markdown heading text, or first non-empty line, else ''. */
function _firstHeadingOrLine(content) {
  for (const line of String(content || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    return t.replace(/^#+\s*/, '');
  }
  return '';
}

/**
 * Default template directories: project-level first (higher precedence), then
 * user-level. Resolved lazily so requiring this module never touches the fs.
 * @returns {string[]}
 */
function _defaultDirs() {
  const dirs = [];
  try {
    const { getDataDir, getProjectDataDir } = require('../utils/dataHome');
    try { dirs.push(getProjectDataDir('templates')); } catch { /* optional */ }
    try { dirs.push(getDataDir('templates')); } catch { /* optional */ }
  } catch { /* dataHome optional */ }
  return Array.from(new Set(dirs));
}

/**
 * List all available templates across template directories. Earlier directories
 * win on name collisions (project overrides user).
 *
 * @param {{ fs?: object, dirs?: string[] }} [opts]
 * @returns {Array<{name,description,filePath,frontmatter,content}>}
 */
function listTemplates(opts = {}) {
  const fsImpl = opts.fs || fs;
  const dirs = opts.dirs || _defaultDirs();
  const out = [];
  const seen = new Set();

  for (const dir of dirs) {
    let files;
    try { files = fsImpl.readdirSync(dir); } catch { continue; }
    for (const file of files) {
      if (!String(file).endsWith('.md')) continue;
      const name = String(file).slice(0, -3);
      if (seen.has(name)) continue;
      seen.add(name);
      const filePath = path.join(dir, file);
      let raw;
      try { raw = fsImpl.readFileSync(filePath, 'utf8'); } catch { continue; }
      const { frontmatter, content } = parseFrontmatter(raw);
      const description =
        (typeof frontmatter.description === 'string' && frontmatter.description)
        || _firstHeadingOrLine(content)
        || 'No description';
      out.push({ name, description, filePath, frontmatter, content });
    }
  }
  return out;
}

/**
 * Load one template by name (null if not found).
 * @param {string} name
 * @param {{ fs?: object, dirs?: string[] }} [opts]
 * @returns {object|null}
 */
function loadTemplate(name, opts = {}) {
  const all = listTemplates(opts);
  return all.find((t) => t.name === name) || null;
}

module.exports = {
  parseFrontmatter,
  listTemplates,
  loadTemplate,
  _defaultDirs,
  _firstHeadingOrLine,
};
