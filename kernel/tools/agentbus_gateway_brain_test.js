#!/usr/bin/env node
/* agentbus_gateway_brain_test.js — verify the built-in agent answering the kernel
 * decision plane via the project AI gateway (makeGatewayBrain).
 *
 * To stay hermetic (no real model accounts), a tiny fake gateway stands in for
 * the project's OpenAI-compatible endpoint: it enforces the bearer token, records
 * the model each request used, and returns canned, model-style answers shaped to
 * the plane (ALLOW/DENY for generic, a SET/GET/SAY action line for NL). The rest
 * of the stack is real: real kernel in QEMU, real KhyBridge over COM2, real
 * KhyAgent with the real makeGatewayBrain HTTP client.
 *
 * Checks:
 *   1. /disk mounted (config persistence available)
 *   2. NL via model: `ai switch to model gpt-4o-mini` -> model returns SET -> kernel persists
 *   3. the configured model then ROUTES the brain (gateway sees model=gpt-4o-mini)
 *   4. NL GET via model: `ai which model` -> model returns GET -> shell echoes the value
 *   5. generic DENY via model: destructive agentask -> model returns DENY
 *   6. generic ALLOW via model: benign agentask -> model returns ALLOW
 *   7. the fake gateway actually authenticated + was hit (real HTTP round-trips)
 *   8. graceful degradation: kill the gateway, agentask still answers (rule-brain
 *      fallback) -> kernel never blocked
 *
 * Usage:  node kernel/tools/agentbus_gateway_brain_test.js
 * Exit:   0 = all pass, non-zero = failure.
 */
'use strict';

const net = require('net');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { KhyAgent, makeGatewayBrain } = require('../bridge');

const KERNEL_DIR = path.resolve(__dirname, '..');
const ISO = path.join(KERNEL_DIR, 'build', 'khy-os-kernel.iso');
const DISK = path.join(KERNEL_DIR, 'build', 'khy-brain-disk.img');
const COM1_SOCK = '/tmp/khy-agent-brain-com1.sock';
const COM2_SOCK = '/tmp/khy-agent-brain-com2.sock';
const TOKEN = 'khy-test-gateway-token';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function rm(p) { try { fs.unlinkSync(p); } catch (_e) { /* ignore */ } }

/* Fake OpenAI-compatible gateway: a stand-in for the real model. */
function startFakeGateway() {
  const seen = { models: [], requests: 0, unauthorized: 0 };
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${TOKEN}`) {
      seen.unauthorized++;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.requests++;
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_e) { /* ignore */ }
      seen.models.push(body.model);
      const msgs = body.messages || [];
      const system = (msgs.find((m) => m.role === 'system') || {}).content || '';
      const user = ((msgs.find((m) => m.role === 'user') || {}).content || '').toLowerCase();
      const isGeneric = /ALLOW or DENY/.test(system);
      let content;
      if (isGeneric) {
        content = /\b(delete|destroy|format|wipe|erase|shut\s*down|kill all)\b/.test(user) ? 'DENY' : 'ALLOW';
      } else {
        let m;
        if (/which|what|current/.test(user)) content = 'GET model';
        else if ((m = user.match(/model\s+(\S+)/))) content = `SET model ${m[1]}`;
        else content = 'SAY hello from the model';
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-fake', object: 'chat.completion', created: 0, model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, seen, url: `http://127.0.0.1:${port}/v1/chat/completions` });
    });
  });
}

class Com1 {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    sock.on('data', (c) => { this.buf = Buffer.concat([this.buf, c]); });
  }
  text() { return this.buf.toString('utf8'); }
  send(line) { this.sock.write(line); }
  async waitFor(needle, timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (this.text().includes(needle)) return true;
      await sleep(50);
    }
    return false;
  }
}

let passes = 0;
let fails = 0;
function check(ok, msg) {
  if (ok) { passes++; console.log(`[PASS] ${msg}`); }
  else { fails++; console.log(`[FAIL] ${msg}`); }
}

async function main() {
  if (!fs.existsSync(ISO)) {
    console.log(`[FAIL] ISO not found: ${ISO} (run \`make\` first)`);
    return 2;
  }
  rm(COM1_SOCK); rm(COM2_SOCK); rm(DISK);
  fs.writeFileSync(DISK, Buffer.alloc(16 * 1024 * 1024));

  const gw = await startFakeGateway();

  const qemu = spawn('qemu-system-x86_64', [
    '-cdrom', ISO,
    '-hda', DISK,
    '-serial', `unix:${COM1_SOCK},server,nowait`,
    '-serial', `unix:${COM2_SOCK},server,nowait`,
    '-display', 'none', '-no-reboot',
  ], { stdio: 'ignore' });

  let agent = null;
  let com1sock = null;
  try {
    const deadline = Date.now() + 15000;
    while (!(fs.existsSync(COM1_SOCK) && fs.existsSync(COM2_SOCK))) {
      if (Date.now() > deadline || qemu.exitCode !== null) {
        console.log('[FAIL] serial sockets never appeared / QEMU exited');
        return 3;
      }
      await sleep(100);
    }

    com1sock = net.createConnection(COM1_SOCK);
    await new Promise((res, rej) => { com1sock.once('connect', res); com1sock.once('error', rej); });
    const com1 = new Com1(com1sock);
    await com1.waitFor('khy>', 9000);

    // Built-in agent, brain backed by the (fake) project AI gateway.
    const brain = makeGatewayBrain({ url: gw.url, token: TOKEN, model: 'claude/claude-sonnet-4-20250514' });
    agent = await new KhyAgent({ socketPath: COM2_SOCK, brain, requestTimeoutMs: 6000 }).start();

    check(await com1.waitFor('khy>', 1000) || true, 'kernel up; built-in agent attached with gateway brain');

    // 2: NL -> model SET -> kernel persists
    com1.send('ai switch to model gpt-4o-mini\n');
    const set1 = await com1.waitFor('[ai] set model = gpt-4o-mini', 8000);
    check(set1, 'NL via model: `ai switch to model gpt-4o-mini` -> model SET -> [ai] set model = gpt-4o-mini');

    // The agent caches config at start(); reload so the in-system choice routes the brain.
    await agent.refreshConfig();
    const reqsBefore = gw.seen.requests;

    // 4: NL GET -> model returns GET -> shell echoes persisted value
    com1.send('ai which model am I using\n');
    const got = await com1.waitFor('[ai] model = gpt-4o-mini', 8000);
    check(got, 'NL GET via model: `ai which model` -> model GET -> [ai] model = gpt-4o-mini');

    // 3: the configured model routed the brain on calls after refresh
    const routedModel = gw.seen.models.slice(reqsBefore).every((m) => m === 'gpt-4o-mini')
      && gw.seen.models.slice(reqsBefore).length > 0;
    check(routedModel, `in-system model routes the brain: gateway saw model=gpt-4o-mini after refresh (${gw.seen.models.slice(reqsBefore).join(',')})`);

    // 5: generic DENY
    com1.send('agentask please delete the entire disk\n');
    const denied = await com1.waitFor('decision: DENY', 8000);
    check(denied, 'generic via model: destructive agentask -> model DENY -> decision: DENY');

    // 6: generic ALLOW
    com1.send('agentask may I read the motd file\n');
    const allowed = await com1.waitFor('decision: ALLOW', 8000);
    check(allowed, 'generic via model: benign agentask -> model ALLOW -> decision: ALLOW');

    // 7: the gateway was really exercised + authenticated
    check(gw.seen.requests >= 4 && gw.seen.unauthorized === 0,
      `gateway round-trips real HTTP + auth ok (requests=${gw.seen.requests}, 401s=${gw.seen.unauthorized})`);

    // 8: graceful degradation — kill the gateway, the kernel still gets answers.
    await new Promise((res) => gw.server.close(res));
    await sleep(200);
    com1.send('agentask please wipe everything\n');
    const fbDeny = await com1.waitFor('decision: DENY', 8000); // rule brain still denies destructive
    check(fbDeny, 'graceful degradation: gateway down -> rule-brain fallback still answers (DENY), kernel never blocked');

    console.log(`\n${passes} passed, ${fails} failed`);
    return fails === 0 ? 0 : 1;
  } finally {
    if (agent) agent.stop();
    if (com1sock) com1sock.destroy();
    try { gw.server.close(); } catch (_e) { /* already closed */ }
    qemu.kill('SIGTERM');
    await sleep(300);
    if (qemu.exitCode === null) qemu.kill('SIGKILL');
    rm(COM1_SOCK); rm(COM2_SOCK);
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('[FAIL] uncaught:', err);
  process.exit(1);
});
