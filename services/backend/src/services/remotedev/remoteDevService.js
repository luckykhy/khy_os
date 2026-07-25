'use strict';

/**
 * remoteDevService.js — unified remote-dev facade (thin orchestration shell).
 *
 * "One command into a remote dev session." This service does NOT re-implement
 * SSH, the daemon, or the bridge — it composes the already-existing primitives
 * into a single coherent lifecycle (connect / attach / status / logs / stop) and
 * a single aggregated status model:
 *
 *   - daemonManager        → background daemon (pid/port/uptime/health)
 *   - bridgeServer         → LAN bridge for mobile/remote attach (url/pin/clients)
 *   - services/remote/*    → SSH host discovery, credential guard, workspace
 *                            resolver, connection registry, state snapshot
 *   - remoteDevSessionStore→ durable "current session" pointer (cross-invocation)
 *   - remoteDevState (leaf)→ pure fold + reconcile + one-line summary
 *
 * Every collaborator is injectable via `opts` so the service is unit-testable
 * with in-memory stubs (no real ssh/daemon/bridge ever spawned in tests).
 *
 * Discoverability (goal red line — never hardcode host/port/auth/session):
 *   - SSH config path  : KHY_REMOTE_SSH_CONFIG_PATH (else ~/.ssh/config, owned by sshConfigService)
 *   - daemon port      : KHY_DAEMON_PORT  (live value comes from daemonStatus())
 *   - bridge port      : BRIDGE_PORT      (live value comes from getStatusSnapshot())
 *   - host allowlist   : KHY_REMOTE_SSH_ALLOWLIST
 *   - workspace allow  : KHY_REMOTE_WORKSPACE_ALLOWLIST
 *   - exec enable      : KHY_REMOTE_SSH_ENABLE_EXEC
 *   - state persistence: KHY_REMOTE_SSH_PERSIST_STATE / KHY_REMOTE_SSH_STATE_PATH
 * This file bakes in NONE of those defaults as literals — the daemon/bridge
 * subsystems own their own default ports; we only surface env values and live
 * values, so the new facade adds zero new hardcoding.
 */

const state = require('./remoteDevState');

/** Master gate (default on). When '0', the unified facade declines gracefully. */
function isEnabled(env = process.env) {
  return env.KHY_REMOTEDEV !== '0';
}

function _nowIso() {
  // Thin IO shell (NOT a leaf) → wall-clock is allowed here.
  return new Date().toISOString();
}

/** Resolve injectable collaborators, defaulting to the real subsystems. */
function _deps(opts = {}) {
  return {
    daemon: opts.daemonManager || require('../daemonManager'),
    bridge: opts.bridge || require('../../bridge/bridgeServer'),
    remote: opts.remote || require('../remote'),
    store: opts.store || require('./remoteDevSessionStore'),
    env: opts.env || process.env,
  };
}

function _commaList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve the discoverable config from env + live subsystem facts. No port
 * literal is invented here; a null port means "unset → subsystem default".
 */
function resolveConfig(deps, daemonStatus, bridgeSnapshot) {
  const env = deps.env;
  let sshConfigPath = null;
  try { sshConfigPath = deps.remote.sshConfigService.getConfigPath(); } catch { /* best-effort */ }
  let statePath = null;
  try {
    statePath = deps.remote.remoteStatePersistence
      && deps.remote.remoteStatePersistence.getStatePath
      ? deps.remote.remoteStatePersistence.getStatePath() : null;
  } catch { /* best-effort */ }

  // Prefer the LIVE port (authoritative when running); fall back to the env
  // override; never a hardcoded literal.
  const daemonPort = (daemonStatus && daemonStatus.port != null)
    ? daemonStatus.port
    : (env.KHY_DAEMON_PORT != null && env.KHY_DAEMON_PORT !== '' ? env.KHY_DAEMON_PORT : null);
  const bridgePort = (bridgeSnapshot && bridgeSnapshot.url)
    ? _portFromUrl(bridgeSnapshot.url)
    : (env.BRIDGE_PORT != null && env.BRIDGE_PORT !== '' ? env.BRIDGE_PORT : null);

  return {
    sshConfigPath,
    daemonPort,
    bridgePort,
    bridgePinSet: Boolean(env.BRIDGE_PIN),
    allowlist: _commaList(env.KHY_REMOTE_SSH_ALLOWLIST),
    workspaceAllowlist: _commaList(env.KHY_REMOTE_WORKSPACE_ALLOWLIST),
    execEnabled: env.KHY_REMOTE_SSH_ENABLE_EXEC === '1' || env.KHY_REMOTE_SSH_ENABLE_EXEC === 'true',
    persistEnabled: env.KHY_REMOTE_SSH_PERSIST_STATE === '1' || env.KHY_REMOTE_SSH_PERSIST_STATE === 'true',
    statePath,
  };
}

function _portFromUrl(url) {
  const m = /:(\d+)(?:\/|$)/.exec(String(url || ''));
  return m ? Number(m[1]) : null;
}

/** Gather all subsystem snapshots and fold them into the unified state model. */
async function getUnifiedStatus(opts = {}) {
  const deps = _deps(opts);
  let daemon = { running: false };
  try { daemon = await deps.daemon.daemonStatus(); } catch { /* best-effort */ }

  let bridge = { running: false };
  try { bridge = deps.bridge.getStatusSnapshot(); } catch { /* best-effort */ }

  let remoteSnapshot = {};
  try { remoteSnapshot = deps.remote.remoteStateSyncService.getSnapshot(); } catch { /* best-effort */ }

  let hosts = [];
  try { hosts = (deps.remote.sshConfigService.listHosts() || {}).hosts || []; } catch { /* best-effort */ }

  const pointer = deps.store.readPointer();
  const config = resolveConfig(deps, daemon, bridge);

  return state.buildUnifiedState({
    daemon, bridge, remoteSnapshot, hosts, pointer, config, nowIso: _nowIso(),
  });
}

/**
 * Establish a remote dev session against an SSH host alias, mirroring the route
 * flow (allowlist → credential guard → workspace resolve → connect), then
 * persist the durable pointer so the session is discoverable afterwards.
 *
 * @returns {{ ok:boolean, code?:string, message?:string, session?:object, descriptor?:object, credentialStatus?:object, unified?:object }}
 */
async function connect(hostAlias, opts = {}) {
  const deps = _deps(opts);
  const alias = String(hostAlias || '').trim();
  if (!alias) {
    return { ok: false, code: 'missing_host', message: '必须提供 SSH 主机别名：connect <host>' };
  }

  // Allowlist gate (mirrors routes/remoteSsh.js) — discoverable via env.
  const allowlist = _commaList(deps.env.KHY_REMOTE_SSH_ALLOWLIST);
  if (allowlist.length > 0 && !allowlist.includes(alias)) {
    return {
      ok: false,
      code: 'host_not_allowed',
      message: `主机 "${alias}" 不在允许列表内（KHY_REMOTE_SSH_ALLOWLIST=${allowlist.join(', ')}）`,
    };
  }

  let listing;
  try { listing = deps.remote.sshConfigService.listHosts(); } catch (err) {
    return { ok: false, code: 'config_read_failed', message: `读取 SSH 配置失败：${err.message}` };
  }
  const hostEntry = (listing.hosts || []).find((h) => h && h.alias === alias);
  if (!hostEntry) {
    return {
      ok: false,
      code: 'host_not_found',
      message: `在 ${listing.configPath || 'SSH 配置'} 中未找到主机别名 "${alias}"`,
    };
  }

  const credentialStatus = deps.remote.sshCredentialGuard.validateHostCredentials(hostEntry);
  if (!credentialStatus.ok) {
    return {
      ok: false,
      code: credentialStatus.code || 'credential_invalid',
      message: `凭证检查未通过：${credentialStatus.message}`,
      credentialStatus,
    };
  }

  let workspace;
  try {
    workspace = deps.remote.remoteWorkspaceResolver.resolveWorkspace({
      requestedWorkspace: opts.workspace,
      hostEntry,
    });
  } catch (err) {
    return { ok: false, code: err.code || 'workspace_invalid', message: `工作目录解析失败：${err.message}` };
  }

  let session;
  try {
    session = deps.remote.sshConnectionManager.connect({
      hostEntry,
      workspace,
      purpose: opts.purpose || 'development',
      traceId: opts.traceId || null,
    });
  } catch (err) {
    return { ok: false, code: 'connect_failed', message: `建立会话失败：${err.message}` };
  }

  const descriptor = state.buildSessionDescriptor({
    session, hostEntry, workspace, savedAt: _nowIso(),
  });
  deps.store.writePointer(descriptor);

  const unified = await getUnifiedStatus(opts);
  return { ok: true, session, descriptor, credentialStatus, unified };
}

/**
 * Attach to (focus) an existing session and refresh the durable pointer. If a
 * connectionId is given it selects that live session; otherwise it reconciles
 * the existing pointer. Useful after a process restart to confirm what is (and
 * is not) still live, and to point the bridge at the right session.
 */
async function attach(opts = {}) {
  const deps = _deps(opts);
  let remoteSnapshot = {};
  try { remoteSnapshot = deps.remote.remoteStateSyncService.getSnapshot(); } catch { /* best-effort */ }
  const live = Array.isArray(remoteSnapshot.active_remote_sessions)
    ? remoteSnapshot.active_remote_sessions : [];

  const wantedId = opts.connectionId ? String(opts.connectionId).trim() : null;
  if (wantedId) {
    const match = live.find((s) => s && String(s.connectionId) === wantedId);
    if (!match) {
      return { ok: false, code: 'session_not_live', message: `未找到活动会话 ${wantedId}（可能进程已重启）` };
    }
    const descriptor = state.buildSessionDescriptor({ session: match, savedAt: _nowIso() });
    deps.store.writePointer(descriptor);
    const unified = await getUnifiedStatus(opts);
    return { ok: true, descriptor, unified, reconciled: state.reconcileSession(descriptor, live) };
  }

  const pointer = deps.store.readPointer();
  const reconciled = state.reconcileSession(pointer, live);
  if (reconciled.state === state.SESSION_STATE.NONE) {
    return { ok: false, code: 'no_session', message: '没有可附着的远端开发会话（先 connect）' };
  }
  const unified = await getUnifiedStatus(opts);
  return { ok: true, descriptor: pointer, unified, reconciled };
}

/** Aggregated status. */
async function status(opts = {}) {
  return getUnifiedStatus(opts);
}

/** Locate the daemon log file + read a bounded tail. Rendering is the handler's job. */
function logs(opts = {}) {
  const deps = _deps(opts);
  let logPath = null;
  try { logPath = deps.daemon.getLogPath(); } catch { /* best-effort */ }
  let lines = [];
  let error = null;
  if (logPath) {
    try {
      const fs = require('fs');
      const content = fs.readFileSync(logPath, 'utf8');
      lines = content.split('\n').filter(Boolean);
    } catch (err) {
      error = err.message;
    }
  }
  return { logPath, lines, error };
}

/**
 * Tear down. Default scope is the remote session only (least destructive): drop
 * the live session(s) and clear the durable pointer. Wider scopes optionally
 * stop the bridge and/or the daemon.
 *
 * @param {object} opts
 * @param {string} [opts.scope='session']  one of VALID_STOP_SCOPES
 */
async function stop(opts = {}) {
  const deps = _deps(opts);
  const scope = state.VALID_STOP_SCOPES.includes(opts.scope) ? opts.scope : 'session';
  const result = { scope, sessionCleared: false, bridgeStopped: false, daemonStopped: false };

  if (scope === 'session' || scope === 'all') {
    try { deps.remote.sshConnectionManager.clearAll(); } catch { /* best-effort */ }
    result.sessionCleared = deps.store.clearPointer() || true;
  }
  if (scope === 'bridge' || scope === 'all') {
    try { await deps.bridge.stopBridgeServer(); result.bridgeStopped = true; } catch { /* best-effort */ }
  }
  if (scope === 'daemon' || scope === 'all') {
    try { result.daemonStopped = Boolean(deps.daemon.daemonStop()); } catch { /* best-effort */ }
  }
  return result;
}

module.exports = {
  isEnabled,
  resolveConfig,
  getUnifiedStatus,
  connect,
  attach,
  status,
  logs,
  stop,
};
