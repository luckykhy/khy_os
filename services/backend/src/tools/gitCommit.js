const { execSync } = require('child_process');

const { defineTool, isGitRepo } = require('./_baseTool');
const _execCompat = require('./_execCompat');

const _TIMING_STATUS = new Set(['A', 'M', 'D', 'R', 'C', 'T']);

/**
 * 采暂存集并跑提交时机判据（`PROCESS-009` / `[DESIGN-GIT-004]`）。
 *
 * 判定全在纯叶子 `cli/commitTiming.js`（零 IO·绝不抛）；本函数只做叶子不做的
 * **采数据**：`git diff --cached --name-status -z`、mtime、验证证据。
 *
 * ⚠ verify 证据的时间锚是**暂存集里最老的改动**，不是进程 uptime —— 用 uptime 会
 *   得到「证据永远太旧」的假阴性，把提交永久阻断（CLI handler 里踩过这个坑）。
 *
 * @param {string} cwd
 * @param {object} opts
 * @param {(cmd:string)=>Promise<string>} _run
 * @returns {Promise<object>} 纯叶子 decide() 的返回值，附 files 计数
 */
async function _assessTiming(cwd, opts, _run) {
  const leaf = require('../cli/commitTiming');
  const fs = require('fs');
  const path = require('path');

  // 暂存集（-z：NUL 分隔，重命名吃三段）
  let raw = '';
  try {
    raw = await _run('git diff --cached --name-status -z');
  } catch {
    raw = '';
  }
  const changes = [];
  {
    const parts = String(raw || '').split('\0');
    let i = 0;
    while (i < parts.length) {
      const code = parts[i];
      if (!code) {
        i += 1;
        continue;
      }
      const status = code[0];
      if (!_TIMING_STATUS.has(status)) {
        i += 1;
        continue;
      }
      i += 1;
      const first = parts[i];
      i += 1;
      let p = first;
      if (status === 'R' || status === 'C') {
        p = parts[i];
        i += 1;
      }
      if (!p) continue;
      let mtimeMs = NaN;
      try {
        mtimeMs = fs.statSync(path.join(cwd, p)).mtimeMs;
      } catch {
        /* 删除的文件没有 mtime —— 判据会自动忽略 */
      }
      changes.push({ status, path: p, mtimeMs });
    }
  }

  // 验证证据：.khy/feedback/<task-id>/verify.txt 里最新的一个是否比最老的改动还新
  let verifyPending = false;
  {
    const times = changes.map((c) => c.mtimeMs).filter((t) => Number.isFinite(t));
    const anchor = times.length ? Math.min(...times) : NaN;
    try {
      const base = path.join(cwd, '.khy', 'feedback');
      for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        try {
          const st = fs.statSync(path.join(base, ent.name, 'verify.txt'));
          if (!Number.isFinite(anchor) || st.mtimeMs >= anchor) {
            verifyPending = true;
            break;
          }
        } catch {
          /* 该 task 无 verify.txt —— 正常 */
        }
      }
    } catch {
      /* 没有 .khy/feedback —— 就是没有证据 */
    }
  }

  const result = leaf.decide(changes, { verifyPending });
  result.files = changes.length;
  return result;
}

module.exports = defineTool({
  name: 'gitCommit',
  description:
    'Stage the given files (git add) and create a commit with the given message. ' +
    'Run it whenever you reach a commit-worthy point — you do NOT need the user to ask each time: ' +
    'a change that satisfies the PROCESS-009 timing criteria (single logical intent, verified, ' +
    'no foreign/stray changes) is a commit-worthy point. ' +
    'Set message to "auto" to let AI generate the message. ' +
    'Set checkTiming to "enforce" to refuse the commit when the timing criteria are not met. ' +
    'If files is omitted, only already-staged changes are committed.',
  category: 'git',
  risk: 'medium',
  searchHint: 'stage add save changes message 提交 暂存 提交代码 时机 timing 该不该提交',
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
    checkTiming: {
      type: 'string',
      required: false,
      description:
        'Timing judgement (PROCESS-009 / [DESIGN-GIT-004]). "warn" (default): judge and surface ' +
        'the verdict in the result, still commit. "enforce": refuse to commit when the criteria ' +
        'are not met (decision do-not-commit or ask-first). "off": skip the judgement entirely.',
      enum: ['warn', 'enforce', 'off'],
      example: 'enforce',
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

      // 提交时机判断(PROCESS-009 / [DESIGN-GIT-004]):治「AI 不知道什么时候该提交」。
      // 判据全在纯叶子 cli/commitTiming.js(零 IO·绝不抛),这里只采数据、读结论、按模式处理。
      // fail-soft:判断本身出任何问题都不许阻断提交路径(与 precheck 同款纪律)。
      const timingMode = params.checkTiming || 'warn';
      let timing = null;
      if (timingMode !== 'off') {
        try {
          const timingResult = await _assessTiming(cwd, opts, _run);
          timing = timingResult;
          if (timingMode === 'enforce' && timingResult.decision !== 'commit-now') {
            return {
              success: false,
              error:
                `提交时机判据未通过(${timingResult.decision}):${timingResult.reason} ` +
                `缺口:${(timingResult.blockers || []).map((b) => `${b.criterion} ${b.message}`).join('; ') || '见 reason'}`,
              timing: timingResult,
            };
          }
        } catch {
          /* fail-soft:判断失败不影响提交 */
        }
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
      const result = { success: true, output: output || '', message };
      // 把时机判断一并回给 AI —— 「这次提交合不合判据」是它下次决策的输入。
      if (timing) {
        result.timing = {
          decision: timing.decision,
          reason: timing.reason,
          files: timing.files,
          blockers: (timing.blockers || []).map((b) => `${b.criterion} ${b.id}: ${b.message}`),
        };
      }
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});
