'use strict';
/**
 * ai-backend (services/ai-backend/server.js) port resilience.
 *
 * The ARCH contract (and the comment at server.js:103) promises that when the
 * single management port is contended, the server auto-detects the next free
 * port — the same port-resilience contract the main backend implements. Today
 * that contract is NOT implemented: `app.listen(PORT, HOST, cb)` has no
 * `error` handler, so an EADDRINUSE surfaces as an unhandled 'error' event on
 * the server → uncaughtException → the whole process dies instead of binding
 * an alternate port.
 *
 * RED today: with AI_MGMT_PORT pointed at an occupied port, the process must
 * (a) stay alive and (b) bind + serve on the next free port.
 *
 * These tests spawn the real server.js as a child process — no in-process
 * import (server.js starts listening at module load).
 */

const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const aiBackendDir = path.resolve(__dirname, '..', '..', 'ai-backend');
const serverEntry = path.join(aiBackendDir, 'server.js');

const holders = []; // occupied-port holder servers, released in afterAll

function grabPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      holders.push(srv);
      resolve(port);
    });
  });
}

async function probeHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    return res.status;
  } catch {
    return 0;
  }
}

async function runServerOnPort(port, { extraEnv = {} } = {}) {
  const env = {
    ...process.env,
    AI_MGMT_PORT: String(port),
    AI_MGMT_HOST: '127.0.0.1',
    KHY_DATA_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'khy-aibk-test-')),
    ...extraEnv,
  };
  const child = spawn(process.execPath, [serverEntry], {
    cwd: aiBackendDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const spawnErr = { message: null };
  const outcome = { exited: false, code: null, signal: null, realExited: false };
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  child.on('error', (e) => {
    spawnErr.message = String(e && e.message ? e.message : e);
  });
  child.on('exit', (code, signal) => {
    // record the real exit so the polling loop can observe it
    outcome.code = code;
    outcome.signal = signal;
    outcome.realExited = true;
  });

  // Poll for the "Running on port N" banner or process exit (whichever first).
  const deadline = Date.now() + 45_000;
  let boundPort = 0;
  while (Date.now() < deadline) {
    const m = out.match(/Running on port (\d+)/);
    if (m) {
      boundPort = Number(m[1]);
      break;
    }
    if (outcome.realExited || spawnErr.message) {
      outcome.exited = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // Probe the health endpoint WHILE the server is still up (before we kill it).
  let healthStatus = 0;
  if (boundPort > 0 && !outcome.realExited) {
    healthStatus = await probeHealth(boundPort);
  }

  const result = { ...outcome, boundPort, out, healthStatus, spawnErr: spawnErr.message, execPath: process.execPath };
  child.kill('SIGTERM');
  // Give the graceful shutdown a moment, then hard-kill if still around.
  await new Promise((r) => setTimeout(r, 1500));
  if (child.exitCode === null && child.signal === null) child.kill('SIGKILL');
  return result;
}

afterAll(async () => {
  for (const srv of holders) srv.close();
  holders.length = 0;
});

describe('ai-backend server.js port resilience', () => {
  test('serves on a free port (baseline)', async () => {
    const freePort = await (async () => {
      const s = net.createServer();
      await new Promise((r) => s.listen(0, '127.0.0.1', r));
      const p = s.address().port;
      await new Promise((r) => s.close(r));
      return p;
    })();

    const { exited, boundPort, out, healthStatus } = await runServerOnPort(freePort, {});
    expect(exited).toBe(false);
    expect(boundPort).toBe(freePort);
    expect(out).toContain('Running on port');
    // The bound port actually serves (200 when DB up, 503 degraded — never 0/err).
    expect(healthStatus).toBeGreaterThanOrEqual(200);
    expect(healthStatus).toBeLessThan(500);
  }, 90_000);

  test('an occupied port is survived: binds the next free port instead of crashing', async () => {
    const occupiedPort = await grabPort();
    const { exited, boundPort, out, healthStatus } = await runServerOnPort(occupiedPort, {});

    // The instability: today this child dies on the unhandled EADDRINUSE.
    expect(exited).toBe(false);
    // It must have bound a DIFFERENT (bumped) port than the occupied one.
    expect(boundPort).toBeGreaterThan(0);
    expect(boundPort).not.toBe(occupiedPort);
    // And that bumped port actually serves.
    expect(healthStatus).toBeGreaterThanOrEqual(200);
    expect(healthStatus).toBeLessThan(500);
  }, 90_000);
});
