'use strict';

/**
 * remoteDevService.test.js — hermetic coverage of the unified facade. Every
 * collaborator is injected so no real ssh / daemon / bridge / filesystem is
 * touched:
 *   - daemonManager : stub daemonStatus / daemonStop / getLogPath
 *   - bridge        : stub getStatusSnapshot / stopBridgeServer
 *   - remote        : stub sshConfigService / sshCredentialGuard /
 *                     remoteWorkspaceResolver / sshConnectionManager /
 *                     remoteStateSyncService
 *   - store         : in-memory pointer (no disk)
 */

const test = require('node:test');
const assert = require('node:assert');

const svc = require('../src/services/remotedev/remoteDevService');

// ── in-memory durable pointer ──────────────────────────────────────────────
function makeStore() {
  let pointer = null;
  return {
    readPointer: () => (pointer ? { ...pointer } : null),
    writePointer: (d) => { pointer = { ...d }; return pointer; },
    clearPointer: () => { const had = pointer != null; pointer = null; return had; },
    _peek: () => pointer,
  };
}

// ── in-memory ssh connection registry (faithful to sshConnectionManager) ────
function makeConnectionManager() {
  let seq = 0;
  const map = new Map();
  return {
    connect({ hostEntry, workspace, purpose, traceId }) {
      seq += 1;
      const rec = {
        connectionId: `conn-${seq}`,
        status: 'connected',
        hostAlias: hostEntry.alias,
        host: hostEntry.host,
        port: hostEntry.port,
        remoteUser: hostEntry.user,
        remoteWorkspace: workspace,
        purpose: purpose || 'development',
        traceId: traceId || null,
        connectedAt: 'C',
        lastActivityAt: 'C',
      };
      map.set(rec.connectionId, rec);
      return { ...rec };
    },
    listSessions: () => [...map.values()].map((r) => ({ ...r })),
    clearAll: () => { map.clear(); },
  };
}

function makeRemote(connMgr, { hosts } = {}) {
  const hostList = hosts || [{ alias: 'dev', host: '10.0.0.2', port: 22, user: 'kode', remoteWorkspace: '~/app', identityFile: null }];
  return {
    sshConfigService: {
      getConfigPath: () => '/home/u/.ssh/config',
      listHosts: () => ({ configPath: '/home/u/.ssh/config', hosts: hostList }),
    },
    sshCredentialGuard: {
      validateHostCredentials: () => ({ ok: true, code: 'no_identity_file', message: 'ok', identityFile: null }),
    },
    remoteWorkspaceResolver: {
      resolveWorkspace: ({ requestedWorkspace, hostEntry }) => String(requestedWorkspace || hostEntry.remoteWorkspace || '~'),
    },
    sshConnectionManager: connMgr,
    remoteStateSyncService: {
      getSnapshot: () => ({
        active_remote_sessions: connMgr.listSessions(),
        pending_remote_approvals: [],
        summary: { persistence_enabled: false },
      }),
    },
    remoteStatePersistence: { getStatePath: () => '/tmp/ssh_state.json' },
  };
}

function makeDaemon({ running = false } = {}) {
  return {
    daemonStatus: async () => (running
      ? { running: true, pid: 7, port: 9090, uptime: 1000, health: null }
      : { running: false, pid: null, port: null, uptime: null, health: null }),
    daemonStop: () => true,
    getLogPath: () => '/tmp/daemon.log',
  };
}

function makeBridge({ running = false } = {}) {
  let stopped = false;
  return {
    getStatusSnapshot: () => (running && !stopped
      ? { running: true, url: 'http://192.168.1.5:9222', pin: '1234', clientCount: 1, tokenShort: 'abcd1234' }
      : { running: false }),
    stopBridgeServer: async () => { stopped = true; },
    _stopped: () => stopped,
  };
}

function baseOpts(over = {}) {
  const connMgr = makeConnectionManager();
  return {
    connMgr,
    store: makeStore(),
    daemonManager: makeDaemon(over.daemon),
    bridge: makeBridge(over.bridge),
    remote: makeRemote(connMgr, over.remoteCfg || {}),
    env: over.env || {},
  };
}

test('connect: resolves host, connects, and writes the durable pointer', async () => {
  const o = baseOpts();
  const res = await svc.connect('dev', o);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.session.hostAlias, 'dev');
  assert.strictEqual(res.descriptor.connectionId, res.session.connectionId);
  assert.strictEqual(o.store._peek().connectionId, res.session.connectionId);
  // unified reflects the new live session
  assert.strictEqual(res.unified.session.state, 'live');
  assert.strictEqual(res.unified.session.remoteWorkspace, '~/app');
});

test('connect: missing host alias is rejected', async () => {
  const res = await svc.connect('', baseOpts());
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'missing_host');
});

test('connect: unknown host alias is reported with the config path', async () => {
  const res = await svc.connect('nope', baseOpts());
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'host_not_found');
  assert.match(res.message, /\.ssh\/config/);
});

test('connect: allowlist (KHY_REMOTE_SSH_ALLOWLIST) blocks non-listed hosts', async () => {
  const o = baseOpts({ env: { KHY_REMOTE_SSH_ALLOWLIST: 'prod,staging' } });
  const res = await svc.connect('dev', o);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'host_not_allowed');
  // an allowed host still connects
  const ok = await svc.connect('dev', baseOpts({ env: { KHY_REMOTE_SSH_ALLOWLIST: 'dev' } }));
  assert.strictEqual(ok.ok, true);
});

test('connect: failed credential guard blocks the connection', async () => {
  const o = baseOpts();
  o.remote.sshCredentialGuard.validateHostCredentials = () => ({ ok: false, code: 'identity_file_missing', message: 'missing key' });
  const res = await svc.connect('dev', o);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'identity_file_missing');
});

test('getUnifiedStatus: aggregates running daemon + running bridge + live session', async () => {
  const o = baseOpts({ daemon: { running: true }, bridge: { running: true } });
  await svc.connect('dev', o);
  const u = await svc.getUnifiedStatus(o);
  assert.strictEqual(u.daemon.running, true);
  assert.strictEqual(u.daemon.port, 9090);
  assert.strictEqual(u.bridge.running, true);
  assert.strictEqual(u.bridge.url, 'http://192.168.1.5:9222');
  assert.strictEqual(u.session.state, 'live');
  // discoverable bridge port derived from the live url, not hardcoded
  const byEnv = Object.fromEntries(u.discoverability.map((r) => [r.env, r.value]));
  assert.strictEqual(String(byEnv.BRIDGE_PORT), '9222');
  assert.strictEqual(String(byEnv.KHY_DAEMON_PORT), '9090');
});

test('attach by connectionId: selects a live session and refreshes the pointer', async () => {
  const o = baseOpts();
  const conn = await svc.connect('dev', o);
  o.store.clearPointer(); // simulate lost pointer
  const res = await svc.attach({ ...o, connectionId: conn.session.connectionId });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(o.store._peek().connectionId, conn.session.connectionId);
  assert.strictEqual(res.reconciled.state, 'live');
});

test('attach by connectionId: non-live id is rejected honestly', async () => {
  const res = await svc.attach({ ...baseOpts(), connectionId: 'ghost' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'session_not_live');
});

test('attach with no pointer and no id → no_session', async () => {
  const res = await svc.attach(baseOpts());
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'no_session');
});

test('attach after restart: pointer survives but registry is empty → recoverable', async () => {
  const o = baseOpts();
  await svc.connect('dev', o);
  // Simulate process restart: keep the durable pointer, wipe the in-memory registry.
  o.connMgr.clearAll();
  const res = await svc.attach(o);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.reconciled.state, 'recoverable');
});

test('stop (default scope=session): clears the session + pointer only', async () => {
  const o = baseOpts({ bridge: { running: true }, daemon: { running: true } });
  await svc.connect('dev', o);
  const res = await svc.stop(o);
  assert.strictEqual(res.scope, 'session');
  assert.strictEqual(res.sessionCleared, true);
  assert.strictEqual(res.bridgeStopped, false);
  assert.strictEqual(res.daemonStopped, false);
  assert.strictEqual(o.store._peek(), null);
  assert.strictEqual(o.connMgr.listSessions().length, 0);
});

test('stop (scope=all): tears down session + bridge + daemon', async () => {
  const o = baseOpts({ bridge: { running: true }, daemon: { running: true } });
  await svc.connect('dev', o);
  const res = await svc.stop({ ...o, scope: 'all' });
  assert.strictEqual(res.scope, 'all');
  assert.strictEqual(res.sessionCleared, true);
  assert.strictEqual(res.bridgeStopped, true);
  assert.strictEqual(res.daemonStopped, true);
  assert.strictEqual(o.bridge._stopped(), true);
});

test('logs: returns the daemon log path and bounded lines', () => {
  const o = baseOpts();
  // getLogPath stubbed to /tmp/daemon.log; file may not exist → error captured, never throws
  const res = svc.logs(o);
  assert.strictEqual(res.logPath, '/tmp/daemon.log');
  assert.ok(Array.isArray(res.lines));
});

test('isEnabled: default on; KHY_REMOTEDEV=0 disables', () => {
  assert.strictEqual(svc.isEnabled({}), true);
  assert.strictEqual(svc.isEnabled({ KHY_REMOTEDEV: '0' }), false);
});
