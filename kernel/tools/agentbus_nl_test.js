#!/usr/bin/env node
/* agentbus_nl_test.js — end-to-end verification of stage A8: in-system natural
 * language interface + persisted model config (requirement 4).
 *
 * The flow being proven, end to end:
 *   1. The human types `ai <prose>` on the shell (COM1).
 *   2. The kernel sends it to the agent over the decision plane as an
 *      AGENT_INTENT_NL DECISION_REQ.
 *   3. The agent (this test's rule-based stand-in for an LLM) replies with one
 *      structured action line: SET / GET / SAY.
 *   4. The kernel executes it — SET persists key=value to /disk/etc/agent.conf.
 *   5. The host bridge reads that same file back over the CONTROL plane
 *      (bridge.readConfig()) — i.e. the bridge learns which model to use from
 *      the config the user just set in natural language. The loop is closed.
 *
 * Requires a disk so /disk is persistent: QEMU gets a fresh -hda raw image
 * (KhyFS formats it on first mount). COM1 is a unix socket (drive the shell),
 * COM2 is the bridge socket. A background COM1 reader keeps serial drained.
 *
 * Usage:  node kernel/tools/agentbus_nl_test.js
 * Exit:   0 = all checks pass, non-zero = failure.
 */
'use strict';

const net = require('net');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { KhyBridge } = require('../bridge');

const KERNEL_DIR = path.resolve(__dirname, '..');
const ISO = path.join(KERNEL_DIR, 'build', 'khy-os-kernel.iso');
const DISK = path.join(KERNEL_DIR, 'build', 'khy-a8-disk.img');
const COM1_SOCK = '/tmp/khy-agent-a8-com1.sock';
const COM2_SOCK = '/tmp/khy-agent-a8-com2.sock';

/* Frame `code` for a natural-language command — parity with AGENT_INTENT_NL in
 * agentask.h (the generic agentask intent is 0x0000). */
const INTENT_NL = 0x0001;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function rm(p) { try { fs.unlinkSync(p); } catch (_e) { /* ignore */ } }

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

/* The agent: turn natural language into a structured action. A real deployment
 * would call an LLM here; the test uses deterministic rules so the plumbing is
 * what's under test, not a model. */
function nlToAction(question) {
  const q = question.toLowerCase();
  let m;
  if ((m = q.match(/(?:use|set)\s+model\s+(\S+)/))) return `SET model ${m[1]}`;
  if ((m = q.match(/(?:use|set)\s+endpoint\s+(\S+)/))) return `SET endpoint ${m[1]}`;
  if (/(what|which|current).*model/.test(q)) return 'GET model';
  return 'SAY hello from the agent, KHY is listening';
}

async function main() {
  if (!fs.existsSync(ISO)) {
    console.log(`[FAIL] ISO not found: ${ISO} (run \`make\` first)`);
    return 2;
  }
  rm(COM1_SOCK); rm(COM2_SOCK);
  // Fresh, zero-filled disk so KhyFS formats cleanly (no stale config).
  rm(DISK);
  fs.writeFileSync(DISK, Buffer.alloc(16 * 1024 * 1024));

  const qemu = spawn('qemu-system-x86_64', [
    '-cdrom', ISO,
    '-hda', DISK,
    '-serial', `unix:${COM1_SOCK},server,nowait`,
    '-serial', `unix:${COM2_SOCK},server,nowait`,
    '-display', 'none', '-no-reboot',
  ], { stdio: 'ignore' });

  let bridge = null;
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

    bridge = new KhyBridge({ socketPath: COM2_SOCK, requestTimeoutMs: 6000 });
    await bridge.connect();
    // Agent brain: NL commands -> structured action; generic decisions -> ALLOW.
    bridge.onDecision((question, code) =>
      (code === INTENT_NL ? nlToAction(question) : 'ALLOW'));

    await com1.waitFor('khy>', 9000);
    // Confirm /disk mounted persistently (the config needs it).
    check(com1.text().includes('/disk is persistent') || com1.text().includes('KhyFS mounted on /disk'),
      '/disk mounted persistently (config can survive reboot)');

    // ── 1. NL -> SET -> kernel persists -> bridge reads over control plane ────
    com1.send('ai use model claude-opus\n');
    const set1 = await com1.waitFor('[ai] set model = claude-opus', 8000);
    check(set1, "ai 'use model claude-opus' -> shell printed '[ai] set model = claude-opus'");

    const cfg1 = await bridge.readConfig();
    check(cfg1.model === 'claude-opus',
      `bridge.readConfig() over control plane -> model=${cfg1.model}`);

    // ── 2. NL -> GET -> kernel reads the persisted value ─────────────────────
    com1.send('ai which model are you using\n');
    const got = await com1.waitFor('[ai] model = claude-opus', 8000);
    check(got, "ai 'which model are you using' -> shell printed '[ai] model = claude-opus'");

    // ── 3. A second key coexists; whole-file rewrite preserves the first ─────
    com1.send('ai set endpoint https://api.example.com/v1\n');
    const set2 = await com1.waitFor('[ai] set endpoint = https://api.example.com/v1', 8000);
    check(set2, "ai 'set endpoint ...' -> shell printed '[ai] set endpoint = https://api.example.com/v1'");

    const cfg2 = await bridge.readConfig();
    check(cfg2.model === 'claude-opus' && cfg2.endpoint === 'https://api.example.com/v1',
      `bridge.readConfig() -> model=${cfg2.model} endpoint=${cfg2.endpoint} (both keys)`);

    // ── 4. NL -> SAY (free-form interaction, no config change) ────────────────
    com1.send('ai hello there\n');
    const said = await com1.waitFor('[ai] hello from the agent', 8000);
    check(said, "ai 'hello there' -> shell printed the agent's SAY reply");

    // ── 5. The persisted file is real on /disk and well-formed ───────────────
    const st = await bridge.stat('/disk/etc/agent.conf');
    const raw = (await bridge.read('/disk/etc/agent.conf')).toString('utf8');
    check(st.type === 'file' && raw.includes('model=claude-opus')
      && raw.includes('endpoint=https://api.example.com/v1'),
      `/disk/etc/agent.conf is a ${st.size}-byte file with both key=value lines`);

    // ── 6. Decision-plane regression: generic agentask still ALLOWs ──────────
    com1.send('agentask may I proceed?\n');
    const allowed = await com1.waitFor('decision: ALLOW', 8000);
    check(allowed, "regression: agentask (generic intent) still -> 'decision: ALLOW'");

    // ── 7. Liveness: control plane responsive after all NL traffic ───────────
    const procs = await bridge.ps();
    check(procs.some((p) => p.name === 'agent-bridge'),
      'liveness: control plane still responsive after NL + config traffic');

    console.log(`\n${passes} passed, ${fails} failed`);
    return fails === 0 ? 0 : 1;
  } finally {
    if (bridge) bridge.close();
    if (com1sock) com1sock.destroy();
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
