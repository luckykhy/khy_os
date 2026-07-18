'use strict';

/**
 * KhyOsTool — deep low-level access to the bare-metal KHY OS kernel for the agent.
 *
 * Boots the kernel (kernel/) under QEMU via the shared KhyOsRunner over a 16550
 * serial bridge, then runs kernel shell commands and returns their output. This
 * gives the agent operations no other tool offers: inspect processes/memory,
 * load & run Ring 3 ELF programs, exercise syscalls, and read/write RAW disk
 * blocks on a persistent KhyFS image.
 *
 * Isolation: everything runs INSIDE QEMU — the kernel cannot touch the host
 * filesystem or network. The only persistent state is a dedicated KhyFS disk
 * image (~/.khyquant/khyos/disks/agent.img), so files/blocks written in one
 * call survive into later calls and across kernel reboots.
 *
 * Lifecycle: the kernel boots lazily on the first call and is REUSED across
 * calls (booting QEMU costs a few seconds). Calls are serialized — the kernel
 * has a single serial line. The session is torn down after an idle period, when
 * QEMU exits, or when the host process exits. Pass restart:true to reboot.
 */

const path = require('path');
const { BaseTool } = require('../_baseTool');

// ── Singleton kernel session (lazy boot, reused across tool calls) ──
let _runner = null;
let _booting = null; // in-flight boot promise (dedupe concurrent first calls)
let _idleTimer = null;
let _chain = Promise.resolve(); // serialize commands on the single serial line
let _exitHookInstalled = false;

const IDLE_MS = Number(process.env.KHY_KHYOS_TOOL_IDLE_MS) || 4 * 60 * 1000;
const BOOT_TIMEOUT_MS = Number(process.env.KHY_KHYOS_TOOL_BOOT_MS) || 25000;

function loadKhyos() {
  // Resolved via @khy/shared subpath export (exports map ./runtime/khyos).
  return require('@khy/shared/runtime/khyos');
}

function agentDiskPath(khyos) {
  return path.join(khyos.khyosCacheDir(), 'disks', 'agent.img');
}

function clearIdleTimer() {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
}

function armIdleTimer() {
  clearIdleTimer();
  _idleTimer = setTimeout(() => { void teardown(); }, IDLE_MS);
  if (_idleTimer.unref) _idleTimer.unref();
}

async function teardown() {
  clearIdleTimer();
  const r = _runner;
  _runner = null;
  if (r) { try { await r.stop(); } catch { /* ignore */ } }
}

function installExitHook() {
  if (_exitHookInstalled) return;
  _exitHookInstalled = true;
  // Best-effort synchronous kill so QEMU isn't orphaned if the host exits while
  // a kernel session is live (async stop() can't complete inside 'exit').
  process.once('exit', () => {
    try {
      const pid = _runner && _runner.pid;
      if (pid) process.kill(pid, 'SIGKILL');
    } catch { /* ignore */ }
  });
}

async function ensureRunner() {
  if (_runner && _runner.running) return _runner;
  if (_booting) return _booting;
  _booting = (async () => {
    const khyos = loadKhyos();
    const iso = await khyos.ensureKhyosIso();
    const runner = new khyos.KhyOsRunner({ isoPath: iso, diskPath: agentDiskPath(khyos) });
    // Errors surface to callers via runCommand rejection; on exit, drop the
    // singleton so the next call boots a fresh kernel.
    runner.on('error', () => { /* noop — observed through command failures */ });
    runner.on('exit', () => { if (_runner === runner) { _runner = null; clearIdleTimer(); } });
    await runner.start();
    await runner.waitForPrompt(BOOT_TIMEOUT_MS);
    _runner = runner;
    installExitHook();
    return runner;
  })();
  try {
    return await _booting;
  } finally {
    _booting = null;
  }
}

class KhyOsTool extends BaseTool {
  static toolName = 'khyos';
  static category = 'system';
  static risk = 'medium';
  static aliases = ['KhyOs', 'khy_os', 'kernel', 'kernel_exec'];
  static searchHint = 'bare-metal kernel low-level disk memory process syscall qemu';
  static shouldDefer = false;

  isReadOnly() { return false; }
  isConcurrencySafe() { return false; }

  prompt() {
    return `Run a command on the bare-metal KHY OS kernel and return its output.

KHY OS is a custom x86_64 kernel booted inside QEMU. This tool is the ONLY way to do deep low-level operations the normal shell/file tools cannot: inspect kernel processes and memory, load and run Ring 3 ELF programs, exercise syscalls, and read/write RAW disk blocks on a persistent filesystem.

Isolation & state:
- Everything runs INSIDE QEMU — the kernel cannot read or modify the host machine. Safe to experiment.
- State persists on a dedicated KhyFS disk image. Files and disk blocks written in one call survive into later calls AND across kernel reboots.
- The kernel boots on the first call (a few seconds) and is reused. Pass restart:true to reboot from a clean kernel state (the KhyFS disk still persists).

Available shell commands (the \`command\` argument):
- help                      list commands
- ps                        list processes
- mem                       memory usage
- ls [dir]                  list a directory (e.g. ls /bin)
- cat <file>                print a file
- write <file> <text>       create/overwrite a file (KhyFS, persisted)
- append <file> <text>      append to a file
- rm <file>                 delete a file
- run <prog>                run a Ring 3 program from /bin (fork+exec), e.g. run /bin/forkwait.elf
- sleep <ms>                sleep
- netstat | netsend | netrecv   networking (prototype)
- diskinfo                  ATA disk geometry/info
- diskread <block>          read a raw disk block
- diskwrite <block> <text>  write a raw disk block (persisted; survives reboot)
- syscalltest               run the syscall self-test

Tips:
- To prove low-level persistence: \`diskwrite 100 hello\`, then call again with restart:true and \`diskread 100\` — the data survives the reboot.
- Pre-built Ring 3 test programs live in /bin (init.elf, forkwait.elf, forktest.elf, exectest.elf, argv.elf, filetest.elf, badptr.elf). \`ls /bin\` to see them.
- Output is the kernel's serial output with the echoed command and prompt stripped.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The KHY OS kernel shell command to run, e.g. "ps", "ls /bin", "run /bin/forkwait.elf", "diskwrite 100 hello", "diskread 100".',
          minLength: 1,
        },
        timeout_ms: {
          type: 'number',
          description: 'Max time to wait for the command to finish, in ms (default 15000).',
          min: 1000,
          max: 120000,
        },
        restart: {
          type: 'boolean',
          description: 'Reboot the kernel before running this command (fresh kernel state; the KhyFS disk still persists). Use to test reboot persistence or recover a wedged kernel.',
        },
      },
      required: ['command'],
    };
  }

  getActivityDescription(input) {
    return `KHY OS 内核: ${String((input && input.command) || '').slice(0, 48)}`;
  }

  async execute(params, _context) {
    const command = String((params && params.command) || '').trim();
    if (!command) {
      return { success: false, error: 'command is required (a KHY OS shell command, e.g. "ps", "ls /bin", "diskread 100")' };
    }
    const timeoutMs = Number(params.timeout_ms) > 0 ? Number(params.timeout_ms) : 15000;
    const restart = !!params.restart;

    // Serialize on the single serial line so concurrent tool calls never
    // interleave their bytes. Keep the chain alive regardless of outcome.
    const run = _chain.then(async () => {
      if (restart) await teardown();
      const coldBoot = !(_runner && _runner.running);

      let runner;
      try {
        runner = await ensureRunner();
      } catch (err) {
        return { success: false, error: `failed to boot KHY OS kernel: ${err.message}` };
      }
      armIdleTimer();

      try {
        const out = await runner.runCommand(command, { timeoutMs });
        const body = out && out.length ? out : '(no output)';
        const note = coldBoot ? '[kernel booted]\n' : '';
        return {
          success: true,
          command,
          coldBoot,
          content: `${note}$ ${command}\n${body}`,
        };
      } catch (err) {
        // A timed-out/wedged kernel: drop the session so the next call reboots clean.
        await teardown();
        return { success: false, error: `command failed: ${err.message}` };
      }
    });
    _chain = run.then(() => {}, () => {});
    return run;
  }
}

module.exports = new KhyOsTool();
module.exports.KhyOsTool = KhyOsTool;
