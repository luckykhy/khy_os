const { execSync } = require('child_process');

const { defineTool, isGitRepo } = require('./_baseTool');
const _execCompat = require('./_execCompat');

module.exports = defineTool({
  name: 'gitCommit',
  description:
    'Stage the given files (git add) and create a commit with the given message. ' +
    'Use it only when the user asks to commit; set message to "auto" to let AI generate the message. ' +
    'If files is omitted, only already-staged changes are committed.',
  category: 'git',
  risk: 'medium',
  searchHint: 'stage add save changes message 提交 暂存 提交代码',
  isReadOnly: false,
  isConcurrencySafe: false,
  isEnabled: isGitRepo,
  inputSchema: {
    message: {
      type: 'string',
      required: true,
      description:
        'Commit message, e.g. "fix: handle empty response". Use the literal string "auto" for an AI-generated message.',
      example: 'fix: handle empty response',
    },
    files: {
      type: 'array',
      required: false,
      description:
        'File paths to stage before committing, e.g. ["src/app.js"] (default: commit already-staged files only).',
      items: { type: 'string' },
    },
    style: {
      type: 'string',
      required: false,
      description:
        'Commit-message style for auto-generation: "conventional" (default) or "descriptive".',
      enum: ['conventional', 'descriptive'],
      example: 'conventional',
    },
    noVerify: {
      type: 'boolean',
      required: false,
      description: 'Skip the pre-commit self-check, like git --no-verify (default: false).',
      example: false,
    },
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
        const fileList = params.files.map((f) => `"${f}"`).join(' ');
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
            return {
              success: false,
              error: `Auto message generation failed: ${result.error || 'empty result'}`,
            };
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
      } catch {
        /* fail-soft */
      }

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
          return {
            success: false,
            error:
              '提交被自检阻断(KHY_COMMIT_PRECHECK_BLOCK=on):存在严重风险。解决后重试,或设 noVerify:true 跳过。',
          };
        }
      } catch {
        /* fail-soft */
      }

      const escaped = message.replace(/"/g, '\\"');
      const output = await _run(`git commit -m "${escaped}"`);
      return { success: true, output: output || '', message };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});
