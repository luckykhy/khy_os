const { execSync } = require('child_process');

const { defineTool, isGitRepo } = require('./_baseTool');
const _execCompat = require('./_execCompat');

module.exports = defineTool({
  name: 'gitDiff',
  description:
    'Show unstaged changes in the working directory (git diff), optionally limited to one file. ' +
    'Read-only; use it to review edits before committing. Use gitStatus for a file-level overview and gitLog for history.',
  category: 'git',
  risk: 'safe',
  searchHint: 'changes working tree compare unstaged 差异 变更 对比',
  isReadOnly: true,
  isConcurrencySafe: true,
  isEnabled: isGitRepo,
  inputSchema: {
    file: {
      type: 'string',
      required: false,
      description:
        'Optional path of a single file to diff, e.g. "src/app.js" (default: all changed files).',
      example: 'src/app.js',
    },
  },
  async execute(params, context) {
    try {
      const cwd = process.env.KHYQUANT_CWD || process.cwd();
      const cmd = params.file ? `git diff -- ${params.file}` : 'git diff';
      // 非阻塞 exec 垫片(门控 KHY_EXEC_NONBLOCKING 默认开)防同步 execSync 冻结事件循环;
      // OFF 逐字节回退今日 execSync。
      const _opts = { cwd, encoding: 'utf-8', timeout: 10000 };
      const output = _execCompat.isNonBlockingExecEnabled(process.env)
        ? await _execCompat.execAsync(cmd, _opts)
        : execSync(cmd, _opts);
      return { success: true, output: output || '' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});
