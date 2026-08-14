'use strict';

const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const remoteSshRoute = require('../../src/routes/remoteSsh');
const {
  resetRemoteStateForTests,
  remoteApprovalBridge,
  remoteStatePersistence,
  markPersistenceAlertsAcknowledged,
} = require('../../src/services/remote');

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/remote/ssh', remoteSshRoute);
  return app;
}

function canBindLoopbackSync() {
  const probe = `
    const net = require('net');
    const server = net.createServer();
    server.once('error', () => process.exit(1));
    server.listen(0, '127.0.0.1', () => server.close(() => process.exit(0)));
  `;
  try {
    const result = spawnSync(process.execPath, ['-e', probe], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

const describeWithLoopback = canBindLoopbackSync() ? describe : describe.skip;

function resolveRequestHost(address) {
  if (!address || typeof address !== 'object') return '127.0.0.1';
  if (address.family === 'IPv6' || address.address === '::' || address.address === '::1') {
    return '::1';
  }
  return '127.0.0.1';
}

function sendRequest(server, { method, pathName, body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const address = server.address();
    const req = http.request(
      {
        hostname: resolveRequestHost(address),
        port: address.port,
        path: pathName,
        method,
        headers: payload
          ? {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
            }
          : undefined,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let parsed = {};
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch (error) {
            reject(error);
            return;
          }
          resolve({
            status: res.statusCode || 0,
            body: parsed,
          });
        });
      }
    );

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function parseSseEvents(raw) {
  const events = [];
  const blocks = String(raw || '').split('\n\n');
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    if (lines.every((line) => line.startsWith(':'))) continue;

    let eventName = 'message';
    let eventId = null;
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith('id:')) {
        const parsed = Number.parseInt(line.slice('id:'.length).trim(), 10);
        eventId = Number.isFinite(parsed) ? parsed : null;
      } else if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim() || 'message';
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trim());
      }
    }
    if (dataLines.length === 0) continue;

    const dataText = dataLines.join('\n');
    let data = dataText;
    try {
      data = JSON.parse(dataText);
    } catch {
      // keep raw text
    }
    events.push({ id: eventId, event: eventName, data });
  }
  return events;
}

function sendStreamRequest(server, { method, pathName, body, headers = null }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const address = server.address();
    const requestHeaders = {};
    if (headers && typeof headers === 'object') {
      Object.assign(requestHeaders, headers);
    }
    if (payload) {
      requestHeaders['content-type'] = 'application/json';
      requestHeaders['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request(
      {
        hostname: resolveRequestHost(address),
        port: address.port,
        path: pathName,
        method,
        headers: Object.keys(requestHeaders).length > 0 ? requestHeaders : undefined,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            raw,
            events: parseSseEvents(raw),
          });
        });
      }
    );

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function openSseAndAbortOnEvent(server, { pathName, eventName = 'ready', headers = null }) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const requestHeaders = {};
    if (headers && typeof headers === 'object') {
      Object.assign(requestHeaders, headers);
    }

    let settled = false;
    const req = http.request(
      {
        hostname: resolveRequestHost(address),
        port: address.port,
        path: pathName,
        method: 'GET',
        headers: Object.keys(requestHeaders).length > 0 ? requestHeaders : undefined,
      },
      (res) => {
        let raw = '';
        let aborted = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve({
            status: res.statusCode || 0,
            raw,
            events: parseSseEvents(raw),
            aborted,
          });
        };

        res.on('data', (chunk) => {
          raw += String(chunk || '');
          if (!aborted && raw.includes(`event: ${eventName}`)) {
            aborted = true;
            req.destroy();
          }
        });
        res.on('end', finish);
        res.on('close', finish);
        res.on('error', (error) => {
          if (aborted) {
            finish();
            return;
          }
          if (settled) return;
          settled = true;
          reject(error);
        });
      }
    );

    req.on('error', (error) => {
      if (settled) return;
      if (error && error.code === 'ECONNRESET') return;
      if (req.destroyed) return;
      settled = true;
      reject(error);
    });

    req.end();
  });
}

function watchSseUntilEvent(
  server,
  {
    pathName,
    targetEvent = 'persistence_alert',
    shouldStop = null,
    headers = null,
    timeoutMs = 2500,
    onReady = null,
  }
) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const requestHeaders = {};
    if (headers && typeof headers === 'object') {
      Object.assign(requestHeaders, headers);
    }

    let settled = false;
    let readyTriggered = false;
    let observedCount = 0;
    let timedOut = false;
    const req = http.request(
      {
        hostname: resolveRequestHost(address),
        port: address.port,
        path: pathName,
        method: 'GET',
        headers: Object.keys(requestHeaders).length > 0 ? requestHeaders : undefined,
      },
      (res) => {
        let raw = '';
        let aborted = false;
        let timeoutTimer = null;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (timeoutTimer) {
            clearTimeout(timeoutTimer);
            timeoutTimer = null;
          }
          resolve({
            status: res.statusCode || 0,
            raw,
            events: parseSseEvents(raw),
            aborted,
            timedOut,
          });
        };

        timeoutTimer = setTimeout(() => {
          if (aborted || settled) return;
          timedOut = true;
          aborted = true;
          req.destroy();
        }, Math.max(100, timeoutMs));

        res.on('data', (chunk) => {
          raw += String(chunk || '');
          const events = parseSseEvents(raw);
          if (events.length <= observedCount) return;
          for (let i = observedCount; i < events.length; i += 1) {
            const eventItem = events[i];
            if (!readyTriggered && eventItem.event === 'ready') {
              readyTriggered = true;
              if (typeof onReady === 'function') {
                Promise.resolve()
                  .then(() => onReady(eventItem))
                  .catch((error) => {
                    if (settled) return;
                    settled = true;
                    if (timeoutTimer) clearTimeout(timeoutTimer);
                    reject(error);
                  });
              }
            }
            if (!aborted && eventItem.event === targetEvent) {
              let stopMatched = true;
              if (typeof shouldStop === 'function') {
                try {
                  stopMatched = Boolean(shouldStop(eventItem));
                } catch (error) {
                  if (!settled) {
                    settled = true;
                    if (timeoutTimer) clearTimeout(timeoutTimer);
                    reject(error);
                  }
                  return;
                }
              }
              if (stopMatched) {
                aborted = true;
                req.destroy();
                break;
              }
            }
          }
          observedCount = events.length;
        });
        res.on('end', finish);
        res.on('close', finish);
        res.on('error', (error) => {
          if (aborted || timedOut) {
            finish();
            return;
          }
          if (settled) return;
          settled = true;
          if (timeoutTimer) clearTimeout(timeoutTimer);
          reject(error);
        });
      }
    );

    req.on('error', (error) => {
      if (settled) return;
      if (error && error.code === 'ECONNRESET') return;
      if (req.destroyed) return;
      settled = true;
      reject(error);
    });

    req.end();
  });
}

describeWithLoopback('remoteSsh route scaffold', () => {
  const originalConfigPath = process.env.KHY_REMOTE_SSH_CONFIG_PATH;
  const originalAllowlist = process.env.KHY_REMOTE_SSH_ALLOWLIST;
  const originalExecEnabled = process.env.KHY_REMOTE_SSH_ENABLE_EXEC;
  let tempDir;
  let app;
  let server;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-remote-ssh-'));

    const keyPath = path.join(tempDir, 'id_ed25519');
    fs.writeFileSync(keyPath, 'dummy-private-key', 'utf8');
    fs.chmodSync(keyPath, 0o600);

    const configPath = path.join(tempDir, 'config');
    const configText = [
      'Host *',
      '  User default-user',
      '  Port 22',
      '',
      'Host demo',
      '  HostName 10.0.0.8',
      `  IdentityFile ${keyPath}`,
      '  User devops',
      '  Port 2222',
      '',
    ].join('\n');

    fs.writeFileSync(configPath, configText, 'utf8');
    process.env.KHY_REMOTE_SSH_CONFIG_PATH = configPath;

    app = createTestApp();
    return new Promise((resolve, reject) => {
      server = app.listen(0, resolve);
      server.once('error', reject);
    });
  });

  beforeEach(() => {
    resetRemoteStateForTests();
    if (originalAllowlist === undefined) {
      delete process.env.KHY_REMOTE_SSH_ALLOWLIST;
    } else {
      process.env.KHY_REMOTE_SSH_ALLOWLIST = originalAllowlist;
    }
    if (originalExecEnabled === undefined) {
      delete process.env.KHY_REMOTE_SSH_ENABLE_EXEC;
    } else {
      process.env.KHY_REMOTE_SSH_ENABLE_EXEC = originalExecEnabled;
    }
  });

  afterAll(() => {
    resetRemoteStateForTests();

    if (originalConfigPath === undefined) {
      delete process.env.KHY_REMOTE_SSH_CONFIG_PATH;
    } else {
      process.env.KHY_REMOTE_SSH_CONFIG_PATH = originalConfigPath;
    }

    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    if (originalAllowlist === undefined) {
      delete process.env.KHY_REMOTE_SSH_ALLOWLIST;
    } else {
      process.env.KHY_REMOTE_SSH_ALLOWLIST = originalAllowlist;
    }

    if (originalExecEnabled === undefined) {
      delete process.env.KHY_REMOTE_SSH_ENABLE_EXEC;
    } else {
      process.env.KHY_REMOTE_SSH_ENABLE_EXEC = originalExecEnabled;
    }

    if (!server) return undefined;
    return new Promise((resolve) => {
      server.close(resolve);
    });
  });

  test('GET /hosts returns discovered hosts', async () => {
    const res = await sendRequest(server, { method: 'GET', pathName: '/api/remote/ssh/hosts' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.total_hosts).toBe(1);
    expect(res.body.data.hosts[0].alias).toBe('demo');
  });

  test('POST /connect + /exec dry_run + /disconnect works in safe scaffold mode', async () => {
    const connectRes = await sendRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/connect',
      body: { hostAlias: 'demo', workspace: '~/project' },
    });

    expect(connectRes.status).toBe(200);
    expect(connectRes.body.success).toBe(true);
    expect(connectRes.body.data.status).toBe('connected');

    const connectionId = connectRes.body.data.connection_id;

    const dryRunRes = await sendRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/exec',
      body: {
        connection_id: connectionId,
        commands: ['npm test'],
      },
    });

    expect(dryRunRes.status).toBe(200);
    expect(dryRunRes.body.success).toBe(true);
    expect(dryRunRes.body.data.status).toBe('dry_run');
    expect(Array.isArray(dryRunRes.body.data.steps)).toBe(true);

    const disconnectRes = await sendRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/disconnect',
      body: { connection_id: connectionId },
    });

    expect(disconnectRes.status).toBe(200);
    expect(disconnectRes.body.success).toBe(true);
    expect(disconnectRes.body.data.status).toBe('disconnected');
  });

  test('POST /exec requires idempotency_key when dry_run is false', async () => {
    const connectRes = await sendRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/connect',
      body: { hostAlias: 'demo' },
    });

    const connectionId = connectRes.body.data.connection_id;

    const execRes = await sendRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/exec',
      body: {
        connection_id: connectionId,
        commands: ['echo hello'],
        dry_run: false,
      },
    });

    expect(execRes.status).toBe(400);
    expect(execRes.body.success).toBe(false);
    expect(execRes.body.message).toContain('idempotency_key');
  });

  test('POST /exec returns approval_required for risky command', async () => {
    const connectRes = await sendRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/connect',
      body: { hostAlias: 'demo' },
    });

    const connectionId = connectRes.body.data.connection_id;

    const execRes = await sendRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/exec',
      body: {
        connection_id: connectionId,
        commands: ['rm -rf /tmp/old-build'],
        dry_run: false,
        idempotency_key: 'idem-001',
      },
    });

    expect(execRes.status).toBe(202);
    expect(execRes.body.success).toBe(true);
    expect(execRes.body.data.status).toBe('approval_required');
    expect(execRes.body.data.approval_ticket).toBeTruthy();
    expect(execRes.body.data.approval_ticket.risk_level).toBe('critical');
  });

  test('GET /sessions returns summary payload', async () => {
    const res = await sendRequest(server, { method: 'GET', pathName: '/api/remote/ssh/sessions' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.summary).toBeTruthy();
    expect(typeof res.body.data.summary.active_session_count).toBe('number');
    expect(typeof res.body.data.summary.pending_approval_count).toBe('number');
    expect(typeof res.body.data.summary.persistence_enabled).toBe('boolean');
    expect(typeof res.body.data.summary.persistence_alert_count).toBe('number');
    expect(res.body.data.persistence).toBeTruthy();
    expect(typeof res.body.data.persistence.enabled).toBe('boolean');
    expect(typeof res.body.data.persistence.alert_subscriber_total).toBe('number');
    expect(res.body.data.last_hydration).toBeTruthy();
    expect(typeof res.body.data.last_hydration.reason_code).toBe('string');
    expect(typeof res.body.data.last_hydration.duration_ms).toBe('number');
  });

  test('POST /connect rejects hostAlias outside allowlist', async () => {
    process.env.KHY_REMOTE_SSH_ALLOWLIST = 'allowed-a,allowed-b';
    const res = await sendRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/connect',
      body: { hostAlias: 'demo' },
    });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain('不在允许列表中');
  });

  test('approval decision flow: pending -> approve -> exec returns execution_disabled in safe mode', async () => {
    const connectRes = await sendRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/connect',
      body: { hostAlias: 'demo' },
    });
    const connectionId = connectRes.body.data.connection_id;

    const createApprovalRes = await sendRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/exec',
      body: {
        connection_id: connectionId,
        commands: ['rm -rf /tmp/need-approval'],
        dry_run: false,
        idempotency_key: 'idem-approval-001',
      },
    });
    expect(createApprovalRes.status).toBe(202);
    expect(createApprovalRes.body.data.status).toBe('approval_required');
    const ticketId = createApprovalRes.body.data.approval_ticket.ticket_id;

    const pendingRes = await sendRequest(server, {
      method: 'GET',
      pathName: '/api/remote/ssh/approvals/pending',
    });
    expect(pendingRes.status).toBe(200);
    expect(pendingRes.body.success).toBe(true);
    expect(pendingRes.body.data.approvals.some((item) => item.ticket_id === ticketId)).toBe(true);

    const approveRes = await sendRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/approvals/decision',
      body: {
        ticket_id: ticketId,
        decision: 'approve',
        reviewer: 'tester',
      },
    });
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.success).toBe(true);
    expect(approveRes.body.data.ticket.status).toBe('approved');

    const execWithApprovalRes = await sendRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/exec',
      body: {
        connection_id: connectionId,
        commands: ['rm -rf /tmp/need-approval'],
        dry_run: false,
        idempotency_key: 'idem-approval-001',
        approval_ticket_id: ticketId,
      },
    });
    expect(execWithApprovalRes.status).toBe(409);
    expect(execWithApprovalRes.body.success).toBe(false);
    expect(execWithApprovalRes.body.data.status).toBe('execution_disabled');
  });

  test('approval decision rejects second decision on same ticket', async () => {
    const connectRes = await sendRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/connect',
      body: { hostAlias: 'demo' },
    });
    const connectionId = connectRes.body.data.connection_id;

    const createApprovalRes = await sendRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/exec',
      body: {
        connection_id: connectionId,
        commands: ['rm -rf /tmp/need-reject'],
        dry_run: false,
        idempotency_key: 'idem-approval-002',
      },
    });
    const ticketId = createApprovalRes.body.data.approval_ticket.ticket_id;

    const rejectRes = await sendRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/approvals/decision',
      body: {
        ticket_id: ticketId,
        decision: 'reject',
        reviewer: 'tester',
      },
    });
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.data.ticket.status).toBe('rejected');

    const secondDecisionRes = await sendRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/approvals/decision',
      body: {
        ticket_id: ticketId,
        decision: 'approve',
        reviewer: 'tester',
      },
    });
    expect(secondDecisionRes.status).toBe(409);
    expect(secondDecisionRes.body.success).toBe(false);
  });

  test('POST /exec/stream emits start/result/done for dry run', async () => {
    const connectRes = await sendRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/connect',
      body: { hostAlias: 'demo' },
    });
    const connectionId = connectRes.body.data.connection_id;

    const streamRes = await sendStreamRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/exec/stream',
      body: {
        connection_id: connectionId,
        commands: ['echo stream'],
        dry_run: true,
      },
    });

    expect(streamRes.status).toBe(200);
    const names = streamRes.events.map((item) => item.event);
    expect(names).toContain('start');
    expect(names).toContain('result');
    expect(names).toContain('done');

    const resultEvent = streamRes.events.find((item) => item.event === 'result');
    expect(resultEvent).toBeTruthy();
    expect(resultEvent.data.status).toBe('dry_run');
  });

  test('POST /exec/stream emits approval-required flow for risky command', async () => {
    const connectRes = await sendRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/connect',
      body: { hostAlias: 'demo' },
    });
    const connectionId = connectRes.body.data.connection_id;

    const streamRes = await sendStreamRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/exec/stream',
      body: {
        connection_id: connectionId,
        commands: ['rm -rf /tmp/stream-approval'],
        dry_run: false,
        idempotency_key: 'idem-stream-approval',
      },
    });

    expect(streamRes.status).toBe(200);
    const resultEvent = streamRes.events.find((item) => item.event === 'result');
    expect(resultEvent).toBeTruthy();
    expect(resultEvent.data.status).toBe('approval_required');

    const remoteEvent = streamRes.events.find((item) => item.event === 'remote_event');
    expect(remoteEvent).toBeTruthy();
    expect(remoteEvent.data.kind).toBe('remote_approval_required');
  });

  test('POST /exec/stream replays from Last-Event-ID on reconnect', async () => {
    const connectRes = await sendRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/connect',
      body: { hostAlias: 'demo' },
    });
    const connectionId = connectRes.body.data.connection_id;
    const streamId = 'stream-replay-test';

    const first = await sendStreamRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/exec/stream',
      body: {
        stream_id: streamId,
        connection_id: connectionId,
        commands: ['echo replay'],
        dry_run: true,
      },
    });

    expect(first.status).toBe(200);
    const firstStart = first.events.find((item) => item.event === 'start');
    const firstResult = first.events.find((item) => item.event === 'result');
    const firstDone = first.events.find((item) => item.event === 'done');
    expect(firstStart).toBeTruthy();
    expect(firstResult).toBeTruthy();
    expect(firstDone).toBeTruthy();
    expect(typeof firstStart.id).toBe('number');
    expect(typeof firstResult.id).toBe('number');
    expect(typeof firstDone.id).toBe('number');

    const resumed = await sendStreamRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/exec/stream',
      headers: {
        'last-event-id': String(firstStart.id),
      },
      body: {
        stream_id: streamId,
      },
    });

    expect(resumed.status).toBe(200);
    expect(resumed.events.some((item) => item.event === 'start')).toBe(false);
    expect(resumed.events.some((item) => item.event === 'result')).toBe(true);
    expect(resumed.events.some((item) => item.event === 'done')).toBe(true);
    const resumedIds = resumed.events.map((item) => item.id).filter((id) => typeof id === 'number');
    expect(resumedIds.length).toBeGreaterThanOrEqual(2);
    expect(Math.min(...resumedIds)).toBeGreaterThan(firstStart.id);
  });

  test('POST /exec/stream resume-only returns 404 when stream_id is unknown', async () => {
    const res = await sendRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/exec/stream',
      body: {
        stream_id: 'stream-not-found',
      },
    });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain('未找到对应 stream_id');
  });

  test('POST /exec/stream returns 409 when same stream_id is reused with different payload', async () => {
    const connectRes = await sendRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/connect',
      body: { hostAlias: 'demo' },
    });
    const connectionId = connectRes.body.data.connection_id;
    const streamId = 'stream-payload-conflict';

    const first = await sendStreamRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/exec/stream',
      body: {
        stream_id: streamId,
        connection_id: connectionId,
        commands: ['echo stable'],
        dry_run: true,
      },
    });
    expect(first.status).toBe(200);

    const second = await sendRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/exec/stream',
      body: {
        stream_id: streamId,
        connection_id: connectionId,
        commands: ['echo changed'],
        dry_run: true,
      },
    });

    expect(second.status).toBe(409);
    expect(second.body.success).toBe(false);
    expect(second.body.data.code).toBe('stream_payload_conflict');
  });

  test('GET /exec/stream/:streamId returns summary and replay events', async () => {
    const connectRes = await sendRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/connect',
      body: { hostAlias: 'demo' },
    });
    const connectionId = connectRes.body.data.connection_id;
    const streamId = 'stream-query-test';

    const streamRes = await sendStreamRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/exec/stream',
      body: {
        stream_id: streamId,
        connection_id: connectionId,
        commands: ['echo query'],
        dry_run: true,
      },
    });
    expect(streamRes.status).toBe(200);
    const startEvent = streamRes.events.find((item) => item.event === 'start');
    expect(startEvent).toBeTruthy();
    expect(typeof startEvent.id).toBe('number');

    const queryRes = await sendRequest(server, {
      method: 'GET',
      pathName: `/api/remote/ssh/exec/stream/${streamId}?after_seq=${startEvent.id}`,
    });

    expect(queryRes.status).toBe(200);
    expect(queryRes.body.success).toBe(true);
    expect(queryRes.body.data.stream.stream_id).toBe(streamId);
    expect(queryRes.body.data.stream.done).toBe(true);
    const replayEvents = queryRes.body.data.replay.events;
    expect(Array.isArray(replayEvents)).toBe(true);
    expect(replayEvents.length).toBeGreaterThanOrEqual(2);
    expect(replayEvents.every((item) => item.seq > startEvent.id)).toBe(true);
    expect(replayEvents.some((item) => item.event === 'done')).toBe(true);
  });

  test('GET /exec/stream/:streamId returns 404 when stream is missing', async () => {
    const res = await sendRequest(server, {
      method: 'GET',
      pathName: '/api/remote/ssh/exec/stream/stream-missing-test',
    });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain('未找到对应 stream_id');
  });

  test('GET /alerts/persistence returns list payload', async () => {
    const res = await sendRequest(server, {
      method: 'GET',
      pathName: '/api/remote/ssh/alerts/persistence?limit=10',
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.data.total).toBe('number');
    expect(Array.isArray(res.body.data.alerts)).toBe(true);
    expect(typeof res.body.data.limit).toBe('number');
  });

  test('GET /alerts/persistence supports only_unacked filter', async () => {
    const originalIsEnabled = remoteStatePersistence.isEnabled;
    const originalSave = remoteStatePersistence.save;

    try {
      remoteStatePersistence.isEnabled = () => true;
      remoteStatePersistence.save = () => ({
        saved: false,
        reason: 'mocked_persist_failure',
      });

      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-only-unacked-1',
        connectionId: 'conn-alert-route-only-unacked-1',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-only-unacked-1'],
        idempotencyKey: 'idem-alert-route-only-unacked-1',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-only-unacked-2',
        connectionId: 'conn-alert-route-only-unacked-2',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-only-unacked-2'],
        idempotencyKey: 'idem-alert-route-only-unacked-2',
        riskContext: { source: 'route-test' },
      });

      const listRes = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence?after_id=0&limit=20',
      });
      expect(listRes.status).toBe(200);
      const alerts = Array.isArray(listRes.body.data.alerts) ? listRes.body.data.alerts : [];
      expect(alerts.length).toBeGreaterThanOrEqual(2);

      const firstAlertId = alerts[0].alert_id;
      const ackRes = await sendRequest(server, {
        method: 'POST',
        pathName: '/api/remote/ssh/alerts/persistence/ack',
        body: {
          alert_id: firstAlertId,
          reviewer: 'tester-only-unacked',
        },
      });
      expect(ackRes.status).toBe(200);
      expect(ackRes.body.success).toBe(true);
      expect(ackRes.body.data.acked_count).toBe(1);

      const unackedRes = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence?after_id=0&limit=20&only_unacked=1',
      });
      expect(unackedRes.status).toBe(200);
      expect(unackedRes.body.success).toBe(true);
      expect(unackedRes.body.data.only_unacked).toBe(true);
      const unackedAlerts = Array.isArray(unackedRes.body.data.alerts)
        ? unackedRes.body.data.alerts
        : [];
      expect(unackedAlerts.length).toBeGreaterThanOrEqual(1);
      expect(unackedAlerts.every((item) => item.acked === false)).toBe(true);
      expect(unackedAlerts.some((item) => item.alert_id === firstAlertId)).toBe(false);
      expect(unackedRes.body.data.latest_unacked).toBeTruthy();
      expect(unackedRes.body.data.latest_unacked.acked).toBe(false);
    } finally {
      remoteStatePersistence.isEnabled = originalIsEnabled;
      remoteStatePersistence.save = originalSave;
    }
  });

  test('POST /alerts/persistence/ack returns 404 when target alert is already acknowledged', async () => {
    const originalIsEnabled = remoteStatePersistence.isEnabled;
    const originalSave = remoteStatePersistence.save;

    try {
      remoteStatePersistence.isEnabled = () => true;
      remoteStatePersistence.save = () => ({
        saved: false,
        reason: 'mocked_persist_failure',
      });

      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-ack-404-1',
        connectionId: 'conn-alert-route-ack-404-1',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-ack-404'],
        idempotencyKey: 'idem-alert-route-ack-404-1',
        riskContext: { source: 'route-test' },
      });

      const listRes = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence?after_id=0&limit=20',
      });
      expect(listRes.status).toBe(200);
      const alerts = Array.isArray(listRes.body.data.alerts) ? listRes.body.data.alerts : [];
      expect(alerts.length).toBeGreaterThanOrEqual(1);
      const alertId = alerts[0].alert_id;

      const ackOnce = await sendRequest(server, {
        method: 'POST',
        pathName: '/api/remote/ssh/alerts/persistence/ack',
        body: {
          alert_id: alertId,
          reviewer: 'tester-ack-404',
        },
      });
      expect(ackOnce.status).toBe(200);
      expect(ackOnce.body.success).toBe(true);
      expect(ackOnce.body.data.acked_count).toBe(1);

      const ackAgain = await sendRequest(server, {
        method: 'POST',
        pathName: '/api/remote/ssh/alerts/persistence/ack',
        body: {
          alert_id: alertId,
          reviewer: 'tester-ack-404',
        },
      });
      expect(ackAgain.status).toBe(404);
      expect(ackAgain.body.success).toBe(false);
      expect(ackAgain.body.message).toContain('未找到可确认的告警');
    } finally {
      remoteStatePersistence.isEnabled = originalIsEnabled;
      remoteStatePersistence.save = originalSave;
    }
  });

  test('POST /alerts/persistence/ack prioritizes alert_id when alert_id and up_to_id are both provided', async () => {
    const originalIsEnabled = remoteStatePersistence.isEnabled;
    const originalSave = remoteStatePersistence.save;

    try {
      remoteStatePersistence.isEnabled = () => true;
      remoteStatePersistence.save = () => ({
        saved: false,
        reason: 'mocked_persist_failure',
      });

      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-ack-priority-1',
        connectionId: 'conn-alert-route-ack-priority-1',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-ack-priority-1'],
        idempotencyKey: 'idem-alert-route-ack-priority-1',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-ack-priority-2',
        connectionId: 'conn-alert-route-ack-priority-2',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-ack-priority-2'],
        idempotencyKey: 'idem-alert-route-ack-priority-2',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-ack-priority-3',
        connectionId: 'conn-alert-route-ack-priority-3',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-ack-priority-3'],
        idempotencyKey: 'idem-alert-route-ack-priority-3',
        riskContext: { source: 'route-test' },
      });

      const listRes = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence?after_id=0&limit=20',
      });
      expect(listRes.status).toBe(200);
      const alerts = Array.isArray(listRes.body.data.alerts) ? listRes.body.data.alerts : [];
      expect(alerts.length).toBeGreaterThanOrEqual(3);
      const targetId = alerts[2].alert_id;

      const ackRes = await sendRequest(server, {
        method: 'POST',
        pathName: '/api/remote/ssh/alerts/persistence/ack',
        body: {
          alert_id: targetId,
          up_to_id: targetId,
          reviewer: 'tester-ack-priority',
        },
      });
      expect(ackRes.status).toBe(200);
      expect(ackRes.body.success).toBe(true);
      expect(ackRes.body.data.acked_count).toBe(1);
      expect(Array.isArray(ackRes.body.data.alerts)).toBe(true);
      expect(ackRes.body.data.alerts).toHaveLength(1);
      expect(ackRes.body.data.alerts[0].alert_id).toBe(targetId);

      const unackedRes = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence?after_id=0&limit=20&only_unacked=1',
      });
      expect(unackedRes.status).toBe(200);
      expect(unackedRes.body.success).toBe(true);
      const unackedAlerts = Array.isArray(unackedRes.body.data.alerts)
        ? unackedRes.body.data.alerts
        : [];
      expect(unackedAlerts.length).toBeGreaterThanOrEqual(2);
      expect(unackedAlerts.some((item) => item.alert_id === targetId)).toBe(false);
    } finally {
      remoteStatePersistence.isEnabled = originalIsEnabled;
      remoteStatePersistence.save = originalSave;
    }
  });

  test('POST /alerts/persistence/ack acknowledges multiple alerts when only up_to_id is provided', async () => {
    const originalIsEnabled = remoteStatePersistence.isEnabled;
    const originalSave = remoteStatePersistence.save;

    try {
      remoteStatePersistence.isEnabled = () => true;
      remoteStatePersistence.save = () => ({
        saved: false,
        reason: 'mocked_persist_failure',
      });

      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-ack-upto-1',
        connectionId: 'conn-alert-route-ack-upto-1',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-ack-upto-1'],
        idempotencyKey: 'idem-alert-route-ack-upto-1',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-ack-upto-2',
        connectionId: 'conn-alert-route-ack-upto-2',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-ack-upto-2'],
        idempotencyKey: 'idem-alert-route-ack-upto-2',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-ack-upto-3',
        connectionId: 'conn-alert-route-ack-upto-3',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-ack-upto-3'],
        idempotencyKey: 'idem-alert-route-ack-upto-3',
        riskContext: { source: 'route-test' },
      });

      const listRes = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence?after_id=0&limit=20',
      });
      expect(listRes.status).toBe(200);
      const alerts = Array.isArray(listRes.body.data.alerts) ? listRes.body.data.alerts : [];
      expect(alerts.length).toBeGreaterThanOrEqual(3);
      const upToId = alerts[1].alert_id;

      const ackRes = await sendRequest(server, {
        method: 'POST',
        pathName: '/api/remote/ssh/alerts/persistence/ack',
        body: {
          up_to_id: upToId,
          reviewer: 'tester-ack-upto',
        },
      });
      expect(ackRes.status).toBe(200);
      expect(ackRes.body.success).toBe(true);
      expect(ackRes.body.data.acked_count).toBe(2);
      expect(Array.isArray(ackRes.body.data.alerts)).toBe(true);
      expect(ackRes.body.data.alerts).toHaveLength(2);
      expect(ackRes.body.data.alerts.every((item) => item.alert_id <= upToId)).toBe(true);
      expect(ackRes.body.data.alerts.every((item) => item.acked === true)).toBe(true);

      const unackedRes = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence?after_id=0&limit=20&only_unacked=1',
      });
      expect(unackedRes.status).toBe(200);
      expect(unackedRes.body.success).toBe(true);
      const unackedAlerts = Array.isArray(unackedRes.body.data.alerts)
        ? unackedRes.body.data.alerts
        : [];
      expect(unackedAlerts.length).toBeGreaterThanOrEqual(1);
      expect(unackedAlerts.some((item) => item.alert_id <= upToId)).toBe(false);
    } finally {
      remoteStatePersistence.isEnabled = originalIsEnabled;
      remoteStatePersistence.save = originalSave;
    }
  });

  test('POST /alerts/persistence/ack returns 400 when up_to_id is zero', async () => {
    const res = await sendRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/alerts/persistence/ack',
      body: {
        up_to_id: 0,
        reviewer: 'tester-ack-invalid-upto',
      },
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain('alert_id 或 up_to_id 至少提供一个');
  });

  test('POST /alerts/persistence/ack returns 400 when up_to_id is not a number', async () => {
    const res = await sendRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/alerts/persistence/ack',
      body: {
        up_to_id: 'abc',
        reviewer: 'tester-ack-invalid-upto-string',
      },
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain('alert_id 或 up_to_id 至少提供一个');
  });

  test('POST /alerts/persistence/ack returns 400 when alert_id is not a number', async () => {
    const res = await sendRequest(server, {
      method: 'POST',
      pathName: '/api/remote/ssh/alerts/persistence/ack',
      body: {
        alert_id: 'abc',
        reviewer: 'tester-ack-invalid-alert-id',
      },
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain('alert_id 或 up_to_id 至少提供一个');
  });

  test('POST /alerts/persistence/ack uses up_to_id when alert_id is invalid', async () => {
    const originalIsEnabled = remoteStatePersistence.isEnabled;
    const originalSave = remoteStatePersistence.save;

    try {
      remoteStatePersistence.isEnabled = () => true;
      remoteStatePersistence.save = () => ({
        saved: false,
        reason: 'mocked_persist_failure',
      });

      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-ack-fallback-1',
        connectionId: 'conn-alert-route-ack-fallback-1',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-ack-fallback-1'],
        idempotencyKey: 'idem-alert-route-ack-fallback-1',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-ack-fallback-2',
        connectionId: 'conn-alert-route-ack-fallback-2',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-ack-fallback-2'],
        idempotencyKey: 'idem-alert-route-ack-fallback-2',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-ack-fallback-3',
        connectionId: 'conn-alert-route-ack-fallback-3',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-ack-fallback-3'],
        idempotencyKey: 'idem-alert-route-ack-fallback-3',
        riskContext: { source: 'route-test' },
      });

      const listRes = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence?after_id=0&limit=20',
      });
      expect(listRes.status).toBe(200);
      const alerts = Array.isArray(listRes.body.data.alerts) ? listRes.body.data.alerts : [];
      expect(alerts.length).toBeGreaterThanOrEqual(3);
      const upToId = alerts[1].alert_id;

      const ackRes = await sendRequest(server, {
        method: 'POST',
        pathName: '/api/remote/ssh/alerts/persistence/ack',
        body: {
          alert_id: 'abc',
          up_to_id: upToId,
          reviewer: 'tester-ack-fallback',
        },
      });
      expect(ackRes.status).toBe(200);
      expect(ackRes.body.success).toBe(true);
      expect(ackRes.body.data.acked_count).toBe(2);
      expect(Array.isArray(ackRes.body.data.alerts)).toBe(true);
      expect(ackRes.body.data.alerts).toHaveLength(2);
      expect(ackRes.body.data.alerts.every((item) => item.alert_id <= upToId)).toBe(true);

      const unackedRes = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence?after_id=0&limit=20&only_unacked=1',
      });
      expect(unackedRes.status).toBe(200);
      expect(unackedRes.body.success).toBe(true);
      const unackedAlerts = Array.isArray(unackedRes.body.data.alerts)
        ? unackedRes.body.data.alerts
        : [];
      expect(unackedAlerts.length).toBeGreaterThanOrEqual(1);
      expect(unackedAlerts.some((item) => item.alert_id <= upToId)).toBe(false);
    } finally {
      remoteStatePersistence.isEnabled = originalIsEnabled;
      remoteStatePersistence.save = originalSave;
    }
  });

  test('POST /alerts/persistence/ack uses alert_id when up_to_id is invalid', async () => {
    const originalIsEnabled = remoteStatePersistence.isEnabled;
    const originalSave = remoteStatePersistence.save;

    try {
      remoteStatePersistence.isEnabled = () => true;
      remoteStatePersistence.save = () => ({
        saved: false,
        reason: 'mocked_persist_failure',
      });

      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-ack-fallback-rev-1',
        connectionId: 'conn-alert-route-ack-fallback-rev-1',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-ack-fallback-rev-1'],
        idempotencyKey: 'idem-alert-route-ack-fallback-rev-1',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-ack-fallback-rev-2',
        connectionId: 'conn-alert-route-ack-fallback-rev-2',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-ack-fallback-rev-2'],
        idempotencyKey: 'idem-alert-route-ack-fallback-rev-2',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-ack-fallback-rev-3',
        connectionId: 'conn-alert-route-ack-fallback-rev-3',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-ack-fallback-rev-3'],
        idempotencyKey: 'idem-alert-route-ack-fallback-rev-3',
        riskContext: { source: 'route-test' },
      });

      const listRes = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence?after_id=0&limit=20',
      });
      expect(listRes.status).toBe(200);
      const alerts = Array.isArray(listRes.body.data.alerts) ? listRes.body.data.alerts : [];
      expect(alerts.length).toBeGreaterThanOrEqual(3);
      const targetId = alerts[2].alert_id;

      const ackRes = await sendRequest(server, {
        method: 'POST',
        pathName: '/api/remote/ssh/alerts/persistence/ack',
        body: {
          alert_id: targetId,
          up_to_id: 'abc',
          reviewer: 'tester-ack-fallback-rev',
        },
      });
      expect(ackRes.status).toBe(200);
      expect(ackRes.body.success).toBe(true);
      expect(ackRes.body.data.acked_count).toBe(1);
      expect(Array.isArray(ackRes.body.data.alerts)).toBe(true);
      expect(ackRes.body.data.alerts).toHaveLength(1);
      expect(ackRes.body.data.alerts[0].alert_id).toBe(targetId);
      expect(ackRes.body.data.alerts[0].acked).toBe(true);

      const unackedRes = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence?after_id=0&limit=20&only_unacked=1',
      });
      expect(unackedRes.status).toBe(200);
      expect(unackedRes.body.success).toBe(true);
      const unackedAlerts = Array.isArray(unackedRes.body.data.alerts)
        ? unackedRes.body.data.alerts
        : [];
      expect(unackedAlerts.length).toBeGreaterThanOrEqual(2);
      expect(unackedAlerts.some((item) => item.alert_id === targetId)).toBe(false);
    } finally {
      remoteStatePersistence.isEnabled = originalIsEnabled;
      remoteStatePersistence.save = originalSave;
    }
  });

  test('GET /alerts/persistence/stream with watch=0 replays alerts and emits done event', async () => {
    const originalIsEnabled = remoteStatePersistence.isEnabled;
    const originalSave = remoteStatePersistence.save;

    try {
      remoteStatePersistence.isEnabled = () => true;
      remoteStatePersistence.save = () => ({
        saved: false,
        reason: 'mocked_persist_failure',
      });

      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-1',
        connectionId: 'conn-alert-route-stream-1',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-1'],
        idempotencyKey: 'idem-alert-route-stream-1',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-2',
        connectionId: 'conn-alert-route-stream-2',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-2'],
        idempotencyKey: 'idem-alert-route-stream-2',
        riskContext: { source: 'route-test' },
      });

      const streamRes = await sendStreamRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence/stream?after_id=0&limit=20&watch=0',
      });

      expect(streamRes.status).toBe(200);
      const readyEvent = streamRes.events.find((item) => item.event === 'ready');
      const doneEvent = streamRes.events.find((item) => item.event === 'done');
      const alertEvents = streamRes.events.filter((item) => item.event === 'persistence_alert');
      expect(readyEvent).toBeTruthy();
      expect(readyEvent.data.watch).toBe(false);
      expect(alertEvents.length).toBeGreaterThanOrEqual(2);
      expect(alertEvents.every((item) => typeof item.id === 'number')).toBe(true);
      expect(doneEvent).toBeTruthy();
      expect(doneEvent.data.status).toBe('replay_complete');
      expect(doneEvent.data.delivered_count).toBe(alertEvents.length);
    } finally {
      remoteStatePersistence.isEnabled = originalIsEnabled;
      remoteStatePersistence.save = originalSave;
    }
  });

  test('GET /alerts/persistence/stream with only_unacked=1 excludes acknowledged alerts', async () => {
    const originalIsEnabled = remoteStatePersistence.isEnabled;
    const originalSave = remoteStatePersistence.save;

    try {
      remoteStatePersistence.isEnabled = () => true;
      remoteStatePersistence.save = () => ({
        saved: false,
        reason: 'mocked_persist_failure',
      });

      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-only-unacked-1',
        connectionId: 'conn-alert-route-stream-only-unacked-1',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-only-unacked-1'],
        idempotencyKey: 'idem-alert-route-stream-only-unacked-1',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-only-unacked-2',
        connectionId: 'conn-alert-route-stream-only-unacked-2',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-only-unacked-2'],
        idempotencyKey: 'idem-alert-route-stream-only-unacked-2',
        riskContext: { source: 'route-test' },
      });

      const listRes = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence?after_id=0&limit=20',
      });
      expect(listRes.status).toBe(200);
      const alerts = Array.isArray(listRes.body.data.alerts) ? listRes.body.data.alerts : [];
      expect(alerts.length).toBeGreaterThanOrEqual(2);
      const ackTargetId = alerts[0].alert_id;

      const ackRes = await sendRequest(server, {
        method: 'POST',
        pathName: '/api/remote/ssh/alerts/persistence/ack',
        body: {
          alert_id: ackTargetId,
          reviewer: 'tester-stream-only-unacked',
        },
      });
      expect(ackRes.status).toBe(200);
      expect(ackRes.body.success).toBe(true);

      const streamRes = await sendStreamRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence/stream?after_id=0&limit=20&watch=0&only_unacked=1',
      });

      expect(streamRes.status).toBe(200);
      const readyEvent = streamRes.events.find((item) => item.event === 'ready');
      const alertEvents = streamRes.events.filter((item) => item.event === 'persistence_alert');
      const doneEvent = streamRes.events.find((item) => item.event === 'done');
      expect(readyEvent).toBeTruthy();
      expect(readyEvent.data.only_unacked).toBe(true);
      expect(alertEvents.length).toBeGreaterThanOrEqual(1);
      expect(alertEvents.every((item) => item.data.acked === false)).toBe(true);
      expect(alertEvents.some((item) => item.data.alert_id === ackTargetId)).toBe(false);
      expect(doneEvent).toBeTruthy();
      expect(doneEvent.data.status).toBe('replay_complete');
      expect(doneEvent.data.delivered_count).toBe(alertEvents.length);
    } finally {
      remoteStatePersistence.isEnabled = originalIsEnabled;
      remoteStatePersistence.save = originalSave;
    }
  });

  test('GET /alerts/persistence/stream reports exact ready.replay_count with only_unacked and after_id filters', async () => {
    const originalIsEnabled = remoteStatePersistence.isEnabled;
    const originalSave = remoteStatePersistence.save;

    try {
      remoteStatePersistence.isEnabled = () => true;
      remoteStatePersistence.save = () => ({
        saved: false,
        reason: 'mocked_persist_failure',
      });

      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-replay-count-1',
        connectionId: 'conn-alert-route-replay-count-1',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-replay-count-1'],
        idempotencyKey: 'idem-alert-route-replay-count-1',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-replay-count-2',
        connectionId: 'conn-alert-route-replay-count-2',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-replay-count-2'],
        idempotencyKey: 'idem-alert-route-replay-count-2',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-replay-count-3',
        connectionId: 'conn-alert-route-replay-count-3',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-replay-count-3'],
        idempotencyKey: 'idem-alert-route-replay-count-3',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-replay-count-4',
        connectionId: 'conn-alert-route-replay-count-4',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-replay-count-4'],
        idempotencyKey: 'idem-alert-route-replay-count-4',
        riskContext: { source: 'route-test' },
      });

      const listRes = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence?after_id=0&limit=20',
      });
      expect(listRes.status).toBe(200);
      const alerts = Array.isArray(listRes.body.data.alerts) ? listRes.body.data.alerts : [];
      expect(alerts.length).toBeGreaterThanOrEqual(4);
      const ids = alerts.map((item) => item.alert_id);

      const ackRes = await sendRequest(server, {
        method: 'POST',
        pathName: '/api/remote/ssh/alerts/persistence/ack',
        body: {
          up_to_id: ids[1],
          reviewer: 'tester-replay-count',
        },
      });
      expect(ackRes.status).toBe(200);
      expect(ackRes.body.success).toBe(true);
      expect(ackRes.body.data.acked_count).toBe(2);

      const streamRes = await sendStreamRequest(server, {
        method: 'GET',
        pathName: `/api/remote/ssh/alerts/persistence/stream?after_id=${ids[0]}&limit=20&watch=0&only_unacked=1`,
      });

      expect(streamRes.status).toBe(200);
      const readyEvent = streamRes.events.find((item) => item.event === 'ready');
      const alertEvents = streamRes.events.filter((item) => item.event === 'persistence_alert');
      const doneEvent = streamRes.events.find((item) => item.event === 'done');
      expect(readyEvent).toBeTruthy();
      expect(readyEvent.data.after_id).toBe(ids[0]);
      expect(readyEvent.data.only_unacked).toBe(true);
      expect(readyEvent.data.replay_count).toBe(2);
      expect(alertEvents).toHaveLength(2);
      expect(alertEvents.map((item) => item.data.alert_id)).toEqual([ids[2], ids[3]]);
      expect(doneEvent).toBeTruthy();
      expect(doneEvent.data.delivered_count).toBe(2);
    } finally {
      remoteStatePersistence.isEnabled = originalIsEnabled;
      remoteStatePersistence.save = originalSave;
    }
  });

  test('GET /alerts/persistence/stream reports exact ready.replay_count under replay limit truncation', async () => {
    const originalIsEnabled = remoteStatePersistence.isEnabled;
    const originalSave = remoteStatePersistence.save;

    try {
      remoteStatePersistence.isEnabled = () => true;
      remoteStatePersistence.save = () => ({
        saved: false,
        reason: 'mocked_persist_failure',
      });

      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-replay-limit-1',
        connectionId: 'conn-alert-route-replay-limit-1',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-replay-limit-1'],
        idempotencyKey: 'idem-alert-route-replay-limit-1',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-replay-limit-2',
        connectionId: 'conn-alert-route-replay-limit-2',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-replay-limit-2'],
        idempotencyKey: 'idem-alert-route-replay-limit-2',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-replay-limit-3',
        connectionId: 'conn-alert-route-replay-limit-3',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-replay-limit-3'],
        idempotencyKey: 'idem-alert-route-replay-limit-3',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-replay-limit-4',
        connectionId: 'conn-alert-route-replay-limit-4',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-replay-limit-4'],
        idempotencyKey: 'idem-alert-route-replay-limit-4',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-replay-limit-5',
        connectionId: 'conn-alert-route-replay-limit-5',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-replay-limit-5'],
        idempotencyKey: 'idem-alert-route-replay-limit-5',
        riskContext: { source: 'route-test' },
      });

      const listRes = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence?after_id=0&limit=20',
      });
      expect(listRes.status).toBe(200);
      const alerts = Array.isArray(listRes.body.data.alerts) ? listRes.body.data.alerts : [];
      expect(alerts.length).toBeGreaterThanOrEqual(5);
      const ids = alerts.map((item) => item.alert_id);
      const afterId = ids[0];
      const expectedReplayIds = [ids[3], ids[4]];

      const streamRes = await sendStreamRequest(server, {
        method: 'GET',
        pathName: `/api/remote/ssh/alerts/persistence/stream?after_id=${afterId}&limit=2&watch=0&only_unacked=1`,
      });

      expect(streamRes.status).toBe(200);
      const readyEvent = streamRes.events.find((item) => item.event === 'ready');
      const alertEvents = streamRes.events.filter((item) => item.event === 'persistence_alert');
      const doneEvent = streamRes.events.find((item) => item.event === 'done');
      expect(readyEvent).toBeTruthy();
      expect(readyEvent.data.after_id).toBe(afterId);
      expect(readyEvent.data.limit).toBe(2);
      expect(readyEvent.data.only_unacked).toBe(true);
      expect(readyEvent.data.replay_count).toBe(2);
      expect(alertEvents).toHaveLength(2);
      expect(alertEvents.map((item) => item.data.alert_id)).toEqual(expectedReplayIds);
      expect(doneEvent).toBeTruthy();
      expect(doneEvent.data.delivered_count).toBe(2);
    } finally {
      remoteStatePersistence.isEnabled = originalIsEnabled;
      remoteStatePersistence.save = originalSave;
    }
  });

  test('GET /alerts/persistence/stream with watch=0 respects replay limit', async () => {
    const originalIsEnabled = remoteStatePersistence.isEnabled;
    const originalSave = remoteStatePersistence.save;

    try {
      remoteStatePersistence.isEnabled = () => true;
      remoteStatePersistence.save = () => ({
        saved: false,
        reason: 'mocked_persist_failure',
      });

      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-limit-watch0-1',
        connectionId: 'conn-alert-route-stream-limit-watch0-1',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-limit-watch0-1'],
        idempotencyKey: 'idem-alert-route-stream-limit-watch0-1',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-limit-watch0-2',
        connectionId: 'conn-alert-route-stream-limit-watch0-2',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-limit-watch0-2'],
        idempotencyKey: 'idem-alert-route-stream-limit-watch0-2',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-limit-watch0-3',
        connectionId: 'conn-alert-route-stream-limit-watch0-3',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-limit-watch0-3'],
        idempotencyKey: 'idem-alert-route-stream-limit-watch0-3',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-limit-watch0-4',
        connectionId: 'conn-alert-route-stream-limit-watch0-4',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-limit-watch0-4'],
        idempotencyKey: 'idem-alert-route-stream-limit-watch0-4',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-limit-watch0-5',
        connectionId: 'conn-alert-route-stream-limit-watch0-5',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-limit-watch0-5'],
        idempotencyKey: 'idem-alert-route-stream-limit-watch0-5',
        riskContext: { source: 'route-test' },
      });

      const listRes = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence?after_id=0&limit=50',
      });
      expect(listRes.status).toBe(200);
      const allAlerts = Array.isArray(listRes.body.data.alerts) ? listRes.body.data.alerts : [];
      expect(allAlerts.length).toBeGreaterThanOrEqual(5);
      const expectedTail = allAlerts.slice(-2).map((item) => item.alert_id);

      const streamRes = await sendStreamRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence/stream?after_id=0&limit=2&watch=0',
      });

      expect(streamRes.status).toBe(200);
      const readyEvent = streamRes.events.find((item) => item.event === 'ready');
      const alertEvents = streamRes.events.filter((item) => item.event === 'persistence_alert');
      const doneEvent = streamRes.events.find((item) => item.event === 'done');
      expect(readyEvent).toBeTruthy();
      expect(readyEvent.data.limit).toBe(2);
      expect(alertEvents).toHaveLength(2);
      expect(alertEvents.map((item) => item.data.alert_id)).toEqual(expectedTail);
      expect(doneEvent).toBeTruthy();
      expect(doneEvent.data.status).toBe('replay_complete');
      expect(doneEvent.data.delivered_count).toBe(2);
    } finally {
      remoteStatePersistence.isEnabled = originalIsEnabled;
      remoteStatePersistence.save = originalSave;
    }
  });

  test('GET /alerts/persistence/stream with watch=1 limits replay size and still receives live alert', async () => {
    const originalIsEnabled = remoteStatePersistence.isEnabled;
    const originalSave = remoteStatePersistence.save;

    try {
      remoteStatePersistence.isEnabled = () => true;
      remoteStatePersistence.save = () => ({
        saved: false,
        reason: 'mocked_persist_failure',
      });

      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-limit-watch1-1',
        connectionId: 'conn-alert-route-stream-limit-watch1-1',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-limit-watch1-1'],
        idempotencyKey: 'idem-alert-route-stream-limit-watch1-1',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-limit-watch1-2',
        connectionId: 'conn-alert-route-stream-limit-watch1-2',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-limit-watch1-2'],
        idempotencyKey: 'idem-alert-route-stream-limit-watch1-2',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-limit-watch1-3',
        connectionId: 'conn-alert-route-stream-limit-watch1-3',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-limit-watch1-3'],
        idempotencyKey: 'idem-alert-route-stream-limit-watch1-3',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-limit-watch1-4',
        connectionId: 'conn-alert-route-stream-limit-watch1-4',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-limit-watch1-4'],
        idempotencyKey: 'idem-alert-route-stream-limit-watch1-4',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-limit-watch1-5',
        connectionId: 'conn-alert-route-stream-limit-watch1-5',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-limit-watch1-5'],
        idempotencyKey: 'idem-alert-route-stream-limit-watch1-5',
        riskContext: { source: 'route-test' },
      });

      const listRes = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence?after_id=0&limit=50',
      });
      expect(listRes.status).toBe(200);
      const allAlerts = Array.isArray(listRes.body.data.alerts) ? listRes.body.data.alerts : [];
      expect(allAlerts.length).toBeGreaterThanOrEqual(5);
      const existingMaxAlertId = allAlerts[allAlerts.length - 1].alert_id;
      const expectedReplayTail = allAlerts.slice(-2).map((item) => item.alert_id).sort((a, b) => a - b);

      const liveStream = await watchSseUntilEvent(server, {
        pathName: '/api/remote/ssh/alerts/persistence/stream?after_id=0&limit=2&watch=1',
        targetEvent: 'persistence_alert',
        shouldStop: (eventItem) => eventItem?.data?.alert_id > existingMaxAlertId,
        timeoutMs: 3000,
        onReady: () => {
          remoteApprovalBridge.createTicket({
            traceId: 'trace-alert-route-stream-limit-watch1-new',
            connectionId: 'conn-alert-route-stream-limit-watch1-new',
            hostAlias: 'demo',
            commands: ['rm -rf /tmp/alert-test-stream-limit-watch1-new'],
            idempotencyKey: 'idem-alert-route-stream-limit-watch1-new',
            riskContext: { source: 'route-test' },
          });
        },
      });

      expect(liveStream.status).toBe(200);
      expect(liveStream.timedOut).toBe(false);
      const readyEvent = liveStream.events.find((item) => item.event === 'ready');
      expect(readyEvent).toBeTruthy();
      expect(readyEvent.data.limit).toBe(2);

      const alertEvents = liveStream.events.filter((item) => item.event === 'persistence_alert');
      expect(alertEvents.length).toBeGreaterThanOrEqual(3);
      const replayPart = alertEvents
        .filter((item) => item.data.alert_id <= existingMaxAlertId)
        .map((item) => item.data.alert_id)
        .sort((a, b) => a - b);
      const livePart = alertEvents.filter((item) => item.data.alert_id > existingMaxAlertId);
      expect(replayPart).toEqual(expectedReplayTail);
      expect(livePart.length).toBeGreaterThanOrEqual(1);
    } finally {
      remoteStatePersistence.isEnabled = originalIsEnabled;
      remoteStatePersistence.save = originalSave;
    }
  });

  test('GET /alerts/persistence/stream with watch=0 returns empty replay when after_id is current tail', async () => {
    const originalIsEnabled = remoteStatePersistence.isEnabled;
    const originalSave = remoteStatePersistence.save;

    try {
      remoteStatePersistence.isEnabled = () => true;
      remoteStatePersistence.save = () => ({
        saved: false,
        reason: 'mocked_persist_failure',
      });

      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-after-tail-watch0-1',
        connectionId: 'conn-alert-route-stream-after-tail-watch0-1',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-after-tail-watch0-1'],
        idempotencyKey: 'idem-alert-route-stream-after-tail-watch0-1',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-after-tail-watch0-2',
        connectionId: 'conn-alert-route-stream-after-tail-watch0-2',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-after-tail-watch0-2'],
        idempotencyKey: 'idem-alert-route-stream-after-tail-watch0-2',
        riskContext: { source: 'route-test' },
      });

      const listRes = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence?after_id=0&limit=20',
      });
      expect(listRes.status).toBe(200);
      const alerts = Array.isArray(listRes.body.data.alerts) ? listRes.body.data.alerts : [];
      expect(alerts.length).toBeGreaterThanOrEqual(2);
      const tailId = alerts[alerts.length - 1].alert_id;

      const streamRes = await sendStreamRequest(server, {
        method: 'GET',
        pathName: `/api/remote/ssh/alerts/persistence/stream?after_id=${tailId}&limit=1&watch=0`,
      });

      expect(streamRes.status).toBe(200);
      const readyEvent = streamRes.events.find((item) => item.event === 'ready');
      const alertEvents = streamRes.events.filter((item) => item.event === 'persistence_alert');
      const doneEvent = streamRes.events.find((item) => item.event === 'done');
      expect(readyEvent).toBeTruthy();
      expect(readyEvent.data.after_id).toBe(tailId);
      expect(readyEvent.data.limit).toBe(1);
      expect(readyEvent.data.replay_count).toBe(0);
      expect(alertEvents).toHaveLength(0);
      expect(doneEvent).toBeTruthy();
      expect(doneEvent.data.status).toBe('replay_complete');
      expect(doneEvent.data.delivered_count).toBe(0);
    } finally {
      remoteStatePersistence.isEnabled = originalIsEnabled;
      remoteStatePersistence.save = originalSave;
    }
  });

  test('GET /alerts/persistence/stream with watch=1 receives live event when replay is empty at tail after_id', async () => {
    const originalIsEnabled = remoteStatePersistence.isEnabled;
    const originalSave = remoteStatePersistence.save;

    try {
      remoteStatePersistence.isEnabled = () => true;
      remoteStatePersistence.save = () => ({
        saved: false,
        reason: 'mocked_persist_failure',
      });

      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-after-tail-watch1-1',
        connectionId: 'conn-alert-route-stream-after-tail-watch1-1',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-after-tail-watch1-1'],
        idempotencyKey: 'idem-alert-route-stream-after-tail-watch1-1',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-after-tail-watch1-2',
        connectionId: 'conn-alert-route-stream-after-tail-watch1-2',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-after-tail-watch1-2'],
        idempotencyKey: 'idem-alert-route-stream-after-tail-watch1-2',
        riskContext: { source: 'route-test' },
      });

      const listRes = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence?after_id=0&limit=20',
      });
      expect(listRes.status).toBe(200);
      const alerts = Array.isArray(listRes.body.data.alerts) ? listRes.body.data.alerts : [];
      expect(alerts.length).toBeGreaterThanOrEqual(2);
      const tailId = alerts[alerts.length - 1].alert_id;

      const liveStream = await watchSseUntilEvent(server, {
        pathName: `/api/remote/ssh/alerts/persistence/stream?after_id=${tailId}&limit=1&watch=1`,
        targetEvent: 'persistence_alert',
        shouldStop: (eventItem) => eventItem?.data?.alert_id > tailId,
        timeoutMs: 3000,
        onReady: () => {
          remoteApprovalBridge.createTicket({
            traceId: 'trace-alert-route-stream-after-tail-watch1-new',
            connectionId: 'conn-alert-route-stream-after-tail-watch1-new',
            hostAlias: 'demo',
            commands: ['rm -rf /tmp/alert-test-stream-after-tail-watch1-new'],
            idempotencyKey: 'idem-alert-route-stream-after-tail-watch1-new',
            riskContext: { source: 'route-test' },
          });
        },
      });

      expect(liveStream.status).toBe(200);
      expect(liveStream.timedOut).toBe(false);
      const readyEvent = liveStream.events.find((item) => item.event === 'ready');
      expect(readyEvent).toBeTruthy();
      expect(readyEvent.data.after_id).toBe(tailId);
      expect(readyEvent.data.limit).toBe(1);
      expect(readyEvent.data.replay_count).toBe(0);
      const alertEvents = liveStream.events.filter((item) => item.event === 'persistence_alert');
      expect(alertEvents.length).toBeGreaterThanOrEqual(1);
      expect(alertEvents.some((item) => item.data.alert_id > tailId)).toBe(true);
    } finally {
      remoteStatePersistence.isEnabled = originalIsEnabled;
      remoteStatePersistence.save = originalSave;
    }
  });

  test('GET /alerts/persistence/stream falls back to Last-Event-ID when query after_id is negative', async () => {
    const originalIsEnabled = remoteStatePersistence.isEnabled;
    const originalSave = remoteStatePersistence.save;

    try {
      remoteStatePersistence.isEnabled = () => true;
      remoteStatePersistence.save = () => ({
        saved: false,
        reason: 'mocked_persist_failure',
      });

      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-after-invalid-neg-1',
        connectionId: 'conn-alert-route-stream-after-invalid-neg-1',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-after-invalid-neg-1'],
        idempotencyKey: 'idem-alert-route-stream-after-invalid-neg-1',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-after-invalid-neg-2',
        connectionId: 'conn-alert-route-stream-after-invalid-neg-2',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-after-invalid-neg-2'],
        idempotencyKey: 'idem-alert-route-stream-after-invalid-neg-2',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-after-invalid-neg-3',
        connectionId: 'conn-alert-route-stream-after-invalid-neg-3',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-after-invalid-neg-3'],
        idempotencyKey: 'idem-alert-route-stream-after-invalid-neg-3',
        riskContext: { source: 'route-test' },
      });

      const listRes = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence?after_id=0&limit=20',
      });
      expect(listRes.status).toBe(200);
      const alerts = Array.isArray(listRes.body.data.alerts) ? listRes.body.data.alerts : [];
      expect(alerts.length).toBeGreaterThanOrEqual(3);
      const cursorId = alerts[0].alert_id;

      const streamRes = await sendStreamRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence/stream?after_id=-1&limit=20&watch=0',
        headers: {
          'last-event-id': String(cursorId),
        },
      });

      expect(streamRes.status).toBe(200);
      const readyEvent = streamRes.events.find((item) => item.event === 'ready');
      const alertEvents = streamRes.events.filter((item) => item.event === 'persistence_alert');
      expect(readyEvent).toBeTruthy();
      expect(readyEvent.data.after_id).toBe(cursorId);
      expect(alertEvents.length).toBeGreaterThanOrEqual(1);
      expect(alertEvents.every((item) => item.data.alert_id > cursorId)).toBe(true);
    } finally {
      remoteStatePersistence.isEnabled = originalIsEnabled;
      remoteStatePersistence.save = originalSave;
    }
  });

  test('GET /alerts/persistence/stream falls back to after_id=0 when query after_id is non-numeric and header is missing', async () => {
    const originalIsEnabled = remoteStatePersistence.isEnabled;
    const originalSave = remoteStatePersistence.save;

    try {
      remoteStatePersistence.isEnabled = () => true;
      remoteStatePersistence.save = () => ({
        saved: false,
        reason: 'mocked_persist_failure',
      });

      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-after-invalid-text-1',
        connectionId: 'conn-alert-route-stream-after-invalid-text-1',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-after-invalid-text-1'],
        idempotencyKey: 'idem-alert-route-stream-after-invalid-text-1',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-after-invalid-text-2',
        connectionId: 'conn-alert-route-stream-after-invalid-text-2',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-after-invalid-text-2'],
        idempotencyKey: 'idem-alert-route-stream-after-invalid-text-2',
        riskContext: { source: 'route-test' },
      });

      const streamRes = await sendStreamRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence/stream?after_id=abc&limit=20&watch=0',
      });

      expect(streamRes.status).toBe(200);
      const readyEvent = streamRes.events.find((item) => item.event === 'ready');
      const alertEvents = streamRes.events.filter((item) => item.event === 'persistence_alert');
      const doneEvent = streamRes.events.find((item) => item.event === 'done');
      expect(readyEvent).toBeTruthy();
      expect(readyEvent.data.after_id).toBe(0);
      expect(readyEvent.data.replay_count).toBeGreaterThanOrEqual(2);
      expect(alertEvents.length).toBeGreaterThanOrEqual(2);
      expect(doneEvent).toBeTruthy();
      expect(doneEvent.data.status).toBe('replay_complete');
    } finally {
      remoteStatePersistence.isEnabled = originalIsEnabled;
      remoteStatePersistence.save = originalSave;
    }
  });

  test('GET /alerts/persistence/stream falls back to Last-Event-ID when query after_id is non-numeric', async () => {
    const originalIsEnabled = remoteStatePersistence.isEnabled;
    const originalSave = remoteStatePersistence.save;

    try {
      remoteStatePersistence.isEnabled = () => true;
      remoteStatePersistence.save = () => ({
        saved: false,
        reason: 'mocked_persist_failure',
      });

      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-after-invalid-text-header-1',
        connectionId: 'conn-alert-route-stream-after-invalid-text-header-1',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-after-invalid-text-header-1'],
        idempotencyKey: 'idem-alert-route-stream-after-invalid-text-header-1',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-after-invalid-text-header-2',
        connectionId: 'conn-alert-route-stream-after-invalid-text-header-2',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-after-invalid-text-header-2'],
        idempotencyKey: 'idem-alert-route-stream-after-invalid-text-header-2',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-after-invalid-text-header-3',
        connectionId: 'conn-alert-route-stream-after-invalid-text-header-3',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-after-invalid-text-header-3'],
        idempotencyKey: 'idem-alert-route-stream-after-invalid-text-header-3',
        riskContext: { source: 'route-test' },
      });

      const listRes = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence?after_id=0&limit=20',
      });
      expect(listRes.status).toBe(200);
      const alerts = Array.isArray(listRes.body.data.alerts) ? listRes.body.data.alerts : [];
      expect(alerts.length).toBeGreaterThanOrEqual(3);
      const cursorId = alerts[0].alert_id;

      const streamRes = await sendStreamRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence/stream?after_id=abc&limit=20&watch=0',
        headers: {
          'last-event-id': String(cursorId),
        },
      });

      expect(streamRes.status).toBe(200);
      const readyEvent = streamRes.events.find((item) => item.event === 'ready');
      const alertEvents = streamRes.events.filter((item) => item.event === 'persistence_alert');
      const doneEvent = streamRes.events.find((item) => item.event === 'done');
      expect(readyEvent).toBeTruthy();
      expect(readyEvent.data.after_id).toBe(cursorId);
      expect(readyEvent.data.replay_count).toBeGreaterThanOrEqual(1);
      expect(alertEvents.length).toBeGreaterThanOrEqual(1);
      expect(alertEvents.every((item) => item.data.alert_id > cursorId)).toBe(true);
      expect(doneEvent).toBeTruthy();
      expect(doneEvent.data.status).toBe('replay_complete');
    } finally {
      remoteStatePersistence.isEnabled = originalIsEnabled;
      remoteStatePersistence.save = originalSave;
    }
  });

  test('GET /alerts/persistence/stream with watch=0 returns empty replay when after_id is greater than latest alert id', async () => {
    const originalIsEnabled = remoteStatePersistence.isEnabled;
    const originalSave = remoteStatePersistence.save;

    try {
      remoteStatePersistence.isEnabled = () => true;
      remoteStatePersistence.save = () => ({
        saved: false,
        reason: 'mocked_persist_failure',
      });

      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-after-too-new-watch0-1',
        connectionId: 'conn-alert-route-stream-after-too-new-watch0-1',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-after-too-new-watch0-1'],
        idempotencyKey: 'idem-alert-route-stream-after-too-new-watch0-1',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-after-too-new-watch0-2',
        connectionId: 'conn-alert-route-stream-after-too-new-watch0-2',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-after-too-new-watch0-2'],
        idempotencyKey: 'idem-alert-route-stream-after-too-new-watch0-2',
        riskContext: { source: 'route-test' },
      });

      const listRes = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence?after_id=0&limit=20',
      });
      expect(listRes.status).toBe(200);
      const alerts = Array.isArray(listRes.body.data.alerts) ? listRes.body.data.alerts : [];
      expect(alerts.length).toBeGreaterThanOrEqual(2);
      const maxAlertId = alerts[alerts.length - 1].alert_id;
      const afterId = maxAlertId + 99;

      const streamRes = await sendStreamRequest(server, {
        method: 'GET',
        pathName: `/api/remote/ssh/alerts/persistence/stream?after_id=${afterId}&limit=20&watch=0`,
      });

      expect(streamRes.status).toBe(200);
      const readyEvent = streamRes.events.find((item) => item.event === 'ready');
      const alertEvents = streamRes.events.filter((item) => item.event === 'persistence_alert');
      const doneEvent = streamRes.events.find((item) => item.event === 'done');
      expect(readyEvent).toBeTruthy();
      expect(readyEvent.data.after_id).toBe(afterId);
      expect(readyEvent.data.replay_count).toBe(0);
      expect(alertEvents).toHaveLength(0);
      expect(doneEvent).toBeTruthy();
      expect(doneEvent.data.status).toBe('replay_complete');
      expect(doneEvent.data.delivered_count).toBe(0);
    } finally {
      remoteStatePersistence.isEnabled = originalIsEnabled;
      remoteStatePersistence.save = originalSave;
    }
  });

  test('GET /alerts/persistence/stream with watch=1 receives live alert once new alert id surpasses a too-new after_id', async () => {
    const originalIsEnabled = remoteStatePersistence.isEnabled;
    const originalSave = remoteStatePersistence.save;

    try {
      remoteStatePersistence.isEnabled = () => true;
      remoteStatePersistence.save = () => ({
        saved: false,
        reason: 'mocked_persist_failure',
      });

      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-after-too-new-watch1-1',
        connectionId: 'conn-alert-route-stream-after-too-new-watch1-1',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-after-too-new-watch1-1'],
        idempotencyKey: 'idem-alert-route-stream-after-too-new-watch1-1',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-after-too-new-watch1-2',
        connectionId: 'conn-alert-route-stream-after-too-new-watch1-2',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-after-too-new-watch1-2'],
        idempotencyKey: 'idem-alert-route-stream-after-too-new-watch1-2',
        riskContext: { source: 'route-test' },
      });

      const listRes = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence?after_id=0&limit=20',
      });
      expect(listRes.status).toBe(200);
      const alerts = Array.isArray(listRes.body.data.alerts) ? listRes.body.data.alerts : [];
      expect(alerts.length).toBeGreaterThanOrEqual(2);
      const maxAlertId = alerts[alerts.length - 1].alert_id;
      const afterId = maxAlertId + 1;

      const liveStream = await watchSseUntilEvent(server, {
        pathName: `/api/remote/ssh/alerts/persistence/stream?after_id=${afterId}&limit=20&watch=1`,
        targetEvent: 'persistence_alert',
        shouldStop: (eventItem) => eventItem?.data?.alert_id > afterId,
        timeoutMs: 3000,
        onReady: () => {
          remoteApprovalBridge.createTicket({
            traceId: 'trace-alert-route-stream-after-too-new-watch1-new-1',
            connectionId: 'conn-alert-route-stream-after-too-new-watch1-new-1',
            hostAlias: 'demo',
            commands: ['rm -rf /tmp/alert-test-stream-after-too-new-watch1-new-1'],
            idempotencyKey: 'idem-alert-route-stream-after-too-new-watch1-new-1',
            riskContext: { source: 'route-test' },
          });
          remoteApprovalBridge.createTicket({
            traceId: 'trace-alert-route-stream-after-too-new-watch1-new-2',
            connectionId: 'conn-alert-route-stream-after-too-new-watch1-new-2',
            hostAlias: 'demo',
            commands: ['rm -rf /tmp/alert-test-stream-after-too-new-watch1-new-2'],
            idempotencyKey: 'idem-alert-route-stream-after-too-new-watch1-new-2',
            riskContext: { source: 'route-test' },
          });
        },
      });

      expect(liveStream.status).toBe(200);
      expect(liveStream.timedOut).toBe(false);
      const readyEvent = liveStream.events.find((item) => item.event === 'ready');
      expect(readyEvent).toBeTruthy();
      expect(readyEvent.data.after_id).toBe(afterId);
      expect(readyEvent.data.replay_count).toBe(0);
      const alertEvents = liveStream.events.filter((item) => item.event === 'persistence_alert');
      expect(alertEvents.length).toBeGreaterThanOrEqual(1);
      expect(alertEvents.some((item) => item.data.alert_id > afterId)).toBe(true);
    } finally {
      remoteStatePersistence.isEnabled = originalIsEnabled;
      remoteStatePersistence.save = originalSave;
    }
  });

  test('GET /alerts/persistence/stream with only_unacked=1 does not replay immediately acknowledged live alert on reconnect after too-new after_id', async () => {
    const originalIsEnabled = remoteStatePersistence.isEnabled;
    const originalSave = remoteStatePersistence.save;

    try {
      remoteStatePersistence.isEnabled = () => true;
      remoteStatePersistence.save = () => ({
        saved: false,
        reason: 'mocked_persist_failure',
      });

      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-after-too-new-ack-1',
        connectionId: 'conn-alert-route-stream-after-too-new-ack-1',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-after-too-new-ack-1'],
        idempotencyKey: 'idem-alert-route-stream-after-too-new-ack-1',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-after-too-new-ack-2',
        connectionId: 'conn-alert-route-stream-after-too-new-ack-2',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-after-too-new-ack-2'],
        idempotencyKey: 'idem-alert-route-stream-after-too-new-ack-2',
        riskContext: { source: 'route-test' },
      });

      const listRes = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence?after_id=0&limit=20',
      });
      expect(listRes.status).toBe(200);
      const alerts = Array.isArray(listRes.body.data.alerts) ? listRes.body.data.alerts : [];
      expect(alerts.length).toBeGreaterThanOrEqual(2);
      const maxAlertId = alerts[alerts.length - 1].alert_id;
      const afterId = maxAlertId + 1;

      const liveStream = await watchSseUntilEvent(server, {
        pathName: `/api/remote/ssh/alerts/persistence/stream?after_id=${afterId}&limit=20&watch=1&only_unacked=1`,
        targetEvent: 'persistence_alert',
        shouldStop: (eventItem) => eventItem?.data?.alert_id > afterId,
        timeoutMs: 3000,
        onReady: () => {
          remoteApprovalBridge.createTicket({
            traceId: 'trace-alert-route-stream-after-too-new-ack-new-1',
            connectionId: 'conn-alert-route-stream-after-too-new-ack-new-1',
            hostAlias: 'demo',
            commands: ['rm -rf /tmp/alert-test-stream-after-too-new-ack-new-1'],
            idempotencyKey: 'idem-alert-route-stream-after-too-new-ack-new-1',
            riskContext: { source: 'route-test' },
          });
          markPersistenceAlertsAcknowledged({
            alertId: afterId,
            reviewer: 'tester-after-too-new-ack',
          });

          remoteApprovalBridge.createTicket({
            traceId: 'trace-alert-route-stream-after-too-new-ack-new-2',
            connectionId: 'conn-alert-route-stream-after-too-new-ack-new-2',
            hostAlias: 'demo',
            commands: ['rm -rf /tmp/alert-test-stream-after-too-new-ack-new-2'],
            idempotencyKey: 'idem-alert-route-stream-after-too-new-ack-new-2',
            riskContext: { source: 'route-test' },
          });
          markPersistenceAlertsAcknowledged({
            alertId: afterId + 1,
            reviewer: 'tester-after-too-new-ack',
          });
        },
      });

      expect(liveStream.status).toBe(200);
      expect(liveStream.timedOut).toBe(false);
      const readyEvent = liveStream.events.find((item) => item.event === 'ready');
      expect(readyEvent).toBeTruthy();
      expect(readyEvent.data.after_id).toBe(afterId);
      expect(readyEvent.data.only_unacked).toBe(true);
      const alertEvents = liveStream.events.filter((item) => item.event === 'persistence_alert');
      expect(alertEvents.length).toBeGreaterThanOrEqual(1);
      const deliveredLiveAlertId = alertEvents[alertEvents.length - 1].data.alert_id;
      expect(deliveredLiveAlertId).toBe(afterId + 1);

      const replayRes = await sendStreamRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence/stream?watch=0&only_unacked=1&limit=20',
        headers: {
          'last-event-id': String(afterId),
        },
      });

      expect(replayRes.status).toBe(200);
      const replayReady = replayRes.events.find((item) => item.event === 'ready');
      const replayAlerts = replayRes.events.filter((item) => item.event === 'persistence_alert');
      const replayDone = replayRes.events.find((item) => item.event === 'done');
      expect(replayReady).toBeTruthy();
      expect(replayReady.data.only_unacked).toBe(true);
      expect(replayAlerts.some((item) => item.data.alert_id === deliveredLiveAlertId)).toBe(false);
      expect(replayDone).toBeTruthy();
      expect(replayDone.data.status).toBe('replay_complete');
    } finally {
      remoteStatePersistence.isEnabled = originalIsEnabled;
      remoteStatePersistence.save = originalSave;
    }
  });

  test('GET /alerts/persistence/stream with watch=1 and only_unacked=1 pushes newly created unacked alerts', async () => {
    const originalIsEnabled = remoteStatePersistence.isEnabled;
    const originalSave = remoteStatePersistence.save;

    try {
      remoteStatePersistence.isEnabled = () => true;
      remoteStatePersistence.save = () => ({
        saved: false,
        reason: 'mocked_persist_failure',
      });

      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-live-unacked-1',
        connectionId: 'conn-alert-route-stream-live-unacked-1',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-live-unacked-1'],
        idempotencyKey: 'idem-alert-route-stream-live-unacked-1',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-live-unacked-2',
        connectionId: 'conn-alert-route-stream-live-unacked-2',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-live-unacked-2'],
        idempotencyKey: 'idem-alert-route-stream-live-unacked-2',
        riskContext: { source: 'route-test' },
      });

      const initialList = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence?after_id=0&limit=20',
      });
      expect(initialList.status).toBe(200);
      const initialAlerts = Array.isArray(initialList.body.data.alerts) ? initialList.body.data.alerts : [];
      expect(initialAlerts.length).toBeGreaterThanOrEqual(2);
      const maxExistingAlertId = initialAlerts[initialAlerts.length - 1].alert_id;

      const ackAllRes = await sendRequest(server, {
        method: 'POST',
        pathName: '/api/remote/ssh/alerts/persistence/ack',
        body: {
          up_to_id: maxExistingAlertId,
          reviewer: 'tester-stream-live-only-unacked',
        },
      });
      expect(ackAllRes.status).toBe(200);
      expect(ackAllRes.body.success).toBe(true);
      expect(ackAllRes.body.data.acked_count).toBeGreaterThanOrEqual(2);

      const liveStream = await watchSseUntilEvent(server, {
        pathName: '/api/remote/ssh/alerts/persistence/stream?after_id=0&limit=20&watch=1&only_unacked=1',
        targetEvent: 'persistence_alert',
        timeoutMs: 3000,
        onReady: () => {
          remoteApprovalBridge.createTicket({
            traceId: 'trace-alert-route-stream-live-unacked-new',
            connectionId: 'conn-alert-route-stream-live-unacked-new',
            hostAlias: 'demo',
            commands: ['rm -rf /tmp/alert-test-stream-live-unacked-new'],
            idempotencyKey: 'idem-alert-route-stream-live-unacked-new',
            riskContext: { source: 'route-test' },
          });
        },
      });

      expect(liveStream.status).toBe(200);
      expect(liveStream.timedOut).toBe(false);
      const readyEvent = liveStream.events.find((item) => item.event === 'ready');
      expect(readyEvent).toBeTruthy();
      expect(readyEvent.data.only_unacked).toBe(true);
      const alertEvents = liveStream.events.filter((item) => item.event === 'persistence_alert');
      expect(alertEvents.length).toBeGreaterThanOrEqual(1);
      expect(alertEvents.every((item) => item.data.acked === false)).toBe(true);
      expect(alertEvents.some((item) => item.data.alert_id > maxExistingAlertId)).toBe(true);
    } finally {
      remoteStatePersistence.isEnabled = originalIsEnabled;
      remoteStatePersistence.save = originalSave;
    }
  });

  test('GET /alerts/persistence/stream with watch=1 + only_unacked=1 does not replay alert after immediate ack on reconnect', async () => {
    const originalIsEnabled = remoteStatePersistence.isEnabled;
    const originalSave = remoteStatePersistence.save;

    try {
      remoteStatePersistence.isEnabled = () => true;
      remoteStatePersistence.save = () => ({
        saved: false,
        reason: 'mocked_persist_failure',
      });

      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-live-ack-replay-1',
        connectionId: 'conn-alert-route-stream-live-ack-replay-1',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-live-ack-replay-1'],
        idempotencyKey: 'idem-alert-route-stream-live-ack-replay-1',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-live-ack-replay-2',
        connectionId: 'conn-alert-route-stream-live-ack-replay-2',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-live-ack-replay-2'],
        idempotencyKey: 'idem-alert-route-stream-live-ack-replay-2',
        riskContext: { source: 'route-test' },
      });

      const initialList = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence?after_id=0&limit=20',
      });
      expect(initialList.status).toBe(200);
      const initialAlerts = Array.isArray(initialList.body.data.alerts) ? initialList.body.data.alerts : [];
      expect(initialAlerts.length).toBeGreaterThanOrEqual(2);
      const maxExistingAlertId = initialAlerts[initialAlerts.length - 1].alert_id;

      const ackAllRes = await sendRequest(server, {
        method: 'POST',
        pathName: '/api/remote/ssh/alerts/persistence/ack',
        body: {
          up_to_id: maxExistingAlertId,
          reviewer: 'tester-stream-live-ack-replay-init',
        },
      });
      expect(ackAllRes.status).toBe(200);
      expect(ackAllRes.body.success).toBe(true);

      const firstLive = await watchSseUntilEvent(server, {
        pathName: '/api/remote/ssh/alerts/persistence/stream?after_id=0&limit=20&watch=1&only_unacked=1',
        targetEvent: 'persistence_alert',
        timeoutMs: 3000,
        onReady: () => {
          remoteApprovalBridge.createTicket({
            traceId: 'trace-alert-route-stream-live-ack-replay-new',
            connectionId: 'conn-alert-route-stream-live-ack-replay-new',
            hostAlias: 'demo',
            commands: ['rm -rf /tmp/alert-test-stream-live-ack-replay-new'],
            idempotencyKey: 'idem-alert-route-stream-live-ack-replay-new',
            riskContext: { source: 'route-test' },
          });
        },
      });

      expect(firstLive.status).toBe(200);
      expect(firstLive.timedOut).toBe(false);
      const liveAlertEvents = firstLive.events.filter((item) => item.event === 'persistence_alert');
      expect(liveAlertEvents.length).toBeGreaterThanOrEqual(1);
      const deliveredAlert = liveAlertEvents[liveAlertEvents.length - 1];
      expect(typeof deliveredAlert.id).toBe('number');
      const deliveredAlertId = deliveredAlert.data.alert_id;
      expect(typeof deliveredAlertId).toBe('number');

      const ackLiveRes = await sendRequest(server, {
        method: 'POST',
        pathName: '/api/remote/ssh/alerts/persistence/ack',
        body: {
          alert_id: deliveredAlertId,
          reviewer: 'tester-stream-live-ack-replay-live',
        },
      });
      expect(ackLiveRes.status).toBe(200);
      expect(ackLiveRes.body.success).toBe(true);
      expect(ackLiveRes.body.data.acked_count).toBe(1);

      const replayRes = await sendStreamRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence/stream?watch=0&only_unacked=1&limit=20',
        headers: {
          'last-event-id': String(Math.max(0, deliveredAlert.id - 1)),
        },
      });

      expect(replayRes.status).toBe(200);
      const replayReady = replayRes.events.find((item) => item.event === 'ready');
      const replayAlerts = replayRes.events.filter((item) => item.event === 'persistence_alert');
      const replayDone = replayRes.events.find((item) => item.event === 'done');
      expect(replayReady).toBeTruthy();
      expect(replayReady.data.only_unacked).toBe(true);
      expect(replayAlerts.some((item) => item.data.alert_id === deliveredAlertId)).toBe(false);
      expect(replayDone).toBeTruthy();
      expect(replayDone.data.status).toBe('replay_complete');
      expect(replayDone.data.delivered_count).toBe(replayAlerts.length);
    } finally {
      remoteStatePersistence.isEnabled = originalIsEnabled;
      remoteStatePersistence.save = originalSave;
    }
  });

  test('GET /alerts/persistence/stream with watch=1 + only_unacked=1 replays from Last-Event-ID and then receives live alert', async () => {
    const originalIsEnabled = remoteStatePersistence.isEnabled;
    const originalSave = remoteStatePersistence.save;

    try {
      remoteStatePersistence.isEnabled = () => true;
      remoteStatePersistence.save = () => ({
        saved: false,
        reason: 'mocked_persist_failure',
      });

      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-live-replay-1',
        connectionId: 'conn-alert-route-stream-live-replay-1',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-live-replay-1'],
        idempotencyKey: 'idem-alert-route-stream-live-replay-1',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-live-replay-2',
        connectionId: 'conn-alert-route-stream-live-replay-2',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-live-replay-2'],
        idempotencyKey: 'idem-alert-route-stream-live-replay-2',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-live-replay-3',
        connectionId: 'conn-alert-route-stream-live-replay-3',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-live-replay-3'],
        idempotencyKey: 'idem-alert-route-stream-live-replay-3',
        riskContext: { source: 'route-test' },
      });

      const baseline = await sendStreamRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence/stream?after_id=0&limit=20&watch=0&only_unacked=1',
      });
      expect(baseline.status).toBe(200);
      const baselineAlerts = baseline.events.filter((item) => item.event === 'persistence_alert');
      expect(baselineAlerts.length).toBeGreaterThanOrEqual(3);
      const cursorId = baselineAlerts[0].id;
      const maxExistingAlertId = Math.max(...baselineAlerts.map((item) => item.data.alert_id));
      expect(typeof cursorId).toBe('number');

      const liveStream = await watchSseUntilEvent(server, {
        pathName: '/api/remote/ssh/alerts/persistence/stream?limit=20&watch=1&only_unacked=1',
        headers: {
          'last-event-id': String(cursorId),
        },
        targetEvent: 'persistence_alert',
        shouldStop: (eventItem) => eventItem?.data?.alert_id > maxExistingAlertId,
        timeoutMs: 3000,
        onReady: () => {
          remoteApprovalBridge.createTicket({
            traceId: 'trace-alert-route-stream-live-replay-new',
            connectionId: 'conn-alert-route-stream-live-replay-new',
            hostAlias: 'demo',
            commands: ['rm -rf /tmp/alert-test-stream-live-replay-new'],
            idempotencyKey: 'idem-alert-route-stream-live-replay-new',
            riskContext: { source: 'route-test' },
          });
        },
      });

      expect(liveStream.status).toBe(200);
      expect(liveStream.timedOut).toBe(false);
      const readyEvent = liveStream.events.find((item) => item.event === 'ready');
      expect(readyEvent).toBeTruthy();
      expect(readyEvent.data.only_unacked).toBe(true);
      const alertEvents = liveStream.events.filter((item) => item.event === 'persistence_alert');
      expect(alertEvents.length).toBeGreaterThanOrEqual(2);
      expect(alertEvents.every((item) => item.id > cursorId)).toBe(true);
      expect(alertEvents.some((item) => item.data.alert_id <= maxExistingAlertId)).toBe(true);
      expect(alertEvents.some((item) => item.data.alert_id > maxExistingAlertId)).toBe(true);
    } finally {
      remoteStatePersistence.isEnabled = originalIsEnabled;
      remoteStatePersistence.save = originalSave;
    }
  });

  test('GET /alerts/persistence/stream uses Last-Event-ID as replay cursor', async () => {
    const originalIsEnabled = remoteStatePersistence.isEnabled;
    const originalSave = remoteStatePersistence.save;

    try {
      remoteStatePersistence.isEnabled = () => true;
      remoteStatePersistence.save = () => ({
        saved: false,
        reason: 'mocked_persist_failure',
      });

      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-last-event-id-1',
        connectionId: 'conn-alert-route-stream-last-event-id-1',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-last-event-id-1'],
        idempotencyKey: 'idem-alert-route-stream-last-event-id-1',
        riskContext: { source: 'route-test' },
      });
      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-stream-last-event-id-2',
        connectionId: 'conn-alert-route-stream-last-event-id-2',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test-stream-last-event-id-2'],
        idempotencyKey: 'idem-alert-route-stream-last-event-id-2',
        riskContext: { source: 'route-test' },
      });

      const first = await sendStreamRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence/stream?after_id=0&limit=20&watch=0',
      });
      expect(first.status).toBe(200);
      const firstAlertEvents = first.events.filter((item) => item.event === 'persistence_alert');
      expect(firstAlertEvents.length).toBeGreaterThanOrEqual(2);
      const firstEventId = firstAlertEvents[0].id;
      expect(typeof firstEventId).toBe('number');

      const resumed = await sendStreamRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence/stream?limit=20&watch=0',
        headers: {
          'last-event-id': String(firstEventId),
        },
      });
      expect(resumed.status).toBe(200);
      const resumedAlertEvents = resumed.events.filter((item) => item.event === 'persistence_alert');
      expect(resumedAlertEvents.length).toBeGreaterThanOrEqual(1);
      expect(resumedAlertEvents.every((item) => item.id > firstEventId)).toBe(true);
    } finally {
      remoteStatePersistence.isEnabled = originalIsEnabled;
      remoteStatePersistence.save = originalSave;
    }
  });

  test('GET /alerts/persistence/stream releases subscriber after client disconnects (watch=1)', async () => {
    const before = await sendRequest(server, {
      method: 'GET',
      pathName: '/api/remote/ssh/sessions',
    });
    expect(before.status).toBe(200);
    expect(before.body.success).toBe(true);
    expect(before.body.data.persistence.alert_subscriber_total).toBe(0);

    const streamRes = await openSseAndAbortOnEvent(server, {
      pathName: '/api/remote/ssh/alerts/persistence/stream?after_id=0&limit=5&watch=1',
      eventName: 'ready',
    });
    expect(streamRes.status).toBe(200);
    expect(streamRes.events.some((item) => item.event === 'ready')).toBe(true);
    expect(streamRes.aborted).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 30));

    const after = await sendRequest(server, {
      method: 'GET',
      pathName: '/api/remote/ssh/sessions',
    });
    expect(after.status).toBe(200);
    expect(after.body.success).toBe(true);
    expect(after.body.data.persistence.alert_subscriber_total).toBe(0);
  });

  test('GET /alerts/persistence surfaces persistence failure alert', async () => {
    const originalIsEnabled = remoteStatePersistence.isEnabled;
    const originalSave = remoteStatePersistence.save;

    try {
      remoteStatePersistence.isEnabled = () => true;
      remoteStatePersistence.save = () => ({
        saved: false,
        reason: 'mocked_persist_failure',
      });

      remoteApprovalBridge.createTicket({
        traceId: 'trace-alert-route-1',
        connectionId: 'conn-alert-route-1',
        hostAlias: 'demo',
        commands: ['rm -rf /tmp/alert-test'],
        idempotencyKey: 'idem-alert-route-1',
        riskContext: { source: 'route-test' },
      });

      const res = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/remote/ssh/alerts/persistence?after_id=0&limit=20',
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const alerts = Array.isArray(res.body.data.alerts) ? res.body.data.alerts : [];
      expect(alerts.length).toBeGreaterThan(0);
      expect(alerts.some((item) => item.code === 'persist_save_failed')).toBe(true);
    } finally {
      remoteStatePersistence.isEnabled = originalIsEnabled;
      remoteStatePersistence.save = originalSave;
    }
  });
});
