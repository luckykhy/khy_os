const { defineTool, isGitRepo } = require('./_baseTool');
const { execSync } = require('child_process');
const _execCompat = require('./_execCompat');

/**
 * gitPush — push local commits to a remote. Mirrors gitCommit's shape.
 *
 * Risk model (Part C「工作区与 git commit 和 push 的概念」):
 *   · A normal push is reversible-ish and only ever ADDS commits to the remote;
 *     it is `risk:'medium'`, NOT destructive → L1 (confirm once), never the red line.
 *   · A force push (`--force` / `--force-with-lease`) can OVERWRITE remote history
 *     and is genuinely destructive → `isDestructive()` returns true so the syscall
 *     gateway sends it to L2 (red line). This is exactly the「修改/删除等破坏性操作」
 *     the user asked to keep gated.
 */
function _isForce(params) {
  return !!(params && (params.force === true || params.forceWithLease === true));
}

module.exports = defineTool({
  name: 'gitPush',
  description: 'Push local commits to a remote. A normal push only adds commits; set force=true only when you must overwrite remote history (treated as a destructive red-line operation).',
  category: 'git',
  risk: 'medium',
  isReadOnly: false,
  // Dynamic: a force push can destroy remote history → red line; a normal push cannot.
  isDestructive: (params) => _isForce(params),
  isConcurrencySafe: false,
  isEnabled: isGitRepo,
  inputSchema: {
    remote: { type: 'string', required: false, description: 'Remote name (default: origin).' },
    branch: { type: 'string', required: false, description: 'Branch to push (default: current branch).' },
    setUpstream: { type: 'boolean', required: false, description: 'Set the pushed branch as upstream (-u). Use on first push of a new branch.' },
    force: { type: 'boolean', required: false, description: 'Overwrite remote history (--force). Destructive; avoid unless required.' },
    forceWithLease: { type: 'boolean', required: false, description: 'Safer force (--force-with-lease): refuse if remote moved unexpectedly.' },
  },
  async execute(params, _context) {
    try {
      const cwd = process.env.KHYQUANT_CWD || process.cwd();
      const opts = { cwd, encoding: 'utf-8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] };
      // 非阻塞 exec 垫片(门控 KHY_EXEC_NONBLOCKING 默认开):push 走网络可能久,同步 execSync
      // 期间冻结整个事件循环(spinner 停 / ESC 死);换异步 exec 后事件循环照转;OFF 逐字节回退。
      const _nb = _execCompat.isNonBlockingExecEnabled(process.env);
      const _run = (c) => (_nb ? _execCompat.execAsync(c, opts) : execSync(c, opts));

      const args = ['push'];
      if (params.setUpstream) args.push('-u');
      if (params.forceWithLease) args.push('--force-with-lease');
      else if (params.force) args.push('--force');

      const remote = params.remote || 'origin';
      // Only append remote/branch when a remote is explicitly given or upstream is set,
      // so a plain `git push` to an already-tracked branch still works.
      if (params.remote || params.branch || params.setUpstream) {
        args.push(remote);
        if (params.branch) {
          args.push(params.branch);
        } else {
          const current = (await _run('git rev-parse --abbrev-ref HEAD')).trim();
          args.push(current);
        }
      }

      const cmd = `git ${args.map(a => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ')}`;
      const output = await _run(cmd);
      return { success: true, output: (output || '').toString().trim(), forced: _isForce(params) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});
