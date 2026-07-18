/**
 * Skill Module — Claude Code-aligned skill loading, discovery, and execution.
 *
 * Skill format (directory-based):
 *   skill-name/
 *     manifest.json   — name, description, trigger, user_invocable, tags
 *     prompt.md       — Full prompt template injected when the skill is invoked
 *     handler.js      — (optional) Custom execution logic beyond prompt injection
 *
 * Discovery chain (priority order):
 *   1. Project:  ./.khy/skills/
 *   2. User:     ~/.khy/skills/
 *   3. Built-in: backend/src/skills/built-in/
 *   4. Legacy SKILL.md format (via skillLoader for backwards compatibility)
 *
 * Public API:
 *   loadSkillsFromDir(dir)     — Load all skills from a directory
 *   discoverAllSkills(projDir) — Full discovery chain
 *   getSkillCommands()         — Get user-invocable skill commands
 *   executeSkill(name, args)   — Execute a skill by name or trigger
 *   getSkillPrompt(name)       — Get the prompt.md content for a skill
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const BUILT_IN_DIR = path.join(__dirname, 'built-in');
const USER_SKILLS_DIR = path.join(os.homedir(), '.khy', 'skills');
const LEGACY_USER_DIR = path.join(os.homedir(), '.khyquant', 'skills');

/** @type {Map<string, Skill>} */
let _skillCache = new Map();
let _cacheReady = false;

// ── Skill Definition ────────────────────────────────────────────────────────

/**
 * @typedef {object} Skill
 * @property {string} name        - Unique skill identifier
 * @property {string} description - Short human-readable description
 * @property {boolean} userInvocable - Whether users can trigger this skill directly
 * @property {string} trigger     - Slash command trigger (e.g., "/commit")
 * @property {string[]} aliases   - Alternative triggers
 * @property {string} category    - Skill category
 * @property {string[]} tags      - Searchable tags
 * @property {string} promptPath  - Absolute path to prompt.md
 * @property {string|null} handlerPath - Absolute path to handler.js (or null)
 * @property {string} source      - 'built-in' | 'user' | 'project'
 * @property {string} dir         - Absolute path to the skill directory
 */

// ── Loading ─────────────────────────────────────────────────────────────────

/**
 * Load all skills from a directory. Each subdirectory must contain a manifest.json.
 * @param {string} dir - Directory to scan
 * @param {string} source - Source label ('built-in', 'user', 'project')
 * @returns {Map<string, Skill>}
 */
function loadSkillsFromDir(dir, source = 'user') {
  const skills = new Map();
  if (!fs.existsSync(dir)) return skills;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return skills;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillDir = path.join(dir, entry.name);
    const manifestPath = path.join(skillDir, 'manifest.json');

    if (!fs.existsSync(manifestPath)) continue;

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const skill = _buildSkill(manifest, skillDir, source);
      if (skill) {
        skills.set(skill.name, skill);
      }
    } catch (err) {
      // Log but do not fail — one broken skill should not break the system
      process.stderr.write(`[SkillLoader] Failed to load skill at ${skillDir}: ${err.message}\n`);
    }
  }

  return skills;
}

/**
 * Discover all skills from the full priority chain.
 * Project skills override user skills, which override built-in skills.
 * @param {string} [projectDir] - Optional project root directory
 * @returns {Map<string, Skill>}
 */
function discoverAllSkills(projectDir) {
  // Load in reverse priority order so that higher-priority entries overwrite
  const skills = new Map();

  // Priority 3: Built-in (lowest priority)
  const builtIn = loadSkillsFromDir(BUILT_IN_DIR, 'built-in');
  for (const [name, skill] of builtIn) {
    skills.set(name, skill);
  }

  // Priority 2: User-level (~/.khy/skills/ and legacy ~/.khyquant/skills/)
  const legacyUser = loadSkillsFromDir(LEGACY_USER_DIR, 'user');
  for (const [name, skill] of legacyUser) {
    skills.set(name, skill);
  }
  const userSkills = loadSkillsFromDir(USER_SKILLS_DIR, 'user');
  for (const [name, skill] of userSkills) {
    skills.set(name, skill);
  }

  // Priority 1: Project-level (highest priority)
  if (projectDir) {
    const projectKhy = loadSkillsFromDir(path.join(projectDir, '.khy', 'skills'), 'project');
    for (const [name, skill] of projectKhy) {
      skills.set(name, skill);
    }
    // Legacy project path
    const projectLegacy = loadSkillsFromDir(path.join(projectDir, '.khyquant', 'skills'), 'project');
    for (const [name, skill] of projectLegacy) {
      skills.set(name, skill);
    }
  }

  // Also integrate legacy SKILL.md format via the existing skillLoader
  try {
    const skillLoader = require('./skillLoader');
    const legacySkills = skillLoader.discoverSkillsDeep(projectDir);
    for (const [id, legacySkill] of legacySkills) {
      // Only add if not already present from manifest-based loading
      if (!skills.has(id)) {
        skills.set(id, _convertLegacySkill(id, legacySkill));
      }
    }
  } catch { /* legacy loader is optional */ }

  _skillCache = skills;
  _cacheReady = true;
  return skills;
}

/**
 * Get cached skills (call discoverAllSkills first to populate).
 * @returns {Map<string, Skill>}
 */
function getCachedSkills() {
  if (!_cacheReady) {
    discoverAllSkills();
  }
  return _skillCache;
}

/**
 * Invalidate the skill cache (forces re-discovery on next access).
 */
function invalidateCache() {
  _skillCache = new Map();
  _cacheReady = false;
}

// ── Querying ────────────────────────────────────────────────────────────────

/**
 * Whether a skill should appear in the model-facing catalog: it must be
 * user-invocable AND not disabled in the A2 state ledger. The ledger lookup is
 * fail-open (missing ledger → enabled) so the catalog never breaks if state
 * persistence is unavailable.
 * @private
 * @param {Skill} skill
 * @returns {boolean}
 */
function _isCatalogVisible(skill) {
  if (!skill.userInvocable) return false;
  try {
    return require('../services/skillStateService').isEnabled(skill.name);
  } catch {
    return true;
  }
}

/**
 * Get all user-invocable skill commands for system prompt listing.
 * Returns an array of command descriptors suitable for AI system reminders.
 * @returns {{ name: string, description: string, trigger: string }[]}
 */
function getSkillCommands() {
  const skills = getCachedSkills();
  const commands = [];

  for (const skill of skills.values()) {
    if (!_isCatalogVisible(skill)) continue;
    commands.push({
      name: skill.name,
      description: skill.description,
      trigger: skill.trigger,
      aliases: skill.aliases,
      category: skill.category,
      whenToUse: skill.whenToUse || '',
    });
  }

  return commands;
}

/**
 * Format skill commands as a string for system prompt injection.
 * Mirrors Claude Code's budget-aware skill listing.
 * @param {number} [charBudget=8000] - Maximum characters for the listing
 * @returns {string}
 */
function formatSkillListing(charBudget = 8000, context) {
  // When context is provided, only list skills active in that context
  let commands;
  if (context) {
    const activeSkills = getActiveSkills(context);
    commands = activeSkills.map(skill => ({
      name: skill.name,
      description: skill.description,
      trigger: skill.trigger,
      aliases: skill.aliases,
      category: skill.category,
      whenToUse: skill.whenToUse || '',
    }));
  } else {
    commands = getSkillCommands();
  }

  if (commands.length === 0) return '';

  // Catalog line: "- /trigger: description (use when: <whenToUse>)". The
  // when-to-use hint is appended only when present, so skills without it keep
  // the minimal name+description shape.
  const formatLine = (cmd, descLen) => {
    const desc = cmd.description.length > descLen
      ? cmd.description.slice(0, descLen - 1) + '\u2026'
      : cmd.description;
    const hint = cmd.whenToUse
      ? ` (use when: ${cmd.whenToUse.length > 120 ? cmd.whenToUse.slice(0, 119) + '\u2026' : cmd.whenToUse})`
      : '';
    return `- ${cmd.trigger}: ${desc}${hint}`;
  };

  const lines = commands.map(cmd => formatLine(cmd, 250));

  const full = lines.join('\n');
  if (full.length <= charBudget) return full;

  // Truncate descriptions to fit within budget
  const overhead = commands.reduce((sum, cmd) => sum + cmd.trigger.length + 4, 0);
  const availableForDescs = charBudget - overhead;
  const maxDescLen = Math.max(20, Math.floor(availableForDescs / commands.length));

  return commands.map(cmd => formatLine(cmd, maxDescLen)).join('\n');
}

// ── Glob matching (zero-dependency) ───────────────────────────────────────

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports: ** (any depth), * (single segment), ? (single char).
 *
 * @param {string} pattern - Glob pattern (e.g., "**\/*.ts", "src/**", "*.vue")
 * @returns {RegExp}
 */
function _globToRegex(pattern) {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      // ** matches any number of path segments
      re += '.*';
      i += 2;
      // Skip trailing /
      if (pattern[i] === '/') i++;
    } else if (ch === '*') {
      // * matches anything except /
      re += '[^/]*';
      i++;
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else if (ch === '.') {
      re += '\\.';
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  return new RegExp('^' + re + '$');
}

/**
 * Test if a file path matches any of the given glob patterns.
 * @param {string} filePath - File path to test (relative to cwd)
 * @param {string[]} patterns - Array of glob patterns
 * @returns {boolean}
 */
function _matchesGlob(filePath, patterns) {
  if (!filePath || !patterns || patterns.length === 0) return false;
  const normalized = filePath.replace(/\\/g, '/');
  for (const pat of patterns) {
    if (_globToRegex(pat).test(normalized)) return true;
  }
  return false;
}

// ── Conditional Activation ───────────────────────────────────────────────

/**
 * Get skills that should be active based on the current context.
 * Skills with paths=null are always active.
 * Skills with paths=[...] are active only if cwd or recentFiles match.
 *
 * @param {object} [context]
 * @param {string} [context.cwd] - Current working directory
 * @param {string[]} [context.recentFiles] - Recently touched file paths
 * @returns {Skill[]}
 */
function getActiveSkills(context) {
  const skills = getCachedSkills();
  const result = [];

  // Collect files in cwd for matching (lazy, only when needed)
  let cwdFiles = null;

  for (const skill of skills.values()) {
    if (!_isCatalogVisible(skill)) continue;

    // No paths constraint → always active
    if (!skill.paths || skill.paths.length === 0) {
      result.push(skill);
      continue;
    }

    // Check recent files first (cheap)
    if (context?.recentFiles) {
      let matched = false;
      for (const f of context.recentFiles) {
        if (_matchesGlob(f, skill.paths)) {
          matched = true;
          break;
        }
      }
      if (matched) {
        result.push(skill);
        continue;
      }
    }

    // Check cwd: scan directory for matching files
    if (context?.cwd) {
      if (!cwdFiles) {
        cwdFiles = _scanCwdFiles(context.cwd, 2); // max 2 levels deep
      }
      let matched = false;
      for (const f of cwdFiles) {
        if (_matchesGlob(f, skill.paths)) {
          matched = true;
          break;
        }
      }
      if (matched) {
        result.push(skill);
        continue;
      }
    }

    // No match — skill not active in this context
  }

  return result;
}

/**
 * Find skills whose paths patterns match a specific file path.
 * @param {string} filePath - File path to match against
 * @returns {Set<string>} Set of matching skill names
 */
function matchAndActivateByPath(filePath) {
  const skills = getCachedSkills();
  const matched = new Set();

  for (const [name, skill] of skills) {
    if (!skill.paths || skill.paths.length === 0) continue;
    if (_matchesGlob(filePath, skill.paths)) {
      matched.add(name);
    }
  }

  return matched;
}

/**
 * Scan a directory for file names (relative paths), up to maxDepth levels.
 * @param {string} dir
 * @param {number} maxDepth
 * @returns {string[]}
 */
function _scanCwdFiles(dir, maxDepth) {
  const files = [];
  try {
    _scanDir(dir, '', maxDepth, files);
  } catch { /* access error */ }
  return files;
}

function _scanDir(base, rel, depth, out) {
  if (depth < 0) return;
  let entries;
  try {
    entries = fs.readdirSync(path.join(base, rel), { withFileTypes: true });
  } catch { return; }

  for (const entry of entries) {
    // Skip hidden dirs and node_modules
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const relPath = rel ? rel + '/' + entry.name : entry.name;
    if (entry.isFile()) {
      out.push(relPath);
    } else if (entry.isDirectory() && depth > 0) {
      _scanDir(base, relPath, depth - 1, out);
    }
  }
}

/**
 * Find a skill by name, trigger, or alias.
 * @param {string} identifier - Skill name, trigger (e.g., "/commit"), or alias
 * @returns {Skill|null}
 */
function findSkill(identifier) {
  const skills = getCachedSkills();
  const normalized = identifier.startsWith('/') ? identifier : `/${identifier}`;

  // Direct name match
  if (skills.has(identifier)) return skills.get(identifier);

  // Trigger or alias match
  for (const skill of skills.values()) {
    if (skill.trigger === normalized) return skill;
    if (skill.trigger === identifier) return skill;
    if (skill.aliases && skill.aliases.includes(normalized)) return skill;
    if (skill.aliases && skill.aliases.includes(identifier)) return skill;
  }

  return null;
}

// ── Execution ───────────────────────────────────────────────────────────────

/**
 * Execute a skill by name, trigger, or alias.
 * @param {string} name - Skill identifier
 * @param {string} [args] - Arguments string passed to the skill
 * @param {object} [context={}] - Execution context (e.g., cwd, user info)
 * @returns {Promise<{ type: string, content: string, skill: string }>}
 */
async function executeSkill(name, args, context = {}) {
  const skill = findSkill(name);
  if (!skill) {
    throw new Error(`Skill "${name}" not found. Use /help to see available skills.`);
  }

  // A2 — enable/disable gate. A disabled skill refuses execution from any
  // caller (model or human). The state ledger is optional; if it is missing or
  // errors, the skill is treated as enabled (fail-open for availability).
  try {
    const skillState = require('../services/skillStateService');
    if (!skillState.isEnabled(skill.name)) {
      throw new Error(`Skill "${skill.name}" is disabled. Run \`khy skill enable ${skill.name}\` to re-enable it.`);
    }
  } catch (err) {
    if (err && /is disabled\./.test(err.message)) throw err;
    /* ledger unavailable — treat as enabled */
  }

  // Record usage for Curator lifecycle tracking (never breaks execution)
  try {
    const { recordUsage } = require('../services/skillCuratorService');
    recordUsage(skill.name, skill.source);
  } catch { /* curator is optional */ }

  // If the skill has a custom handler, execute it
  if (skill.handlerPath && fs.existsSync(skill.handlerPath)) {
    // A1 — while a handler runs in-process, its `allowed-tools` (if any) become
    // a runtime whitelist enforced by toolCalling._checkActiveSkillPolicy.
    let activeRestore = null;
    try {
      const activeSkillContext = require('../services/activeSkillContext');
      activeRestore = activeSkillContext.setActiveSkill(skill);
    } catch { /* marker optional */ }
    try {
      // Clear require cache for hot-reload during development
      try { delete require.cache[require.resolve(skill.handlerPath)]; } catch { /* ignore */ }

      const handler = require(skill.handlerPath);
      if (typeof handler.execute === 'function') {
        const result = await handler.execute(args, context);
        return {
          type: 'handler-result',
          content: typeof result === 'string' ? result : JSON.stringify(result),
          skill: skill.name,
        };
      }
      if (typeof handler === 'function') {
        const result = await handler(args, context);
        return {
          type: 'handler-result',
          content: typeof result === 'string' ? result : JSON.stringify(result),
          skill: skill.name,
        };
      }
    } catch (err) {
      throw new Error(`Skill "${skill.name}" handler failed: ${err.message}`);
    } finally {
      try {
        const activeSkillContext = require('../services/activeSkillContext');
        activeSkillContext.clearActiveSkill(activeRestore);
      } catch { /* marker optional */ }
    }
  }

  // Default: return the prompt template for AI-driven execution
  const prompt = getSkillPrompt(skill.name);
  if (!prompt) {
    throw new Error(`Skill "${skill.name}" has no prompt.md and no handler.js`);
  }

  return {
    type: 'prompt',
    content: prompt,
    skill: skill.name,
    args: args || '',
  };
}

/**
 * Get the prompt.md content for a skill.
 * @param {string} name - Skill name
 * @returns {string|null}
 */
function getSkillPrompt(name) {
  const skill = findSkill(name);
  if (!skill) return null;

  if (!skill.promptPath || !fs.existsSync(skill.promptPath)) return null;

  try {
    return fs.readFileSync(skill.promptPath, 'utf-8');
  } catch {
    return null;
  }
}

// ── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Build a Skill object from a manifest and directory path.
 * @private
 */
function _buildSkill(manifest, skillDir, source) {
  if (!manifest.name) return null;

  const promptPath = path.join(skillDir, 'prompt.md');
  const handlerPath = path.join(skillDir, 'handler.js');
  const rawTrigger = manifest.trigger || manifest.command || `/${manifest.name}`;
  const trigger = String(rawTrigger).startsWith('/') ? String(rawTrigger) : `/${String(rawTrigger)}`;
  const userInvocable = typeof manifest.user_invocable === 'boolean'
    ? manifest.user_invocable
    : (typeof manifest.userInvocable === 'boolean' ? manifest.userInvocable : true);

  return {
    name: manifest.name,
    description: manifest.description || '',
    userInvocable,
    trigger,
    aliases: Array.isArray(manifest.aliases) ? manifest.aliases : [],
    category: manifest.category || 'others',
    tags: Array.isArray(manifest.tags) ? manifest.tags : [],
    platforms: Array.isArray(manifest.platforms) ? manifest.platforms : [],
    paths: Array.isArray(manifest.paths) ? manifest.paths : null, // null = always active
    // CC-parity frontmatter (s07): guide invocation, scope tools, choose
    // execution context and model. Normalized here so every consumer reads one
    // shape regardless of which key style the manifest used.
    whenToUse: manifest.when_to_use || manifest.whenToUse || '',
    allowedTools: _normalizeToolList(manifest['allowed-tools'] || manifest.allowed_tools || manifest.allowedTools),
    // DesireCore-style control: when true the model may NOT invoke this skill
    // via SkillTool (human CLI `skill run` still works). Default false.
    disableModelInvocation: _truthyFlag(
      manifest['disable-model-invocation'] ?? manifest.disable_model_invocation ?? manifest.disableModelInvocation,
    ),
    context: manifest.context === 'fork' ? 'fork' : 'inline',
    model: manifest.model || null,
    promptPath: fs.existsSync(promptPath) ? promptPath : null,
    handlerPath: fs.existsSync(handlerPath) ? handlerPath : null,
    source,
    dir: skillDir,
  };
}

/**
 * Convert a legacy SKILL.md-based skill into the new format.
 * @private
 */
function _convertLegacySkill(id, legacySkill) {
  const meta = legacySkill.meta || {};
  return {
    name: id,
    description: meta.description || '',
    userInvocable: true,
    trigger: `/${id}`,
    aliases: [],
    category: meta.category || meta.layer || 'others',
    tags: meta.tags || [],
    platforms: meta.platforms || [],
    paths: Array.isArray(meta.paths) ? meta.paths : null,
    // CC-parity frontmatter (s07): same normalized shape as manifest skills.
    whenToUse: meta.when_to_use || meta.whenToUse || '',
    allowedTools: _normalizeToolList(meta['allowed-tools'] || meta.allowed_tools || meta.allowedTools),
    disableModelInvocation: _truthyFlag(
      meta['disable-model-invocation'] ?? meta.disable_model_invocation ?? meta.disableModelInvocation,
    ),
    context: meta.context === 'fork' ? 'fork' : 'inline',
    model: meta.model || null,
    promptPath: legacySkill.source || null,
    handlerPath: null,
    source: legacySkill.priority || 'builtin',
    dir: legacySkill.source ? path.dirname(legacySkill.source) : null,
    // Preserve legacy body for prompt access
    _legacyBody: legacySkill.body || null,
  };
}

/**
 * Normalize an "allowed-tools" frontmatter value into a string[] or null.
 * Accepts an array, or a comma/space-separated string. null = no restriction.
 * @private
 * @param {*} value
 * @returns {string[]|null}
 */
function _normalizeToolList(value) {
  if (Array.isArray(value)) {
    const list = value.map(v => String(v).trim()).filter(Boolean);
    return list.length ? list : null;
  }
  if (typeof value === 'string') {
    const list = value.split(/[,\s]+/).map(v => v.trim()).filter(Boolean);
    return list.length ? list : null;
  }
  return null;
}

/**
 * Coerce a frontmatter flag into a boolean. Accepts real booleans and the
 * common string spellings ("true"/"yes"/"1") that the simple YAML parser may
 * leave as strings. Anything else is false.
 * @private
 * @param {*} value
 * @returns {boolean}
 */
function _truthyFlag(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return /^(true|yes|on|1)$/i.test(value.trim());
  }
  return value === 1;
}

module.exports = {
  // Loading
  loadSkillsFromDir,
  discoverAllSkills,
  getCachedSkills,
  invalidateCache,

  // Querying
  getSkillCommands,
  formatSkillListing,
  findSkill,

  // Conditional activation
  getActiveSkills,
  matchAndActivateByPath,

  // Execution
  executeSkill,
  getSkillPrompt,
};
