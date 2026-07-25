/**
 * Skill Loader — parse SKILL.md files with YAML frontmatter.
 *
 * Standard skill format (compatible with ANOLISA):
 *
 *   ---
 *   name: linux-admin
 *   version: 1.0.0
 *   description: Linux system administration skill
 *   layer: system          # system | application | domain
 *   lifecycle: operations  # development | testing | deployment | operations | maintenance
 *   tags: [linux, sysadmin]
 *   platforms: [cosh, claude-code, khy-quant]
 *   dependencies: [shell-scripting]
 *   ---
 *
 *   # Skill Title
 *   ... markdown body (instructions for the AI) ...
 *
 * Discovery chain (priority order, first match wins):
 *   1. Project:  ./.khy/skills/   (canonical)   then ./.khyquant/skills/ (legacy)
 *   2. User:     ~/.khy/skills/   (canonical)   then ~/.khyquant/skills/ (legacy)
 *   3. Built-in: backend/src/skills/
 *   4. CC bridge (gated KHY_CC_SKILL_BRIDGE, default ON): Claude Code's on-disk
 *      skill roots (~/.claude/skills, …) — appended LAST so khy-native SKILL.md
 *      always wins. A SKILL.md placed under khy's own ~/.khy/skills is therefore
 *      discovered natively, without living in ~/.claude/skills (which would also
 *      surface it in Claude Code's slash menu).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const SKILL_FILENAME = 'SKILL.md';

/**
 * Parse a SKILL.md file into structured data.
 */
function parseSkillFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return parseSkillContent(raw, filePath);
}

function parseSkillContent(content, sourcePath = '') {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!fmMatch) {
    return { meta: { name: path.basename(path.dirname(sourcePath)) }, body: content, source: sourcePath };
  }

  const meta = _parseYamlSimple(fmMatch[1]);
  const body = fmMatch[2].trim();

  return { meta, body, source: sourcePath };
}

/**
 * Simple YAML parser for frontmatter (no external deps).
 * Handles: scalars, inline arrays [a, b], block lists (key: then "- item"
 * lines), booleans, numbers, and quoted strings.
 */
function _parseYamlSimple(yaml) {
  const result = {};
  const lines = yaml.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Block-list item lines are consumed by their parent key below; a stray
    // item with no parent is ignored.
    if (trimmed.startsWith('- ')) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();

    // Inline array: [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      result[key] = value.slice(1, -1).split(',').map(v => v.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      continue;
    }

    // Block list: "key:" with nothing after the colon, followed by one or more
    // "- item" lines (any indentation). Look ahead and collect them.
    if (value === '') {
      const items = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const t = lines[j].trim();
        if (!t || t.startsWith('#')) continue;       // skip blanks/comments inside the list
        if (!t.startsWith('- ')) break;               // next key — stop
        items.push(t.slice(2).trim().replace(/^["']|["']$/g, ''));
      }
      if (items.length > 0) {
        result[key] = items;
        i = j - 1; // resume after the consumed list items
        continue;
      }
      // No list items followed — treat as an empty string value.
      result[key] = '';
      continue;
    }

    // Boolean
    if (value === 'true') { result[key] = true; continue; }
    if (value === 'false') { result[key] = false; continue; }

    // Number
    if (/^\d+(\.\d+)?$/.test(value)) { result[key] = Number(value); continue; }

    // String (strip quotes)
    result[key] = value.replace(/^["']|["']$/g, '');
  }

  return result;
}

/**
 * Discover all skills from the priority chain.
 * Returns Map<skillName, Skill> (first match wins in priority order).
 */
function discoverSkills(projectDir, opts = {}) {
  const homedir = opts.homedir || os.homedir();
  const skills = new Map();
  const searchPaths = [];

  // Priority 1: Project-level — canonical `.khy` first, then legacy `.khyquant`.
  if (projectDir) {
    searchPaths.push({ dir: path.join(projectDir, '.khy', 'skills'), source: 'project' });
    searchPaths.push({ dir: path.join(projectDir, '.khyquant', 'skills'), source: 'project' });
  }

  // Priority 2: User-level — canonical `~/.khy/skills` first, then legacy.
  searchPaths.push({ dir: path.join(homedir, '.khy', 'skills'), source: 'user' });
  searchPaths.push({ dir: path.join(homedir, '.khyquant', 'skills'), source: 'user' });

  // Priority 3: Built-in
  searchPaths.push({ dir: path.join(__dirname, '../../skills'), source: 'builtin' });

  for (const { dir, source } of searchPaths) {
    if (!fs.existsSync(dir)) continue;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillFile = path.join(dir, entry.name, SKILL_FILENAME);
        if (!fs.existsSync(skillFile)) continue;

        // First match wins (project > user > builtin)
        if (skills.has(entry.name)) continue;

        try {
          const skill = parseSkillFile(skillFile);
          skill.id = entry.name;
          skill.priority = source;
          skills.set(entry.name, skill);
        } catch (err) {
          console.error(`[SkillLoader] Failed to parse ${skillFile}: ${err.message}`);
        }
      }
    } catch { /* directory read error, skip */ }
  }

  return skills;
}

/**
 * Find skills matching a query by name, tags, or description.
 */
function matchSkills(skills, query) {
  const q = (query || '').toLowerCase();
  const results = [];

  for (const [, skill] of skills) {
    const { name = '', description = '', tags = [] } = skill.meta;
    const text = `${name} ${description} ${tags.join(' ')}`.toLowerCase();
    if (text.includes(q)) results.push(skill);
  }

  return results;
}

/**
 * Discover skills with recursive directory scanning.
 * Supports nested category structures: security/cve-query/SKILL.md
 * Returns Map<skillName, Skill> (first match wins in priority order).
 */
function discoverSkillsDeep(projectDir, opts = {}) {
  const homedir = opts.homedir || os.homedir();
  const skills = new Map();
  const searchPaths = [];

  // Priority 1: Project-level — canonical `.khy` first, then legacy `.khyquant`.
  if (projectDir) {
    searchPaths.push({ dir: path.join(projectDir, '.khy', 'skills'), source: 'project' });
    searchPaths.push({ dir: path.join(projectDir, '.khyquant', 'skills'), source: 'project' });
  }
  // Priority 2: User-level — canonical `~/.khy/skills` first, then legacy
  // `~/.khyquant/skills`. This is what lets khy natively discover a SKILL.md
  // dropped under its OWN home dir (no need to place it in Claude Code's
  // ~/.claude/skills, which would also surface it in CC's slash menu).
  searchPaths.push({ dir: path.join(homedir, '.khy', 'skills'), source: 'user' });
  searchPaths.push({ dir: path.join(homedir, '.khyquant', 'skills'), source: 'user' });
  // Priority 3: Built-in
  searchPaths.push({ dir: path.join(__dirname), source: 'builtin' });

  // CC marketplace bridge (gated, default ON): also discover skills that Claude
  // Code has installed on disk (~/.claude/skills, <project>/.claude/skills,
  // ~/.claude/plugins/cache, ~/.claude/local-plugins). khy's SKILL.md parser is
  // already CC-compatible, so we just feed CC's roots into the same recursive
  // scan below. Appended AFTER khy roots → khy-native SKILL.md keeps priority
  // (first match wins in _scanDirectory). OFF → byte-identical legacy khy chain.
  try {
    const ccBridge = require('./ccSkillBridge');
    if (ccBridge.isCcSkillBridgeEnabled()) {
      for (const p of ccBridge.ccSkillSearchPaths({ homedir, projectDir })) {
        searchPaths.push(p);
      }
    }
  } catch { /* bridge unavailable → khy-only discovery */ }

  for (const { dir, source } of searchPaths) {
    if (!fs.existsSync(dir)) continue;
    _scanDirectory(dir, skills, source);
  }

  return skills;
}

/**
 * Recursively scan a directory for SKILL.md files.
 */
function _scanDirectory(dir, skills, source) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subDir = path.join(dir, entry.name);

      // Check if this directory has a SKILL.md
      const skillFile = path.join(subDir, SKILL_FILENAME);
      if (fs.existsSync(skillFile)) {
        const skillId = entry.name;
        if (skills.has(skillId)) continue; // first match wins

        try {
          const skill = parseSkillFile(skillFile);
          skill.id = skillId;
          skill.priority = source;
          skills.set(skillId, skill);
        } catch { /* skip broken skill */ }
      }

      // Recurse into subdirectories (for category/skill-name structure)
      _scanDirectory(subDir, skills, source);
    }
  } catch { /* directory read error */ }
}

/**
 * Filter skills by platform compatibility.
 * @param {Map} skills - Skills map from discoverSkills
 * @param {string} platform - Target platform (e.g., 'khy-quant', 'claude-code')
 * @returns {Map} Filtered skills
 */
function filterByPlatform(skills, platform) {
  const result = new Map();
  for (const [id, skill] of skills) {
    const platforms = skill.meta.platforms || [];
    // If no platforms specified, treat as universal
    if (platforms.length === 0 || platforms.includes(platform)) {
      result.set(id, skill);
    }
  }
  return result;
}

/**
 * Group skills by category.
 * @param {Map} skills - Skills map
 * @returns {Object} Category -> skill array
 */
function groupByCategory(skills) {
  const grouped = {};
  for (const [, skill] of skills) {
    const category = skill.meta.category || skill.meta.layer || 'others';
    if (!grouped[category]) grouped[category] = [];
    grouped[category].push(skill);
  }
  return grouped;
}

/**
 * Group skills by layer (core / system / application / domain).
 * @param {Map} skills - Skills map
 * @returns {Object} Layer -> skill array
 */
function groupByLayer(skills) {
  const grouped = {};
  for (const [, skill] of skills) {
    const layer = skill.meta.layer || 'application';
    if (!grouped[layer]) grouped[layer] = [];
    grouped[layer].push(skill);
  }
  return grouped;
}

/**
 * Validate a skill's metadata for completeness.
 * @param {Object} skill - Parsed skill object
 * @returns {{ valid: boolean, warnings: string[] }}
 */
function validateSkill(skill) {
  const warnings = [];
  const meta = skill.meta || {};

  if (!meta.name) warnings.push('missing name');
  if (!meta.version) warnings.push('missing version');
  if (!meta.description) warnings.push('missing description');
  if (!meta.layer) warnings.push('missing layer (system|application|domain)');
  if (!meta.tags || meta.tags.length === 0) warnings.push('missing tags');
  if (!meta.platforms || meta.platforms.length === 0) warnings.push('missing platforms — skill assumed universal');

  return { valid: warnings.length === 0, warnings };
}

module.exports = {
  parseSkillFile,
  parseSkillContent,
  discoverSkills,
  discoverSkillsDeep,
  matchSkills,
  filterByPlatform,
  groupByCategory,
  groupByLayer,
  validateSkill,
};
