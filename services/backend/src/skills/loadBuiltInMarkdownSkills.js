'use strict';

/**
 * Markdown-based built-in skill loader.
 *
 * Scans the built-in/ directory for .md files that declare `builtin: true`
 * in their YAML frontmatter and converts them to Skill objects compatible
 * with the directory-based skill system.
 *
 * This allows new built-in skills to be added as single markdown files
 * (frontmatter = manifest, body = prompt) without creating a full directory
 * with manifest.json + prompt.md + handler.js.
 *
 * Frontmatter fields (mirrors manifest.json keys):
 *   builtin: true          (required -- gates the file as a built-in skill)
 *   description: ...       (required)
 *   name: skill-name       (required)
 *   trigger: /skill-name   (optional -- defaults to /<name>)
 *   user_invocable: true   (optional -- default true)
 *   category: system       (optional)
 *   tags: [a, b]           (optional)
 *   platforms: [khy-os]    (optional)
 *   paths: [glob, ...]     (optional -- glob patterns for conditional activation)
 *   when_to_use: ...       (optional)
 *   allowed-tools: [Read, Write]  (optional)
 *   model: haiku           (optional)
 *   context: inline        (optional -- inline or fork)
 *
 * The markdown body (after frontmatter) becomes the prompt.md content.
 */

const fs = require('fs');
const path = require('path');
const { parseSkillContent } = require('./skillLoader');

// Cache to avoid re-scanning on every call
let _markdownSkillCache = null;

/**
 * Scan the built-in/ directory for markdown-based skills.
 * Pure function: reads from disk, never throws -- returns [] on any error.
 *
 * @returns {Array<import('./index').Skill>}
 */
function loadBuiltInMarkdownSkills() {
  if (_markdownSkillCache !== null) {
    return _markdownSkillCache;
  }

  const skills = [];
  const dir = path.join(__dirname, 'built-in');

  try {
    if (!fs.existsSync(dir)) {
      _markdownSkillCache = skills;
      return skills;
    }

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');

        // Gate: only files explicitly marked as builtin are auto-loaded
        const builtinFlag = _extractBuiltinFlag(raw);
        if (!builtinFlag) {
          continue;
        }

        // Parse frontmatter + body using the same parser as SKILL.md
        const parsed = parseSkillContent(raw, filePath);
        const meta = parsed.meta || {};

        // Require name and description
        if (!meta.name || !meta.description) {
          continue;
        }

        // Build a Skill object compatible with the directory-based format.
        // parsed.body is already the markdown content WITHOUT frontmatter.
        const skill = _buildMarkdownSkill(meta, parsed.body, filePath);
        skills.push(skill);
      } catch {
        // Skip unreadable files silently
      }
    }
  } catch {
    // Directory not readable -- return empty
  }

  _markdownSkillCache = skills;
  return skills;
}

/**
 * Build a Skill object from parsed frontmatter + markdown body.
 * @private
 */
function _buildMarkdownSkill(meta, body, sourcePath) {
  const rawTrigger = meta.trigger || meta.command || '/' + meta.name;
  const trigger = String(rawTrigger).startsWith('/')
    ? String(rawTrigger)
    : '/' + String(rawTrigger);

  const userInvocable =
    typeof meta.user_invocable === 'boolean'
      ? meta.user_invocable
      : typeof meta.userInvocable === 'boolean'
        ? meta.userInvocable
        : true;

  const allowedTools = _normalizeToolList(
    meta['allowed-tools'] || meta.allowed_tools || meta.allowedTools
  );

  const disableModelInvocation = _truthyFlag(
    meta['disable-model-invocation'] ??
      meta.disable_model_invocation ??
      meta.disableModelInvocation
  );

  return {
    name: meta.name,
    description: meta.description || '',
    userInvocable,
    trigger,
    aliases: Array.isArray(meta.aliases) ? meta.aliases : [],
    category: meta.category || 'others',
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    platforms: Array.isArray(meta.platforms) ? meta.platforms : [],
    paths: Array.isArray(meta.paths) ? meta.paths : null,
    whenToUse: meta.when_to_use || meta.whenToUse || '',
    allowedTools,
    disableModelInvocation,
    context: meta.context === 'fork' ? 'fork' : 'inline',
    model: meta.model || null,
    promptPath: sourcePath,     // The .md file itself serves as prompt
    handlerPath: null,          // Single-file skills cannot have handlers
    source: 'built-in',
    dir: path.dirname(sourcePath),
    _markdownBuiltIn: true,     // Marker for priority handling
    _promptBody: body,          // Cached prompt body (frontmatter already stripped)
  };
}

/**
 * Quick check: does this markdown content have `builtin: true` in frontmatter?
 * Doesn't do full parsing -- just a string scan for the flag.
 *
 * @param {string} raw
 * @returns {boolean}
 */
function _extractBuiltinFlag(raw) {
  // Extract the frontmatter block (between --- markers)
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return false;
  }
  // Look for builtin: true (case-insensitive for the key)
  return /\bbuiltin\s*:\s*true\b/i.test(match[1]);
}

/**
 * Normalize an "allowed-tools" value into a string[] or null.
 * @private
 */
function _normalizeToolList(value) {
  if (Array.isArray(value)) {
    const list = value.map((v) => String(v).trim()).filter(Boolean);
    return list.length ? list : null;
  }
  if (typeof value === 'string') {
    const list = value
      .split(/[,\s]+/)
      .map((v) => v.trim())
      .filter(Boolean);
    return list.length ? list : null;
  }
  return null;
}

/**
 * Coerce a frontmatter flag into a boolean.
 * @private
 */
function _truthyFlag(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return /^(true|yes|on|1)$/i.test(value.trim());
  }
  return value === 1;
}

/**
 * Clear the markdown built-in skill cache.
 * Exposed for testing.
 */
function clearMarkdownSkillCache() {
  _markdownSkillCache = null;
}

module.exports = {
  loadBuiltInMarkdownSkills,
  clearMarkdownSkillCache,
};
