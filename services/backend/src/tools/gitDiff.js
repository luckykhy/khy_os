const { defineTool, isGitRepo } = require('./_baseTool');
const { execSync } = require('child_process');
const _execCompat = require('./_execCompat');

module.exports = defineTool({
  name: 'gitDiff',
  description: 'Show changes in the working directory (git diff)',
  category: 'git',
  risk: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  isEnabled: isGitRepo,
  inputSchema: {
    file: { type: 'string', required: false, description: 'Specific file to diff' },
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
