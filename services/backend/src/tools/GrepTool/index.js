/**
 * GrepTool — content search tool, aligned with Claude Code's Grep tool.
 *
 * Searches file contents using regex patterns. Supports multiple output modes:
 * files_with_matches (default), content, count. Uses grep/rg for performance.
 */
// [AI-弱模型·照抄] 本工具即 weakModelGuidance 'tool-description' 位点的**示范**:prompt() 简明祈使、
// 参数逐个写清。改本工具时参数严格照 inputSchema;prompt() 末尾的 this.weakModelToolNote() 注入别删。
const { BaseTool } = require('../_baseTool');
const { execSync } = require('child_process');
// 非阻塞执行垫片:同步 execSync 会阻塞事件循环(spinner 停、ESC 无效)→「调用工具卡死」。
// 门控开时改用异步 exec(输出/退出码/抛错与 execSync 同形);门控关时逐字节回退 execSync。
const _execCompat = require('../_execCompat');
const path = require('path');
const fs = require('fs');
const {
  isRgAvailable: _isRgAvailablePlatform,
  isGrepAvailable,
  shellEscape: _shellEscapePlatform,
  pureJsGrep,
  DEFAULT_EXCLUDE_DIRS,
} = require('../platformUtils');

const MAX_OUTPUT = 100 * 1024; // 100 KB

class GrepTool extends BaseTool {
  static toolName = 'Grep';
  static category = 'filesystem';
  static risk = 'safe';
  static aliases = ['grep', 'search_content', 'rg'];
  static searchHint = 'search grep regex content files';
  static alwaysLoad = true;

  isReadOnly() { return true; }
  isConcurrencySafe() { return true; }

  prompt() {
    return `A powerful search tool built on ripgrep

  Usage:
  - ALWAYS use Grep for search tasks. NEVER invoke \`grep\` or \`rg\` as a Bash command. The Grep tool has been optimized for correct permissions and access.
  - Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
  - Use Grep to find functions, classes, routes, identifiers, configuration keys, and other text inside files. Do NOT use Glob for that
  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
  - Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
  - Use Agent tool for open-ended searches requiring multiple rounds
  - Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use \`interface\\{\\}\` to find \`interface{}\` in Go code)
  - Multiline matching: By default patterns match within single lines only. For cross-line patterns like \`struct \\{[\\s\\S]*?field\`, use \`multiline: true\`
  - If you get too many matches, narrow with path/glob/type or switch output_mode. If you get zero matches, broaden the path or try nearby naming variants before concluding nothing exists
  - In unfamiliar repositories, use Grep together with README/project-manifest reads to trace where the important code paths start
  - When you report findings, name the path/glob/type filters you used and surface relevant match counts instead of only saying "found it"
` + this.weakModelToolNote();
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'The regular expression pattern to search for in file contents',
        },
        path: {
          type: 'string',
          description: 'File or directory to search in. Defaults to current working directory.',
        },
        glob: {
          type: 'string',
          description: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")',
        },
        type: {
          type: 'string',
          description: 'File type to search (e.g., "js", "py", "rust"). More efficient than glob for standard file types.',
        },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
          description: 'Output mode: "content" shows matching lines, "files_with_matches" shows file paths (default), "count" shows match counts.',
        },
        '-i': {
          type: 'boolean',
          description: 'Case insensitive search',
        },
        '-n': {
          type: 'boolean',
          description: 'Show line numbers in output (default true for content mode)',
        },
        head_limit: {
          type: 'number',
          description: 'Limit output to first N lines/entries. Defaults to 250.',
        },
        multiline: {
          type: 'boolean',
          description: 'Enable multiline mode where . matches newlines and patterns can span lines. Default: false.',
        },
        '-A': {
          type: 'number',
          description: 'Number of lines to show after each match. Requires output_mode: "content".',
        },
        '-B': {
          type: 'number',
          description: 'Number of lines to show before each match. Requires output_mode: "content".',
        },
        '-C': {
          type: 'number',
          description: 'Number of context lines before and after each match. Requires output_mode: "content".',
        },
      },
      required: ['pattern'],
    };
  }

  getActivityDescription(input) {
    return `搜索内容：\"${(input.pattern || '').slice(0, 40)}\"`;
  }

  getToolUseSummary(input) {
    return `搜索：${(input.pattern || '').slice(0, 60)}`;
  }

  async execute(params, _context) {
    const cwd = process.env.KHYQUANT_CWD || process.cwd();
    const searchPath = params.path ? path.resolve(cwd, params.path) : cwd;
    const mode = params.output_mode || 'files_with_matches';
    const headLimit = params.head_limit || 250;
    const caseInsensitive = params['-i'] || false;

    if (!fs.existsSync(searchPath)) {
      return { success: false, error: `Path not found: ${searchPath}` };
    }

    // Strategy: rg (best, cross-platform) → grep (Unix) → pure-JS (universal fallback)
    if (_isRgAvailablePlatform()) {
      return this._executeRg(params, searchPath, mode, headLimit, caseInsensitive, cwd);
    }
    if (isGrepAvailable()) {
      return this._executeGrep(params, searchPath, mode, headLimit, caseInsensitive, cwd);
    }
    return this._executePureJs(params, searchPath, mode, headLimit, caseInsensitive, cwd);
  }

  async _executeRg(params, searchPath, mode, headLimit, caseInsensitive, cwd) {
    const args = [];

    if (caseInsensitive) args.push('-i');

    if (mode === 'files_with_matches') {
      args.push('-l');
    } else if (mode === 'count') {
      args.push('-c');
    } else {
      args.push('-n'); // line numbers for content mode
      if (params['-A']) args.push(`-A`, `${params['-A']}`);
      if (params['-B']) args.push(`-B`, `${params['-B']}`);
      if (params['-C'] || params.context) args.push(`-C`, `${params['-C'] || params.context}`);
    }

    if (params.multiline) {
      args.push('-U', '--multiline-dotall');
    }

    if (params.glob) {
      args.push('--glob', params.glob);
    }

    if (params.type) {
      args.push('--type', params.type);
    }

    // Exclude noise directories
    args.push('-g', '!node_modules', '-g', '!.git', '-g', '!dist', '-g', '!build');

    args.push('-e', params.pattern);
    args.push(searchPath);

    try {
      const cmd = `rg ${args.map(_shellEscape).join(' ')}`;
      const opts = {
        cwd,
        encoding: 'utf-8',
        maxBuffer: MAX_OUTPUT,
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      };
      // 门控开:异步 exec(不阻塞事件循环);关:逐字节回退今日 execSync。
      const output = _execCompat.isNonBlockingExecEnabled(process.env)
        ? await _execCompat.execAsync(cmd, opts)
        : execSync(cmd, opts);

      return this._formatOutput(output, mode, headLimit, cwd);
    } catch (err) {
      if (err.status === 1) {
        return { success: true, matches: [], count: 0, message: 'No matches found' };
      }
      return { success: false, error: err.message };
    }
  }

  async _executeGrep(params, searchPath, mode, headLimit, caseInsensitive, cwd) {
    const args = ['-rn'];
    if (caseInsensitive) args.push('-i');

    if (mode === 'files_with_matches') {
      args.push('-l');
    } else if (mode === 'count') {
      args.push('-c');
    }

    args.push('-E');

    if (params.glob) {
      args.push(`--include=${params.glob}`);
    }

    for (const skip of DEFAULT_EXCLUDE_DIRS) {
      args.push(`--exclude-dir=${skip}`);
    }

    if (mode === 'content') {
      if (params['-A']) args.push(`-A`, `${params['-A']}`);
      if (params['-B']) args.push(`-B`, `${params['-B']}`);
      if (params['-C'] || params.context) args.push(`-C`, `${params['-C'] || params.context}`);
    }

    const escapedPattern = _shellEscape(params.pattern);
    const cmd = `grep ${args.join(' ')} ${escapedPattern} ${searchPath}`;

    try {
      const opts = {
        cwd,
        encoding: 'utf-8',
        maxBuffer: MAX_OUTPUT,
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      };
      // 门控开:异步 exec(不阻塞事件循环);关:逐字节回退今日 execSync。
      const output = _execCompat.isNonBlockingExecEnabled(process.env)
        ? await _execCompat.execAsync(cmd, opts)
        : execSync(cmd, opts);

      return this._formatOutput(output, mode, headLimit, cwd);
    } catch (err) {
      if (err.status === 1) {
        return { success: true, matches: [], count: 0, message: 'No matches found' };
      }
      return { success: false, error: err.message };
    }
  }

  _executePureJs(params, searchPath, mode, headLimit, _caseInsensitive, cwd) {
    try {
      const flags = _caseInsensitive ? 'i' : '';
      const regex = new RegExp(params.pattern, flags);
      const excludeDirs = DEFAULT_EXCLUDE_DIRS;

      const result = pureJsGrep(searchPath, regex, {
        mode,
        glob: params.glob,
        maxResults: headLimit,
        excludeDirs,
      });

      if (mode === 'files_with_matches') {
        const files = (result.files || []).map(f => path.relative(cwd, f));
        return { success: true, files, count: files.length, truncated: result.truncated };
      }
      if (mode === 'count') {
        const counts = (result.counts || []).map(c => ({
          file: path.relative(cwd, c.file), count: c.count,
        }));
        return { success: true, counts, total: result.total || 0 };
      }
      // content mode
      const matches = (result.matches || []).map(m => ({
        file: path.relative(cwd, m.file), line: m.line, content: m.content,
      }));
      return { success: true, matches, count: matches.length, truncated: result.truncated };
    } catch (err) {
      return { success: false, error: `Pure-JS grep error: ${err.message}` };
    }
  }

  _formatOutput(output, mode, headLimit, cwd) {
    if (!output || !output.trim()) {
      return { success: true, matches: [], count: 0, message: 'No matches found' };
    }

    const lines = output.trim().split('\n');
    const limited = lines.slice(0, headLimit);

    if (mode === 'files_with_matches') {
      const files = limited.map(f => {
        try { return path.relative(cwd, f.trim()); } catch { return f.trim(); }
      });
      return { success: true, files, count: files.length, truncated: lines.length > headLimit };
    }

    if (mode === 'count') {
      const counts = [];
      for (const line of limited) {
        const sep = line.lastIndexOf(':');
        if (sep > 0) {
          const file = path.relative(cwd, line.slice(0, sep));
          const count = parseInt(line.slice(sep + 1), 10);
          if (count > 0) counts.push({ file, count });
        }
      }
      return { success: true, counts, total: counts.reduce((s, c) => s + c.count, 0) };
    }

    // mode === 'content'
    const matches = limited.map(line => {
      const firstColon = line.indexOf(':');
      const secondColon = line.indexOf(':', firstColon + 1);
      if (firstColon > 0 && secondColon > 0) {
        return {
          file: path.relative(cwd, line.slice(0, firstColon)),
          line: parseInt(line.slice(firstColon + 1, secondColon), 10),
          content: line.slice(secondColon + 1),
        };
      }
      return { raw: line };
    });

    return { success: true, matches, count: matches.length, truncated: lines.length > headLimit };
  }
}

// ── Helpers ────────────────────────────────────────────────────────

// Delegates to platformUtils for cross-platform compatibility
const _shellEscape = _shellEscapePlatform;

module.exports = new GrepTool();
module.exports.GrepTool = GrepTool;
