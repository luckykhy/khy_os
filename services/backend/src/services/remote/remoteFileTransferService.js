'use strict';

/**
 * remoteFileTransferService — scp-based upload of a single local artifact to a
 * remote host, used by the deploy pipeline to ship a Docker bundle to the
 * "last mile" before running `docker compose up` remotely.
 *
 * Design mirrors remoteExecService.js on purpose:
 *   - Destination is the SSH config host alias (e.g. `scp file alias:path`), so
 *     HostName / User / Port / IdentityFile are resolved from ~/.ssh/config.
 *     Nothing about the host/credentials is ever hardcoded or passed inline.
 *   - Side effects are gated behind KHY_REMOTE_SSH_ENABLE_EXEC; when disabled it
 *     returns `{status:'execution_disabled'}` exactly like remoteExecService so
 *     callers degrade transparently instead of silently writing to a remote.
 *   - Idle-timeout (KHY_REMOTE_SSH_IDLE_TIMEOUT_MS), ConnectTimeout
 *     (KHY_REMOTE_SSH_CONNECT_TIMEOUT_SEC), secret redaction, safeKill and a
 *     bounded idempotency replay cache match the exec service.
 */

const { spawn } = require('child_process');
const { safeKill } = require('../../tools/platformUtils');

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_CONNECT_TIMEOUT_SEC = 8;
const MAX_PREVIEW_CHARS = 8_000;
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

class RemoteFileTransferService {
  constructor({ connectionManager }) {
    this._connectionManager = connectionManager;
    this._idempotentResults = new Map();
  }

  _emitEvent(onEvent, event) {
    if (typeof onEvent !== 'function' || !event) return;
    try {
      onEvent({ ...event });
    } catch {
      /* ignore callback failures */
    }
  }

  _buildEvent(session, traceId, kind, severity, payload = {}) {
    return {
      trace_id: traceId || session.traceId || null,
      connection_id: session.connectionId,
      host_alias: session.hostAlias,
      remote_user: session.remoteUser,
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

  _cleanupExpiredIdempotentResults() {
    const now = Date.now();
    for (const [key, record] of this._idempotentResults.entries()) {
      if ((now - record.createdAtMs) > IDEMPOTENCY_TTL_MS) {
        this._idempotentResults.delete(key);
      }
    }
  }

  /**
   * Upload a single local file to `remotePath` on the host behind `connectionId`.
   * Returns a structured, redacted result; never throws for transport failures.
   */
  async upload({ connectionId, localPath, remotePath, idempotencyKey, traceId = null, onEvent = null }) {
    this._cleanupExpiredIdempotentResults();

    const session = this._assertSession(connectionId);

    const local = String(localPath || '').trim();
    const remote = String(remotePath || '').trim();
    if (!local || !remote) {
      const result = {
        ok: false,
        status: 'invalid_transfer_request',
        connection_id: session.connectionId,
        message: 'Both localPath and remotePath are required for an upload.',
      };
      this._emitEvent(onEvent, this._buildEvent(session, traceId, 'remote_transfer_summary', 'error', result));
      return result;
    }

    if (!idempotencyKey) {
      const result = {
        ok: false,
        status: 'idempotency_key_required',
        connection_id: session.connectionId,
        message: 'File transfer requires an idempotency_key.',
      };
      this._emitEvent(onEvent, this._buildEvent(session, traceId, 'remote_transfer_summary', 'error', result));
      return result;
    }

    const storeKey = `${session.connectionId}::${idempotencyKey}`;
    const replay = this._idempotentResults.get(storeKey);
    if (replay) {
      const result = {
        ...replay.result,
        status: 'idempotent_replay',
        message: 'Upload replayed from a prior result for the same idempotency_key.',
      };
      this._emitEvent(onEvent, this._buildEvent(session, traceId, 'remote_transfer_summary', 'info', result));
      return result;
    }

    // Side-effect gate: identical posture to remoteExecService.
    if (!_envFlag('KHY_REMOTE_SSH_ENABLE_EXEC', false)) {
      const result = {
        ok: false,
        status: 'execution_disabled',
        connection_id: session.connectionId,
        message: 'Remote file transfer is disabled. Set KHY_REMOTE_SSH_ENABLE_EXEC=true to enable uploads.',
        redaction_applied: true,
      };
      this._emitEvent(onEvent, this._buildEvent(session, traceId, 'remote_transfer_summary', 'wait', result));
      return result;
    }

    const result = await this._runScp({ session, local, remote, traceId, onEvent });
    if (result.ok) {
      this._idempotentResults.set(storeKey, { createdAtMs: Date.now(), result });
      this._connectionManager.touch(session.connectionId);
    }
    return result;
  }

  async _runScp({ session, local, remote, traceId, onEvent }) {
    const idleTimeoutMs = _getIdleTimeoutMs();
    const connectTimeoutSec = _getConnectTimeoutSec();

    // Destination uses the host alias so scp honors ~/.ssh/config (HostName,
    // User, Port, IdentityFile). Zero inline host/credential material.
    const destination = `${session.hostAlias}:${remote}`;
    const scpArgs = [
      '-o',
      'BatchMode=yes',
      '-o',
      `ConnectTimeout=${connectTimeoutSec}`,
      local,
      destination,
    ];

    const startedAt = Date.now();
    let lastActivityMs = Date.now();
    let stderrBuf = '';
    let finished = false;

    const pushEvent = (kind, severity, payload) => {
      const event = this._buildEvent(session, traceId, kind, severity, payload);
      this._emitEvent(onEvent, event);
    };

    pushEvent('remote_transfer_step', 'info', {
      status: 'start',
      local_preview: local.slice(0, 200),
      remote_preview: remote.slice(0, 200),
    });

    const child = spawn('scp', scpArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    const onStderr = (chunk) => {
      const redacted = _redactSecrets(String(chunk || ''));
      stderrBuf += redacted;
      if (stderrBuf.length > MAX_PREVIEW_CHARS * 2) {
        stderrBuf = stderrBuf.slice(-MAX_PREVIEW_CHARS * 2);
      }
      lastActivityMs = Date.now();
    };
    const onStdout = () => {
      lastActivityMs = Date.now();
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
          const err = new Error(`Remote upload idle timeout: no progress for ${idleMs}ms.`);
          err.code = 'remote_transfer_idle_timeout';
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
      const result = {
        ok,
        status: ok ? 'uploaded' : 'upload_failed',
        connection_id: session.connectionId,
        host_alias: session.hostAlias,
        local_path: local,
        remote_path: remote,
        exit_code: exitState.code,
        signal: exitState.signal || null,
        elapsed_ms: elapsedMs,
        stderr_preview: _trimPreview(stderrBuf),
        redaction_applied: true,
      };
      pushEvent('remote_transfer_summary', ok ? 'ok' : 'error', result);
      return result;
    } catch (error) {
      finished = true;
      if (idleCheckTimer) clearInterval(idleCheckTimer);

      const result = {
        ok: false,
        status: 'upload_error',
        connection_id: session.connectionId,
        host_alias: session.hostAlias,
        local_path: local,
        remote_path: remote,
        exit_code: null,
        signal: null,
        elapsed_ms: Date.now() - startedAt,
        error: _redactSecrets(error.message || String(error)),
        stderr_preview: _trimPreview(stderrBuf),
        redaction_applied: true,
      };
      pushEvent('remote_transfer_summary', 'error', result);
      return result;
    }
  }
}

module.exports = {
  RemoteFileTransferService,
  createRemoteFileTransferService: (deps) => new RemoteFileTransferService(deps),
};
