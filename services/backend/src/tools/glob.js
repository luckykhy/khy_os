/**
 * Glob — file pattern matching tool.
 *
 * Finds files matching a glob pattern (e.g. "**\/*.js", "src/**\/*.ts").
 * Results sorted by modification time (newest first), capped at 200 entries.
 *
 * Uses recursive fs.readdirSync + minimatch-style matching (pure JS, no deps).
 */
const { defineTool } = require('./_baseTool');
const fs = require('fs');
const path = require('path');

const MAX_RESULTS = 200;
const MAX_DEPTH = 15;

// Simple glob-to-regex converter (covers *, **, ?, {a,b}, [abc])
function globToRegex(pattern) {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** matches any path segment
        re += '.*';
        i += 2;
        if (pattern[i] === '/') i++; // consume trailing /
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end !== -1) {
        const alts = pattern.slice(i + 1, end).split(',').map(a => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        re += '(?:' + alts.join('|') + ')';
        i = end;
      } else {
        re += '\\{';
      }
    } else if (c === '[') {
      const end = pattern.indexOf(']', i);
      if (end !== -1) {
        re += pattern.slice(i, end + 1);
        i = end;
      } else {
        re += '\\[';
      }
    } else if ('.+^$|()\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
    i++;
  }
  return new RegExp('^' + re + '$');
}

// Skip directories that are never useful to search
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.cache',
  '__pycache__', '.tox', '.mypy_cache', '.pytest_cache', 'coverage',
  '.next', '.nuxt', '.output', 'vendor',
]);

function walkDir(dir, baseDir, regex, results, depth) {
  if (depth > MAX_DEPTH || results.length >= MAX_RESULTS) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    if (results.length >= MAX_RESULTS) break;
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      walkDir(fullPath, baseDir, regex, results, depth + 1);
    } else if (entry.isFile()) {
      if (regex.test(relPath)) {
        let mtime = 0;
        try { mtime = fs.statSync(fullPath).mtimeMs; } catch {}
        results.push({ path: relPath, mtime });
      }
    }
  }
}

module.exports = defineTool({
  name: 'glob',
  description:
    'Find files matching a glob pattern (e.g. "**/*.js", "src/**/*.ts").  ' +
    'Returns matching file paths sorted by modification time (newest first).  ' +
    'Use this instead of shell find commands.',
  category: 'filesystem',
  risk: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,

  aliases: ['find_files', 'find'],
  searchHint: 'find files by name pattern glob',

  inputSchema: {
    pattern: {
      type: 'string',
      required: true,
      description: 'Glob pattern to match files (e.g. "**/*.js", "src/**/*.{ts,tsx}")',
    },
    path: {
      type: 'string',
      required: false,
      description: 'Directory to search in (default: CWD)',
    },
  },

  getActivityDescription(input) {
    return `搜索文件：${input.pattern || '文件'}`;
  },

  async execute(params) {
    try {
      const cwd = process.env.KHYQUANT_CWD || process.cwd();
      let searchDir = params.path ? path.resolve(cwd, params.path) : cwd;

      if (!fs.existsSync(searchDir)) {
        return { success: false, error: `Directory not found: ${searchDir}` };
      }

      const regex = globToRegex(params.pattern);
      const results = [];
      walkDir(searchDir, searchDir, regex, results, 0);

      // Sort by mtime descending (newest first)
      results.sort((a, b) => b.mtime - a.mtime);

      const out = {
        success: true,
        files: results.map(r => r.path),
        count: results.length,
        truncated: results.length >= MAX_RESULTS,
      };
      // 抓重点(加法式,不动 files[]/count/truncated):结果多时附加 salience summary,
      // 让模型一眼看到关键文件+目录/类型分布,而非在长文件名列表里迷失。门控 KHY_GLOB_SALIENCE。
      try {
        const fileSalience = require('../services/fileSalience');
        const flagRegistry = require('../services/flagRegistry');
        const minN = flagRegistry.resolveNumeric('KHY_GLOB_SALIENCE_MIN', process.env);
        if (flagRegistry.isFlagEnabled('KHY_GLOB_SALIENCE', process.env)
            && fileSalience.isEnabled(process.env)
            && results.length >= minN) {
          const summary = fileSalience.summarizeListing(
            results.map(r => ({ path: r.path })), { env: process.env, total: results.length });
          const block = fileSalience.renderSalienceBlock(summary, { env: process.env });
          if (block) out.summary = block;
        }
      } catch { /* salience 附加失败绝不影响 glob 主结果 */ }
      return out;
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});
