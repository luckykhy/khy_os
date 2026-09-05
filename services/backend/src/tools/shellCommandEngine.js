/**
 * shellCommandEngine — 共享 shell 执行引擎。
 *
 * 从 shellCommand.js 提取核心执行逻辑,供 shellCommand / bash / powershell / cmd
 * 四个工具复用。接受 shellOverride 参数以显式指定目标 shell:
 *   - null       → 平台默认(同原 shellCommand 行为)
 *   - 'bash'     → 强制 bash (Windows 用 Git Bash)
 *   - 'powershell' → 强制 PowerShell (Windows 优先 pwsh,Unix 需 pwsh)
 *   - 'cmd'      → 强制 cmd.exe (仅 Windows)
 *
 * 当目标 shell 不可用时返回 { success: false, error: '原因' },绝不抛。
 */
const { execSync } = require('child_process');
const fs = require('fs');

const { spawnWithIdleTimeout, smartDecodeWinOutput } = require('../utils/spawnWithIdleTimeout');
const _execCompat = require('./_execCompat');
const { backgroundShells: _backgroundShells } = require('./backgroundShellRegistry');
const {
  isGuiApp,
  spawnGuiApp,
  getShellConfiguration,
  normalizePathEnvForWindows,
  findGitBashPath,
  searchExecutable,
} = require('./platformUtils');
const { isSearchOrReadCommand, getBaseCommand } = require('./shellClassifier');
const { composeShellError: _composeShellError } = require('./shellDiagnostics');
const {
  patchWinCommand: _patchWinCommand,
  patchGitBashCommand: _patchGitBashCommand,
  forceWindowsUtf8: _forceWindowsUtf8,
  patchPowerShellRecurse: _patchPowerShellRecurse,
} = require('./winCommandTranslate');
const { buildToolAvoidanceBlock: _buildToolAvoidanceBlock } = require('../constants/shellTransparency');

let _interpretShellExit;
try {
  ({ interpretShellExit: _interpretShellExit } = require('./shellExitSemantics'));
} catch {
  _interpretShellExit = null;
}
let _buildEmptyOutputNote;
try {
  ({ buildEmptyOutputNote: _buildEmptyOutputNote } = require('./shellEmptyOutputNote'));
} catch {
  _buildEmptyOutputNote = null;
}
let _gitTracker;
try {
  _gitTracker = require('../services/gitOperationTracker');
} catch {
  _gitTracker = null;
}
let _adaptiveOutput;
try {
  _adaptiveOutput = require('../services/adaptiveOutput');
} catch {
  _adaptiveOutput = null;
}

const MAX_OUTPUT = 200 * 1024; // 200 KB

const BUILD_CMD_RE =
  /\b(mvn|gradle|gradlew|npm\s+run\s+build|npx\s+tsc|cargo\s+build|go\s+build|make|cmake|dotnet\s+build|msbuild)\b/i;
const BUILD_ERROR_LINE_RE =
  /\b(ERROR|FAILURE|FAILED|error\[|error:|cannot find|cannot resolve|compilation failed|BUILD FAILED|exception|NoClassDefFoundError|ClassNotFoundException|NullPointerException|SyntaxError|TypeError|ReferenceError)\b/i;

const _GIT_DESTRUCTIVE_PATTERNS = [
  { re: /\bgit\s+reset\s+--hard\b/, warn: '⚠ git reset --hard — 可能丢弃所有未提交的更改' },
  { re: /\bgit\s+push\s+.*(-f|--force)\b/, warn: '⚠ git push --force — 可能覆盖远端历史记录' },
  { re: /\bgit\s+clean\s+.*-[a-zA-Z]*f/, warn: '⚠ git clean -f — 可能永久删除未追踪的文件' },
  { re: /\bgit\s+checkout\s+\.\s*$/, warn: '⚠ git checkout . — 可能丢弃工作区所有更改' },
  { re: /\bgit\s+restore\s+\.\s*$/, warn: '⚠ git restore . — 可能丢弃工作区所有更改' },
  { re: /\bgit\s+stash\s+(drop|clear)\b/, warn: '⚠ git stash drop/clear — 可能永久删除暂存的更改' },
  { re: /\bgit\s+branch\s+-D\b/, warn: '⚠ git branch -D — 可能强制删除分支' },
  {
    re: /\bgit\s+(commit|push|merge)\s+.*--no-verify\b/,
    warn: '⚠ --no-verify — 可能跳过安全钩子检查',
  },
  { re: /\bgit\s+commit\s+.*--amend\b/, warn: '⚠ git commit --amend — 可能重写最近一次提交' },
];

function _detectGitDestructive(command) {
  if (!command) return [];
  const warnings = [];
  for (const { re, warn } of _GIT_DESTRUCTIVE_PATTERNS) {
    if (re.test(command)) warnings.push(warn);
  }
  return warnings;
}

function _parseCommitMessage(command) {
  const mFlag = command.match(/-m\s+(["'])/);
  if (!mFlag) return null;
  const quote = mFlag[1];
  const startIdx = mFlag.index + mFlag[0].length;
  let endIdx = -1;
  for (let i = startIdx; i < command.length; i++) {
    if (command[i] === quote && command[i - 1] !== '\\') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return null;
  return { message: command.slice(startIdx, endIdx), trailing: command.slice(endIdx + 1) };
}

function _detectCommitInjection(command) {
  if (!command) return null;
  if (!/\bgit\s+.*\bcommit\b/.test(command) && !/\bgit\s+commit\b/.test(command)) return null;
  if (!/-m\s/.test(command)) return null;
  const parsed = _parseCommitMessage(command);
  if (!parsed) return null;
  const { message, trailing } = parsed;
  if (/\$\(/.test(message) || /`[^`]+`/.test(message)) {
    return '🛑 Git commit 消息包含命令替换 ($(...) 或 `...`)，已阻止执行以防止注入攻击。请移除 commit message 中的命令替换语法。';
  }
  if (trailing && /[;&|]/.test(trailing.trim())) {
    const afterQuote = trailing.trim();
    if (/^(&&|\|\||;)\s*git\s/.test(afterQuote)) return null;
    if (/^(&&|\|\||;)\s*(echo|printf|true|:)\b/.test(afterQuote)) return null;
    return '🛑 Git commit -m 引号关闭后包含 shell 元字符，已阻止执行以防止命令注入。请确保 commit message 正确闭合且后续命令安全。';
  }
  return null;
}

function _extractBuildErrorSummary(command, fullOutput) {
  if (!command || !fullOutput || !BUILD_CMD_RE.test(command)) return null;
  const lines = fullOutput.split('\n');
  const errorLines = [];
  for (const line of lines) {
    if (BUILD_ERROR_LINE_RE.test(line)) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && trimmed.length < 500) errorLines.push(trimmed);
      if (errorLines.length >= 30) break;
    }
  }
  if (errorLines.length === 0) return null;
  return `\n\n--- Build Errors Summary (${errorLines.length} lines) ---\n${errorLines.join('\n')}\n---`;
}

function _extractListingSummary(command, fullOutput, env) {
  try {
    const { extractListingSummary } = require('../services/bashListingSummary');
    return extractListingSummary(command, fullOutput, env || process.env);
  } catch {
    return null;
  }
}

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

function _smartTruncate(text, maxLen) {
  if (!text || text.length <= maxLen) return text;
  const HEAD = Math.min(2048, Math.floor(maxLen * 0.15));
  const TAIL = maxLen - HEAD - 100;
  const omitted = text.length - HEAD - TAIL;
  return text.slice(0, HEAD) + `\n\n... [${omitted} chars omitted — head+tail preserved] ...\n\n` + text.slice(-TAIL);
}

// ── shellOverride 路由 ──────────────────────────────────────────────

/**
 * 根据 shellOverride 解析目标 shell 配置。
 * @param {string|null} shellOverride  null | 'bash' | 'powershell' | 'cmd' | 'pwsh' | 'sh'
 * @param {boolean} login 是否使用 login shell
 * @returns {{ executable, argsPrefix, shell, available?: false, reason?: string, fallback?: boolean }}
 */
function resolveShellConfig(shellOverride, login = true) {
  const isWin = process.platform === 'win32';

  if (!shellOverride) {
    return getShellConfiguration({ login });
  }

  switch (shellOverride) {
    case 'bash': {
      if (isWin) {
        const bashPath = findGitBashPath();
        if (!bashPath) {
          return { available: false, reason: 'Git Bash 未安装。请安装 Git for Windows 或运行 winget install Git.Git' };
        }
        return { executable: bashPath, argsPrefix: ['-lc'], shell: 'bash' };
      }
      if (fs.existsSync('/bin/bash')) {
        return { executable: '/bin/bash', argsPrefix: login ? ['-lc'] : ['-c'], shell: 'bash' };
      }
      if (fs.existsSync('/bin/sh')) {
        return { executable: '/bin/sh', argsPrefix: ['-c'], shell: 'sh', fallback: true };
      }
      return { available: false, reason: '系统未找到 bash 或 sh。' };
    }

    case 'pwsh':
    case 'powershell': {
      if (isWin) {
        const pwshPath = searchExecutable('pwsh');
        const comSpec = (process.env.COMSPEC || '').toLowerCase();
        return {
          executable:
            pwshPath ||
            (comSpec.endsWith('powershell.exe') ? process.env.COMSPEC : 'powershell.exe'),
          argsPrefix: ['-NoProfile', '-NonInteractive', '-Command'],
          shell: 'powershell',
        };
      }
      const pwshPath = searchExecutable('pwsh');
      if (pwshPath) {
        return { executable: pwshPath, argsPrefix: ['-NoProfile', '-NonInteractive', '-Command'], shell: 'powershell' };
      }
      return {
        available: false,
        reason: 'PowerShell Core (pwsh) 未安装。安装命令: sudo snap install powershell 或参见 https://aka.ms/pscore6',
      };
    }

    case 'cmd': {
      if (!isWin) {
        return { available: false, reason: 'cmd.exe 仅 Windows 可用。请使用 bash 工具。' };
      }
      return { executable: process.env.COMSPEC || 'cmd.exe', argsPrefix: ['/d', '/s', '/c'], shell: 'cmd' };
    }

    case 'sh': {
      if (isWin) {
        const bashPath = findGitBashPath();
        if (bashPath) return { executable: bashPath, argsPrefix: ['-c'], shell: 'bash' };
        return { available: false, reason: 'Git Bash 未安装，无法运行 sh。' };
      }
      const shPath = fs.existsSync('/bin/sh') ? '/bin/sh' : null;
      if (shPath) return { executable: shPath, argsPrefix: ['-c'], shell: 'sh' };
      return { available: false, reason: '系统未找到 sh。' };
    }

    default:
      return getShellConfiguration({ login });
  }
}

/**
 * 检测 shell 是否在当前平台可用。
 * @param {string|null} shellOverride
 * @returns {boolean}
 */
function isShellAvailable(shellOverride) {
  const cfg = resolveShellConfig(shellOverride);
  return cfg.available !== false;
}

// ── 共享执行函数 ────────────────────────────────────────────────────

/**
 * 执行 shell 命令的核心逻辑。
 * @param {object} params  { command, cwd, timeout, idleTimeout, run_in_background }
 * @param {object} context  { onActivity, traceContext }
 * @param {string|null} shellOverride  null | 'bash' | 'powershell' | 'cmd' | 'sh' | 'pwsh'
 * @returns {Promise<{ success: boolean, output?, error?, exitCode?, backgroundTaskId? }>}
 */
async function executeShellCommand(params, context, shellOverride = null) {
  try {
    const gitWarnings = _detectGitDestructive(params.command);
    if (gitWarnings.length > 0 && context && typeof context.onActivity === 'function') {
      try {
        context.onActivity({ phase: 'destructive_warning', warnings: gitWarnings, message: gitWarnings.join('\n') });
      } catch {
        /* non-critical */
      }
    }

    const cwd = params.cwd || process.env.KHYQUANT_CWD || process.cwd();

    // ── 解析目标 shell ─────────────────────────────────────────────
    const shellCfg = resolveShellConfig(shellOverride, true);
    if (shellCfg.available === false) {
      return { success: false, error: shellCfg.reason };
    }

    // ── RTK 省 token 模式 ──────────────────────────────────────────
    let _rtkRouted = false;
    try {
      const _rtkMode = require('../services/rtkMode');
      const _rtkInstaller = require('../services/rtkInstaller');
      if (_rtkMode.modeEnabled()) {
        const bin = await _rtkMode.resolveBinary();
        if (bin) {
          const rewritten = _rtkMode.rewriteShellCommand(params.command, { bin });
          if (rewritten && rewritten.run) {
            params = { ...params, command: rewritten.run };
            _rtkRouted = true;
          }
        } else if (_rtkMode.autoInstallEnabled()) {
          _rtkInstaller.kickoff();
        }
      }
    } catch {
      /* 非关键:任何异常都回落原生命令 */
    }

    // ── 超时计算 ───────────────────────────────────────────────────
    const _hwShellTimeout = parseInt(process.env.KHY_SHELL_TIMEOUT_MS, 10);
    const baseTimeout = Math.min(
      params.timeout || (Number.isFinite(_hwShellTimeout) ? _hwShellTimeout : 30000),
      60000
    );
    const timeout = _adaptiveOutput ? _adaptiveOutput.applyMultiplier(baseTimeout) : baseTimeout;

    // ── Windows PowerShell -Recurse 修补 ───────────────────────────
    const _shellAdvisories = [];
    if (process.platform === 'win32') {
      const rec = _patchPowerShellRecurse(params.command);
      if (rec.patched) {
        params = { ...params, command: rec.command };
        _shellAdvisories.push(
          '已自动加 -Force -ErrorAction SilentlyContinue 以跳过无权限子目录' +
            '（计数已成功；逐条 access-denied 被 SilentlyContinue 抑制，如需逐条错误请显式指定 -ErrorAction）。'
        );
      }
    }

    // ── 命令翻译 ───────────────────────────────────────────────────
    if (shellCfg.shell === 'cmd') {
      params = { ...params, command: _patchWinCommand(params.command) };
    } else if (process.platform === 'win32' && shellCfg.shell === 'bash') {
      params = { ...params, command: _patchGitBashCommand(params.command) };
    }

    const baseCmd = getBaseCommand(params.command);

    // ── UTF-8 强制 ─────────────────────────────────────────────────
    const { command: execCommand, outputEncoding: forcedEnc } = _forceWindowsUtf8(
      shellCfg,
      params.command
    );

    // ── GUI apps ───────────────────────────────────────────────────
    if (isGuiApp(baseCmd)) {
      const parts = params.command.split(/\s+/);
      const child = spawnGuiApp(parts[0], parts.slice(1), { cwd });
      return { success: true, output: `已启动 ${baseCmd} (PID: ${child.pid})` };
    }

    // ── 后台执行 ───────────────────────────────────────────────────
    if (params.run_in_background === true) {
      const traceCtx = context && context.traceContext ? context.traceContext : {};
      let bgEnv = { ...process.env, ...(traceCtx && typeof traceCtx === 'object' ? traceCtx.env || {} : {}) };
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
        onChild: (child) => {
          entry.child = child;
          entry.pid = child && child.pid;
        },
      })
        .then((result) => {
          let merged = `${result.stdout || ''}${result.stderr ? `\n${result.stderr}` : ''}`;
          if (_rtkRouted) {
            try {
              merged = require('../services/rtkMode').stripRtkMeta(merged);
            } catch { /* ignore */ }
          }
          if (merged && merged.length > MAX_OUTPUT) merged = _smartTruncate(merged, MAX_OUTPUT);
          entry.status = result.code === 0 ? 'completed' : 'failed';
          entry.result = { output: merged, exitCode: result.code };
          if (result.code !== 0) entry.error = _composeShellError(result.code, merged, params.command);
          if (_gitTracker) {
            try { _gitTracker.trackFromShellOutput(params.command, merged); } catch { /* non-critical */ }
          }
        })
        .catch((err) => {
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

    // ── 前台执行（idle timeout） ───────────────────────────────────
    const idleTimeoutEnabled =
      String(process.env.KHY_SHELL_IDLE_TIMEOUT_ENABLED || 'true').toLowerCase() !== 'false';
    if (idleTimeoutEnabled) {
      const idleTimeoutMs = Math.max(
        1000,
        parseInt(String(params.idleTimeout || process.env.KHY_SHELL_IDLE_TIMEOUT_MS || timeout), 10) || timeout
      );
      const traceCtx = context && context.traceContext ? context.traceContext : {};
      let spawnEnv = { ...process.env, ...(traceCtx && typeof traceCtx === 'object' ? traceCtx.env || {} : {}) };
      if (shellCfg.shell !== 'cmd') spawnEnv = normalizePathEnvForWindows(spawnEnv);
      const shellBin = shellCfg.executable;
      const shellArgs = [...shellCfg.argsPrefix, execCommand];
      const label = `shellCommand:${baseCmd || 'command'}`;

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
          spawnOpts: { cwd, env: spawnEnv, windowsHide: true },
          label,
          outputEncoding: forcedEnc,
        });
        let merged = `${result.stdout || ''}${result.stderr ? `\n${result.stderr}` : ''}`;
        if (_rtkRouted) {
          try {
            merged = require('../services/rtkMode').stripRtkMeta(merged);
          } catch { /* ignore */ }
        }
        const _listSummary = _extractListingSummary(params.command, merged, process.env);
        if (merged && merged.length > MAX_OUTPUT) {
          const errSummary = _extractBuildErrorSummary(params.command, merged);
          merged = _smartTruncate(merged, MAX_OUTPUT);
          if (errSummary) merged += errSummary;
        }
        if (_listSummary) merged = _listSummary + merged;
        if (advisory) advisory.clear();
        if (context && typeof context.onActivity === 'function') {
          try { context.onActivity({ phase: 'shell_completed', command: baseCmd, code: result.code }); } catch { /* non-critical */ }
        }
        if (_gitTracker) {
          try { _gitTracker.trackFromShellOutput(params.command, merged); } catch { /* non-critical */ }
        }
        const _verdict = _interpretShellExit
          ? _interpretShellExit(params.command, result.code, process.env)
          : { isError: result.code !== 0, message: undefined };
        const _ok = !_verdict.isError;
        let _successOutput = merged || _verdict.message || '';
        if (_ok && !_successOutput && _buildEmptyOutputNote) {
          const _emptyNote = _buildEmptyOutputNote(params.command, process.env);
          if (_emptyNote) _successOutput = _emptyNote;
        }
        return {
          success: _ok,
          output: _successOutput,
          exitCode: Number.isFinite(result.code) ? result.code : 0,
          ...(_ok ? {} : { error: _composeShellError(result.code, merged, params.command) }),
          ...(_verdict.message ? { _exitNote: _verdict.message } : {}),
          ...(gitWarnings.length > 0 ? { _destructiveWarnings: gitWarnings } : {}),
          ...(_shellAdvisories.length > 0 ? { _advisories: _shellAdvisories } : {}),
        };
      } catch (err) {
        if (advisory) advisory.clear();
        return { success: false, error: String(err && err.message ? err.message : err || 'shell command failed') };
      }
    }

    // ── Fallback path (idle-timeout disabled) ───────────────────────
    const _execOpts = { cwd, timeout, maxBuffer: MAX_OUTPUT, shell: shellCfg.executable };
    const _rawOut = _execCompat.isNonBlockingExecEnabled(process.env)
      ? await _execCompat.execAsync(execCommand, _execOpts)
      : execSync(execCommand, _execOpts);
    let output =
      process.platform === 'win32'
        ? smartDecodeWinOutput(Buffer.isBuffer(_rawOut) ? _rawOut : Buffer.from(String(_rawOut)))
        : Buffer.isBuffer(_rawOut)
          ? _rawOut.toString('utf-8')
          : String(_rawOut);

    if (_rtkRouted) {
      try {
        output = require('../services/rtkMode').stripRtkMeta(output);
      } catch { /* ignore */ }
    }
    const _listSummary = _extractListingSummary(params.command, output, process.env);
    if (output && output.length > MAX_OUTPUT) {
      const errSummary = _extractBuildErrorSummary(params.command, output);
      output = _smartTruncate(output, MAX_OUTPUT);
      if (errSummary) output += errSummary;
    }
    if (_listSummary) output = _listSummary + output;
    if (_gitTracker) {
      try { _gitTracker.trackFromShellOutput(params.command, output); } catch { /* non-critical */ }
    }
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
}

module.exports = {
  executeShellCommand,
  resolveShellConfig,
  isShellAvailable,
  _detectCommitInjection,
  _detectGitDestructive,
  _multiCommandBlock,
};
