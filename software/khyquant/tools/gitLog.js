'use strict';

const { defineTool, isGitRepo } = require('./_baseTool');
const { execSync } = require('child_process');
const _execCompat = require('./_execCompat');

/**
 * gitLog — show commit history (git log).
 *
 * Completes the native git tool family (gitStatus / gitDiff / gitCommit / gitPush
 * already exist) so the model can read history without falling back to a raw
 * shell command. Read-only; bounded output (default 20 commits, one line each).
 */
module.exports = defineTool({
  name: 'gitLog',
  description: 'Show recent commit history (git log). Read-only; returns a bounded, one-line-per-commit summary.',
  category: 'git',
  risk: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  isEnabled: isGitRepo,
  aliases: ['git_log'],
  inputSchema: {
    max_count: {
      type: 'number',
      required: false,
      min: 1,
      max: 200,
      description: 'How many commits to show (default 20, max 200).',
    },
    file: {
      type: 'string',
      required: false,
      description: 'Optional path to limit history to a single file.',
    },
    oneline: {
      type: 'boolean',
      required: false,
      description: 'One line per commit (default true). Set false for full author/date/body.',
    },
  },
  async execute(params, _context) {
    try {
      const cwd = process.env.KHYQUANT_CWD || process.cwd();
      const n = Math.max(1, Math.min(200, parseInt(params && params.max_count, 10) || 20));
      const oneline = params && params.oneline === false ? false : true;
      // The pretty format contains spaces and `%` tokens, so it MUST be a single
      // shell-quoted argument — otherwise git sees `%ad` etc. as separate args
      // ("ambiguous argument"). `--date` is a standalone flag (not part of format).
      const fmt = oneline
        ? '--pretty=format:%h %ad %an %s'
        : '--pretty=format:%H%n  Author: %an <%ae>%n  Date:   %ad%n  %s';
      const dateArg = oneline ? '--date=short' : '--date=iso';
      // Build argv-safe command. Both the format and the optional file path are
      // JSON.stringify-quoted so spaces / metachars never word-split. n is numeric.
      const fileArg = params && params.file ? ` -- ${JSON.stringify(String(params.file))}` : '';
      const cmd = `git log -n ${n} ${dateArg} ${JSON.stringify(fmt)}${fileArg}`;
      // 非阻塞 exec 垫片(门控 KHY_EXEC_NONBLOCKING 默认开)防同步 execSync 冻结事件循环;
      // OFF 逐字节回退今日 execSync。
      const _opts = { cwd, encoding: 'utf-8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 };
      const output = _execCompat.isNonBlockingExecEnabled(process.env)
        ? await _execCompat.execAsync(cmd, _opts)
        : execSync(cmd, _opts);
      return { success: true, output: output || '(no commits)' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});
