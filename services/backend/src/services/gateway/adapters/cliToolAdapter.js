/**
 * CLI Tool Adapter — detect and invoke local AI CLI tools
 * (Claude Code, Codex, Aider, etc.) via child processes.
 *
 * Supports streaming output for Claude Code (stream-json format)
 * so the user can see thinking and response in real-time.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { safeKill } = require('../../../tools/platformUtils');
const { classifyAdapterError } = require('./_errorClassifiers');
const { buildSuccess, buildFailure } = require('./_responseBuilder');

// Fix G — stream-json tool_use input recovery.
//
// The stream-json protocol emits a tool call in three events:
//   content_block_start  → tool_use, but `input` is EMPTY (args stream later)
//   content_block_delta  → input_json_delta.partial_json (accumulated → inputRaw)
//   content_block_stop   → the block is complete; inputRaw holds the full args
//
// Historically content_block_stop only emitted a display-only `tool_result`
// ("参数: ...") and DROPPED the accumulated inputRaw. Downstream collectors
// (ai.js stream interceptor) therefore only ever saw the EMPTY start emission,
// so a shell tool call reached the syscall gateway with `{}` → empty command →
// classified L2 critical → headless fail-closed. This gate makes stop re-surface
// the completed tool_use carrying the real arguments. Byte-revertible: gate off
// restores the prior display-only tool_result emission exactly.
const _CLI_TOOLUSE_STOP_INPUT_OFF = ['0', 'false', 'off', 'no'];
function _cliToolUseStopInputEnabled(env = process.env) {
  const v = String((env && env.KHY_CLI_TOOLUSE_STOP_INPUT) || '').trim().toLowerCase();
  return !_CLI_TOOLUSE_STOP_INPUT_OFF.includes(v);
}

const TOOLS = [
  {
    name: 'Claude Code',
    cmd: 'claude',
    // Default allow set when no print-mode gate is active.
    defaultAllowedTools: 'Bash,Read,LS,Grep,Glob,Edit,Write,MultiEdit,Task,TodoWrite,WebSearch,WebFetch,NotebookRead,NotebookEdit',
    buildArgs() {
      // Claude Code SDK alignment: when khy delegates to the real Claude Code
      // binary, propagate the active --allowedTools / --disallowedTools gate so
      // the delegate enforces the same restriction (identical flag names). The
      // gate is the shared toolAccessGateway leaf; inactive → default allow set.
      let allowDeny;
      try {
        allowDeny = require('../../toolAccessGateway')
          .buildClaudeAllowDenyArgs(this.defaultAllowedTools.split(','));
      } catch {
        allowDeny = ['--allowedTools', this.defaultAllowedTools];
      }
      return [
        '-p',
        '--output-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
        ...allowDeny,
        '--permission-mode', 'bypassPermissions',
      ];
    },
    useStdin: true,
    streaming: true,
    priority: 1,
    // Claude Code has a Read tool with vision + bypassPermissions, so it can
    // open image files referenced by absolute path. Only such tools get the
    // image-path prompt block (see generate()).
    supportsImageFiles: true,
  },
  {
    name: 'Codex',
    cmd: 'codex',
    buildArgs: () => ['exec', '--color', 'never', '--skip-git-repo-check', '--sandbox', 'read-only'],
    useStdin: true,
    streaming: false,
    priority: 2,
  },
  {
    name: 'Aider',
    cmd: 'aider',
    buildArgs: () => ['--message', '__PROMPT__', '--yes', '--no-auto-commits'],
    useStdin: false,
    streaming: false,
    priority: 3,
  },
  {
    // OpenCode: non-interactive `opencode run [message..]`. Positional prompt
    // (no stdin), auto-approves in run mode, prints the response and exits —
    // same shape as Aider. Model injection uses opencode's `-m provider/model`
    // form via applyModel (only when the model looks like provider/model).
    // Gated by KHY_OPENCODE (default on); when off, detect() skips it so the
    // detected-tool set is byte-identical to before opencode was integrated.
    name: 'OpenCode',
    cmd: 'opencode',
    buildArgs: () => require('./opencodeInvocation').buildRunArgs(),
    applyModel: (args, model) => require('./opencodeInvocation').applyModelArg(args, model),
    gate: (env) => require('./opencodeInvocation').isEnabled(env),
    useStdin: false,
    streaming: false,
    priority: 4,
  },
];

const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

let _detected = null; // cached detection results

// ── abort→kill 门控(root cause B)───────────────────────────────────────────
// KHY_CLITOOL_ABORT 默认 on:子进程调用监听 options.abortSignal,abort 时立即 SIGKILL 子进程,
// 不再只靠 ≥180s idle-timeout(若子进程仍缓慢吐字节则 idle 永不触发 → 无限 hang)。
// 关 → 逐字节回退今日仅 idle 兜底行为。绝不抛。
function _isCliToolAbortEnabled() {
  try {
    return require('../../flagRegistry').isFlagEnabled('KHY_CLITOOL_ABORT', process.env);
  } catch {
    const raw = process.env && process.env.KHY_CLITOOL_ABORT;
    if (raw === undefined || raw === null) return true;
    const v = String(raw).trim().toLowerCase();
    return !(v === 'off' || v === 'false' || v === '0' || v === 'no');
  }
}

// 给一个子进程挂 abort 监听:abort 时 SIGKILL child 并调 onAbort(err)。返回 detach 幂等清理器。
// signal 无效或门关时返回 no-op detach(等价「不挂监听」)。绝不抛。仿 claudeAdapter 的 abortWatcher。
function _wireChildAbort(child, signal, onAbort) {
  if (!_isCliToolAbortEnabled() || !signal || typeof signal.addEventListener !== 'function') {
    return () => {};
  }
  const fire = () => {
    try { safeKill(child, 'SIGKILL', 0); } catch { /* ignore */ }
    try { onAbort(new Error(`cli tool aborted: ${_abortReason(signal)}`)); } catch { /* ignore */ }
  };
  if (signal.aborted) { fire(); return () => {}; }
  const watcher = () => fire();
  try { signal.addEventListener('abort', watcher, { once: true }); } catch { return () => {}; }
  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    try { signal.removeEventListener('abort', watcher); } catch { /* ignore */ }
  };
}

function _abortReason(signal) {
  try {
    const r = signal && signal.reason;
    if (r === undefined || r === null) return 'signal aborted';
    return typeof r === 'string' ? r : (r && r.message) ? r.message : String(r);
  } catch { return 'signal aborted'; }
}

function isTransientTransportMessage(message = '') {
  return /reconnecting|channel closed|failed to record rollout items|transport issue during rollout recording/i.test(String(message || ''));
}

function resolveToolIdleTimeoutMs(tool = {}, options = {}) {
  const explicitIdleTimeout = parseInt(String(options.idleTimeoutMs ?? ''), 10);
  const explicitTimeout = parseInt(String(options.timeoutMs ?? ''), 10);
  const toolEnvKey = `GATEWAY_${String(tool.cmd || '').trim().toUpperCase()}_IDLE_TIMEOUT_MS`;
  const envIdleTimeout = parseInt(
    process.env[toolEnvKey]
    || process.env.GATEWAY_CLI_TOOL_IDLE_TIMEOUT_MS
    || process.env.KHY_CLI_TOOL_IDLE_TIMEOUT_MS
    || '',
    10
  );
  const minIdleTimeoutMs = Math.max(
    60000,
    parseInt(process.env.GATEWAY_CLI_TOOL_MIN_IDLE_TIMEOUT_MS || '180000', 10) || 180000
  );

  let idleTimeoutMs = explicitIdleTimeout;
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) idleTimeoutMs = envIdleTimeout;
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) idleTimeoutMs = explicitTimeout;
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;

  return Math.max(minIdleTimeoutMs, idleTimeoutMs);
}

function resolveAggregateErrorType(attempts = []) {
  const failed = Array.isArray(attempts) ? attempts.filter(a => a && a.success === false) : [];
  if (failed.length === 0) return 'unavailable';

  const lastMsg = String(failed[failed.length - 1].error || '');
  const lastType = classifyAdapterError(lastMsg);
  if (lastType && lastType !== 'unknown') return lastType;

  for (let i = failed.length - 1; i >= 0; i -= 1) {
    const t = classifyAdapterError(failed[i].error || '');
    if (t && t !== 'unknown') return t;
  }
  return 'unavailable';
}

/**
 * Check if a command exists on the system PATH.
 *
 * Delegates to the shared TTL availability cache so repeated detection (the
 * preflight + getStatus + periodic re-detect passes each call `detect(true)`)
 * coalesces into at most one synchronous `<cmd> --version` spawn per window,
 * instead of freezing the event loop with a back-to-back spawnSync storm.
 */
function commandExists(cmd) {
  return require('./_commandAvailability').isAvailable(cmd);
}

/**
 * Resolve the effective executable for a tool. For every tool except opencode
 * this is byte-for-byte `tool.cmd` (unchanged behavior). For opencode it routes
 * through opencodeBinResolver, which honors KHY_OPENCODE_BIN and the portable
 * install convention (`<repo>/tools/opencode-portable/.../bin/opencode(.exe)`)
 * so a non-PATH portable install is still found — instead of failing detection
 * and sending the AI hunting the wrong directories. Gate KHY_OPENCODE_BIN_DISCOVERY
 * (default on) off → resolver returns the bare 'opencode' (legacy PATH-only).
 */
function _effectiveCmd(tool) {
  if (!tool || tool.cmd !== 'opencode') return tool && tool.cmd;
  try { return require('./opencodeBinResolver').resolveOpencodeBin(process.env); }
  catch { return tool.cmd; }
}

/**
 * Whether a tool's optional env gate is open. Tools without a `gate` are always
 * eligible (unchanged behavior for claude/codex/aider); gated tools (opencode)
 * are skipped entirely — not probed, not offered — when their gate reads off.
 */
function _toolGateOpen(tool) {
  if (!tool || typeof tool.gate !== 'function') return true;
  try { return !!tool.gate(process.env); } catch { return true; }
}

/**
 * Detect which CLI tools are available.
 * Returns boolean; caches the tool list internally.
 */
function detect(forceRefresh = false) {
  if (_detected !== null && !forceRefresh) return _detected.length > 0;

  _detected = TOOLS
    .filter(tool => _toolGateOpen(tool))
    .filter(tool => commandExists(_effectiveCmd(tool)))
    .sort((a, b) => a.priority - b.priority);

  return _detected.length > 0;
}

/**
 * Async detection. Probes every candidate CLI concurrently via execFile (not
 * spawnSync) so the gateway's parallel init never freezes the event loop on a
 * back-to-back `<cmd> --version` storm — the startup-stall ("press Enter, wait
 * tens of seconds before the workspace responds") this avoids. Outcome and tool
 * ordering are identical to detect(); only the probe mechanism is async.
 */
async function detectAsync(forceRefresh = false) {
  if (_detected !== null && !forceRefresh) return _detected.length > 0;

  const availability = require('./_commandAvailability');
  const gated = TOOLS.filter(tool => _toolGateOpen(tool));
  const probed = await Promise.all(
    gated.map(async (tool) => ({
      tool,
      ok: await availability.isAvailableAsync(_effectiveCmd(tool), { force: forceRefresh }),
    })),
  );
  _detected = probed
    .filter(({ ok }) => ok)
    .map(({ tool }) => tool)
    .sort((a, b) => a.priority - b.priority);

  return _detected.length > 0;
}

/**
 * Get the list of detected tools (for status display).
 */
function getDetectedTools() {
  if (_detected === null) detect();
  return _detected;
}

/**
 * Invoke a streaming CLI tool (Claude Code) and emit chunks via callback.
 *
 * The onChunk callback receives objects like:
 *   { type: 'thinking', text: '...' }
 *   { type: 'text', text: '...' }
 *   { type: 'cost', cost: 0.05 }
 */
function invokeStreamingTool(tool, prompt, onChunk, options = {}) {
  return new Promise((resolve, reject) => {
    try { onChunk({ type: 'status', text: `Launching ${tool.name}...` }); } catch { /* best effort */ }
    const args = tool.buildArgs();
    const child = spawn(_effectiveCmd(tool), args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    const idleTimeoutMs = resolveToolIdleTimeoutMs(tool, options);

    let finished = false;
    let idleTimer = null;
    let lastActivityAt = Date.now();
    let killedByIdleTimeout = false;
    const clearIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };
    const scheduleIdleTimeout = () => {
      if (finished || killedByIdleTimeout) return;
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        if (finished || killedByIdleTimeout) return;
        const idleMs = Date.now() - lastActivityAt;
        killedByIdleTimeout = true;
        try {
          onChunk({
            type: 'status',
            text: `${tool.name} 流输出空闲 ${Math.round(idleMs / 1000)}s，正在终止子进程`,
          });
        } catch { /* best effort */ }
        try { safeKill(child, 'SIGTERM', 1200); } catch { /* ignore */ }
      }, idleTimeoutMs);
      idleTimer.unref?.();
    };
    const touchActivity = () => {
      lastActivityAt = Date.now();
      scheduleIdleTimeout();
    };
    let _detachAbort = () => {};
    const done = (err, value) => {
      if (finished) return;
      finished = true;
      clearIdleTimer();
      _detachAbort();
      if (err) reject(err);
      else resolve(value);
    };

    // abort→kill(root cause B):UI 的 Esc/Ctrl-C 传下来的 abortSignal 一触发即 SIGKILL 子进程,
    // 不必等 ≥180s idle-timeout。门关/无 signal → _detachAbort 保持 no-op,逐字节回退。
    _detachAbort = _wireChildAbort(child, options.abortSignal, (abortErr) => done(abortErr));

    let fullContent = '';
    let buffer = '';
    // 跨 chunk 边界安全的 UTF-8 解码器:防 stream-json 里的中文/emoji 被劈成 U+FFFD(◆)。见 _sseTextDecoder.js。
    const _textDecoder = require('./_sseTextDecoder').createSseTextDecoder();
    let claudeApiKeySourceNone = false;
    let claudeRetryCount = 0;
    const parserState = { blocks: new Map(), sawStreamEvent: false, sawAssistantText: false }; // idx -> { type, name, id, inputRaw }
    scheduleIdleTimeout();

    child.stdout.on('data', (chunk) => {
      touchActivity();
      buffer += _textDecoder.write(chunk);

      // Process complete JSON lines
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete last line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'system' && event.subtype === 'init' && String(event.apiKeySource || '').toLowerCase() === 'none') {
            claudeApiKeySourceNone = true;
          }
          if (event.type === 'system' && event.subtype === 'api_retry' && claudeApiKeySourceNone) {
            claudeRetryCount += 1;
            if (claudeRetryCount >= 3) {
              try { safeKill(child, 'SIGKILL', 0); } catch { /* ignore */ }
              done(new Error('claude auth unavailable (apiKeySource:none)'));
              return;
            }
          }
          processStreamEvent(event, onChunk, (text) => { fullContent += text; }, parserState);
        } catch {
          // not valid JSON, ignore
        }
      }
    });

    let stderr = '';
    let stderrBytes = 0;
    // CLI tools (e.g. Claude Code >= 2.x) may output stream-json events to stderr
    // instead of stdout. Parse JSON from stderr the same way as stdout.
    let stderrJsonBuffer = '';
    child.stderr.on('data', (chunk) => {
      touchActivity();
      const raw = chunk.toString();
      stderrJsonBuffer += raw;
      const stderrLines = stderrJsonBuffer.split('\n');
      stderrJsonBuffer = stderrLines.pop();
      for (const line of stderrLines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('{')) {
          try {
            const event = JSON.parse(trimmed);
            if (event && typeof event.type === 'string') {
              if (event.type === 'system' && event.subtype === 'init' && String(event.apiKeySource || '').toLowerCase() === 'none') {
                claudeApiKeySourceNone = true;
              }
              if (event.type === 'system' && event.subtype === 'api_retry' && claudeApiKeySourceNone) {
                claudeRetryCount += 1;
                if (claudeRetryCount >= 3) {
                  try { safeKill(child, 'SIGKILL', 0); } catch { /* ignore */ }
                  done(new Error('claude auth unavailable (apiKeySource:none)'));
                  return;
                }
              }
              processStreamEvent(event, onChunk, (text) => { fullContent += text; }, parserState);
              continue;
            }
          } catch { /* not valid JSON, accumulate as plain stderr */ }
        }
        stderrBytes += Buffer.byteLength(trimmed + '\n', 'utf8');
        if (stderrBytes <= MAX_BUFFER) stderr += trimmed + '\n';
      }
    });

    child.on('close', (code) => {
      if (finished) return;
      // Drain trailing stdout buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          processStreamEvent(event, onChunk, (text) => { fullContent += text; }, parserState);
        } catch { /* ignore */ }
      }
      // Drain trailing stderr JSON buffer
      const trailingStderr = stderrJsonBuffer.trim();
      if (trailingStderr && trailingStderr.startsWith('{')) {
        try {
          const event = JSON.parse(trailingStderr);
          if (event && typeof event.type === 'string') {
            processStreamEvent(event, onChunk, (text) => { fullContent += text; }, parserState);
          }
        } catch { /* ignore */ }
      }

      if (killedByIdleTimeout) {
        done(new Error(`${tool.name} idle timeout after ${idleTimeoutMs}ms without stream activity`));
        return;
      }

      if (code === 0 || fullContent.trim()) {
        done(null, fullContent.trim());
      } else {
        try { onChunk({ type: 'status', text: `${tool.name} failed: ${stderr.trim() || `exit ${code}`}` }); } catch {}
        done(new Error(stderr.trim() || `Process exited with code ${code}`));
      }
    });

    child.on('error', (err) => {
      try { onChunk({ type: 'status', text: `${tool.name} process error: ${err.message}` }); } catch {}
      done(err);
    });

    // Pipe prompt via stdin
    if (tool.useStdin) {
      child.stdin.on('error', () => {}); // Ignore EPIPE if child exits early
      child.stdin.write(prompt);
      child.stdin.end();
    }
  });
}

/**
 * Process a single stream-json event from Claude Code.
 */
function processStreamEvent(event, onChunk, appendContent, state = { blocks: new Map(), sawStreamEvent: false, sawAssistantText: false }) {
  const summarizeInput = (input) => {
    if (!input) return '';
    if (typeof input === 'string') return input.slice(0, 120);
    try {
      return Object.entries(input)
        .map(([k, v]) => `${k}=${String(typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 40)}`)
        .join(', ')
        .slice(0, 120);
    } catch { return ''; }
  };
  const parseJsonMaybe = (str) => {
    if (!str || typeof str !== 'string') return null;
    try { return JSON.parse(str); } catch { return null; }
  };
  const summarizeText = (value, maxLen = 220) => {
    const text = typeof value === 'string' ? value : summarizeInput(value);
    if (!text) return '';
    return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
  };

  // Claude SDK-style progress event (stream-json top-level)
  if (event.type === 'tool_progress') {
    onChunk({
      type: 'tool_progress',
      id: event.tool_use_id || event.id || '',
      tool: event.tool_name || event.tool || 'tool',
      status: event.status || event.status_category || '',
      detail: summarizeText(event.status_detail || event.message || event.detail || ''),
      parentId: event.parent_tool_use_id || null,
    });
    return;
  }

  // Claude SDK-style auth status event
  if (event.type === 'auth_status') {
    onChunk({
      type: 'auth_status',
      isAuthenticating: !!event.isAuthenticating,
      output: summarizeText(event.output || ''),
      error: summarizeText(event.error || ''),
    });
    return;
  }

  // Claude SDK-style task lifecycle events (usually under system subtype)
  if (event.type === 'system' && event.subtype &&
      (event.subtype === 'task_started' || event.subtype === 'task_progress' || event.subtype === 'task_notification')) {
    onChunk({
      type: event.subtype,
      taskId: event.task_id || '',
      toolUseId: event.tool_use_id || '',
      status: event.status || '',
      summary: summarizeText(event.summary || event.message || ''),
      outputFile: event.output_file || '',
      usage: event.usage || null,
    });
    return;
  }

  // Newer Claude stream-json wrapper format: { type: "stream_event", event: {...} }
  if (event.type === 'stream_event' && event.event) {
    state.sawStreamEvent = true;
    const ev = event.event;

    if (ev.type === 'tool_progress') {
      onChunk({
        type: 'tool_progress',
        id: ev.tool_use_id || ev.id || '',
        tool: ev.tool_name || ev.tool || 'tool',
        status: ev.status || ev.status_category || '',
        detail: summarizeText(ev.status_detail || ev.message || ev.detail || ''),
        parentId: ev.parent_tool_use_id || null,
      });
      return;
    }

    if (ev.type === 'auth_status') {
      onChunk({
        type: 'auth_status',
        isAuthenticating: !!ev.isAuthenticating,
        output: summarizeText(ev.output || ''),
        error: summarizeText(ev.error || ''),
      });
      return;
    }

    if (ev.type === 'system' && ev.subtype &&
      (ev.subtype === 'task_started' || ev.subtype === 'task_progress' || ev.subtype === 'task_notification')) {
      onChunk({
        type: ev.subtype,
        taskId: ev.task_id || '',
        toolUseId: ev.tool_use_id || '',
        status: ev.status || '',
        summary: summarizeText(ev.summary || ev.message || ''),
        outputFile: ev.output_file || '',
        usage: ev.usage || null,
      });
      return;
    }

    if (ev.type === 'system' && ev.subtype === 'session_state_changed') {
      const stateText = ev.state || ev.session_state || '';
      if (stateText) onChunk({ type: 'status', text: `Session state: ${stateText}` });
      return;
    }

    if (ev.type === 'content_block_start') {
      const idx = Number(ev.index);
      const block = ev.content_block || {};
      state.blocks.set(idx, {
        type: block.type || '',
        name: block.name || '',
        id: block.id || '',
        inputRaw: '',
      });

      if (block.type === 'thinking' && block.thinking) {
        onChunk({ type: 'thinking', text: block.thinking });
      } else if (block.type === 'text' && block.text) {
        onChunk({ type: 'text', text: block.text });
        appendContent(block.text);
        state.sawAssistantText = true;
      } else if (block.type === 'tool_use') {
        const toolName = block.name || 'unknown';
        const inputSummary = summarizeInput(block.input);
        onChunk({ type: 'tool_use', tool: toolName, input: inputSummary, rawInput: block.input, id: block.id });
      } else if (block.type === 'tool_result') {
        const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
        onChunk({ type: 'tool_result', id: block.tool_use_id || '', content: content.slice(0, 200) });
      }
      return;
    }

    if (ev.type === 'content_block_delta') {
      const idx = Number(ev.index);
      const delta = ev.delta || {};
      if (delta.type === 'thinking_delta' && delta.thinking) {
        onChunk({ type: 'thinking', text: delta.thinking });
      } else if (delta.type === 'text_delta' && delta.text) {
        onChunk({ type: 'text', text: delta.text });
        appendContent(delta.text);
        state.sawAssistantText = true;
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const blk = state.blocks.get(idx);
        if (blk) blk.inputRaw += delta.partial_json;
      }
      return;
    }

    if (ev.type === 'content_block_stop') {
      const idx = Number(ev.index);
      const blk = state.blocks.get(idx);
      if (blk && blk.type === 'tool_use') {
        const parsed = parseJsonMaybe(blk.inputRaw);
        const summary = summarizeInput(parsed) || summarizeInput(blk.inputRaw);
        // Re-surface the COMPLETED tool_use with the full accumulated input so
        // downstream collectors receive the real arguments (the start emission
        // had empty input). Without this the structured args were dropped and
        // shell calls reached the gateway with an empty command → L2 critical.
        if (
          _cliToolUseStopInputEnabled() &&
          parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
          Object.keys(parsed).length > 0
        ) {
          onChunk({
            type: 'tool_use',
            tool: blk.name || 'unknown',
            input: summary || '',
            rawInput: parsed,
            id: blk.id || '',
          });
        } else if (summary) {
          onChunk({ type: 'tool_result', id: blk.id || '', content: `参数: ${summary}` });
        }
      }
      state.blocks.delete(idx);
      return;
    }

    if (ev.type === 'message_delta' && ev.usage && typeof ev.usage.output_tokens === 'number') {
      onChunk({ type: 'cost', cost: ev.usage.output_tokens });
      return;
    }
  }

  // Some Claude CLI versions emit both stream_event and legacy assistant/user
  // payloads for the same output turn. Skip legacy payload once stream_event
  // has been observed to prevent duplicated response text.
  if (state.sawStreamEvent && (event.type === 'assistant' || event.type === 'user')) {
    return;
  }

  // Surface retry/system signals so UI doesn't appear stalled.
  if (event.type === 'system' && event.subtype) {
    if (event.subtype === 'api_retry') {
      const attempt = event.attempt || '?';
      const max = event.max_retries || '?';
      const reason = event.error || 'unknown';
      onChunk({ type: 'status', text: `Claude API retry ${attempt}/${max} (${reason})` });
      return;
    }
    if (event.subtype === 'error') {
      onChunk({ type: 'status', text: `Claude system error: ${event.error || 'unknown'}` });
      return;
    }
    if (event.subtype === 'session_state_changed') {
      const stateText = event.state || event.session_state || '';
      if (stateText) {
        onChunk({ type: 'status', text: `Session state: ${stateText}` });
      }
      return;
    }
  }

  // Handle top-level tool events emitted by some Claude CLI versions
  if (event.type === 'tool_use' || event.type === 'tool_call') {
    const toolName = event.name || event.tool || event.tool_name || 'unknown';
    const inputSummary = summarizeInput(event.input || event.arguments || event.params || {});
    onChunk({
      type: 'tool_use',
      tool: toolName,
      input: inputSummary,
      rawInput: event.input || event.arguments || event.params || {},
      id: event.id || '',
    });
    return;
  }
  if (event.type === 'tool_result') {
    const content = typeof event.content === 'string'
      ? event.content
      : JSON.stringify(event.content || event.result || '');
    onChunk({ type: 'tool_result', id: event.tool_use_id || event.id || '', content: content.slice(0, 200), isError: event.is_error });
    return;
  }

  // Handle assistant messages (thinking, text, tool_use)
  if (event.type === 'assistant' && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === 'thinking' && block.thinking) {
        onChunk({ type: 'thinking', text: block.thinking });
      } else if (block.type === 'text' && block.text) {
        onChunk({ type: 'text', text: block.text });
        appendContent(block.text);
        state.sawAssistantText = true;
      } else if (block.type === 'tool_use') {
        // Claude CLI is executing a tool internally — surface to UI
        const toolName = block.name || 'unknown';
        const inputSummary = summarizeInput(block.input);
        onChunk({ type: 'tool_use', tool: toolName, input: inputSummary, rawInput: block.input, id: block.id });
      }
    }
  // Handle user messages containing tool_result
  } else if (event.type === 'user' && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === 'tool_result') {
        const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
        onChunk({ type: 'tool_result', id: block.tool_use_id, content: content.slice(0, 200), isError: block.is_error });
      }
    }
  } else if (event.type === 'result') {
    if (event.total_cost_usd) {
      onChunk({ type: 'cost', cost: event.total_cost_usd });
    }
    // Some variants only emit final text in result.result.
    if (!state.sawAssistantText && typeof event.result === 'string' && event.result.trim()) {
      onChunk({ type: 'text', text: event.result });
      appendContent(event.result);
      state.sawAssistantText = true;
    }
  }
}

/**
 * Invoke a non-streaming CLI tool (Codex, Aider).
 */
function invokeToolAsync(tool, prompt, options = {}) {
  return new Promise((resolve, reject) => {
    const onChunk = typeof options.onChunk === 'function' ? options.onChunk : () => {};
    let args;
    if (tool.useStdin) {
      args = tool.buildArgs();
    } else {
      args = tool.buildArgs().map(a => a === '__PROMPT__' ? prompt : a);
    }
    // Generalized model injection (was codex-only): a tool may declare
    // applyModel(args, model) to control how its model flag is formed (opencode
    // uses `-m provider/model`, only for provider/model-shaped ids). Tools
    // without the hook keep the legacy codex `--model <model>` behavior
    // byte-for-byte; non-codex hookless tools (aider) get no model flag.
    if (options.model) {
      if (typeof tool.applyModel === 'function') {
        try {
          const injected = tool.applyModel(args.slice(), options.model);
          if (Array.isArray(injected)) args = injected;
        } catch { /* keep args on hook failure */ }
      } else if (tool.cmd === 'codex') {
        args.push('--model', options.model);
      }
    }

    const child = spawn(_effectiveCmd(tool), args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    const idleTimeoutMs = resolveToolIdleTimeoutMs(tool, options);

    let stdout = '';
    let stderr = '';
    let totalBytes = 0;
    let finished = false;
    let idleTimer = null;
    let killedByIdleTimeout = false;
    let lastActivityAt = Date.now();
    let sawTransientTransportWarning = false;
    let lastTransientTransportMessage = '';
    const clearIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };
    const scheduleIdleTimeout = () => {
      if (finished || killedByIdleTimeout) return;
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        if (finished || killedByIdleTimeout) return;
        const idleMs = Date.now() - lastActivityAt;
        killedByIdleTimeout = true;
        try {
          onChunk({
            type: 'status',
            text: `${tool.name} 子进程空闲 ${Math.round(idleMs / 1000)}s，正在终止执行`,
          });
        } catch { /* best effort */ }
        try { safeKill(child, 'SIGTERM', 1200); } catch { /* ignore */ }
      }, idleTimeoutMs);
      idleTimer.unref?.();
    };
    const touchActivity = () => {
      lastActivityAt = Date.now();
      scheduleIdleTimeout();
    };
    let _detachAbort = () => {};
    const done = (err, value) => {
      if (finished) return;
      finished = true;
      clearIdleTimer();
      _detachAbort();
      if (err) reject(err);
      else resolve(value);
    };
    // abort→kill(root cause B):同 invokeStreamingTool,abortSignal 触发即 SIGKILL 子进程。
    // 门关/无 signal → _detachAbort 保持 no-op,逐字节回退今日仅 idle 兜底行为。
    _detachAbort = _wireChildAbort(child, options.abortSignal, (abortErr) => done(abortErr));
    scheduleIdleTimeout();

    child.stdout.on('data', (chunk) => {
      touchActivity();
      totalBytes += chunk.length;
      if (totalBytes <= MAX_BUFFER) stdout += chunk;
      if (tool.cmd === 'codex') {
        const s = chunk.toString();
        if (isTransientTransportMessage(s)) {
          sawTransientTransportWarning = true;
          lastTransientTransportMessage = s.trim() || 'codex transport issue during rollout recording';
          try {
            onChunk({
              type: 'status',
              text: `Codex 通道抖动，等待自动恢复：${lastTransientTransportMessage.slice(0, 160)}`,
            });
          } catch { /* best effort */ }
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      touchActivity();
      stderr += chunk;
      if (tool.cmd === 'codex') {
        const s = chunk.toString();
        if (isTransientTransportMessage(s)) {
          sawTransientTransportWarning = true;
          lastTransientTransportMessage = s.trim() || 'codex transport issue during rollout recording';
          try {
            onChunk({
              type: 'status',
              text: `Codex 通道抖动，等待自动恢复：${lastTransientTransportMessage.slice(0, 160)}`,
            });
          } catch { /* best effort */ }
        }
      }
    });

    child.on('close', (code) => {
      if (finished) return;
      if (killedByIdleTimeout) {
        done(new Error(`${tool.name} idle timeout after ${idleTimeoutMs}ms without subprocess output`));
        return;
      }
      if (!stderr.trim() && sawTransientTransportWarning && lastTransientTransportMessage) {
        stderr = lastTransientTransportMessage;
      }
      if (code === 0 && stdout.trim()) {
        done(null, stdout.trim());
      } else {
        done(new Error(stderr.trim() || `Process exited with code ${code}`));
      }
    });

    child.on('error', (err) => done(err));

    if (tool.useStdin) {
      child.stdin.on('error', () => {});
      child.stdin.write(prompt);
      child.stdin.end();
    }
  });
}

// ── Image bridging ──────────────────────────────────────────────────────
// CLI tools (Claude Code et al.) read a flat text prompt via stdin/args and
// cannot receive inline base64 the way API adapters do. So when the gateway
// passes options.images (dataUrl strings), we materialize each to a temp file
// and reference the absolute paths in the prompt. Claude Code (Read tool + vision,
// running with bypassPermissions here) then reads and analyzes them. Without
// this the image is silently dropped and the model truthfully replies "no image
// received" even though the user uploaded one.

const _IMG_EXT_BY_MIME = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/webp': '.webp',
  'image/gif': '.gif', 'image/bmp': '.bmp', 'image/svg+xml': '.svg', 'image/tiff': '.tif',
};

// Decode one image entry (dataUrl string, raw base64, or {data,mediaType}) to a
// Buffer + extension. Returns null when the entry cannot be parsed.
function _decodeImageEntry(entry) {
  try {
    let mime = '';
    let b64 = '';
    if (entry && typeof entry === 'object') {
      b64 = String(entry.data || entry.base64 || '');
      mime = String(entry.mediaType || entry.mimeType || '');
    } else if (typeof entry === 'string') {
      const m = entry.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/s);
      if (m) { mime = m[1] || ''; b64 = m[2] || ''; }
      else { b64 = entry; } // assume bare base64
    }
    b64 = b64.replace(/\s+/g, '');
    if (!b64) return null;
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) return null;
    const ext = _IMG_EXT_BY_MIME[String(mime).toLowerCase()] || '.png';
    return { buf, ext };
  } catch { return null; }
}

// Write images to a unique temp dir. Returns { paths, dir } or null when nothing
// could be materialized. Caller must clean up via _cleanupImageDir(dir).
function _materializeImages(images) {
  if (!Array.isArray(images) || images.length === 0) return null;
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-cli-img-'));
  } catch { return null; }
  const paths = [];
  for (let i = 0; i < images.length; i += 1) {
    const decoded = _decodeImageEntry(images[i]);
    if (!decoded) continue;
    const file = path.join(dir, `image-${i + 1}-${crypto.randomBytes(4).toString('hex')}${decoded.ext}`);
    try {
      fs.writeFileSync(file, decoded.buf);
      paths.push(file);
    } catch { /* skip unwritable entry */ }
  }
  if (paths.length === 0) {
    _cleanupImageDir(dir);
    return null;
  }
  return { paths, dir };
}

function _cleanupImageDir(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// Build the prompt block that points the CLI tool at the materialized images.
function _buildImagePromptBlock(paths) {
  const list = paths.map(p => `- ${p}`).join('\n');
  return `【图片附件】用户上传了 ${paths.length} 张图片，已保存到本地路径如下。`
    + `请使用 Read 工具读取这些文件并结合用户的问题进行视觉分析（不要回答“未收到图片”）：\n${list}`;
}

/**
 * Generate a response using the best available CLI tool.
 * Tries each detected tool in priority order.
 *
 * @param {string} prompt
 * @param {object} options
 * @param {function} [options.onChunk] - streaming callback for real-time output
 */
async function generate(prompt, options = {}) {
  const detectedTools = getDetectedTools();

  // Targeted invocation: when the caller names a specific CLI tool (e.g. the
  // dedicated opencodeAdapter passes cliTool:'opencode'), restrict to that one
  // tool instead of the priority-ordered fallback sweep — this is what lets
  // khyos *command* a specific external editor rather than merely fall back to
  // it. Match by cmd or display name (case-insensitive).
  const target = String(options.cliTool || options.tool || '').trim().toLowerCase();
  let tools = detectedTools;
  if (target) {
    tools = detectedTools.filter(
      t => t.cmd.toLowerCase() === target || t.name.toLowerCase() === target,
    );
    if (tools.length === 0) {
      return buildFailure(`cli tool '${target}' not detected`, {
        adapter: 'cli', errorType: 'unavailable',
      });
    }
  }

  if (tools.length === 0) {
    return buildFailure('no cli tools detected', { adapter: 'cli', errorType: 'unavailable' });
  }

  const attempts = [];
  const onChunk = options.onChunk || (() => {});

  // CLI tools receive only a flat text prompt via stdin/args. Extract critical
  // behavioral directives from the system prompt so they survive the bridge.
  let effectivePrompt = prompt;
  const _cliSystem = String(options.system || '').trim();
  if (_cliSystem) {
    const _lwMatch = _cliSystem.match(/# 轻量对话[^\n]*\n[\s\S]*?(?=\n#\s|\n\n#|$)/);
    const _langMatch = _cliSystem.match(/# Language\n[^\n]+(?:\n[^\n#]+)*/);
    const _directives = [_lwMatch && _lwMatch[0], _langMatch && _langMatch[0]].filter(Boolean).join('\n\n');
    if (_directives) effectivePrompt = _directives + '\n\n' + effectivePrompt;
  }

  // Bridge inline images to disk so vision-capable CLI tools (those declaring
  // `supportsImageFiles`, e.g. Claude Code with its Read tool) can analyze them.
  // Tools without file-vision (Codex/Aider) must NOT receive the "Read these
  // files" directive — it would only mislead a tool that cannot act on it.
  // Materialize once; append the block per-tool inside the loop below.
  // Cleaned up in the finally.
  const _imageMaterial = _materializeImages(options.images);
  const _imageBlock = _imageMaterial ? _buildImagePromptBlock(_imageMaterial.paths) : '';

  try {
    for (let idx = 0; idx < tools.length; idx += 1) {
    const tool = tools[idx];
    if (idx > 0) {
      const previous = attempts[idx - 1];
      const previousName = previous && previous.provider ? previous.provider : '上一通道';
      try {
        onChunk({ type: 'status', text: `CLI 工具桥接重试中：${previousName} 失败，切换到 ${tool.name}...` });
      } catch { /* best effort */ }
    }
    try {
      if (!tool.streaming) {
        try { onChunk({ type: 'status', text: `Launching ${tool.name}...` }); } catch { /* best effort */ }
      }
      // Only vision-capable tools get the image-path block appended.
      const toolPrompt = (_imageBlock && tool.supportsImageFiles)
        ? `${effectivePrompt}\n\n${_imageBlock}`
        : effectivePrompt;
      let content;
      if (tool.streaming) {
        content = await invokeStreamingTool(tool, toolPrompt, onChunk, options);
      } else {
        content = await invokeToolAsync(tool, toolPrompt, { ...options, onChunk });
      }
      attempts.push({ provider: tool.name, success: true });
      return buildSuccess(content, {
        adapter: 'cli',
        provider: tool.name,
        attempts,
      });
    } catch (err) {
      const errMsg = String(err && err.message ? err.message : err || 'unknown error');
      attempts.push({ provider: tool.name, success: false, error: errMsg });
      if (!tool.streaming) {
        try { onChunk({ type: 'status', text: `${tool.name} failed: ${errMsg}` }); } catch { /* best effort */ }
      }
    }
  }

    const lastErr = attempts.length > 0 ? attempts[attempts.length - 1].error : '';
    const errorType = resolveAggregateErrorType(attempts);
    return buildFailure(lastErr || 'all cli tools failed', {
      adapter: 'cli',
      errorType,
      attempts,
    });
  } finally {
    if (_imageMaterial) _cleanupImageDir(_imageMaterial.dir);
  }
}

/**
 * Get adapter status for display.
 */
function getStatus() {
  detect(); // ensure detection has run
  const tools = getDetectedTools();
  return {
    name: 'CLI 工具桥接',
    type: 'cli',
    available: tools.length > 0,
    detail: tools.length > 0
      ? tools.map(t => t.name).join(', ')
      : '未检测到 (claude/codex/aider/opencode)',
  };
}

function destroy() {
  _detected = null;
}

module.exports = {
  detect,
  detectAsync,
  generate,
  getStatus,
  destroy,
  TOOLS,
  __test__: {
    classifyAdapterError,
    resolveToolIdleTimeoutMs,
    isTransientTransportMessage,
    _decodeImageEntry,
    _materializeImages,
    _cleanupImageDir,
    _buildImagePromptBlock,
    processStreamEvent,
    _cliToolUseStopInputEnabled,
    _wireChildAbort,
    _isCliToolAbortEnabled,
  },
};
