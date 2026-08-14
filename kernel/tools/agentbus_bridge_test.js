#!/usr/bin/env node
/* agentbus_bridge_test.js — end-to-end verification of the host khy-bridge
 * (stage A7) against the real kernel in QEMU. This is the first test where the
 * agent side speaks JSON, not hand-packed bytes: it drives the kernel entirely
 * through bridge/index.js, proving the host single-source-of-truth works across
 * all three planes at once.
 *
 *   - control plane (over COM2, pure JSON API): list / stat / read / write /
 *     append / ps, plus a negative ENOENT case via the raw escape hatch.
 *   - decision plane: a decision handler answers a DECISION_REQ the kernel
 *     raises when we type `agentask ...` on the shell (COM1); we confirm the
 *     shell printed the bridge's decision.
 *   - event plane: we subscribe to bridge events, run a clean program and a
 *     faulting one on the shell, and confirm SPAWN/EXIT and FAULT/EXIT arrive
 *     as parsed JSON.
 *
 * COM1 is a unix socket (so we can drive the shell for the decision/event
 * triggers and read its output); COM2 is the bridge socket. A background COM1
 * reader keeps the shell's serial output drained so kernel serial_print never
 * back-pressures (which would otherwise make a running program — and thus its
 * events — lag; see the A6 test note).
 *
 * Usage:  node kernel/tools/agentbus_bridge_test.js
 * Exit:   0 = all checks pass, non-zero = failure.
 */
'use strict';

const net = require('net');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { KhyBridge } = require('../bridge');
const P = require('../bridge/khy-protocol');

const KERNEL_DIR = path.resolve(__dirname, '..');
const ISO = path.join(KERNEL_DIR, 'build', 'khy-os-kernel.iso');
const COM1_SOCK = '/tmp/khy-agent-a7-com1.sock';
const COM2_SOCK = '/tmp/khy-agent-a7-com2.sock';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rm(p) { try { fs.unlinkSync(p); } catch (_e) { /* ignore */ } }

/* Background reader for COM1: accumulate the shell transcript and let us wait
 * for a substring, while continuously draining so the kernel never blocks on
 * serial TX back-pressure. */
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

/* Collect bridge events and wait for one matching a predicate. */
class EventLog {
  constructor(bridge) {
    this.events = [];
    bridge.on('event', (e) => this.events.push(e));
  }
  async waitFor(pred, timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      await sleep(50);
    }
    return null;
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
  rm(COM1_SOCK); rm(COM2_SOCK);

  const qemu = spawn('qemu-system-x86_64', [
    '-cdrom', ISO,
    '-serial', `unix:${COM1_SOCK},server,nowait`,
    '-serial', `unix:${COM2_SOCK},server,nowait`,
    '-display', 'none', '-no-reboot',
  ], { stdio: 'ignore' });

  let bridge = null;
  let com1sock = null;
  try {
    // Wait for both serial sockets to appear.
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
    const events = new EventLog(bridge);

    // Let the kernel boot far enough to start the shell + the bridge task.
    await com1.waitFor('khy>', 9000);

    // ── Control plane (pure JSON over COM2) ─────────────────────────────────
    const root = await bridge.list('/');
    const rootNames = new Set(root.map((e) => e.name));
    const wantDirs = ['bin', 'etc', 'proc', 'tmp', 'var', 'net'];
    check(wantDirs.every((d) => rootNames.has(d)),
      `list('/') -> ${[...rootNames].sort().join(',')}`);

    const st = await bridge.stat('/etc/motd');
    check(st.type === 'file' && st.size > 0,
      `stat('/etc/motd') -> type=${st.type} size=${st.size} mode=${st.mode.toString(8)}`);

    const motd = await bridge.read('/etc/motd');
    check(motd.toString('utf8').startsWith('KHY OS ramfs online') && motd.length === st.size,
      `read('/etc/motd') -> ${motd.length} bytes, banner matches`);

    const line1 = 'bridge wrote this\n';
    const n1 = await bridge.write('/tmp/bridge.txt', line1);
    const back1 = await bridge.read('/tmp/bridge.txt');
    check(n1 === Buffer.byteLength(line1) && back1.toString('utf8') === line1,
      `write+read round-trip -> ${n1} bytes match`);

    const line2 = 'and appended this\n';
    await bridge.write('/tmp/bridge.txt', line2, { append: true });
    const back2 = await bridge.read('/tmp/bridge.txt');
    check(back2.toString('utf8') === line1 + line2,
      `append -> file now ${back2.length} bytes, concatenated`);

    const procs = await bridge.ps();
    check(procs.some((p) => p.name === 'agent-bridge'),
      `ps() -> ${procs.length} procs incl. agent-bridge`);

    const miss = await bridge.rawVerb(P.VERB.STAT, P.statReq('/no/such/path'));
    check(miss.statusName === 'ENOENT', `stat('/no/such/path') -> ${miss.statusName}`);

    // ── Decision plane (OS -> agent; bridge answers) ────────────────────────
    bridge.onDecision((q) => (q.includes('shut down') ? 'DENY' : 'ALLOW'));
    let sawQuestion = null;
    bridge.once('decision', (d) => { sawQuestion = d.question; });
    com1.send('agentask may I proceed?\n');
    const decided = await com1.waitFor('decision: ALLOW', 8000);
    check(decided && sawQuestion === 'may I proceed?',
      `decision plane: bridge saw '${sawQuestion}', shell printed 'decision: ALLOW'`);

    // ── Event plane (OS -> agent; fire-and-forget) ──────────────────────────
    com1.send('run /bin/stattest.elf\n');
    const spawn1 = await events.waitFor(
      (e) => e.kind === 'spawn' && e.name.includes('stattest'), 12000);
    const exit1 = spawn1
      ? await events.waitFor((e) => e.kind === 'exit' && e.pid === spawn1.pid, 12000)
      : null;
    check(spawn1 && exit1 && exit1.code === 0,
      `event plane: SPAWN pid=${spawn1 && spawn1.pid} name=${spawn1 && spawn1.name}, `
      + `EXIT code=${exit1 && exit1.code}`);

    com1.send('run /bin/fault.elf\n');
    const fault = await events.waitFor((e) => e.kind === 'fault', 12000);
    const faultExit = fault
      ? await events.waitFor((e) => e.kind === 'exit' && e.pid === fault.pid, 12000)
      : null;
    check(fault && fault.vector === 14 && faultExit && faultExit.code === 128 + 14,
      `event plane: FAULT pid=${fault && fault.pid} vector=${fault && fault.vector}, `
      + `paired EXIT code=${faultExit && faultExit.code}`);

    // ── Liveness: control plane still works after all of the above ───────────
    const procs2 = await bridge.ps();
    check(procs2.some((p) => p.name === 'agent-bridge'),
      'liveness: control plane still responsive after decision+event traffic');

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
