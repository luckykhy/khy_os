'use strict';

/**
 * remoteDevState.js — PURE LEAF (zero IO, deterministic).
 *
 * Single source of truth for the *shape* of the unified remote-dev state and the
 * pure transforms over it. It NEVER touches the filesystem, the network, the
 * clock (no Date.now / new Date — callers inject `nowIso`), or any subsystem; it
 * only takes already-gathered raw snapshots and folds them into one normalized
 * model plus the human-facing one-liner.
 *
 * The three live subsystems remain authoritative for their own data:
 *   - daemonManager.daemonStatus()        → { running, pid, port, uptime, health }
 *   - bridgeServer.getStatusSnapshot()     → { running, url, pin, clientCount, tokenShort }
 *   - sshConnectionManager.listSessions()  → [{ connectionId, hostAlias, host, port, ... }]
 *
 * This leaf does not re-implement any of them; it only aggregates + reconciles.
 */

/** Allowed scopes for `stop` — what the unified facade is allowed to tear down. */
const VALID_STOP_SCOPES = ['session', 'bridge', 'daemon', 'all'];

/** Session reconciliation verdicts (persisted pointer vs. live in-process registry). */
const SESSION_STATE = {
  LIVE: 'live',           // pointer's connectionId is present in the live registry
  RECOVERABLE: 'recoverable', // pointer exists but the live registry lost it (process restarted)
  NONE: 'none',           // no persisted dev session at all
};

function _str(v) {
  return v === undefined || v === null ? '' : String(v);
}

function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Reconcile the durable session pointer against the live in-process session
 * registry. SSH "sessions" are logical metadata held in an in-memory Map that
 * does NOT survive a process restart, so the on-disk pointer is what makes a
 * session *discoverable* across invocations. This decides whether the pointer
 * still maps to something live, is merely recoverable metadata, or is absent.
 *
 * @param {object|null} pointer       persisted descriptor (see buildSessionDescriptor)
 * @param {Array<object>} liveSessions sshConnectionManager.listSessions()
 * @returns {{ state:string, connectionId:(string|null), session:(object|null), live:boolean }}
 */
function reconcileSession(pointer, liveSessions) {
  const sessions = Array.isArray(liveSessions) ? liveSessions : [];
  if (!pointer || typeof pointer !== 'object' || !pointer.connectionId) {
    return { state: SESSION_STATE.NONE, connectionId: null, session: null, live: false };
  }
  const connectionId = _str(pointer.connectionId);
  const liveMatch = sessions.find((s) => s && _str(s.connectionId) === connectionId) || null;
  if (liveMatch) {
    // Live registry wins for volatile fields (status/lastActivityAt); pointer
    // carries the discoverable identity. Merge with live taking precedence.
    return {
      state: SESSION_STATE.LIVE,
      connectionId,
      session: { ...pointer, ...liveMatch },
      live: true,
    };
  }
  // Pointer survived a restart but the in-memory registry is empty for it.
  return {
    state: SESSION_STATE.RECOVERABLE,
    connectionId,
    session: { ...pointer, status: 'recoverable' },
    live: false,
  };
}

/**
 * Build the durable session descriptor to persist after a connect/attach. Pure:
 * the caller injects `savedAt` (an ISO string) so the leaf stays clock-free.
 */
function buildSessionDescriptor({ session, hostEntry, workspace, savedAt }) {
  const s = session || {};
  const h = hostEntry || {};
  return {
    connectionId: _str(s.connectionId) || null,
    hostAlias: _str(s.hostAlias || h.alias) || null,
    host: _str(s.host || h.host) || null,
    port: _num(s.port != null ? s.port : h.port),
    remoteUser: _str(s.remoteUser || h.user) || null,
    remoteWorkspace: _str(s.remoteWorkspace || workspace) || null,
    purpose: _str(s.purpose) || 'development',
    connectedAt: _str(s.connectedAt) || null,
    savedAt: _str(savedAt) || null,
  };
}

/**
 * Fold raw subsystem snapshots into one normalized unified state.
 *
 * @param {object}  args
 * @param {object}  args.daemon         daemonManager.daemonStatus() result
 * @param {object}  args.bridge         bridgeServer.getStatusSnapshot() result
 * @param {object}  args.remoteSnapshot remoteStateSyncService.getSnapshot() result
 * @param {Array}   args.hosts          sshConfigService.listHosts().hosts
 * @param {object|null} args.pointer    persisted session descriptor
 * @param {object}  args.config         discoverable config (see resolveConfig in service)
 * @param {string}  args.nowIso         injected timestamp (clock-free leaf)
 */
function buildUnifiedState({ daemon, bridge, remoteSnapshot, hosts, pointer, config, nowIso } = {}) {
  const d = daemon || {};
  const b = bridge || {};
  const rs = remoteSnapshot || {};
  const liveSessions = Array.isArray(rs.active_remote_sessions) ? rs.active_remote_sessions : [];
  const reconciled = reconcileSession(pointer, liveSessions);

  return {
    generatedAt: _str(nowIso) || null,
    daemon: {
      running: Boolean(d.running),
      pid: d.pid != null ? d.pid : null,
      port: _num(d.port),
      uptimeMs: _num(d.uptime),
      health: d.health != null ? d.health : null,
    },
    bridge: {
      running: Boolean(b.running),
      url: _str(b.url) || null,
      pin: _str(b.pin) || null,
      clientCount: _num(b.clientCount) || 0,
      tokenShort: _str(b.tokenShort) || null,
    },
    session: {
      state: reconciled.state,
      live: reconciled.live,
      connectionId: reconciled.connectionId,
      hostAlias: reconciled.session ? _str(reconciled.session.hostAlias) || null : null,
      host: reconciled.session ? _str(reconciled.session.host) || null : null,
      port: reconciled.session ? _num(reconciled.session.port) : null,
      remoteUser: reconciled.session ? _str(reconciled.session.remoteUser) || null : null,
      remoteWorkspace: reconciled.session ? _str(reconciled.session.remoteWorkspace) || null : null,
      purpose: reconciled.session ? _str(reconciled.session.purpose) || null : null,
      connectedAt: reconciled.session ? _str(reconciled.session.connectedAt) || null : null,
    },
    remote: {
      activeSessionCount: liveSessions.length,
      pendingApprovalCount: Array.isArray(rs.pending_remote_approvals)
        ? rs.pending_remote_approvals.length : 0,
      persistenceEnabled: Boolean(rs.summary && rs.summary.persistence_enabled),
      sessions: liveSessions.map((s) => ({
        connectionId: _str(s.connectionId) || null,
        hostAlias: _str(s.hostAlias) || null,
        host: _str(s.host) || null,
        port: _num(s.port),
        remoteUser: _str(s.remoteUser) || null,
        remoteWorkspace: _str(s.remoteWorkspace) || null,
        status: _str(s.status) || null,
      })),
    },
    hosts: (Array.isArray(hosts) ? hosts : []).map((h) => ({
      alias: _str(h.alias) || null,
      host: _str(h.host) || null,
      port: _num(h.port),
      user: _str(h.user) || null,
      remoteWorkspace: _str(h.remoteWorkspace) || null,
    })),
    discoverability: discoverabilityReport(config || {}),
  };
}

/**
 * Turn the discoverable config into an ordered list of {label, env, value} rows.
 * This is what satisfies "ports / auth / session must be discoverable, never
 * hardcoded" — every knob names the env var that overrides it and its current
 * resolved value (never a secret; PIN/token are surfaced elsewhere only as the
 * non-sensitive short prefix). A null value renders as "(default)" by callers.
 */
function discoverabilityReport(config) {
  const c = config || {};
  return [
    { label: 'SSH config path', env: 'KHY_REMOTE_SSH_CONFIG_PATH', value: c.sshConfigPath != null ? _str(c.sshConfigPath) : null },
    { label: 'Daemon port', env: 'KHY_DAEMON_PORT', value: c.daemonPort != null ? _str(c.daemonPort) : null },
    { label: 'Bridge port', env: 'BRIDGE_PORT', value: c.bridgePort != null ? _str(c.bridgePort) : null },
    { label: 'Bridge PIN', env: 'BRIDGE_PIN', value: c.bridgePinSet ? '(set)' : null },
    { label: 'Host allowlist', env: 'KHY_REMOTE_SSH_ALLOWLIST', value: (Array.isArray(c.allowlist) && c.allowlist.length) ? c.allowlist.join(', ') : null },
    { label: 'Workspace allowlist', env: 'KHY_REMOTE_WORKSPACE_ALLOWLIST', value: (Array.isArray(c.workspaceAllowlist) && c.workspaceAllowlist.length) ? c.workspaceAllowlist.join(', ') : null },
    { label: 'Remote exec', env: 'KHY_REMOTE_SSH_ENABLE_EXEC', value: c.execEnabled ? 'enabled' : 'disabled (dry-run)' },
    { label: 'State persistence', env: 'KHY_REMOTE_SSH_PERSIST_STATE', value: c.persistEnabled ? 'enabled' : 'disabled' },
    { label: 'State path', env: 'KHY_REMOTE_SSH_STATE_PATH', value: c.statePath != null ? _str(c.statePath) : null },
  ];
}

/**
 * One-line, honest summary of the current connection in Chinese (this repo is a
 * Chinese-allowed scope). Always names host / session / workspace / port — the
 * four facts the goal requires the output to make unambiguous — or says plainly
 * that there is no active dev session.
 */
function summarizeConnection(unified) {
  const u = unified || {};
  const s = u.session || {};
  if (!s.connectionId || s.state === SESSION_STATE.NONE) {
    return '远端开发会话：未连接（使用 `khy remotedev connect <host>` 建立）';
  }
  const host = s.host || s.hostAlias || '未知主机';
  const alias = s.hostAlias && s.hostAlias !== host ? `${s.hostAlias} → ` : '';
  const user = s.remoteUser ? `${s.remoteUser}@` : '';
  const port = s.port != null ? `:${s.port}` : '';
  const ws = s.remoteWorkspace || '~';
  const cid = s.connectionId ? s.connectionId.slice(0, 8) : '?';
  const liveTag = s.state === SESSION_STATE.RECOVERABLE
    ? '（元数据可恢复 · 进程已重启，注册表未持有活动连接）'
    : '（活动）';
  return `远端开发会话 ${liveTag}：${alias}${user}${host}${port} · 工作目录 ${ws} · 会话 ${cid}`;
}

module.exports = {
  VALID_STOP_SCOPES,
  SESSION_STATE,
  reconcileSession,
  buildSessionDescriptor,
  buildUnifiedState,
  discoverabilityReport,
  summarizeConnection,
};
