/**
 * Explore Tool — parallel codebase exploration agent.
 *
 * Combines glob, grep, and file reading to answer questions about the codebase.
 * Spawns parallel search tasks and aggregates results.
 * Claude Code equivalent: Agent tool with subagent_type=Explore.
 */
const { defineTool } = require('./_baseTool');
const path = require('path');
const fs = require('fs');

module.exports = defineTool({
  name: 'explore',
  description:
    'Search the codebase to answer questions. Runs glob patterns, greps for content, ' +
    'and reads relevant files in parallel. Use for: finding files, understanding architecture, ' +
    'locating function definitions, tracing code paths.',
  category: 'data',
  risk: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  alwaysLoad: true,

  aliases: ['search_codebase', 'find_code', 'codebase_search'],
  searchHint: 'search find explore codebase grep glob files code',

  inputSchema: {
    query: {
      type: 'string',
      required: true,
      description: 'What to search for (e.g. "function handleLogin", "*.vue files", "database connection")',
    },
    patterns: {
      type: 'array',
      required: false,
      description: 'Glob patterns to search (e.g. ["**/*.js", "src/**/*.ts"]). Auto-detected if omitted.',
      items: { type: 'string' },
    },
    grep_pattern: {
      type: 'string',
      required: false,
      description: 'Regex pattern to grep for in file contents. Auto-detected from query if omitted.',
    },
    path: {
      type: 'string',
      required: false,
      description: 'Directory to search in (default: current working directory)',
    },
    max_results: {
      type: 'number',
      required: false,
      description: 'Maximum number of results to return (default: 20)',
    },
  },

  getActivityDescription(input) {
    return `探索代码：${(input.query || '').slice(0, 40)}`;
  },

  getToolUseSummary(input) {
    return `探索：${(input.query || '').slice(0, 60)}`;
  },

  async execute(params) {
    const cwd = params.path || process.env.KHYQUANT_CWD || process.cwd();
    const maxResults = params.max_results || 20;
    const query = params.query || '';

    const results = {
      files_found: [],
      content_matches: [],
      summary: '',
    };

    // ── Step 1: Determine search strategy ──────────────────────────
    const globPatterns = params.patterns || _inferGlobPatterns(query);
    const grepPattern = params.grep_pattern || _inferGrepPattern(query);

    // ── Step 2: Run glob and grep in parallel ──────────────────────
    const tasks = [];

    // Glob search for files
    for (const pattern of globPatterns) {
      tasks.push(_runGlob(pattern, cwd, maxResults));
    }

    // Grep search for content
    if (grepPattern) {
      tasks.push(_runGrep(grepPattern, cwd, maxResults));
    }

    const taskResults = await Promise.allSettled(tasks);

    // ── Step 3: Aggregate results ──────────────────────────────────
    const fileSet = new Set();
    const contentMatches = [];

    for (const result of taskResults) {
      if (result.status !== 'fulfilled') continue;
      const data = result.value;

      if (data.type === 'glob') {
        for (const f of data.files) {
          if (fileSet.size >= maxResults) break;
          fileSet.add(f);
        }
      } else if (data.type === 'grep') {
        for (const match of data.matches) {
          if (contentMatches.length >= maxResults) break;
          contentMatches.push(match);
          fileSet.add(match.file);
        }
      }
    }

    results.files_found = [...fileSet].slice(0, maxResults).map(f => {
      const rel = path.relative(cwd, f);
      return rel || f;
    });
    results.content_matches = contentMatches.slice(0, maxResults);

    // ── Step 4: Read key files for context ─────────────────────────
    const filesToRead = results.files_found.slice(0, 8);
    const fileContents = [];

    for (const relPath of filesToRead) {
      try {
        const absPath = path.resolve(cwd, relPath);
        const stat = fs.statSync(absPath);
        // 读前防卡死前检:探索树里若混入 FIFO/设备/阻塞伪文件,readFileSync 会永久卡死(下方 catch 只接抛错不接卡死)。
        // 命中即跳过并留痕,复用已算好的 stat(零额外 IO)。
        try {
          const { classifyPreReadHang } = require('./filePreReadHangGuard');
          const hang = classifyPreReadHang({ absPath, stat, env: process.env });
          if (hang && hang.blocked) {
            fileContents.push({ path: relPath, preview: `[skipped — ${hang.kind} would hang the reader]` });
            continue;
          }
        } catch { /* 判定失败 → 回退历史行为 */ }
        if (stat.size > 100000) {
          fileContents.push({ path: relPath, preview: `[${(stat.size / 1024).toFixed(0)}KB — too large for preview]` });
          continue;
        }
        const content = fs.readFileSync(absPath, 'utf8');
        const lines = content.split('\n');
        const preview = lines.slice(0, 100).join('\n');
        const suffix = lines.length > 100 ? `\n... +${lines.length - 100} more lines` : '';
        fileContents.push({ path: relPath, lines: lines.length, preview: preview + suffix });
      } catch { /* skip unreadable files */ }
    }

    // ── Step 5: Build summary ──────────────────────────────────────
    const parts = [];
    parts.push(`Found ${results.files_found.length} file(s)`);
    if (contentMatches.length > 0) {
      parts.push(`${contentMatches.length} content match(es)`);
    }
    results.summary = parts.join(', ');

    return {
      success: true,
      data: {
        query,
        ...results,
        file_previews: fileContents,
      },
    };
  },
});

// ── Helper functions ────────────────────────────────────────────────

function _inferGlobPatterns(query) {
  const patterns = [];
  // If query contains file extension hints
  const extMatch = query.match(/\*\.\w+|\.\w{1,5}\b/g);
  if (extMatch) {
    for (const ext of extMatch) {
      const pattern = ext.startsWith('*.') ? `**/${ext}` : `**/*${ext}`;
      patterns.push(pattern);
    }
  }
  // If query mentions specific directory
  const dirMatch = query.match(/\b(src|lib|components|pages|views|routes|services|utils|models)\b/i);
  if (dirMatch) {
    patterns.push(`${dirMatch[1]}/**/*`);
  }
  // Default: search common source files
  if (patterns.length === 0) {
    patterns.push('**/*.{js,ts,vue,jsx,tsx,py,go,rs,java,md,json,yaml,yml,css,html}');
  }
  return patterns;
}

function _inferGrepPattern(query) {
  // Extract likely code identifiers from the query (including identifiers in Chinese-mixed text)
  const codePatterns = query.match(/\b[a-zA-Z_]\w{2,40}\b/g);
  if (!codePatterns || codePatterns.length === 0) return null;

  // Filter out common English words and Chinese context words
  const stopWords = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her',
    'was', 'one', 'our', 'out', 'has', 'how', 'what', 'where', 'when', 'which',
    'find', 'search', 'show', 'file', 'files', 'code', 'function', 'class',
    'use', 'using', 'with', 'from', 'this', 'that', 'have', 'does', 'will',
    'implement', 'implemented', 'implementation', 'located', 'defined',
  ]);

  const meaningful = codePatterns.filter(w => !stopWords.has(w.toLowerCase()) && w.length > 2);
  if (meaningful.length === 0) return null;

  // Detect definition-search intent and generate broader patterns
  const isDefSearch = /where is|find.*function|find.*class|定义|在哪|怎么实现|实现了/i.test(query);
  if (isDefSearch && meaningful.length === 1) {
    const term = meaningful[0];
    // Generate patterns for function/class/method definitions
    return `(function|class|const|let|var|def|fn|type|interface)\\s+${term}|${term}`;
  }

  // Use the most specific-looking terms
  return meaningful.slice(0, 3).join('|');
}

async function _runGlob(pattern, cwd, maxResults) {
  const { glob } = require('glob');
  try {
    const files = await glob(pattern, {
      cwd,
      absolute: true,
      nodir: true,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
      maxDepth: 10,
    });
    return { type: 'glob', pattern, files: files.slice(0, maxResults) };
  } catch {
    return { type: 'glob', pattern, files: [] };
  }
}

async function _runGrep(pattern, cwd, maxResults) {
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    const args = [
      '-r', '-l', '-i',
      '--max-count=5',
      '--include=*.js', '--include=*.ts', '--include=*.vue',
      '--include=*.jsx', '--include=*.tsx', '--include=*.py',
      '--include=*.go', '--include=*.rs', '--include=*.java',
      '--include=*.md', '--include=*.json', '--include=*.yaml',
      '--include=*.yml', '--include=*.css', '--include=*.html',
      '-E', pattern,
      cwd,
    ];

    // Try ripgrep first (faster), fall back to grep
    const tryRg = () => {
      const rgArgs = [
        '-l', '-i', '--max-count=5',
        '-g', '!node_modules', '-g', '!.git', '-g', '!dist',
        '-e', pattern,
        cwd,
      ];
      execFile('rg', rgArgs, { timeout: 10000, maxBuffer: 1024 * 256 }, (err, stdout) => {
        if (err && err.code === 'ENOENT') {
          // rg not found, try grep
          execFile('grep', args, { timeout: 10000, maxBuffer: 1024 * 256 }, (err2, stdout2) => {
            const files = (stdout2 || '').trim().split('\n').filter(Boolean).slice(0, maxResults);
            resolve({ type: 'grep', pattern, matches: files.map(f => ({ file: f })) });
          });
          return;
        }
        const files = (stdout || '').trim().split('\n').filter(Boolean).slice(0, maxResults);
        resolve({ type: 'grep', pattern, matches: files.map(f => ({ file: f })) });
      });
    };

    tryRg();
  });
}
