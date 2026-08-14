'use strict';

const { execSync } = require('child_process');

const { defineTool, isGitRepo } = require('./_baseTool');
const _execCompat = require('./_execCompat');

/**
 * gitBlame — line-by-line authorship for a file (git blame).
 *
 * Completes the read-only native git family (gitStatus / gitDiff / gitLog already
 * exist) so the model can answer "who last changed this line, and in which commit"
 * without falling back to a raw shell command. This is a high-frequency code
 * provenance query during debugging and refactoring. Read-only; bounded output.
 *
 * Optional line range (start_line/end_line) maps to `git blame -L a,b` so large
 * files can be blamed cheaply. Whitespace-only changes are ignored (-w) so blame
 * points at the real authoring commit rather than a reformat.
 */
module.exports = defineTool({
  name: 'gitBlame',
  description:
    'Show line-by-line authorship for a file (git blame): who last changed each line and in which commit. ' +
    'Read-only; use it for provenance questions during debugging/refactoring. Pass start_line/end_line to blame just a range of a large file cheaply; whitespace-only changes are ignored.',
  category: 'git',
  risk: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  isEnabled: isGitRepo,
  aliases: ['git_blame'],
  searchHint: 'authorship who changed line commit history 代码归属 追溯 作者',
  inputSchema: {
    file: {
      type: 'string',
      required: true,
      description: 'Path to the file to blame, relative to the repo root, e.g. "src/app.js".',
      example: 'src/app.js',
    },
    start_line: {
      type: 'number',
      required: false,
      min: 1,
      description:
        'First line (1-based) of the range to blame (default: whole file). Pair with end_line.',
      example: 100,
    },
    end_line: {
      type: 'number',
      required: false,
      min: 1,
      description:
        'Last line (1-based) of the range to blame; must be >= start_line. Pair with start_line.',
      example: 150,
    },
  },
  async execute(params, _context) {
    try {
      const cwd = process.env.KHYQUANT_CWD || process.cwd();
      const file = params && params.file ? String(params.file) : '';
      if (!file) {
        return { success: false, error: 'file is required' };
      }
      // Optional line range → -L start,end. Both must be positive integers with end >= start.
      let rangeArg = '';
      const s = parseInt(params && params.start_line, 10);
      const e = parseInt(params && params.end_line, 10);
      if (Number.isFinite(s) && Number.isFinite(e) && s >= 1 && e >= s) {
        rangeArg = ` -L ${s},${e}`;
      }
      // File path is JSON.stringify-quoted so spaces / metachars never word-split.
      // -w ignores whitespace-only changes; --date=short keeps the output compact.
      const cmd = `git blame -w --date=short${rangeArg} -- ${JSON.stringify(file)}`;
      // 非阻塞 exec 垫片(门控 KHY_EXEC_NONBLOCKING 默认开)防同步 execSync 冻结事件循环;
      // OFF 逐字节回退今日 execSync。
      const _opts = { cwd, encoding: 'utf-8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 };
      const output = _execCompat.isNonBlockingExecEnabled(process.env)
        ? await _execCompat.execAsync(cmd, _opts)
        : execSync(cmd, _opts);
      return { success: true, output: output || '(no output)' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});
