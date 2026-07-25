/**
 * GlobTool — fast file pattern matching, aligned with Claude Code's Glob tool.
 *
 * Finds files matching a glob pattern. Results sorted by modification time.
 * Uses pure-JS recursive directory walking with glob-to-regex conversion.
 */
const { BaseTool } = require('../_baseTool');
const fs = require('fs');
const path = require('path');
// 墙钟预算:超大树 / Windows junction 回环下,防同步 walk 阻塞事件循环假死。
const walkBudget = require('../_walkBudget');

const MAX_RESULTS = 200;
const MAX_DEPTH = 15;

// Skip directories that are never useful to search
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.cache',
  '__pycache__', '.tox', '.mypy_cache', '.pytest_cache', 'coverage',
  '.next', '.nuxt', '.output', 'vendor',
]);

/**
 * Simple glob-to-regex converter (covers *, **, ?, {a,b}, [abc]).
 */
function globToRegex(pattern) {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (pattern[i] === '/') i++;
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

function walkDir(dir, baseDir, regex, results, depth, deadline) {
  if (depth > MAX_DEPTH || results.length >= MAX_RESULTS) return;
  // 墙钟预算耗尽 → 优雅提前返回(deadline 为 null 时表示门控关,永不触发 = 今日行为)。
  if (deadline && deadline.exceeded()) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    if (results.length >= MAX_RESULTS) break;
    if (deadline && deadline.exceeded()) break;
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      walkDir(fullPath, baseDir, regex, results, depth + 1, deadline);
    } else if (entry.isFile()) {
      if (regex.test(relPath)) {
        let mtime = 0;
        try { mtime = fs.statSync(fullPath).mtimeMs; } catch { /* skip */ }
        results.push({ path: relPath, mtime });
      }
    }
  }
}

// 异步孪生:与 walkDir 逐行等价,readdirSync/statSync → fs.promises 版,每个 entry 之间 await
// 让出。走 libuv 线程池 ⇒ 单个慢系统调用不再冻结事件循环 ⇒ 既有超时/中断恢复生效。结果形状
// (results[] 的 {path,mtime} 与集合)与同步版一致(execute 之后统一按 mtime 排序)。
async function walkDirAsync(dir, baseDir, regex, results, depth, deadline) {
  if (depth > MAX_DEPTH || results.length >= MAX_RESULTS) return;
  if (deadline && deadline.exceeded()) return;
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    if (results.length >= MAX_RESULTS) break;
    if (deadline && deadline.exceeded()) break;
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      await walkDirAsync(fullPath, baseDir, regex, results, depth + 1, deadline);
    } else if (entry.isFile()) {
      if (regex.test(relPath)) {
        let mtime = 0;
        try { mtime = (await fs.promises.stat(fullPath)).mtimeMs; } catch { /* skip */ }
        results.push({ path: relPath, mtime });
      }
    }
  }
}

class GlobTool extends BaseTool {
  static toolName = 'Glob';
  static category = 'filesystem';
  static risk = 'safe';
  static aliases = ['glob', 'find_files', 'find'];
  static searchHint = 'find files by name pattern glob';
  static alwaysLoad = true;

  isReadOnly() { return true; }
  isConcurrencySafe() { return true; }

  prompt() {
    return `- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns or directory layout
- Do NOT fall back to Bash find/ls loops for normal file discovery when Glob can answer directly
- Do NOT use this tool to search file contents. If you need to find code, identifiers, routes, or function definitions inside files, use Grep instead
- When a repository is unfamiliar, Glob is useful for mapping the top-level structure after you read README or project manifests
- If Glob returns too many files, narrow the pattern or path. If it returns zero files, broaden the pattern before giving up
- When you report results, mention the pattern/path you searched and how many files matched if that count matters to the conclusion
- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'The glob pattern to match files against',
        },
        path: {
          type: 'string',
          description: 'The directory to search in. If not specified, the current working directory will be used.',
        },
      },
      required: ['pattern'],
    };
  }

  getActivityDescription(input) {
    return `搜索文件：${input.pattern || '文件'}`;
  }

  async execute(params, _context) {
    try {
      const cwd = process.env.KHYQUANT_CWD || process.cwd();
      const searchDir = params.path ? path.resolve(cwd, params.path) : cwd;

      if (!fs.existsSync(searchDir)) {
        return { success: false, error: `Directory not found: ${searchDir}` };
      }

      const regex = globToRegex(params.pattern);
      const results = [];
      const deadline = walkBudget.createWalkDeadline(process.env);
      // 门开:异步 walk(不冻结事件循环,既有超时/中断恢复生效);门关:逐字节回退同步 walk。
      if (walkBudget.isWalkAsyncEnabled(process.env)) {
        await walkDirAsync(searchDir, searchDir, regex, results, 0, deadline);
      } else {
        walkDir(searchDir, searchDir, regex, results, 0, deadline);
      }

      // Sort by mtime descending (newest first)
      results.sort((a, b) => b.mtime - a.mtime);

      const timedOut = !!(deadline && deadline.exceeded());
      const out = {
        success: true,
        files: results.map(r => r.path),
        count: results.length,
        truncated: results.length >= MAX_RESULTS || timedOut,
      };
      // 墙钟预算耗尽:结果可能不完整,诚实标注(不改 files[]/count,加法式)。
      if (timedOut) out.timedOut = true;
      // 抓重点(加法式,不动 files[]/count/truncated):结果多时附加 salience summary,
      // 让模型一眼看到关键文件+目录/类型分布,而非在长文件名列表里迷失。门控 KHY_GLOB_SALIENCE。
      try {
        const fileSalience = require('../../services/fileSalience');
        const flagRegistry = require('../../services/flagRegistry');
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
  }
}

module.exports = new GlobTool();
module.exports.GlobTool = GlobTool;
