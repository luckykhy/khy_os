/**
 * Hook Runner — executes hook commands as child processes.
 *
 * Each hook receives context as JSON on stdin and can:
 *   - Exit 0: allow (pass through)
 *   - Exit 2: block (prevent the action)
 *   - Emit JSON on stdout: modify the context
 */
const { spawn } = require('child_process');

const { platformShell, safeKill } = require('../../../../tools/platformUtils');

/**
 * Per-event whitelist of fields a COMMAND hook may merge into the loop context.
 *
 * Command hooks are user-configured child processes whose stdout is parsed as
 * arbitrary JSON — an untrusted surface. Without this gate, a command hook
 * returning e.g. {"iteration": 999} or {"toolName": "x"} could silently clobber
 * the loop's internal control fields and break later pattern-matched hooks.
 *
 * Function hooks are in-process trusted code (built-in guards + programmatic
 * registrations) and are intentionally NOT filtered here — they may carry
 * bespoke fields (see hook-lifecycle tests groups 7 & 10).
 *
 * Mirrors Claude Code's restricted HookResult fields (updatedInput /
 * additionalContext / preventContinuation) rather than a free-form merge.
 */
const CMD_HOOK_ALLOWED_FIELDS = {
  PreToolUse: ['params'],
  PostToolUse: ['result', 'preventContinuation', 'stopReason', 'additionalContext'],
  PrePrompt: ['prompt', 'additionalContext'],
  PostResponse: ['additionalContext'],
  PreCompact: ['additionalContext'],
  PostCompact: ['additionalContext'],
  Stop: ['stopReason'],
  SubAgentStart: [],
  SubAgentEnd: [],
  // 插件注册点(Block B)。command hook 的 JSON 输出必须逐事件白名单化：缺了条目
  // filterCommandOutput 会走 `!allowed -> 原样透传` 分支，等于对这两个事件完全
  // 不过滤 —— 而它们恰恰最不能放开(一个决定权限裁决，一个往系统提示词里塞文本)。
  // 字段取自 hookContribSeams 的读取契约：
  //   applyToolPermissionHooks 只读 res.context.decision(block 走退出码 2，不经输出)
  //   collectPromptSections   只读 res.context.sections / res.context.section
  ToolPermission: ['decision'],
  PromptSection: ['sections', 'section'],
};

/**
 * Filter a command hook's parsed JSON output down to the fields allowed for its
 * event. Dropped fields are reported on `_dropped` so the runner can warn.
 * @param {string} event
 * @param {Object} output - Parsed stdout JSON from a command hook
 * @returns {{ filtered: Object, dropped: string[] }}
 */
function filterCommandOutput(event, output) {
  if (!output || typeof output !== 'object') {
    return { filtered: output, dropped: [] };
  }
  const allowed = CMD_HOOK_ALLOWED_FIELDS[event];
  // Unknown event (should not happen — registry validates): pass through untouched.
  if (!allowed) {
    return { filtered: output, dropped: [] };
  }
  const filtered = {};
  const dropped = [];
  for (const key of Object.keys(output)) {
    if (allowed.includes(key)) {
      filtered[key] = output[key];
    } else {
      dropped.push(key);
    }
  }
  return { filtered, dropped };
}

/**
 * Run a single hook (command-based or function-based).
 * @param {Object} hook - Hook definition from registry
 * @param {Object} context - Event context (toolName, args, prompt, etc.)
 * @returns {Promise<{action: 'allow'|'block'|'modify', output?: Object, error?: string}>}
 */
async function runHook(hook, context) {
  // Function-based hooks: call directly
  if (hook.type === 'function' && typeof hook.handler === 'function') {
    return _runFunctionHook(hook, context);
  }

  // 声明成 function 但 handler 不可调用 → 明确报错，而**不是**掉进下面的命令分支。
  // 之前是掉下去的：hook.command 为 undefined，platformShell(undefined) 产出
  // argv 尾部一个 null，Linux 上等于 `bash -c null` —— 子进程立刻以 127 退出，我们
  // 随后往它 stdin 写 JSON 就撞上 EPIPE。既白起一个 shell，又把一个配置错误伪装成
  // 「hook 执行失败」。
  if (hook.type === 'function') {
    return { action: 'allow', error: 'Function hook has no callable handler' };
  }

  // Command-based hooks: spawn child process
  return _runCommandHook(hook, context);
}

/**
 * Execute a function-based hook.
 * @private
 */
async function _runFunctionHook(hook, context) {
  let timer = null;
  try {
    const result = await Promise.race([
      Promise.resolve(hook.handler(context)),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Hook function timed out')),
          hook.timeout || 10000
        );
        timer.unref?.();
      }),
    ]);
    if (timer) {
      clearTimeout(timer);
    }

    // Normalize return value
    if (!result || typeof result !== 'object') {
      return { action: 'allow' };
    }
    if (result.action === 'block') {
      // Preserve a guard's approval metadata so a soft block can be lifted by an
      // explicit user approval downstream. Without this, only `reason` survives
      // and an approvable block is indistinguishable from a hard security block.
      return {
        action: 'block',
        error: result.reason || 'Blocked by function hook',
        approvable: !!result.approvable,
        source: result.source,
      };
    }
    if (result.action === 'modify') {
      const { action, ...overrides } = result;
      return { action: 'modify', output: overrides };
    }
    return { action: result.action || 'allow', output: result };
  } catch (err) {
    if (timer) {
      clearTimeout(timer);
    }
    return { action: 'allow', error: err.message };
  }
}

/**
 * Execute a command-based hook via child process.
 * @private
 */
async function _runCommandHook(hook, context) {
  const HOOK_MAX_BUFFER = 512 * 1024; // 512 KB max per stream
  const hookTimeoutMs = hook.timeout || 10000;
  // 没有命令就不要起 shell：spawn 一个 argv 尾部为 null 的 cmd/bash 只会立刻失败，
  // 而且失败信息完全不指向真正的原因（hook 定义缺 command）。
  if (!String(hook.command || '').trim()) {
    return { action: 'allow', error: 'Command hook has no command' };
  }
  return new Promise((resolve) => {
    const sh = platformShell(hook.command);
    const child = spawn(sh.cmd, sh.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOOK_EVENT: hook.event },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      resolve(result);
    };

    // Manual timeout — spawn()'s `timeout` option is unreliable
    let killTimer = setTimeout(() => {
      if (settled) {
        return;
      }
      try {
        safeKill(child, 'SIGKILL', 0);
      } catch {
        /* ignore */
      }
      finish({ action: 'allow', error: `Hook timed out after ${hookTimeoutMs}ms` });
    }, hookTimeoutMs);
    killTimer.unref?.();

    child.stdout.on('data', (d) => {
      if (stdout.length < HOOK_MAX_BUFFER) {
        stdout += d;
      }
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < HOOK_MAX_BUFFER) {
        stderr += d;
      }
    });

    child.on('error', (err) => {
      finish({ action: 'allow', error: err.message });
    });

    child.on('close', (code) => {
      if (code === 2) {
        return finish({ action: 'block', error: stderr.trim() || 'Blocked by hook' });
      }

      let output;
      if (stdout.trim()) {
        try {
          output = JSON.parse(stdout.trim());
        } catch {
          /* not JSON, ignore */
        }
      }

      // Contain untrusted command-hook JSON: only event-whitelisted fields may
      // reach the loop context. Dropped fields are surfaced as a warning.
      let dropWarning;
      if (output) {
        const { filtered, dropped } = filterCommandOutput(hook.event, output);
        output = filtered;
        if (dropped.length > 0) {
          dropWarning = `Command hook for ${hook.event} attempted to set disallowed field(s): ${dropped.join(', ')}`;
          console.warn(`[HookRunner] ${dropWarning}`);
        }
      }

      finish({
        action: output && Object.keys(output).length > 0 ? 'modify' : 'allow',
        output,
        error: code !== 0 ? stderr.trim() || `Hook exited with code ${code}` : dropWarning,
      });
    });

    // Send context as JSON on stdin.
    // stdin 的写入失败是**异步**的：命令 hook 只要不读 stdin 就先退出，Linux 上内核
    // 回 EPIPE，Node 把它作为 stdin 流的 error 事件抛出 —— 同步 try/catch 抓不到（原注释
    // 那句 `broken pipe is fine` 写的是意图，实现却拦不住），没有监听器就升级成
    // uncaughtException。safeRunHook 的 try/catch 也救不了：异常发生在别的 tick，不在
    // await 的调用栈里。于是它会被 jest 记到「当时正在跑的那个用例」头上 —— 哪怕那个
    // 用例根本没起过子进程，甚至不在同一个文件（worker 进程跨文件复用）。Windows 的
    // 命名管道时序不同，几乎不触发，所以长期只在 Linux 门禁上红。
    child.stdin.on('error', () => {
      /* EPIPE / ERR_STREAM_DESTROYED：hook 不读 stdin 就退出，属正常路径 */
    });
    try {
      child.stdin.write(JSON.stringify(context));
      child.stdin.end();
    } catch {
      /* 同步失败（stdin 已 destroyed）同样忽略 */
    }
  });
}

// ── Hook Execution Telemetry ──────────────────────────────────────

const _hookMetrics = []; // [{hookSource, event, durationMs, action, error?}]
const HOOK_METRICS_MAX = 500;

/**
 * Fault-isolated hook runner — wraps runHook to guarantee:
 *   1. No thrown error propagates
 *   2. Malformed results are normalized to { action: 'allow' }
 *   3. Execution timing is recorded for telemetry
 * @param {Object} hook - Hook definition
 * @param {Object} context - Event context
 * @returns {Promise<{action: 'allow'|'block'|'modify', output?: Object, error?: string}>}
 */
async function safeRunHook(hook, context) {
  const start = Date.now();
  try {
    const result = await runHook(hook, context);
    const duration = Date.now() - start;
    _hookMetrics.push({
      hookSource: hook.source || hook.command || 'unknown',
      event: hook._event || hook.event,
      durationMs: duration,
      action: result?.action || 'allow',
    });
    if (_hookMetrics.length > HOOK_METRICS_MAX) {
      _hookMetrics.splice(0, _hookMetrics.length - HOOK_METRICS_MAX);
    }
    if (!result || typeof result.action !== 'string') {
      return { action: 'allow', error: 'Hook returned invalid result' };
    }
    return result;
  } catch (err) {
    const duration = Date.now() - start;
    _hookMetrics.push({
      hookSource: hook.source || hook.command || 'unknown',
      event: hook._event || hook.event,
      durationMs: duration,
      action: 'allow',
      error: err.message,
    });
    if (_hookMetrics.length > HOOK_METRICS_MAX) {
      _hookMetrics.splice(0, _hookMetrics.length - HOOK_METRICS_MAX);
    }
    return { action: 'allow', error: `Hook crash: ${err.message}` };
  }
}

/**
 * Get hook execution metrics for telemetry/observability.
 * @returns {Array<{hookSource: string, event: string, durationMs: number, action: string, error?: string}>}
 */
function getHookMetrics() {
  return [..._hookMetrics];
}

/**
 * Run all hooks for an event sequentially.
 * Returns the final context (potentially modified) and whether to proceed.
 */
async function runHooks(hooks, context) {
  let ctx = { ...context };

  for (const hook of hooks) {
    const result = await safeRunHook(hook, ctx);

    if (result.action === 'block') {
      // Carry the guard's approval metadata to the caller. A truthy `approvable`
      // means an interactive host may turn this block into a user-approval prompt
      // (soft guard); absent/false keeps it a hard, unbypassable block.
      return {
        blocked: true,
        reason: result.error,
        approvable: !!result.approvable,
        source: result.source,
        context: ctx,
      };
    }

    if (result.action === 'modify' && result.output) {
      ctx = { ...ctx, ...result.output };
    }
  }

  return { blocked: false, context: ctx };
}

module.exports = {
  runHook,
  safeRunHook,
  runHooks,
  getHookMetrics,
  filterCommandOutput,
  CMD_HOOK_ALLOWED_FIELDS,
  _hookMetrics,
};
