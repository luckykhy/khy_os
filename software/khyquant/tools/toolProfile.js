/**
 * Tool Profile — predefined tool sets for different agent roles.
 *
 * Inspired by OpenClaw's tool-catalog.ts profile system:
 *   minimal   → read-only tools for exploration
 *   coding    → minimal + edit/execute/git tools for development
 *   analysis  → minimal + quant/finance tools
 *   full      → all tools (default)
 *
 * Each profile specifies an allow-list of tool names.
 * Tools not in the allow-list are hidden from the AI prompt,
 * reducing token usage and preventing unintended actions.
 */

// ── Profile Definitions ────────────────────────────────────────────

const PROFILES = {
  minimal: {
    description: 'Read-only tools for exploration and search',
    tools: [
      'readFile', 'glob', 'grep', 'search', 'toolSearch',
      'quote', 'dataFetch', 'webSearch',
    ],
  },

  coding: {
    description: 'Development tools: read, edit, execute, test, git',
    extends: 'minimal',
    tools: [
      'editFile', 'writeFile', 'scaffoldFiles', 'scaffold_files', 'shellCommand',
      'MultiEdit', 'multiEdit', 'multi_edit',
      'gitStatus', 'gitDiff', 'gitCommit',
      // Prefer canonical snake_case names; keep legacy camelCase for compatibility.
      'build_project', 'run_tests', 'lint_code',
      'buildProject', 'runTests', 'lintCode',
      'compile_file', 'compileFile',
      'executeCode',
      // Headless browser automation (navigate/click/fill/screenshot/getText/…) so
      // weak (T3) models trimmed to this profile can still drive the web.
      'WebBrowser', 'web_browser',
      'verify_artifact', 'verifyArtifact',
      'unpack',
      'projectTemplate', 'project_template',
      'createDocument', 'create_document',
      // Image generation (绘图/文生图) + editing (图改图) + video (文生视频) —
      // kept in the coding profile so weak (T3) models, which get trimmed to
      // this profile, can still draw, edit images, and generate video.
      'image_generate', 'imageGenerate', 'generate_image',
      'image_edit', 'imageEdit', 'edit_image', 'img2img',
      'video_generate', 'videoGenerate', 'generate_video',
      // KHY OS bare-metal kernel: deep low-level ops (disk/memory/process/syscall)
      // inside QEMU. Available to coding agents, not just the `full` profile.
      'khyos', 'KhyOs', 'kernel_exec',
    ],
  },

  analysis: {
    description: 'Quantitative analysis and financial tools',
    extends: 'minimal',
    tools: [
      'backtest', 'strategyList', 'optimizeConfig',
    ],
  },

  verification: {
    description: 'Read + execute tools for testing/validation (no file writes)',
    extends: 'minimal',
    tools: [
      'shellCommand', 'shell_command', 'bash',
      'LSP', 'lsp',
      'listDir', 'list_directory',
      'build_project', 'run_tests', 'lint_code',
      'buildProject', 'runTests', 'lintCode',
      'compile_file', 'compileFile',
    ],
  },

  explore: {
    description: 'Read-only tools for codebase exploration (search + read only)',
    tools: [
      'readFile', 'Read', 'read_file',
      'glob', 'Glob',
      'grep', 'Grep',
      'search', 'toolSearch',
      'shellCommand', 'Bash', 'shell_command',
    ],
  },

  full: {
    description: 'All available tools (default)',
    tools: null, // null = no filtering
  },
};

// ── Resolved cache (profile → Set<string>) ─────────────────────────

const _resolved = new Map();

// Legacy profile names to canonical tool names.
const LEGACY_TOOL_NAME_ALIASES = Object.freeze({
  buildProject: 'build_project',
  runTests: 'run_tests',
  lintCode: 'lint_code',
  verifyArtifact: 'verify_artifact',
});

/**
 * Resolve a profile's full tool list (following extends chain).
 * @param {string} profileId
 * @returns {Set<string>|null}  null means "all tools"
 */
function _resolve(profileId) {
  if (_resolved.has(profileId)) return _resolved.get(profileId);

  const profile = PROFILES[profileId];
  if (!profile) return null; // unknown profile = full access

  if (profile.tools === null) {
    _resolved.set(profileId, null);
    return null;
  }

  const set = new Set(profile.tools);
  // Add canonical names for legacy aliases to avoid profile miss and tool starvation.
  for (const name of profile.tools) {
    const canonical = LEGACY_TOOL_NAME_ALIASES[name];
    if (canonical) set.add(canonical);
  }

  // Resolve extends chain
  if (profile.extends) {
    const parent = _resolve(profile.extends);
    if (parent) {
      for (const name of parent) set.add(name);
    }
  }

  _resolved.set(profileId, set);
  return set;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Get the list of tool names allowed by a profile.
 * @param {string} profileId  One of: minimal, coding, analysis, full
 * @returns {string[]|null}   null means all tools are allowed
 */
function getProfileTools(profileId) {
  const set = _resolve(profileId);
  return set ? [...set] : null;
}

/**
 * Filter a tools Map by profile.
 * @param {Map<string, object>} toolsMap
 * @param {string} profileId
 * @returns {Map<string, object>}  Filtered map (or original if full)
 */
function filterToolsByProfile(toolsMap, profileId) {
  if (!profileId || profileId === 'full') return toolsMap;

  const allowed = _resolve(profileId);
  if (!allowed) return toolsMap;

  const filtered = new Map();
  for (const [name, tool] of toolsMap) {
    if (allowed.has(name)) {
      filtered.set(name, tool);
    }
    // Also check aliases
    if (tool.aliases && Array.isArray(tool.aliases)) {
      for (const alias of tool.aliases) {
        if (allowed.has(alias) && !filtered.has(name)) {
          filtered.set(name, tool);
          break;
        }
      }
    }
  }
  return filtered;
}

/**
 * List all available profile IDs and their descriptions.
 * @returns {Array<{id: string, description: string, toolCount: number|string}>}
 */
function listProfiles() {
  return Object.entries(PROFILES).map(([id, p]) => ({
    id,
    description: p.description,
    toolCount: p.tools === null ? 'all' : (_resolve(id)?.size || 0),
  }));
}

module.exports = { getProfileTools, filterToolsByProfile, listProfiles, PROFILES };
