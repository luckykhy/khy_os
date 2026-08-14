const { execSync } = require('child_process');

const { defineTool, isGitRepo } = require('./_baseTool');
const _execCompat = require('./_execCompat');

module.exports = defineTool({
  name: 'gitStatus',
  description:
    'Show the git working-tree status in porcelain format (staged/modified/untracked files). ' +
    'Read-only; use it before committing or to check for uncommitted changes. Use gitDiff to see the actual content changes.',
  category: 'git',
  risk: 'safe',
  searchHint: 'staged modified untracked working tree 状态 变更 未跟踪',
  isReadOnly: true,
  isConcurrencySafe: true,
  isEnabled: isGitRepo,
  inputSchema: {},
  async execute(params, context) {
    try {
      const cwd = process.env.KHYQUANT_CWD || process.cwd();
      // Git Bash 优先解析是 Windows 专属关切(Unix 无特殊路径的 Git Bash 概念)。
      // 仅在 win32 调用检测器,其它平台保持 'git'(字节回退兼容,不引入探针噪声)。
      let quotedGit = 'git';
      if (process.platform === 'win32') {
        try {
          const detector = require('../services/gitExecutableDetector');
          const detected = detector.detectGitExecutable();
          if (!detected) {
            return {
              success: false,
              error: detector.buildNoGitMessage({ platform: process.platform }),
            };
          }
          quotedGit = detected === 'git' ? 'git' : `"${detected}"`;
        } catch {
          /* 检测失败 → 回退 'git'(历史行为) */
        }
      }
      // 非阻塞 exec 垫片(门控 KHY_EXEC_NONBLOCKING 默认开):同步 execSync 会冻结事件循环
      // (spinner 停 / ESC 死),换异步 exec 后事件循环照转;OFF 逐字节回退今日 execSync。
      const _opts = { cwd, encoding: 'utf-8', timeout: 10000 };
      const cmd = `${quotedGit} status --porcelain`;
      const output = _execCompat.isNonBlockingExecEnabled(process.env)
        ? await _execCompat.execAsync(cmd, _opts)
        : execSync(cmd, _opts);
      return { success: true, output: output || '' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});
