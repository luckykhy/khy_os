const { defineTool, isGitRepo } = require('./_baseTool');
const { execSync } = require('child_process');
const _execCompat = require('./_execCompat');

module.exports = defineTool({
  name: 'gitCommit',
  description: 'Stage files and create a git commit. Set message to "auto" to generate a commit message via AI.',
  category: 'git',
  risk: 'medium',
  isReadOnly: false,
  isConcurrencySafe: false,
  isEnabled: isGitRepo,
  inputSchema: {
    message: { type: 'string', required: true, description: 'Commit message. Use "auto" for AI-generated message.' },
    files: { type: 'array', required: false, description: 'Files to stage (git add). If empty, commits already staged files.', items: { type: 'string' } },
    style: { type: 'string', required: false, description: 'Commit style for auto-generation: "conventional" or "descriptive"', enum: ['conventional', 'descriptive'] },
    noVerify: { type: 'boolean', required: false, description: 'Skip pre-commit self-check (aligns with git --no-verify).' },
  },
  async execute(params, context) {
    try {
      const cwd = process.env.KHYQUANT_CWD || process.cwd();
      const opts = { cwd, encoding: 'utf-8', timeout: 15000 };
      // 非阻塞 exec 垫片(门控 KHY_EXEC_NONBLOCKING 默认开):同步 execSync 会冻结事件循环
      // (spinner 停 / ESC 死),换异步 exec 后事件循环照转;OFF 逐字节回退今日 execSync。
      const _nb = _execCompat.isNonBlockingExecEnabled(process.env);
      const _run = (c) => (_nb ? _execCompat.execAsync(c, opts) : execSync(c, opts));

      if (params.files && params.files.length > 0) {
        const fileList = params.files.map(f => `"${f}"`).join(' ');
        await _run(`git add ${fileList}`);
      }

      let message = params.message;

      // AI-powered commit message generation
      if (message === 'auto' && context && context.callModel) {
        try {
          const commitMsgSvc = require('../services/commitMessageService');
          const result = await commitMsgSvc.generateCommitMessage(
            { callModel: context.callModel },
            { cwd, style: params.style || 'conventional' }
          );
          if (result.message) {
            message = result.message;
          } else {
            return { success: false, error: `Auto message generation failed: ${result.error || 'empty result'}` };
          }
        } catch (err) {
          return { success: false, error: `Auto message generation failed: ${err.message}` };
        }
      }

      // Co-Authored-By 尾注(gitCoAuthorTrailer,门控 KHY_GIT_COAUTHOR_TRAILER default-on):
      // 幂等追加 AI 协作者尾注(已含则不重复)。门关/异常 → 逐字节今日行为(无尾注)。fail-soft。
      try {
        const { appendCoAuthorTrailer } = require('../constants/gitCoAuthorTrailer');
        message = appendCoAuthorTrailer(message, process.env);
      } catch { /* fail-soft */ }

      // Pre-commit self-check: warn on secrets/large files/artifacts (only warns,
      // never blocks unless KHY_COMMIT_PRECHECK_BLOCK=on); enqueues offending paths
      // to the /gitignore review queue. Fail-soft — never breaks the commit path.
      try {
        const precheck = require('../services/precommitCheck');
        const chk = precheck.runPrecommitCheck({
          cwd,
          message,
          addAll: !!(params.files && params.files.length > 0),
          noVerify: !!params.noVerify,
        });
        if (chk && chk.shouldBlock) {
          return { success: false, error: '提交被自检阻断(KHY_COMMIT_PRECHECK_BLOCK=on):存在严重风险。解决后重试,或设 noVerify:true 跳过。' };
        }
      } catch { /* fail-soft */ }

      const escaped = message.replace(/"/g, '\\"');
      const output = await _run(`git commit -m "${escaped}"`);
      return { success: true, output: output || '', message };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});
