/**
 * ListDirTool — 列目录并「抓重点」。补 khy 缺失的专用列目录工具。
 *
 * 背景(goal「分析压缩包/文件夹/盘符时文件太多抓不住重点」):khy 此前无专用 list_directory 工具,
 * FileReadTool 显式把 agent 推去用 Bash ls/find(裸 dump,无上限、无排序、无分组)。分析大文件夹 /
 * C、D 盘符时,一堆文件名把入口 / README / manifest / config 淹没。本工具在列目录后经 fileSalience
 * 附加「关键文件 + 按目录/扩展名分组计数 + 最大文件」摘要,让模型一眼抓住重点。
 *
 * 门控 KHY_LISTDIR_TOOL(经 flagRegistry 声明式注册,默认开)。关 → 本模块导出一个 benign 非工具对象,
 * 自动发现循环(tools/index.js Phase 1 的 Case 1–6)全部跳过 → 工具不注册(= 今日无此工具的行为)。
 */
const { BaseTool } = require('../_baseTool');
const fs = require('fs');
const path = require('path');
// 墙钟预算:超大树 / Windows junction 回环下,防同步 walk 阻塞事件循环假死。
const walkBudget = require('../_walkBudget');

const MAX_RESULTS = 1000;   // 单次列举上限(防超大目录 OOM;salience 在此上限内重排+摘要)
const MAX_DEPTH = 4;        // 递归深度上限(列目录用,浅于 Glob 的 15)

// 与 GlobTool / fileSalience / projectMetadataService 同口径的噪声目录集。
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.cache',
  '__pycache__', '.tox', '.mypy_cache', '.pytest_cache', 'coverage',
  '.next', '.nuxt', '.output', 'vendor', 'target', 'out',
]);

function _gateEnabled(env = process.env) {
  try {
    const flagRegistry = require('../../services/flagRegistry');
    return flagRegistry.isFlagEnabled('KHY_LISTDIR_TOOL', env);
  } catch {
    // flagRegistry 不可用 → 保守放行(默认开语义)。
    const raw = env && env.KHY_LISTDIR_TOOL;
    if (raw === undefined || raw === null) return true;
    return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
  }
}

function walkDir(dir, baseDir, results, depth, maxDepth, deadline) {
  if (depth > maxDepth || results.length >= MAX_RESULTS) return;
  // 墙钟预算耗尽 → 优雅提前返回(deadline 为 null 时表示门控关,永不触发 = 今日行为)。
  if (deadline && deadline.exceeded()) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    if (results.length >= MAX_RESULTS) break;
    if (deadline && deadline.exceeded()) break;
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      walkDir(fullPath, baseDir, results, depth + 1, maxDepth, deadline);
    } else if (entry.isFile()) {
      let size = 0;
      try { size = fs.statSync(fullPath).size; } catch { /* skip size */ }
      results.push({ path: relPath, size, isDirectory: false });
    }
  }
}

// 异步孪生:与 walkDir 逐行等价,只把 readdirSync/statSync 换成 fs.promises 版并在每个 entry
// 之间 await 让出。走 libuv 线程池 ⇒ 单个慢系统调用不再冻结事件循环 ⇒ 工具漏斗 120s 墙钟竞赛 /
// abort / 本模块的 deadline.exceeded() 全部恢复生效。结果形状(results[] 的 {path,size,isDirectory}
// 与顺序)与同步版逐字节一致(readdir 返回顺序相同,execute 之后仍统一 sort)。
async function walkDirAsync(dir, baseDir, results, depth, maxDepth, deadline) {
  if (depth > maxDepth || results.length >= MAX_RESULTS) return;
  if (deadline && deadline.exceeded()) return;
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    if (results.length >= MAX_RESULTS) break;
    if (deadline && deadline.exceeded()) break;
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      await walkDirAsync(fullPath, baseDir, results, depth + 1, maxDepth, deadline);
    } else if (entry.isFile()) {
      let size = 0;
      try { size = (await fs.promises.stat(fullPath)).size; } catch { /* skip size */ }
      results.push({ path: relPath, size, isDirectory: false });
    }
  }
}

class ListDirTool extends BaseTool {
  static toolName = 'ListDir';
  static category = 'filesystem';
  static risk = 'safe';
  static aliases = ['list_directory', 'list_dir', 'listdir'];
  static searchHint = 'list a directory and surface the important files';
  static alwaysLoad = true;

  isReadOnly() { return true; }
  isConcurrencySafe() { return true; }

  prompt() {
    return `- Lists the files under a directory and surfaces the ones that matter (entry points, README, manifests, config), plus a per-directory and per-extension breakdown
- Use this for "what's in this folder / drive / project", especially when a directory has many files and a raw listing would bury the key files
- Prefer this over Bash ls/find loops for directory overview: it ranks by intrinsic importance and groups counts, so you grasp the structure at a glance
- Returns: files[] (relative paths), count, truncated, and a human-readable summary highlighting the important files
- For finding files by a name pattern use Glob; to search file contents use Grep`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The directory to list. If not specified, the current working directory is used.',
        },
        depth: {
          type: 'number',
          description: `Recursion depth (default 2, max ${MAX_DEPTH}). 1 = only the given directory.`,
        },
      },
      required: [],
    };
  }

  getActivityDescription(input) {
    return `列目录：${input.path || '.'}`;
  }

  async execute(params, _context) {
    try {
      const env = process.env;
      const cwd = env.KHYQUANT_CWD || process.cwd();
      const searchDir = params.path ? path.resolve(cwd, params.path) : cwd;

      if (!fs.existsSync(searchDir)) {
        return { success: false, error: `Directory not found: ${searchDir}` };
      }
      let stat;
      try { stat = fs.statSync(searchDir); } catch { stat = null; }
      if (!stat || !stat.isDirectory()) {
        return { success: false, error: `Not a directory: ${searchDir}` };
      }

      const reqDepth = Number(params.depth);
      const maxDepth = Number.isFinite(reqDepth) && reqDepth > 0
        ? Math.min(MAX_DEPTH, Math.floor(reqDepth))
        : 2;

      const results = [];
      const deadline = walkBudget.createWalkDeadline(process.env);
      // 门开:异步 walk(不冻结事件循环,既有超时/中断恢复生效);门关:逐字节回退同步 walk。
      if (walkBudget.isWalkAsyncEnabled(process.env)) {
        await walkDirAsync(searchDir, searchDir, results, 1, maxDepth, deadline);
      } else {
        walkDir(searchDir, searchDir, results, 1, maxDepth, deadline);
      }
      // 确定性字母序(与 Bash ls 一致的可预期顺序;salience summary 才是「抓重点」层)。
      results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

      const timedOut = !!(deadline && deadline.exceeded());
      const out = {
        success: true,
        directory: searchDir,
        files: results.map(r => r.path),
        count: results.length,
        truncated: results.length >= MAX_RESULTS || timedOut,
      };
      // 墙钟预算耗尽:结果可能不完整,诚实标注(不改 files[]/count,加法式)。
      if (timedOut) out.timedOut = true;

      // 抓重点 summary(加法式)。
      try {
        const fileSalience = require('../../services/fileSalience');
        if (fileSalience.isEnabled(env)) {
          const summary = fileSalience.summarizeListing(results, { env, total: results.length });
          const block = fileSalience.renderSalienceBlock(summary, { env });
          if (block) out.summary = block;
        }
      } catch { /* salience 附加失败绝不影响列目录主结果 */ }

      return out;
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}

// 门控关 → 导出 benign 非工具对象,自动发现全部跳过(= 工具不注册,今日行为)。
if (!_gateEnabled(process.env)) {
  module.exports = { _khyListDirDisabled: true };
} else {
  module.exports = new ListDirTool();
  module.exports.ListDirTool = ListDirTool;
}
