'use strict';

const { spawn } = require('child_process');
const { safeKill } = require('../../tools/platformUtils');
const crypto = require('crypto');

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_CONNECT_TIMEOUT_SEC = 8;
const MAX_PREVIEW_CHARS = 8_000;
const MAX_EVENT_COUNT = 120;
const IDEMPOTENCY_TTL_MS = 6 * 60 * 60 * 1000;

// 收敛到 utils/envFlagByName 单一真源(逐字节委托,调用点不变)
const _envFlag = require('../../utils/envFlagByName');

function _getIdleTimeoutMs() {
  const parsed = Number.parseInt(process.env.KHY_REMOTE_SSH_IDLE_TIMEOUT_MS || '', 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_IDLE_TIMEOUT_MS;
}

function _getConnectTimeoutSec() {
  const parsed = Number.parseInt(process.env.KHY_REMOTE_SSH_CONNECT_TIMEOUT_SEC || '', 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_CONNECT_TIMEOUT_SEC;
}

function _shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function _redactSecrets(text) {
  const input = String(text || '');
  return input
    .replace(/(password|passwd|token|secret|api[_-]?key)\s*[:=]\s*([^\s"'`]+)/gi, '$1=***')
    .replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, '[redacted-private-key]');
}

function _trimPreview(text) {
  if (typeof text !== 'string') return '';
  if (text.length <= MAX_PREVIEW_CHARS) return text;
  return `${text.slice(0, MAX_PREVIEW_CHARS)}\n...[truncated]`;
}

function _hashExecutionRequest(connectionId, commands) {
  const hash = crypto.createHash('sha256');
  hash.update(String(connectionId || ''));
  hash.update('\n');
  hash.update(JSON.stringify(commands || []));
  return hash.digest('hex');
}

class RemoteExecService {
  constructor({ connectionManager, approvalBridge }) {
    this._connectionManager = connectionManager;
    this._approvalBridge = approvalBridge;
    this._idempotentResults = new Map();
    this._idempotentRunning = new Map();
  }

  _emitEvent(onEvent, event) {
    if (typeof onEvent !== 'function' || !event) return;
    try {
      onEvent({ ...event });
    } catch {
      /* ignore callback failures */
    }
  }

  _buildEvent(session, traceId, sequence, kind, severity, payload = {}) {
    return {
      trace_id: traceId || session.traceId || null,
      connection_id: session.connectionId,
      host_alias: session.hostAlias,
      remote_user: session.remoteUser,
      remote_workspace: session.remoteWorkspace,
      sequence,
      ts: new Date().toISOString(),
      kind,
      severity,
      redaction_applied: true,
      ...payload,
    };
  }

  _assertSession(connectionId) {
    const session = this._connectionManager.getSession(connectionId);
    if (!session) {
      const error = new Error(`Remote session not found for connection_id=${connectionId}`);
      error.code = 'session_not_found';
      throw error;
    }
    return session;
  }

  _normalizeCommands(commands) {
    if (!Array.isArray(commands)) return [];
    return commands
      .map((command) => String(command || '').trim())
      .filter(Boolean);
  }

  _buildIdempotencyStoreKey(connectionId, idempotencyKey) {
    return `${connectionId}::${idempotencyKey}`;
  }

  _cleanupExpiredIdempotentResults() {
    const now = Date.now();
    for (const [key, record] of this._idempotentResults.entries()) {
      if ((now - record.createdAtMs) > IDEMPOTENCY_TTL_MS) {
        this._idempotentResults.delete(key);
      }
    }
  }

  _buildExecDisabledResult({ session, traceId, evaluation, idempotencyKey }) {
    return {
      trace_id: traceId || session.traceId || null,
      connection_id: session.connectionId,
      status: 'execution_disabled',
      message: 'Remote side-effect execution is disabled in this scaffold. Set KHY_REMOTE_SSH_ENABLE_EXEC=true to enable execution.',
      dry_run: false,
      redaction_applied: true,
      risk_summary: {
        highest_risk: evaluation.highestRisk,
        reason: evaluation.highestReason,
      },
      idempotency_key: idempotencyKey,
    };
  }

  _buildRemoteShellCommand(workspace, command) {
    const workspacePart = `cd ${_shellSingleQuote(workspace)}`;
    return `${workspacePart} && ${command}`;
  }

  async _runSingleRemoteCommand({ session, command, step, traceId, onEvent, getNextSequence }) {
    const idleTimeoutMs = _getIdleTimeoutMs();
    const connectTimeoutSec = _getConnectTimeoutSec();
    const remoteCommand = this._buildRemoteShellCommand(session.remoteWorkspace || '~', command);
    const sshArgs = [
      '-o',
      'BatchMode=yes',
      '-o',
      `ConnectTimeout=${connectTimeoutSec}`,
      session.hostAlias,
      `bash -lc ${_shellSingleQuote(remoteCommand)}`,
    ];

    const events = [];
    let localSequence = 1;
    const startedAt = Date.now();
    let lastActivityMs = Date.now();
    let stdoutBuf = '';
    let stderrBuf = '';
    let finished = false;

    const nextSequence = () => {
      if (typeof getNextSequence === 'function') return getNextSequence();
      return localSequence++;
    };

    const pushEvent = (kind, severity, payload) => {
      if (events.length >= MAX_EVENT_COUNT) return;
      const event = this._buildEvent(session, traceId, nextSequence(), kind, severity, payload);
      events.push(event);
      this._emitEvent(onEvent, event);
    };

    pushEvent('remote_exec_step', 'info', {
      step,
      status: 'start',
      command_preview: command.slice(0, 200),
    });

    const child = spawn('ssh', sshArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    const onStdout = (chunk) => {
      const redacted = _redactSecrets(String(chunk || ''));
      stdoutBuf += redacted;
      if (stdoutBuf.length > MAX_PREVIEW_CHARS * 2) {
        stdoutBuf = stdoutBuf.slice(-MAX_PREVIEW_CHARS * 2);
      }
      lastActivityMs = Date.now();
      pushEvent('remote_exec_stdout', 'info', {
        step,
        chunk_preview: _trimPreview(redacted),
      });
    };

    const onStderr = (chunk) => {
      const redacted = _redactSecrets(String(chunk || ''));
      stderrBuf += redacted;
      if (stderrBuf.length > MAX_PREVIEW_CHARS * 2) {
        stderrBuf = stderrBuf.slice(-MAX_PREVIEW_CHARS * 2);
      }
      lastActivityMs = Date.now();
      pushEvent('remote_exec_stderr', 'warn', {
        step,
        chunk_preview: _trimPreview(redacted),
      });
    };

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);

    let idleCheckTimer;
    const idlePromise = new Promise((_, reject) => {
      idleCheckTimer = setInterval(() => {
        if (finished) return;
        const idleMs = Date.now() - lastActivityMs;
        if (idleMs > idleTimeoutMs) {
          try { safeKill(child); } catch { /* ignore */ }
          const err = new Error(`Remote exec idle timeout: no output for ${idleMs}ms while running step ${step}.`);
          err.code = 'remote_exec_idle_timeout';
          reject(err);
        }
      }, 1000);
      if (idleCheckTimer && idleCheckTimer.unref) idleCheckTimer.unref();
    });

    const exitPromise = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });

    try {
      const exitState = await Promise.race([exitPromise, idlePromise]);
      finished = true;
      if (idleCheckTimer) clearInterval(idleCheckTimer);

      const elapsedMs = Date.now() - startedAt;
      const ok = exitState.code === 0;
      pushEvent('remote_exec_step', ok ? 'ok' : 'error', {
        step,
        status: ok ? 'ok' : 'failed',
        exit_code: exitState.code,
        signal: exitState.signal || null,
        elapsed_ms: elapsedMs,
      });

      return {
        ok,
        step,
        command,
        exit_code: exitState.code,
        signal: exitState.signal || null,
        elapsed_ms: elapsedMs,
        stdout_preview: _trimPreview(stdoutBuf),
        stderr_preview: _trimPreview(stderrBuf),
        events,
      };
    } catch (error) {
      finished = true;
      if (idleCheckTimer) clearInterval(idleCheckTimer);

      const elapsedMs = Date.now() - startedAt;
      pushEvent('remote_exec_step', 'error', {
        step,
        status: 'error',
        error: _redactSecrets(error.message || String(error)),
        elapsed_ms: elapsedMs,
      });

      return {
        ok: false,
        step,
        command,
        exit_code: null,
        signal: null,
        elapsed_ms: elapsedMs,
        error: _redactSecrets(error.message || String(error)),
        stdout_preview: _trimPreview(stdoutBuf),
        stderr_preview: _trimPreview(stderrBuf),
        events,
      };
    }
  }

  async _executeCommands({ session, commands, traceId, onEvent }) {
    const steps = [];
    const events = [];
    let sequence = 1;
    const nextSequence = () => sequence++;

    const pushEvent = (kind, severity, payload) => {
      if (events.length >= MAX_EVENT_COUNT) return;
      const event = this._buildEvent(session, traceId, nextSequence(), kind, severity, payload);
      events.push(event);
      this._emitEvent(onEvent, event);
    };

    pushEvent('remote_exec_summary', 'info', {
      status: 'running',
      total_steps: commands.length,
      executed_steps: 0,
      failed_steps: 0,
    });

    for (let idx = 0; idx < commands.length; idx++) {
      const result = await this._runSingleRemoteCommand({
        session,
        command: commands[idx],
        step: idx + 1,
        traceId,
        onEvent,
        getNextSequence: nextSequence,
      });

      steps.push({
        step: result.step,
        command: result.command,
        ok: result.ok,
        exit_code: result.exit_code,
        signal: result.signal,
        elapsed_ms: result.elapsed_ms,
        error: result.error || null,
        stdout_preview: result.stdout_preview,
        stderr_preview: result.stderr_preview,
      });

      events.push(...result.events);
      if (!result.ok) {
        break;
      }
    }

    const allOk = steps.every((item) => item.ok);
    const summary = {
      total_steps: commands.length,
      executed_steps: steps.length,
      succeeded_steps: steps.filter((item) => item.ok).length,
      failed_steps: steps.filter((item) => !item.ok).length,
    };
    pushEvent('remote_exec_summary', allOk ? 'ok' : 'error', {
      status: allOk ? 'completed' : 'failed',
      ...summary,
    });

    return {
      status: allOk ? 'completed' : 'failed',
      steps,
      events: events.slice(0, MAX_EVENT_COUNT),
      summary,
      redaction_applied: true,
    };
  }

  planDryRun({ connectionId, commands, traceId, riskContext = null }) {
    const session = this._assertSession(connectionId);
    const normalizedCommands = this._normalizeCommands(commands);
    const evaluation = this._approvalBridge.evaluateCommands(normalizedCommands);
    const nowIso = new Date().toISOString();

    return {
      trace_id: traceId || session.traceId || null,
      connection_id: session.connectionId,
      host_alias: session.hostAlias,
      remote_user: session.remoteUser,
      remote_workspace: session.remoteWorkspace,
      status: 'dry_run',
      dry_run: true,
      risk_summary: {
        highest_risk: evaluation.highestRisk,
        reason: evaluation.highestReason,
        approval_required: evaluation.requiresApproval,
      },
      steps: evaluation.perCommand.map((item, index) => ({
        step: index + 1,
        command: item.command,
        risk: item.risk,
        reason: item.reason,
        will_execute: false,
      })),
      redaction_applied: true,
      ts: nowIso,
      risk_context: riskContext,
    };
  }

  async requestExecution({ connectionId, commands, idempotencyKey, approvalTicketId, traceId, riskContext = null, onEvent = null }) {
    this._cleanupExpiredIdempotentResults();

    const session = this._assertSession(connectionId);
    const normalizedCommands = this._normalizeCommands(commands);
    const evaluation = this._approvalBridge.evaluateCommands(normalizedCommands);

    if (normalizedCommands.length === 0) {
      const result = {
        trace_id: traceId || session.traceId || null,
        connection_id: session.connectionId,
        status: 'invalid_commands',
        message: 'Execution request must contain at least one non-empty command.',
      };
      this._emitEvent(onEvent, this._buildEvent(session, traceId, 1, 'remote_exec_summary', 'error', result));
      return result;
    }

    if (!idempotencyKey) {
      const result = {
        trace_id: traceId || session.traceId || null,
        connection_id: session.connectionId,
        status: 'idempotency_key_required',
        message: 'Side-effect execution requires idempotency_key.',
      };
      this._emitEvent(onEvent, this._buildEvent(session, traceId, 1, 'remote_exec_summary', 'error', result));
      return result;
    }

    const requestHash = _hashExecutionRequest(session.connectionId, normalizedCommands);
    const idempotencyStoreKey = this._buildIdempotencyStoreKey(session.connectionId, idempotencyKey);
    const existingResult = this._idempotentResults.get(idempotencyStoreKey);
    if (existingResult) {
      if (existingResult.requestHash === requestHash) {
        const result = {
          trace_id: traceId || session.traceId || null,
          connection_id: session.connectionId,
          status: 'idempotent_replay',
          message: 'Execution skipped and replayed from prior result for the same idempotency_key.',
          idempotency_key: idempotencyKey,
          result: existingResult.result,
        };
        this._emitEvent(onEvent, this._buildEvent(session, traceId, 1, 'remote_exec_summary', 'info', result));
        return result;
      }
      const result = {
        trace_id: traceId || session.traceId || null,
        connection_id: session.connectionId,
        status: 'idempotency_conflict',
        message: 'The same idempotency_key was already used with a different command payload.',
        idempotency_key: idempotencyKey,
      };
      this._emitEvent(onEvent, this._buildEvent(session, traceId, 1, 'remote_exec_summary', 'error', result));
      return result;
    }

    if (this._idempotentRunning.has(idempotencyStoreKey)) {
      const result = {
        trace_id: traceId || session.traceId || null,
        connection_id: session.connectionId,
        status: 'idempotency_in_progress',
        message: 'An execution with the same idempotency_key is already in progress.',
        idempotency_key: idempotencyKey,
      };
      this._emitEvent(onEvent, this._buildEvent(session, traceId, 1, 'remote_exec_summary', 'wait', result));
      return result;
    }

    if (evaluation.requiresApproval) {
      const approvedTicket = approvalTicketId
        ? this._approvalBridge.getTicket(approvalTicketId)
        : null;

      const isApproved = approvedTicket
        && approvedTicket.status === 'approved'
        && approvedTicket.connection_id === session.connectionId;

      if (!isApproved) {
        const result = {
          trace_id: traceId || session.traceId || null,
          connection_id: session.connectionId,
          status: 'approval_required',
          approval_ticket: this._approvalBridge.createTicket({
            traceId: traceId || session.traceId || null,
            connectionId: session.connectionId,
            hostAlias: session.hostAlias,
            commands: normalizedCommands,
            idempotencyKey,
            riskContext,
          }),
        };
        this._emitEvent(onEvent, this._buildEvent(session, traceId, 1, 'remote_approval_required', 'warn', result));
        return result;
      }

      if (approvedTicket.idempotency_key && approvedTicket.idempotency_key !== idempotencyKey) {
        const result = {
          trace_id: traceId || session.traceId || null,
          connection_id: session.connectionId,
          status: 'approval_idempotency_mismatch',
          message: 'Provided idempotency_key does not match the approved ticket.',
          idempotency_key: idempotencyKey,
          approval_ticket_id: approvedTicket.ticket_id,
        };
        this._emitEvent(onEvent, this._buildEvent(session, traceId, 1, 'remote_exec_summary', 'error', result));
        return result;
      }

      if (approvedTicket.consumed_at) {
        const result = {
          trace_id: traceId || session.traceId || null,
          connection_id: session.connectionId,
          status: 'approval_ticket_consumed',
          message: 'The provided approval ticket has already been consumed.',
          approval_ticket_id: approvedTicket.ticket_id,
          consumed_at: approvedTicket.consumed_at,
        };
        this._emitEvent(onEvent, this._buildEvent(session, traceId, 1, 'remote_exec_summary', 'error', result));
        return result;
      }
    }

    if (!_envFlag('KHY_REMOTE_SSH_ENABLE_EXEC', false)) {
      const result = this._buildExecDisabledResult({
        session,
        traceId,
        evaluation,
        idempotencyKey,
      });
      this._emitEvent(onEvent, this._buildEvent(session, traceId, 1, 'remote_exec_summary', 'wait', result));
      return result;
    }

    if (evaluation.requiresApproval && approvalTicketId) {
      const consume = this._approvalBridge.consumeApprovedTicket(approvalTicketId, idempotencyKey);
      if (!consume.ok) {
        const result = {
          trace_id: traceId || session.traceId || null,
          connection_id: session.connectionId,
          status: 'approval_ticket_consume_failed',
          message: consume.message,
          approval_ticket_id: approvalTicketId,
          code: consume.code,
        };
        this._emitEvent(onEvent, this._buildEvent(session, traceId, 1, 'remote_exec_summary', 'error', result));
        return result;
      }
    }

    const executionPromise = this._executeCommands({
      session,
      commands: normalizedCommands,
      traceId,
      onEvent,
    });
    this._idempotentRunning.set(idempotencyStoreKey, executionPromise);

    try {
      const executionResult = await executionPromise;
      const wrapped = {
        trace_id: traceId || session.traceId || null,
        connection_id: session.connectionId,
        status: executionResult.status,
        idempotency_key: idempotencyKey,
        redaction_applied: true,
        risk_summary: {
          highest_risk: evaluation.highestRisk,
          reason: evaluation.highestReason,
        },
        ...executionResult,
      };

      this._idempotentResults.set(idempotencyStoreKey, {
        createdAtMs: Date.now(),
        requestHash,
        result: wrapped,
      });
      this._connectionManager.touch(session.connectionId);
      const lastSeq = Array.isArray(wrapped.events) && wrapped.events.length > 0
        ? Number(wrapped.events[wrapped.events.length - 1].sequence || 0)
        : 0;
      this._emitEvent(
        onEvent,
        this._buildEvent(
          session,
          traceId,
          lastSeq + 1,
          'remote_exec_summary',
          wrapped.status === 'completed' ? 'ok' : 'error',
          wrapped
        )
      );
      return wrapped;
    } catch (error) {
      const result = {
        trace_id: traceId || session.traceId || null,
        connection_id: session.connectionId,
        status: 'execution_error',
        message: _redactSecrets(error.message || String(error)),
        redaction_applied: true,
        idempotency_key: idempotencyKey,
      };
      this._emitEvent(onEvent, this._buildEvent(session, traceId, 1, 'remote_exec_summary', 'error', result));
      return result;
    } finally {
      this._idempotentRunning.delete(idempotencyStoreKey);
    }
  }
}

module.exports = {
  RemoteExecService,
};
