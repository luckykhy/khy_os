'use strict';

/**
 * CodebaseMapTool — AI tool for generating a compact codebase map.
 *
 * Solves the "analyze large project" problem: instead of dumping all code into
 * context (which overflows), this tool generates a lightweight structural map
 * (~200-500 tokens) that tells the AI WHERE to look for details.
 *
 * The AI can then use Read/Glob/Grep tools to explore specific files on demand.
 *
 * Output includes:
 * - Project type (node/python/rust/go/java)
 * - Entry points (main files, manifest mains)
 * - Dependencies (from package.json, pyproject.toml, etc.)
 * - Directory tree (depth-limited, node-count-limited)
 * - File type statistics
 * - Git branch info
 * - Test directories
 * - Config files
 *
 * Design principle: NEVER reads file contents — only directory listings and
 * manifest metadata. This keeps the output small while giving the AI enough
 * information to know where to dig deeper.
 *
 * @module tools/CodebaseMapTool
 */

const fs = require('fs');
const path = require('path');

const { BaseTool } = require('../_baseTool');

// Lazy-load the shared service (same one used by the CLI `project map` command)
let _mapService = null;
function _getMapService() {
  if (!_mapService) {
    _mapService = require('../../services/projectAnalysis/projectMapService');
  }
  return _mapService;
}

// Gate: KHY_CODEBASE_MAP_TOOL (default on)
function _gateEnabled(env = process.env) {
  try {
    const flagRegistry = require('../../services/flagRegistry');
    return flagRegistry.isFlagEnabled('KHY_CODEBASE_MAP_TOOL', env);
  } catch {
    const raw = env && env.KHY_CODEBASE_MAP_TOOL;
    if (raw === undefined || raw === null) {
      return true;
    }
    return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
  }
}

// Simple in-memory cache for repeated calls within a session
const _cache = new Map();
const CACHE_TTL_MS = 30000; // 30 seconds

function _getCached(key) {
  const entry = _cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) {
    return entry.value;
  }
  _cache.delete(key);
  return null;
}

function _setCached(key, value) {
  _cache.set(key, { value, ts: Date.now() });
  // Simple cleanup: if cache gets too large, clear it
  if (_cache.size > 100) {
    _cache.clear();
  }
}

class CodebaseMapTool extends BaseTool {
  static toolName = 'CodebaseMap';
  static category = 'analysis';
  static risk = 'safe';
  static aliases = ['codebase_map', 'project_map', 'map_project', 'map'];
  static searchHint =
    'codebase map project structure directory tree entry points dependencies architecture overview';
  static alwaysLoad = false;

  isReadOnly() {
    return true;
  }
  isDestructive() {
    return false;
  }
  isConcurrencySafe() {
    return true;
  }

  prompt() {
    return [
      '- Generates a compact structural map of a codebase without reading file contents.',
      '- Use this when you need to understand the overall structure of a project before diving into details.',
      '- Returns: project type, entry points, dependencies, directory tree (depth-limited), file type stats, git info, test dirs, config files.',
      '- Output is ~200-500 tokens — small enough to fit in context even for large projects.',
      '- After getting the map, use Read/Glob/Grep tools to explore specific files on demand.',
      '- For listing a single directory with importance ranking, use ListDir.',
      '- For finding files by name pattern, use Glob.',
      '- Modes: "mini" (~100 tokens), "standard" (~300 tokens), "full" (~500 tokens).',
    ].join('\n');
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'The project root directory to map. If not specified, uses the current working directory. Example: "/path/to/project" or "."',
        },
        depth: {
          type: 'number',
          description:
            'Maximum directory tree depth (default: 3, max: 5). Deeper trees show more detail but use more tokens. Example: 2',
        },
        maxNodes: {
          type: 'number',
          description:
            'Maximum tree nodes to include (default: 80, max: 200). Higher values show more files but use more tokens. Example: 50',
        },
        mode: {
          type: 'string',
          description:
            'Map detail level: "mini" (~100 tokens, just entry points + top files), "standard" (~300 tokens, default), "full" (~500 tokens, deeper tree + more stats + git + tests + config). Example: "standard"',
          enum: ['mini', 'standard', 'full'],
        },
      },
      required: [],
    };
  }

  getActivityDescription(input) {
    return `生成项目地图：${input.path || '.'}`;
  }

  async execute(params, _context) {
    try {
      const cwd = process.env.KHYQUANT_CWD || process.cwd();
      const targetPath = params.path ? path.resolve(cwd, params.path) : cwd;

      if (!fs.existsSync(targetPath)) {
        return { success: false, error: `Directory not found: ${targetPath}` };
      }

      let stat;
      try {
        stat = fs.statSync(targetPath);
      } catch {
        stat = null;
      }
      if (!stat || !stat.isDirectory()) {
        return { success: false, error: `Not a directory: ${targetPath}` };
      }

      const mapService = _getMapService();
      const mode = params.mode || 'standard';

      // Check cache for standard/full mode (not for custom paths)
      const cacheKey = `${targetPath}:${mode}:${params.depth || ''}:${params.maxNodes || ''}`;
      const cached = _getCached(cacheKey);
      if (cached && !params.path) {
        return { ...cached, cached: true };
      }

      let map;
      if (mode === 'mini') {
        map = mapService.generateMiniMap(targetPath);
      } else {
        const depthMap = { standard: 3, full: 5 };
        const nodesMap = { standard: 80, full: 200 };
        const depth = parseInt(params.depth, 10);
        const maxNodes = parseInt(params.maxNodes, 10);
        map = mapService.generateProjectMap(targetPath, {
          maxDepth: Number.isFinite(depth) ? Math.min(5, depth) : depthMap[mode],
          maxNodes: Number.isFinite(maxNodes) ? Math.min(200, maxNodes) : nodesMap[mode],
          includeManifest: true,
          includeTree: true,
          includeStats: mode === 'full',
          includeReadme: mode !== 'mini',
          includeGit: mode === 'full',
          includeTests: mode === 'full',
          includeConfig: mode === 'full',
        });
      }

      const result = {
        success: true,
        map,
        path: targetPath,
        mode,
        lines: map.split('\n').length,
        tokens: Math.ceil(map.length / 3), // Rough estimate: ~3 chars/token
      };

      // Cache the result
      if (!params.path) {
        _setCached(cacheKey, result);
      }

      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}

// Gate: disabled → export benign non-tool object, auto-discovery skips it
if (!_gateEnabled(process.env)) {
  module.exports = { _khyCodebaseMapDisabled: true };
} else {
  module.exports = new CodebaseMapTool();
  module.exports.CodebaseMapTool = CodebaseMapTool;
}
