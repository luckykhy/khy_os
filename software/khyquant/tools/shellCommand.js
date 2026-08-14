const { defineTool } = require('./_baseTool');
const { execSync } = require('child_process');
// 非阻塞执行垫片:idle-timeout 关闭时的 execSync 回退路径会同步阻塞事件循环(spinner停/ESC死)。
// 门控开时改用异步 exec(未指定 encoding 时返 Buffer,与 execSync 同形);门控关逐字节回退 execSync。
const _execCompat = require('./_execCompat');
const { isSearchOrReadCommand, getBaseCommand } = require('./shellClassifier');
const { isGuiApp, spawnGuiApp, getShellConfiguration, normalizePathEnvForWindows } = require('./platformUtils');
const { spawnWithIdleTimeout, smartDecodeWinOutput } = require('../utils/spawnWithIdleTimeout');
// Windows 命令翻译（cmd / Git Bash 兜底）抽到兄弟纯模块，便于单测与单一真源。
// forceWindowsUtf8 / patchPowerShellRecurse 同样迁入该模块（纯函数，便于单测）。
const {
  patchWinCommand: _patchWinCommand,
  patchGitBashCommand: _patchGitBashCommand,
  forceWindowsUtf8: _forceWindowsUtf8,
  patchPowerShellRecurse: _patchPowerShellRecurse,
} = require('./winCommandTranslate');
// 失败的错误映射（永不塌缩成裸退出码）抽到平台无关的兄弟纯模块。
const { composeShellError: _composeShellError } = require('./shellDiagnostics');
// 退出码语义重判(对齐 CC commandSemantics.interpretCommandResult):grep/rg 无匹配
// (exit 1)、diff 有差异、test/[ 条件假、find 部分目录不可访问等非错误信息性退出码,
// 不再误判为命令失败。门控 KHY_SHELL_EXIT_SEMANTICS 默认开,关/异常字节回退旧语义。
let _interpretShellExit;
try { ({ interpretShellExit: _interpretShellExit } = require('./shellExitSemantics')); }
catch { _interpretShellExit = null; }
// 成功但零输出时的确定性说明(与 diagnoseEmptyFailure 对称:那治失败+空,这治成功+空)。
// `... | grep x | head` 这类过滤器收尾的管道 exit 0 但 stdout 空 → 裸「(无输出)」令用户困惑
// (goal 截图)。门控 KHY_SHELL_EMPTY_OUTPUT_NOTE 默认开,关/异常返 null → 保持空串逐字节回退。
let _buildEmptyOutputNote;
try { ({ buildEmptyOutputNote: _buildEmptyOutputNote } = require('./shellEmptyOutputNote')); }
catch { _buildEmptyOutputNote = null; }
// 「禁误用 dedicated tool / 许可 echo·head·tail 透明性命令」文案的单一真源（纯叶子，门控 KHY_SHELL_TRANSPARENCY）。
const { buildToolAvoidanceBlock: _buildToolAvoidanceBlock } = require('../constants/shellTransparency');
let _gitTracker;
try { _gitTracker = require('../services/gitOperationTracker'); } catch { _gitTracker = null; }
let _adaptiveOutput;
try { _adaptiveOutput = require('../services/adaptiveOutput'); } catch { _adaptiveOutput = null; }

const MAX_OUTPUT = 200 * 1024; // 200 KB

// Shared registry for run_in_background dispatch. Kept in a separate module
// because defineTool() freezes the returned tool object (see
// backgroundShellRegistry.js for the rationale).
const { backgroundShells: _backgroundShells } = require('./backgroundShellRegistry');
// RTK 省 token 模式:执行前把命令改写成 rtk 等价命令(单一真源 services/rtkMode)。
// 缺二进制/关闭/失败全部静默回落原生命令——零破坏。见 rtkMode / rtkInstaller。
const _rtkMode = require('../services/rtkMode');
const _rtkInstaller = require('../services/rtkInstaller');

function _smartTruncate(text, maxLen) {
  if (!text || text.length <= maxLen) return text;
  const HEAD = Math.min(2048, Math.floor(maxLen * 0.15));
  const TAIL = maxLen - HEAD - 100;
  const omitted = text.length - HEAD - TAIL;
  return text.slice(0, HEAD)
    + `\n\n... [${omitted} chars omitted — head+tail preserved] ...\n\n`
    + text.slice(-TAIL);
}

const BUILD_CMD_RE = /\b(mvn|gradle|gradlew|npm\s+run\s+build|npx\s+tsc|cargo\s+build|go\s+build|make|cmake|dotnet\s+build|msbuild)\b/i;
const BUILD_ERROR_LINE_RE = /\b(ERROR|FAILURE|FAILED|error\[|error:|cannot find|cannot resolve|compilation failed|BUILD FAILED|exception|NoClassDefFoundError|ClassNotFoundException|NullPointerException|SyntaxError|TypeError|ReferenceError)\b/i;

// ── Git 破坏性命令警告（对标 CC destructiveCommandWarning）─────────
const _GIT_DESTRUCTIVE_PATTERNS = [
  { re: /\bgit\s+reset\s+--hard\b/, warn: '⚠ git reset --hard — 可能丢弃所有未提交的更改' },
  { re: /\bgit\s+push\s+.*(-f|--force)\b/, warn: '⚠ git push --force — 可能覆盖远端历史记录' },
  { re: /\bgit\s+clean\s+.*-[a-zA-Z]*f/, warn: '⚠ git clean -f — 可能永久删除未追踪的文件' },
  { re: /\bgit\s+checkout\s+\.\s*$/, warn: '⚠ git checkout . — 可能丢弃工作区所有更改' },
  { re: /\bgit\s+restore\s+\.\s*$/, warn: '⚠ git restore . — 可能丢弃工作区所有更改' },
  { re: /\bgit\s+stash\s+(drop|clear)\b/, warn: '⚠ git stash drop/clear — 可能永久删除暂存的更改' },
  { re: /\bgit\s+branch\s+-D\b/, warn: '⚠ git branch -D — 可能强制删除分支' },
  { re: /\bgit\s+(commit|push|merge)\s+.*--no-verify\b/, warn: '⚠ --no-verify — 可能跳过安全钩子检查' },
  { re: /\bgit\s+commit\s+.*--amend\b/, warn: '⚠ git commit --amend — 可能重写最近一次提交' },
];

/**
 * 检测 git 破坏性命令，返回警告信息数组（空数组 = 安全）。
 * 不阻止执行，仅在结果中附加提示。
 */
function _detectGitDestructive(command) {
  if (!command) return [];
  const warnings = [];
  for (const { re, warn } of _GIT_DESTRUCTIVE_PATTERNS) {
    if (re.test(command)) warnings.push(warn);
  }
  return warnings;
}

// ── Git commit 消息注入防护（对标 CC bashSecurity.ts）────────────
//
// 模型生成的 commit message 可能意外包含 $(...) 或 `...` 命令替换，
// 导致 shell 在展开引号内容时执行任意命令。
//
// 策略：
//  1. 解析 git commit -m '...' / "..." 中的消息体
//  2. 检查消息体是否包含 $(...) 或 `...` 命令替换
//  3. 检查 -m 引号关闭后是否跟有 shell 元字符（; && || | 等）
//  4. 检测到威胁则阻止执行

/**
 * 解析 git commit -m "msg" / -m 'msg' 中的消息体和尾部。
 * 返回 { message, trailing } 或 null。
 */
function _parseCommitMessage(command) {
  // 找到 -m 后面的引号和消息体
  const mFlag = command.match(/-m\s+(["'])/);
  if (!mFlag) return null;
  const quote = mFlag[1];
  const startIdx = mFlag.index + mFlag[0].length; // 引号后第一个字符
  // 找到匹配的关闭引号（不是转义的）
  let endIdx = -1;
  for (let i = startIdx; i < command.length; i++) {
    if (command[i] === quote && command[i - 1] !== '\\') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return null; // 未闭合引号，放行
  return {
    message: command.slice(startIdx, endIdx),
    trailing: command.slice(endIdx + 1),
  };
}

function _detectCommitInjection(command) {
  if (!command) return null;
  // 只检查包含 git commit -m 的命令
  if (!/\bgit\s+.*\bcommit\b/.test(command) && !/\bgit\s+commit\b/.test(command)) return null;
  if (!/-m\s/.test(command)) return null;

  const parsed = _parseCommitMessage(command);
  if (!parsed) return null; // 无法解析 — 保守放行

  const { message, trailing } = parsed;

  // 检查 commit message 内的命令替换
  if (/\$\(/.test(message) || /`[^`]+`/.test(message)) {
    return '🛑 Git commit 消息包含命令替换 ($(...) 或 `...`)，已阻止执行以防止注入攻击。请移除 commit message 中的命令替换语法。';
  }

  // 检查 -m 引号关闭后是否有 shell 元字符（; && || | 等拼接额外命令）
  if (trailing && /[;&|]/.test(trailing.trim())) {
    // 允许常见的安全后续：&& git push, && echo 等
    // 但禁止直接裸 shell 注入
    const afterQuote = trailing.trim();
    // 如果是 && git ... 或 ; git ... 这类链式 git 命令，放行
    if (/^(&&|\|\||;)\s*git\s/.test(afterQuote)) return null;
    // 如果是 && echo / && printf 等无害命令，放行
    if (/^(&&|\|\||;)\s*(echo|printf|true|:)\b/.test(afterQuote)) return null;
    return '🛑 Git commit -m 引号关闭后包含 shell 元字符，已阻止执行以防止命令注入。请确保 commit message 正确闭合且后续命令安全。';
  }

  return null;
}

function _extractBuildErrorSummary(command, fullOutput) {
  if (!command || !fullOutput) return null;
  if (!BUILD_CMD_RE.test(command)) return null;
  const lines = fullOutput.split('\n');
  const errorLines = [];
  for (const line of lines) {
    if (BUILD_ERROR_LINE_RE.test(line)) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && trimmed.length < 500) {
        errorLines.push(trimmed);
      }
      if (errorLines.length >= 30) break;
    }
  }
  if (errorLines.length === 0) return null;
  return '\n\n--- Build Errors Summary (' + errorLines.length + ' lines) ---\n' + errorLines.join('\n') + '\n---';
}

/**
 * 接缝1(goal「C/D 盘符 / 文件夹文件太多抓不住重点」):委派纯叶子 bashListingSummary。
 * 列目录类命令(ls -R / find / tree / du / dir /s)的海量清单在被 _smartTruncate 盲截前,
 * 先经解析 + fileSalience 摘要前置到输出顶部。不适用 → null(逐字节回退纯截断)。绝不抛。
 */
function _extractListingSummary(command, fullOutput, env) {
  try {
    const { extractListingSummary } = require('../services/bashListingSummary');
    return extractListingSummary(command, fullOutput, env || process.env);
  } catch {
    return null;
  }
}

// PowerShell-aware "When issuing multiple commands" sub-block. When the target
// shell is a PowerShell family (KHY_SHELL override / COMSPEC → powershell·pwsh),
// teach `;`/`if ($?)` instead of `&&` (Windows PowerShell 5.1 has no `&&`).
// Default context is byte-identical to the legacy `&&` wording. fail-soft.
function _multiCommandBlock() {
  try {
    return require('../constants/shellChainStyle').multiCommandLines(process.env).join('\n');
  } catch {
    return [
      ' - When issuing multiple commands:',
      '   - If independent, make parallel tool calls.',
      "   - If dependent, chain with '&&'.",
      "   - Use ';' only when you don't care if earlier commands fail.",
    ].join('\n');
  }
}

const shellCommandTool = defineTool({
  name: 'shellCommand',
  description: `Executes a given shell command and returns its output.

${_buildToolAvoidanceBlock()}

# Instructions
 - Prefer dedicated tools over this tool whenever possible. Use shell execution only when you genuinely need a process, shell syntax, or a command-line program.
 - Always quote file paths that contain spaces with double quotes.
 - You may specify an optional timeout in milliseconds (max 60000).
 - Choose the narrowest sufficient command or check. Prefer targeted tests, focused builds, and scoped inspection commands before wider repo-wide commands.
 - Before running a mutating command, assess reversibility and scope. Confirm with the user if it is destructive, production-facing, or affects shared state unless they already requested it explicitly.
 - For builds, tests, installs, and other potentially long-running commands, tell the user what is being run, watch concrete progress, and avoid assuming a fixed completion time.
  - If a command fails, inspect the exit code and stderr before retrying. Change the approach instead of looping on the same failure.
  - After 2-3 adjusted attempts on the same failing command path, stop and report what you tried, the error observed, the likely cause, and the next fallback option.
  - Prefer root-cause fixes over command-line band-aids. If one attempted fix creates a different failure, re-evaluate before piling on more commands.
  - When reporting output, surface the important lines and summarize noisy logs instead of pasting everything verbatim.
  - Do not jump to a broader command like a full test suite, full build, or repo-wide scan if a narrower command can already prove the result with similar confidence.
  - On Windows, prefer syntax compatible with the active shell and do not assume PowerShell 7-only features are available.
${_multiCommandBlock()}

# Git Safety
 - NEVER update the git config.
 - NEVER run destructive git commands (push --force, reset --hard, checkout ., clean -f, branch -D) unless the user explicitly requests it.
 - NEVER skip hooks (--no-verify) unless the user explicitly requests it.
 - Prefer creating NEW commits over amending existing ones.
 - Before running destructive operations, consider safer alternatives.

# Dangerous Commands
 - Be cautious with rm -rf, mkfs, dd, format, fdisk — these are irreversible.
 - Confirm with user before running destructive commands on shared systems.`,
  category: 'execution',
  risk: 'critical',

  // Dynamic: read-only if the command is a search/read/list pipeline
  isReadOnly: (input) => {
    if (!input?.command) return false;
    const { isSearch, isRead, isList } = isSearchOrReadCommand(input.command);
    return isSearch || isRead || isList;
  },

  isDestructive: (input) => {
    if (!input?.command) return false;
    // Filesystem destructive patterns
    if (/\b(rm\s+-rf|rm\s+-r|mkfs|dd\s+if=|format\s|fdisk|wipefs|shred)\b/i.test(input.command)) return true;
    // Git destructive patterns
    return _detectGitDestructive(input.command).length > 0;
  },
  // Dynamic: read-only shell commands (ls, git status, grep, etc.) are safe for parallel execution
  isConcurrencySafe: (input) => {
    if (!input?.command) return false;
    const { isSearch, isRead, isList } = isSearchOrReadCommand(input.command);
    return isSearch || isRead || isList;
  },

  // Chapter 5 additions
  maxResultSizeChars: 50000,

  // Clamp an over-max timeout/idleTimeout to the cap BEFORE schema validation
  // instead of hard-rejecting it. A weak model that sets timeout=600000 (e.g.
  // retrying after a 60s idle-kill) would otherwise hit schema `timeout.max:60000`
  // → collapsed to an opaque "Invalid tool parameters" it cannot recover from.
  // The internal code already Math.min(timeout, 60000)s, so clamping here just
  // makes the (redundant) schema max stop rejecting. Gate KHY_SHELL_TIMEOUT_CLAMP
  // (default-on); off → params pass through unchanged → schema still rejects
  // (byte-identical legacy). Fail-soft: any error → original params.
  normalizeParams(params, env) {
    try {
      return require('../services/shellTimeoutClamp').clampTimeoutParams(params, env);
    } catch {
      return params;
    }
  },

  inputSchema: {
    command: { type: 'string', required: true, description: 'Shell command to execute' },
    cwd: { type: 'string', required: false, description: 'Working directory' },
    timeout: { type: 'number', required: false, max: 60000, description: 'Timeout in ms (max 60000)' },
    idleTimeout: {
      type: 'number',
      required: false,
      description: 'Optional idle (no-output) timeout in ms. The command is killed if it produces no output for this long, '
        + 'even if the total timeout has not elapsed. Use for commands that may hang silently (network calls, prompts). '
        + 'Defaults to the total timeout when omitted.',
    },
    run_in_background: {
      type: 'boolean',
      required: false,
      description: 'Run the command detached and return immediately. Use for slow operations '
        + '(installs, builds, long test suites, dev servers). Completion is reported later via a '
        + '<task_notification> block — do NOT poll.',
    },
  },

  async validateInput(input) {
    const { validateNotDevicePath, validateNotUNCPath, composeValidations } = require('./inputValidators');

    // ── Git commit 注入防护 ─────────────────────────────────────────
    if (input.command) {
      const injectionError = _detectCommitInjection(input.command);
      if (injectionError) {
        return { valid: false, message: injectionError };
      }
    }

    // Check for device paths in the command arguments
    if (input.command) {
      const tokens = input.command.split(/\s+/);
      for (const token of tokens) {
        if (token.startsWith('/dev/')) {
          const devCheck = validateNotDevicePath(token);
          if (!devCheck.valid) return devCheck;
        }
      }
    }

    // Check working directory
    if (input.cwd) {
      return composeValidations(
        validateNotUNCPath(input.cwd),
      );
    }

    return { valid: true };
  },

  getActivityDescription(input) {
    if (!input?.command) return '执行 Shell 命令';
    const base = getBaseCommand(input.command);
    const short = input.command.length > 60
      ? input.command.slice(0, 57) + '...'
      : input.command;
    return `运行命令：${short}`;
  },

  getToolUseSummary(input) {
    if (!input?.command) return null;
    return `Shell：${input.command.slice(0, 80)}`;
  },

  async execute(params, context) {
    try {
      // ── Git 破坏性命令预警（不阻止执行）──────────────────────────
      const gitWarnings = _detectGitDestructive(params.command);
      if (gitWarnings.length > 0 && context && typeof context.onActivity === 'function') {
        try {
          context.onActivity({
            phase: 'destructive_warning',
            warnings: gitWarnings,
            message: gitWarnings.join('\n'),
          });
        } catch { /* non-critical */ }
      }

      const cwd = params.cwd || process.env.KHYQUANT_CWD || process.cwd();

      // ── RTK 省 token 模式:执行前改写命令 ────────────────────────────────
      // 把原始 shell 命令交给 `rtk rewrite`,得到 rtk 等价命令(如 `git status`
      // → `rtk git status`),后续三条执行分支自然继承。缺二进制时按 KHY_RTK_AUTO_INSTALL
      // fire-and-forget 触发安装(非阻塞,本回合仍跑原生命令);改写失败/退出码非改写态
      // → 保持原命令。命中改写后,输出在各 return 点剥离 `[rtk]` 元信息。
      let _rtkRouted = false;
      if (_rtkMode.modeEnabled()) {
        try {
          const bin = await _rtkMode.resolveBinary();
          if (bin) {
            const rewritten = _rtkMode.rewriteShellCommand(params.command, { bin });
            if (rewritten && rewritten.run) {
              params = { ...params, command: rewritten.run };
              _rtkRouted = true;
            }
          } else if (_rtkMode.autoInstallEnabled()) {
            _rtkInstaller.kickoff(); // 后台安装,绝不阻塞本回合
          }
        } catch { /* 非关键:任何异常都回落原生命令 */ }
      }

      // Per-call timeout > hardware-derived default (KHY_SHELL_TIMEOUT_MS, set by
      // hardwareProfileService.applyLimits — tighter on weak machines) > 30s.
      // Hard-capped at 60s regardless.
      const _hwShellTimeout = parseInt(process.env.KHY_SHELL_TIMEOUT_MS, 10);
      const baseTimeout = Math.min(
        params.timeout || (Number.isFinite(_hwShellTimeout) ? _hwShellTimeout : 30000),
        60000
      );
      const timeout = _adaptiveOutput ? _adaptiveOutput.applyMultiplier(baseTimeout) : baseTimeout;

      // Resolve the cross-platform shell once (Git Bash / PowerShell / cmd on
      // Windows; login bash on Unix). Single source of truth — replaces the
      // former inline shell selection.
      const shellCfg = getShellConfiguration({ login: true });

      // Windows: PowerShell `Get-ChildItem -Recurse` 撞无权限子目录会整体 exit 1（用户要的
      // 计数拿不到）。在任何 shell 翻译之前注入 -Force -ErrorAction SilentlyContinue 让其跳过
      // 无权限项并成功——因用户常从 cmd 调 `powershell -Command "...-Recurse..."`，故不限活动 shell。
      // patched 时附 advisory 透明告知（见下方 _advisories）。
      const _shellAdvisories = [];
      if (process.platform === 'win32') {
        const rec = _patchPowerShellRecurse(params.command);
        if (rec.patched) {
          params = { ...params, command: rec.command };
          _shellAdvisories.push(
            '已自动加 -Force -ErrorAction SilentlyContinue 以跳过无权限子目录'
            + '（计数已成功；逐条 access-denied 被 SilentlyContinue 抑制，如需逐条错误请显式指定 -ErrorAction）。'
          );
        }
      }

      // Windows: 自动修补常见的 Linux-only 命令语法。仅当目标 shell 是 cmd.exe 时
      // 才翻译 —— _patchWinCommand 产出纯 cmd 语法 (type/findstr/NUL/%VAR%)，对
      // Git Bash / PowerShell 是错的。
      if (shellCfg.shell === 'cmd') {
        params = { ...params, command: _patchWinCommand(params.command) };
      } else if (process.platform === 'win32' && shellCfg.shell === 'bash') {
        // Git Bash / MSYS on Windows: drive-absolute Windows paths (D:\foo) are
        // unusable by coreutils and `dir` does not exist — translate to MSYS form
        // so model-generated cmd-style commands still succeed.
        params = { ...params, command: _patchGitBashCommand(params.command) };
      }

      const baseCmd = getBaseCommand(params.command);

      // Windows: force UTF-8 for commands carrying non-ASCII (CJK paths etc.) so the
      // child shell parses and emits text as UTF-8 instead of the legacy OEM code page.
      // `execCommand` is what we actually spawn; `forcedEnc` tells the decoder how to
      // read the child output. ASCII-only commands are returned unchanged (zero regression).
      const { command: execCommand, outputEncoding: forcedEnc } = _forceWindowsUtf8(shellCfg, params.command);

      // GUI apps: launch in background (detached), cross-platform
      if (isGuiApp(baseCmd)) {
        const parts = params.command.split(/\s+/);
        const child = spawnGuiApp(parts[0], parts.slice(1), { cwd });
        return { success: true, output: `已启动 ${baseCmd} (PID: ${child.pid})` };
      }

      // Background dispatch: run_in_background detaches the command and returns
      // immediately. The result flows back later as a <task_notification> drained
      // by the tool-use loop — no polling, no blocking. Same spawn machinery as
      // the foreground path, just fire-and-forget with output capped.
      if (params.run_in_background === true) {
        const traceCtx = (context && context.traceContext) ? context.traceContext : {};
        let bgEnv = {
          ...process.env,
          ...(traceCtx && typeof traceCtx === 'object' ? traceCtx.env || {} : {}),
        };
        if (shellCfg.shell !== 'cmd') bgEnv = normalizePathEnvForWindows(bgEnv);
        const bgIdleMs = Math.max(
          1000,
          parseInt(String(params.idleTimeout || process.env.KHY_SHELL_IDLE_TIMEOUT_MS || timeout), 10) || timeout
        );
        const bgId = `bgsh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const entry = { status: 'running', command: params.command, startedAt: Date.now(), kind: 'shell' };
        _backgroundShells.set(bgId, entry);

        spawnWithIdleTimeout(shellCfg.executable, [...shellCfg.argsPrefix, execCommand], {
          idleMs: bgIdleMs,
          spawnOpts: { cwd, env: bgEnv, windowsHide: true },
          label: `shellCommand[bg]:${baseCmd || 'command'}`,
          maxOutputBytes: MAX_OUTPUT,
          outputEncoding: forcedEnc,
          // Retain the child so KillShell can terminate a still-running bg command.
          // Additive: default path unaffected when onChild is absent.
          onChild: (child) => { entry.child = child; entry.pid = child && child.pid; },
        }).then((result) => {
          let merged = `${result.stdout || ''}${result.stderr ? `\n${result.stderr}` : ''}`;
          if (_rtkRouted) merged = _rtkMode.stripRtkMeta(merged);
          if (merged && merged.length > MAX_OUTPUT) merged = _smartTruncate(merged, MAX_OUTPUT);
          entry.status = result.code === 0 ? 'completed' : 'failed';
          entry.result = { output: merged, exitCode: result.code };
          if (result.code !== 0) entry.error = _composeShellError(result.code, merged, params.command);
          if (_gitTracker) {
            try { _gitTracker.trackFromShellOutput(params.command, merged); } catch { /* non-critical */ }
          }
        }).catch((err) => {
          entry.status = 'failed';
          entry.error = String(err && err.message ? err.message : err || 'background shell failed');
        });

        return {
          success: true,
          backgroundTaskId: bgId,
          output: `已在后台启动命令（task_id=${bgId}）。完成后会通过 <task_notification> 自动回报，无需轮询。`,
          ...(gitWarnings.length > 0 ? { _destructiveWarnings: gitWarnings } : {}),
          ...(_shellAdvisories.length > 0 ? { _advisories: _shellAdvisories } : {}),
        };
      }

      // Activity-based idle timeout for potentially long-running shell commands.
      // If the command keeps producing output, it stays alive (no fixed wall-clock kill).
      const idleTimeoutEnabled = String(process.env.KHY_SHELL_IDLE_TIMEOUT_ENABLED || 'true').toLowerCase() !== 'false';
      if (idleTimeoutEnabled) {
        const idleTimeoutMs = Math.max(
          1000,
          parseInt(
            String(params.idleTimeout || process.env.KHY_SHELL_IDLE_TIMEOUT_MS || timeout),
            10
          ) || timeout
        );
        const traceCtx = (context && context.traceContext) ? context.traceContext : {};
        let spawnEnv = {
          ...process.env,
          ...(traceCtx && typeof traceCtx === 'object' ? traceCtx.env || {} : {}),
        };
        // PowerShell / Git Bash are sensitive to case-variant PATH/Path/path keys
        // that cmd.exe tolerates; canonicalize before spawning a non-cmd shell.
        if (shellCfg.shell !== 'cmd') spawnEnv = normalizePathEnvForWindows(spawnEnv);
        const shellBin = shellCfg.executable;
        const shellArgs = [...shellCfg.argsPrefix, execCommand];
        const label = `shellCommand:${baseCmd || 'command'}`;

        // Long-run advisory: suggest background promotion at 50% of timeout
        let advisory;
        if (_adaptiveOutput && context && typeof context.onActivity === 'function') {
          advisory = _adaptiveOutput.createLongRunAdvisory({
            timeoutMs: idleTimeoutMs,
            command: params.command,
            onAdvisory: (msg) => {
              try { context.onActivity({ phase: 'long_run_advisory', message: msg }); } catch { /* ignore */ }
            },
          });
        }

        try {
          const result = await spawnWithIdleTimeout(shellBin, shellArgs, {
            idleMs: idleTimeoutMs,
            spawnOpts: {
              cwd,
              env: spawnEnv,
              windowsHide: true,
            },
            label,
            outputEncoding: forcedEnc,
          });
          let merged = `${result.stdout || ''}${result.stderr ? `\n${result.stderr}` : ''}`;
          if (_rtkRouted) merged = _rtkMode.stripRtkMeta(merged);
          // 接缝1:列目录清单摘要从**截断前完整输出**计算,前置到顶部(摘要必存,截断只砍原始清单)。
          // 门控/解析不足/非列举命令 → null,merged 逐字节不变。
          const _listSummary = _extractListingSummary(params.command, merged, process.env);
          if (merged && merged.length > MAX_OUTPUT) {
            const errSummary = _extractBuildErrorSummary(params.command, merged);
            merged = _smartTruncate(merged, MAX_OUTPUT);
            if (errSummary) merged += errSummary;
          }
          if (_listSummary) merged = _listSummary + merged;
          if (advisory) advisory.clear();
          if (context && typeof context.onActivity === 'function') {
            try {
              context.onActivity({ phase: 'shell_completed', command: baseCmd, code: result.code });
            } catch { /* non-critical */ }
          }
          // Track git operations from shell output
          if (_gitTracker) {
            try { _gitTracker.trackFromShellOutput(params.command, merged); } catch { /* non-critical */ }
          }
          // 退出码语义重判:门控关/无专属语义 → verdict 与旧 `result.code === 0`
          // 逐字节等价(isError === code !== 0、无 message);命中 grep/rg/find/diff/
          // test 专属语义则把 exit 1 等信息性退出码判为成功并带中性 note。
          const _verdict = _interpretShellExit
            ? _interpretShellExit(params.command, result.code, process.env)
            : { isError: result.code !== 0, message: undefined };
          const _ok = !_verdict.isError;
          // 成功但零输出:落一行确定性说明消除「(无输出)」困惑(门控关/异常 → null,
          // 保持 `merged || (_verdict.message || '')` 逐字节回退)。仅在成功且无 stdout、
          // 也无语义 note 时生效——有匹配到的 stdout 或 grep「No matches found」note 时不覆盖。
          let _successOutput = merged || (_verdict.message || '');
          if (_ok && !_successOutput && _buildEmptyOutputNote) {
            const _emptyNote = _buildEmptyOutputNote(params.command, process.env);
            if (_emptyNote) _successOutput = _emptyNote;
          }
          return {
            success: _ok,
            // stdout 为空但有语义 note(如 grep 无匹配)时,把 note 落到 output,
            // 让模型看到「No matches found」而非空串;有 stdout(如 find 列出文件)
            // 则保留 stdout,note 另挂 _exitNote 不丢失。成功且完全空 → 上面的确定性说明。
            output: _successOutput,
            exitCode: Number.isFinite(result.code) ? result.code : 0,
            ...(_ok ? {} : { error: _composeShellError(result.code, merged, params.command) }),
            ...(_verdict.message ? { _exitNote: _verdict.message } : {}),
            ...(gitWarnings.length > 0 ? { _destructiveWarnings: gitWarnings } : {}),
            ...(_shellAdvisories.length > 0 ? { _advisories: _shellAdvisories } : {}),
          };
        } catch (err) {
          if (advisory) advisory.clear();
          const message = String(err && err.message ? err.message : err || 'shell command failed');
          return { success: false, error: message };
        }
      }

      // Fallback path (idle-timeout disabled). execSync always runs the command
      // through a shell; route it through the same shell binary the primary path
      // uses so both agree on cmd / PowerShell / Git Bash / bash. (Note: execSync
      // cannot pass the `-lc` login flag — Node fixes the shell args — so the
      // login PATH is only guaranteed on the primary spawn path above.)
      // execCommand carries the `chcp 65001` / OutputEncoding prefix on Windows,
      // but chcp does NOT reliably transcode cmd built-ins' piped output (dir/ver),
      // so reading stdout as utf-8 here would mojibake the same way the spawn path
      // once did. Capture raw bytes (encoding omitted → Buffer) and run them through
      // the shared smart decoder on Windows; non-Windows keeps the utf-8 fast path.
      const _execOpts = {
        cwd,
        timeout,
        maxBuffer: MAX_OUTPUT,
        shell: shellCfg.executable,
      };
      // 门控开:异步 exec(不阻塞事件循环,ESC 可中断);关:逐字节回退今日 execSync。
      // 两者未指定 encoding 均返回 Buffer(raw bytes),下游 smartDecodeWinOutput 解码逻辑不变。
      const _rawOut = _execCompat.isNonBlockingExecEnabled(process.env)
        ? await _execCompat.execAsync(execCommand, _execOpts)
        : execSync(execCommand, _execOpts);
      let output = process.platform === 'win32'
        ? smartDecodeWinOutput(Buffer.isBuffer(_rawOut) ? _rawOut : Buffer.from(String(_rawOut)))
        : (Buffer.isBuffer(_rawOut) ? _rawOut.toString('utf-8') : String(_rawOut));

      if (_rtkRouted) output = _rtkMode.stripRtkMeta(output);
      // 接缝1(孪生回退路径):列目录清单摘要从截断前完整输出计算,前置到顶部。null → output 逐字节不变。
      const _listSummary = _extractListingSummary(params.command, output, process.env);
      if (output && output.length > MAX_OUTPUT) {
        const errSummary = _extractBuildErrorSummary(params.command, output);
        output = _smartTruncate(output, MAX_OUTPUT);
        if (errSummary) output += errSummary;
      }
      if (_listSummary) output = _listSummary + output;

      // Track git operations from shell output
      if (_gitTracker) {
        try { _gitTracker.trackFromShellOutput(params.command, output); } catch { /* non-critical */ }
      }

      // 成功但零输出:同主路径落确定性说明(门控关/异常 → null,保持 `output || ''` 逐字节回退)。
      let _fbOutput = output || '';
      if (!_fbOutput && _buildEmptyOutputNote) {
        const _emptyNote = _buildEmptyOutputNote(params.command, process.env);
        if (_emptyNote) _fbOutput = _emptyNote;
      }

      return {
        success: true,
        output: _fbOutput,
        ...(gitWarnings.length > 0 ? { _destructiveWarnings: gitWarnings } : {}),
        ...(_shellAdvisories.length > 0 ? { _advisories: _shellAdvisories } : {}),
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});

module.exports = shellCommandTool;
