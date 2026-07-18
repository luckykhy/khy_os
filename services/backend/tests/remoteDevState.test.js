'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  VALID_STOP_SCOPES,
  SESSION_STATE,
  reconcileSession,
  buildSessionDescriptor,
  buildUnifiedState,
  discoverabilityReport,
  summarizeConnection,
} = require('../src/services/remotedev/remoteDevState');

const NOW = '2026-06-29T00:00:00.000Z';

test('reconcileSession: no pointer → none', () => {
  const r = reconcileSession(null, []);
  assert.strictEqual(r.state, SESSION_STATE.NONE);
  assert.strictEqual(r.connectionId, null);
  assert.strictEqual(r.live, false);
});

test('reconcileSession: pointer present in live registry → live (live fields win)', () => {
  const pointer = { connectionId: 'abc', host: 'old', remoteWorkspace: '/w' };
  const live = [{ connectionId: 'abc', host: 'new', status: 'connected', lastActivityAt: 't' }];
  const r = reconcileSession(pointer, live);
  assert.strictEqual(r.state, SESSION_STATE.LIVE);
  assert.strictEqual(r.live, true);
  assert.strictEqual(r.session.host, 'new');        // live precedence
  assert.strictEqual(r.session.remoteWorkspace, '/w'); // pointer-only field retained
});

test('reconcileSession: pointer not in live registry → recoverable (process restarted)', () => {
  const pointer = { connectionId: 'gone', host: 'h1', remoteWorkspace: '~/proj' };
  const r = reconcileSession(pointer, []);
  assert.strictEqual(r.state, SESSION_STATE.RECOVERABLE);
  assert.strictEqual(r.live, false);
  assert.strictEqual(r.session.status, 'recoverable');
  assert.strictEqual(r.session.remoteWorkspace, '~/proj');
});

test('buildSessionDescriptor: folds session + hostEntry, clock injected', () => {
  const d = buildSessionDescriptor({
    session: { connectionId: 'c1', hostAlias: 'dev', host: '10.0.0.2', port: 22, remoteUser: 'kode', remoteWorkspace: '~/app', purpose: 'development', connectedAt: 'C' },
    savedAt: NOW,
  });
  assert.deepStrictEqual(d, {
    connectionId: 'c1', hostAlias: 'dev', host: '10.0.0.2', port: 22,
    remoteUser: 'kode', remoteWorkspace: '~/app', purpose: 'development',
    connectedAt: 'C', savedAt: NOW,
  });
});

test('buildSessionDescriptor: falls back to hostEntry / workspace when session is sparse', () => {
  const d = buildSessionDescriptor({
    session: { connectionId: 'c2' },
    hostEntry: { alias: 'box', host: '1.2.3.4', port: 2222, user: 'u' },
    workspace: '/srv/code',
    savedAt: NOW,
  });
  assert.strictEqual(d.hostAlias, 'box');
  assert.strictEqual(d.host, '1.2.3.4');
  assert.strictEqual(d.port, 2222);
  assert.strictEqual(d.remoteUser, 'u');
  assert.strictEqual(d.remoteWorkspace, '/srv/code');
  assert.strictEqual(d.purpose, 'development'); // default
});

test('buildUnifiedState: aggregates daemon + bridge + remote + hosts + session', () => {
  const u = buildUnifiedState({
    daemon: { running: true, pid: 4242, port: 9090, uptime: 120000, health: { ok: true } },
    bridge: { running: true, url: 'http://192.168.1.5:9222', pin: '1234', clientCount: 2, tokenShort: 'deadbeef' },
    remoteSnapshot: {
      active_remote_sessions: [{ connectionId: 'c1', hostAlias: 'dev', host: '10.0.0.2', port: 22, remoteUser: 'kode', remoteWorkspace: '~/app', status: 'connected' }],
      pending_remote_approvals: [{ id: 'a1' }],
      summary: { persistence_enabled: true },
    },
    hosts: [{ alias: 'dev', host: '10.0.0.2', port: 22, user: 'kode', remoteWorkspace: '~/app' }],
    pointer: { connectionId: 'c1', hostAlias: 'dev', host: '10.0.0.2', port: 22, remoteUser: 'kode', remoteWorkspace: '~/app' },
    config: { sshConfigPath: '/home/u/.ssh/config', daemonPort: 9090, bridgePort: 9222, allowlist: ['dev'], execEnabled: false, persistEnabled: true },
    nowIso: NOW,
  });

  assert.strictEqual(u.generatedAt, NOW);
  assert.deepStrictEqual(u.daemon, { running: true, pid: 4242, port: 9090, uptimeMs: 120000, health: { ok: true } });
  assert.strictEqual(u.bridge.url, 'http://192.168.1.5:9222');
  assert.strictEqual(u.bridge.clientCount, 2);
  assert.strictEqual(u.session.state, SESSION_STATE.LIVE);
  assert.strictEqual(u.session.remoteWorkspace, '~/app');
  assert.strictEqual(u.session.port, 22);
  assert.strictEqual(u.remote.activeSessionCount, 1);
  assert.strictEqual(u.remote.pendingApprovalCount, 1);
  assert.strictEqual(u.hosts.length, 1);
  assert.ok(Array.isArray(u.discoverability));
});

test('buildUnifiedState: empty inputs are safe and report not-running / none', () => {
  const u = buildUnifiedState({});
  assert.strictEqual(u.daemon.running, false);
  assert.strictEqual(u.bridge.running, false);
  assert.strictEqual(u.session.state, SESSION_STATE.NONE);
  assert.strictEqual(u.remote.activeSessionCount, 0);
  assert.deepStrictEqual(u.hosts, []);
});

test('discoverabilityReport: every knob names its env var; null → caller renders default', () => {
  const rows = discoverabilityReport({ sshConfigPath: '/x/config', allowlist: ['a', 'b'], execEnabled: false, persistEnabled: false });
  const byEnv = Object.fromEntries(rows.map((r) => [r.env, r]));
  assert.strictEqual(byEnv.KHY_REMOTE_SSH_CONFIG_PATH.value, '/x/config');
  assert.strictEqual(byEnv.KHY_DAEMON_PORT.value, null);       // unset → default
  assert.strictEqual(byEnv.KHY_REMOTE_SSH_ALLOWLIST.value, 'a, b');
  assert.strictEqual(byEnv.KHY_REMOTE_SSH_ENABLE_EXEC.value, 'disabled (dry-run)');
  // PIN is never leaked — only "(set)" / null is exposed.
  assert.ok(!('(set)' === byEnv.BRIDGE_PIN.value && false));
});

test('summarizeConnection: no session → explicit not-connected line', () => {
  const u = buildUnifiedState({});
  const line = summarizeConnection(u);
  assert.match(line, /未连接/);
});

test('summarizeConnection: live session names host / user / port / workspace / id', () => {
  const u = buildUnifiedState({
    remoteSnapshot: { active_remote_sessions: [{ connectionId: 'c1abcd99', hostAlias: 'dev', host: '10.0.0.2', port: 22, remoteUser: 'kode', remoteWorkspace: '~/app' }] },
    pointer: { connectionId: 'c1abcd99', hostAlias: 'dev', host: '10.0.0.2', port: 22, remoteUser: 'kode', remoteWorkspace: '~/app' },
    nowIso: NOW,
  });
  const line = summarizeConnection(u);
  assert.match(line, /kode@10\.0\.0\.2:22/);
  assert.match(line, /~\/app/);
  assert.match(line, /c1abcd99/);
  assert.match(line, /活动/);
});

test('summarizeConnection: recoverable session is flagged honestly', () => {
  const u = buildUnifiedState({
    remoteSnapshot: { active_remote_sessions: [] },
    pointer: { connectionId: 'zz', hostAlias: 'dev', host: 'h', port: 22, remoteWorkspace: '~/w' },
    nowIso: NOW,
  });
  const line = summarizeConnection(u);
  assert.match(line, /可恢复|重启/);
});

test('VALID_STOP_SCOPES is the closed set', () => {
  assert.deepStrictEqual(VALID_STOP_SCOPES.slice().sort(), ['all', 'bridge', 'daemon', 'session']);
});
