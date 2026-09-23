/* Smoke test for ai-manage-daemon.js require.main guard + F1 seams. */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-dsmoke-'));
const runtimeFile = path.join(dataHome, 'ai_manage_runtime.json');
const port = 19090;

const backendRoot = path.resolve(__dirname, '..', '..');
const child = spawn(process.execPath, [
  path.join(backendRoot, 'scripts', 'ai-manage-daemon.js'),
  '--no-frontend',
  '--api-port', String(port),
  '--startup-grace-ms', '300000',
], {
  cwd: backendRoot,
  env: { ...process.env, KHY_DATA_HOME: dataHome },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // Wait for the runtime file to be published
  let rt = null;
  for (let i = 0; i < 40 && !rt; i++) {
    await sleep(500);
    if (fs.existsSync(runtimeFile)) {
      rt = JSON.parse(fs.readFileSync(runtimeFile, 'utf-8'));
    }
  }
  if (!rt) {
    console.error('FAIL: runtime file not published. out=', out.slice(-2000));
    child.kill('SIGKILL');
    process.exit(1);
  }
  console.log('runtime published:', JSON.stringify({ pid: rt.pid, apiPort: rt.apiPort, controlPort: rt.controlPort }));

  // Probe the control API with the token
  const res = await fetch(`http://127.0.0.1:${rt.controlPort}/status`, {
    headers: { 'x-khy-token': rt.controlToken },
  });
  const body = await res.json();
  console.log('status probe:', res.status, JSON.stringify(body.ok));
  if (res.status !== 200 || body.ok !== true) {
    console.error('FAIL: control /status probe failed');
    child.kill('SIGKILL');
    process.exit(1);
  }

  // Request a graceful shutdown
  const shut = await fetch(`http://127.0.0.1:${rt.controlPort}/shutdown`, {
    method: 'POST',
    headers: { 'x-khy-token': rt.controlToken },
  });
  console.log('shutdown status:', shut.status);

  const exited = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 30000);
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve(code === 0);
    });
  });
  console.log('exited cleanly:', exited);
  fs.rmSync(dataHome, { recursive: true, force: true });
  process.exit(exited ? 0 : 1);
})().catch((e) => {
  console.error('SMOKE ERROR', e);
  child.kill('SIGKILL');
  process.exit(1);
});
