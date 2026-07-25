'use strict';

/**
 * KhyOsRunner — the single host-side bridge to the bare-metal KHY OS kernel.
 *
 * The kernel (kernel/) talks to the outside world over one 16550 UART serial
 * port — a complete bidirectional byte stream (keyboard‖serial in, VGA+serial
 * out). It needs ZERO changes to be driven from the host: we boot it under QEMU
 * with the serial port exposed as a loopback TCP listener
 * (`-serial tcp:127.0.0.1:<port>,server,nowait`) and connect to it. TCP (not a
 * unix socket) makes the bridge identical on Windows and Linux.
 *
 * One runner, three faces (see the integration plan):
 *   - TUI mounts a runner in-process (KhyOsView)
 *   - the frontend drives one per /ws session (aiManagementServer)
 *   - the pip `khy os` CLI delegates to Node which uses this class
 *
 * Events (extends EventEmitter):
 *   'ready'  () — serial socket connected; kernel is reachable
 *   'data'   (Buffer) — raw bytes from the kernel serial output
 *   'exit'   ({ code, signal }) — QEMU process exited
 *   'error'  (Error) — spawn/connect/runtime failure
 */

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');

const { findFreePort } = require('./portUtils');
const { ensureDiskImage, resolveQemuImg } = require('./diskImage');
const { locateSystemQemu } = require('./qemuLocate');

const DEFAULT_QEMU = 'qemu-system-x86_64';
// The kernel polls the UART with no RX interrupt, so a burst written faster than
// it drains overflows the (small) input path. Pace programmatic writes: send at
// most CHUNK bytes, then wait CHUNK_DELAY_MS before the next slice.
const WRITE_CHUNK = 16;
const WRITE_CHUNK_DELAY_MS = 8;
// `,nowait` means QEMU does not block boot waiting for us to connect, creating a
// TOCTOU window before its listener is up. Retry the connect with a short backoff.
const CONNECT_RETRIES = 60;
const CONNECT_RETRY_DELAY_MS = 50;
// Default shell prompt emitted by kernel/src/shell.c.
const DEFAULT_PROMPT_RE = /khy>\s*$/;
// Loose prompt token — matches the prompt anywhere, used to detect "booted"
// even while one-shot boot tasks (the IPC demo) are still printing after it.
const DEFAULT_PROMPT_TOKEN = 'khy>';

// Desktop screen capture (see captureScreen): the kernel renders its windowed
// desktop to the VGA framebuffer even under `-display none`, so QEMU's HMP
// `screendump` can snapshot it. We expose the Human Monitor Protocol on a second
// loopback TCP listener and drive `screendump <tmpfile>` over it on demand. The
// serial bridge is untouched — this is a strictly additive second channel.
const MONITOR_CONNECT_RETRIES = 40;
const MONITOR_CONNECT_RETRY_DELAY_MS = 50;
// A 1024x768 P6 PPM is ~2.36 MB; QEMU writes it fast, but allow generous slack
// for a slow disk before we give up on one frame.
const SCREENDUMP_WRITE_TIMEOUT_MS = 4000;
// Input-injection HMP commands (`sendkey` / `mouse_move` / `mouse_button`) return
// their "(qemu) " prompt almost immediately. A short ceiling keeps a stalled
// monitor from wedging the interactive path — the timeout resolves (never
// rejects) so a dropped keystroke is at worst silently lost, never fatal.
const INPUT_COMMAND_TIMEOUT_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Platform-specific "how to install QEMU" hint, appended to the missing-QEMU
 * error so the user gets a concrete next step instead of a dead end. The caller
 * keeps the core "not found — install QEMU to run KHY OS … KHY_QEMU" wording
 * verbatim; this only adds the install command(s). The commands themselves are
 * language-neutral, so this stays useful regardless of UI locale.
 *
 * Honesty gate (`opts.autoDownloadAvailable`): the Windows branch may only
 * promise "normally auto-downloaded on first run" when a portable QEMU is
 * ACTUALLY pinned in the manifest (and the qemu binary was not pinned by the
 * user). With the empty placeholder pin the wheel ships today, no download is
 * ever attempted, so claiming one "normally" happens is a false promise that
 * sends Windows users chasing a retry that can never succeed. When auto-download
 * is not armed we give the real, actionable path instead.
 */
function qemuInstallHint(platform = process.platform, opts = {}) {
  if (platform === 'win32') {
    if (opts.autoDownloadAvailable) {
      return 'On Windows a portable QEMU is normally auto-downloaded on first '
        + 'run; if that failed, install QEMU and add it to PATH, or point '
        + 'KHY_QEMU at qemu-system-x86_64.exe.';
    }
    // No portable QEMU is pinned → no auto-download will happen. Be honest and
    // point at the concrete next step.
    return 'On Windows, install QEMU and add it to PATH (a Windows build is at '
      + 'https://qemu.weilnetz.de/w64/), or point KHY_QEMU at the '
      + 'qemu-system-x86_64.exe you installed.';
  }
  if (platform === 'darwin') {
    return 'On macOS: brew install qemu.';
  }
  // Linux and other POSIX hosts.
  return 'Install it with your package manager — '
    + 'Debian/Ubuntu: sudo apt-get install qemu-system-x86 · '
    + 'Fedora: sudo dnf install qemu-system-x86 · '
    + 'Arch: sudo pacman -S qemu-base.';
}

/** Strip ANSI/VT100 escape sequences the kernel shell emits for cursor moves. */
function stripAnsi(s) {
  // CSI sequences (ESC [ ... final-byte) and lone escapes.
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[=>]/g, '');
}

class KhyOsRunner extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.isoPath   - absolute path to a bootable kernel ISO
   * @param {string} [opts.diskPath] - raw disk image for KhyFS persistence; if
   *                                    set, ensured/created and attached as IDE
   * @param {string} [opts.memory='512M']
   * @param {string[]} [opts.extraArgs=[]] - extra QEMU args appended verbatim
   * @param {string} [opts.qemu]    - qemu-system-x86_64 path override
   * @param {RegExp} [opts.promptRe] - shell prompt matcher for runCommand
   * @param {Function} [opts.spawnSync] - inject child_process.spawnSync (test seam)
   * @param {Function} [opts.ensurePortableQemu] - inject the portable-QEMU
   *        provisioner (test seam); defaults to builderProvisioner's.
   */
  constructor(opts = {}) {
    super();
    if (!opts.isoPath) throw new Error('KhyOsRunner requires opts.isoPath');
    this.isoPath = opts.isoPath;
    this.diskPath = opts.diskPath || null;
    this.memory = opts.memory || '512M';
    this.extraArgs = Array.isArray(opts.extraArgs) ? opts.extraArgs : [];
    // Desktop capture: when enabled, start() adds a `-monitor tcp:...` HMP
    // listener so captureScreen() can `screendump` the VGA framebuffer. Opt-in —
    // absent this flag the QEMU command line is byte-for-byte unchanged. The
    // backend gates it behind KHY_KHYOS_DESKTOP_CAPTURE; here it is a plain option
    // so the class stays env-free and unit-testable.
    this.enableDesktopCapture = !!opts.enableDesktopCapture;
    this.qemu = opts.qemu || process.env.KHY_QEMU || DEFAULT_QEMU;
    // An explicitly chosen QEMU (constructor opt or KHY_QEMU) is honored verbatim
    // — never auto-provisioned over. Only the bare default name triggers the
    // PATH-probe → portable-download fallback in _ensureRuntimeQemu().
    this._qemuExplicit = !!(opts.qemu || process.env.KHY_QEMU);
    this._spawnSync = opts.spawnSync || spawnSync;
    this._ensurePortableQemu = opts.ensurePortableQemu || null;
    // Inject the system-QEMU locator (test seam); defaults to the pure leaf.
    this._locateSystemQemu = opts.locateSystemQemu || null;
    this.promptRe = opts.promptRe || DEFAULT_PROMPT_RE;
    this.promptToken = opts.promptToken || DEFAULT_PROMPT_TOKEN;

    this.proc = null;
    this.socket = null;
    this.port = null;
    // Desktop-capture HMP monitor: a second loopback listener, its port, the
    // persistent connection, and a serialized-capture guard (screendump writes to
    // one shared temp file, so overlapping captures must not race).
    this.monitorPort = null;
    this.monitorSocket = null;
    this._captureInFlight = null;
    this._running = false;
    this._stopping = false;
    this._buffer = ''; // decoded text accumulator for runCommand()
    this._lastDataAt = 0; // ms timestamp of the most recent serial byte
    // Set by the process 'error' handler when QEMU fails to spawn (e.g. ENOENT
    // when QEMU is not installed). _connectWithRetry() short-circuits on it so a
    // spawn failure surfaces as its real cause, not a misleading serial timeout.
    this._spawnError = null;
  }

  /** True once QEMU is spawned and the serial socket is connected. */
  get running() {
    return this._running;
  }

  /** PID of the QEMU child process, or null if not running. For best-effort
   *  synchronous teardown (e.g. a host process 'exit' hook) where async stop()
   *  cannot complete. */
  get pid() {
    return this.proc ? this.proc.pid : null;
  }

  /**
   * Boot the kernel under QEMU and connect to its serial socket.
   * Resolves once connected (also emits 'ready'); rejects on spawn/connect
   * failure. Idempotent guard: throws if already started.
   */
  async start() {
    if (this.proc) throw new Error('KhyOsRunner already started');
    this._stopping = false;
    this._spawnError = null;

    // Resolve qemu-system before spawning: when none is on PATH (typical fresh
    // Windows), auto-download the pinned portable QEMU. Fail-soft — leaves the
    // default name so the spawn ENOENT path emits the actionable install hint.
    await this._ensureRuntimeQemu();

    if (this.diskPath) ensureDiskImage(this.diskPath);

    this.port = await findFreePort();

    const args = [
      '-m', this.memory,
      '-cdrom', this.isoPath,
      '-serial', `tcp:127.0.0.1:${this.port},server,nowait`,
      '-display', 'none',
      '-no-reboot',
    ];
    if (this.diskPath) {
      // Explicit raw IDE drive (NOT -hda): -hda's format autodetection guards
      // KhyFS's LBA0 superblock write. See the diskImage.js note.
      args.push('-drive', `file=${this.diskPath},format=raw,if=ide`);
    }
    if (this.enableDesktopCapture) {
      // Second loopback listener for the Human Monitor Protocol. captureScreen()
      // connects here and issues `screendump`. `-display none` is retained: the
      // framebuffer still exists and renders, we simply never open a QEMU window.
      this.monitorPort = await findFreePort();
      args.push('-monitor', `tcp:127.0.0.1:${this.monitorPort},server,nowait`);
    }
    args.push(...this.extraArgs);

    try {
      this.proc = spawn(this.qemu, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      throw new Error(`failed to spawn ${this.qemu}: ${err.message}`);
    }

    let qemuStderr = '';
    if (this.proc.stderr) {
      this.proc.stderr.on('data', (d) => {
        qemuStderr += d.toString();
        if (qemuStderr.length > 4096) qemuStderr = qemuStderr.slice(-4096);
      });
    }

    this.proc.on('error', (err) => {
      // Normalize a missing-QEMU spawn failure (ENOENT) into an actionable hint.
      // Auto-download is only a real path when a portable QEMU is pinned AND the
      // user did not pin the binary explicitly — otherwise the hint must not
      // promise a download that can never happen.
      const autoDownloadAvailable = !this._qemuExplicit && this._portableQemuPinned();
      const normalized = (err && err.code === 'ENOENT')
        ? new Error(
            `${this.qemu} not found — install QEMU to run KHY OS `
              + `(set KHY_QEMU to override the executable path). `
              + qemuInstallHint(process.platform, { autoDownloadAvailable })
          )
        : err;
      // A spawn failure happens during start(), before we are connected: route it
      // through the start() rejection (via _connectWithRetry, which short-circuits
      // on _spawnError) as the SINGLE, real cause. Do NOT also emit 'error' here —
      // callers that surface both the 'error' event and the start() rejection would
      // otherwise report the same failure twice (and the old code additionally
      // buried it under a misleading "could not connect to serial port" timeout).
      // Once running, a process 'error' is a genuine live runtime fault → emit it.
      if (this._running) {
        this.emit('error', normalized);
      } else {
        this._spawnError = normalized;
        // A child that fails to spawn (ENOENT/EACCES) never becomes a live OS
        // process and so will NEVER emit 'exit'. Drop the dead reference now so
        // the short-circuit's stop() returns immediately instead of blocking on
        // stop()'s 3s SIGKILL fallback waiting for an exit that can never come.
        this.proc = null;
      }
    });

    this.proc.on('exit', (code, signal) => {
      this._running = false;
      const proc = this.proc;
      this.proc = null;
      if (this.socket) {
        try { this.socket.destroy(); } catch { /* ignore */ }
        this.socket = null;
      }
      if (!this._stopping) {
        // Unexpected QEMU exit before/while connected — surface stderr.
        if (code && code !== 0 && qemuStderr.trim()) {
          this.emit('error', new Error(`QEMU exited (code ${code}): ${qemuStderr.trim().slice(-400)}`));
        }
      }
      this.emit('exit', { code, signal });
      void proc;
    });

    await this._connectWithRetry(qemuStderr);
    this._running = true;
    this.emit('ready');
  }

  /**
   * Probe whether an executable is runnable on this host (`<exe> --version`
   * exits 0). Cheap, synchronous, and quiet. Returns false on ANY failure
   * (ENOENT, non-zero exit, spawn error) — never throws.
   */
  _probeExecutable(exe) {
    try {
      const r = this._spawnSync(exe, ['--version'], { stdio: 'ignore', timeout: 10000 });
      return !!(r && !r.error && r.status === 0);
    } catch {
      return false;
    }
  }

  /**
   * Ensure `this.qemu` points at a runnable qemu-system-x86_64 before boot.
   *
   * Order: (1) an explicit override (opts.qemu / KHY_QEMU) is honored as-is;
   * (2) a system QEMU on PATH is used when present; (3) otherwise the pinned
   * portable QEMU is downloaded+cached (Windows) and `this.qemu` repointed at it.
   * Fail-soft throughout: when nothing resolves (offline, not pinned, non-Windows
   * with no system QEMU), the default name is left untouched so start()'s spawn
   * ENOENT handler emits the actionable "install QEMU" hint — never worse than
   * before this auto-provisioning existed. Download progress is surfaced as
   * 'status' events ({ phase:'provisioning-qemu', downloaded, total, done }).
   */
  /**
   * Whether a portable QEMU is actually pinned for this host — i.e. whether the
   * auto-download in _ensureRuntimeQemu() could ever produce one. Drives the
   * honesty of the missing-QEMU hint. Fail-soft: any require/read error → false
   * (the safe, honest default — never promise a download that may not be armed).
   */
  _portableQemuPinned() {
    try {
      return !!require('./builderProvisioner').isPortableQemuPinned();
    } catch {
      return false;
    }
  }

  async _ensureRuntimeQemu() {
    if (this._qemuExplicit) return;
    if (this._probeExecutable(this.qemu)) return;

    // A system QEMU may be installed off-PATH — the Windows installer / winget put
    // qemu-system-x86_64.exe in C:\Program Files\qemu without touching PATH. Locate
    // it in well-known install dirs and use it before downloading a portable copy,
    // so an already-installed QEMU "just works" with no manual PATH editing. Gated
    // by KHY_QEMU_AUTOLOCATE (default on) inside the leaf; fail-soft → fall through.
    try {
      const locate = this._locateSystemQemu || locateSystemQemu;
      const found = locate({
        platform: process.platform,
        env: process.env,
        exists: (p) => { try { return fs.existsSync(p); } catch { return false; } },
        readdir: (d) => fs.readdirSync(d),
      });
      if (found && this._probeExecutable(found)) {
        this.qemu = found;
        return;
      }
    } catch { /* fail-soft: fall through to the portable download */ }

    let provisioned = null;
    try {
      const ensure = this._ensurePortableQemu
        || require('./builderProvisioner').ensurePortableQemu;
      provisioned = await ensure({
        onProgress: (p) => {
          try {
            this.emit('status', {
              phase: 'provisioning-qemu',
              downloaded: (p && p.downloaded) || 0,
              total: (p && p.total) || 0,
              done: !!(p && p.done),
            });
          } catch { /* status must never break a boot */ }
        },
      });
    } catch {
      provisioned = null; // fail-soft: fall through to the default name
    }
    if (provisioned && provisioned.systemBin) {
      this.qemu = provisioned.systemBin;
    }
  }

  async _connectWithRetry() {
    let lastErr;
    for (let i = 0; i < CONNECT_RETRIES; i++) {
      // A spawn failure (e.g. QEMU not installed → ENOENT) surfaces asynchronously
      // on the process 'error' event. Bail immediately with that real cause rather
      // than grinding through all CONNECT_RETRIES only to throw a misleading "could
      // not connect to serial port" error that buries it — the serial listener can
      // never come up if QEMU never started.
      if (this._spawnError) {
        try { await this.stop(); } catch { /* ignore */ }
        throw this._spawnError;
      }
      if (!this.proc) throw new Error('QEMU exited before serial connect');
      try {
        this.socket = await this._connectOnce();
        return;
      } catch (err) {
        lastErr = err;
        await sleep(CONNECT_RETRY_DELAY_MS);
      }
    }
    // Connect never succeeded — tear down QEMU so we don't leak it.
    try { await this.stop(); } catch { /* ignore */ }
    throw new Error(
      `could not connect to KHY OS serial port on 127.0.0.1:${this.port} ` +
        `after ${CONNECT_RETRIES} attempts: ${lastErr ? lastErr.message : 'unknown'}`
    );
  }

  _connectOnce() {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: this.port }, () => {
        sock.removeListener('error', onErr);
        // Bytes from the kernel: emit raw, and accumulate decoded text for runCommand.
        sock.on('data', (buf) => {
          this._lastDataAt = Date.now();
          this._buffer += buf.toString('utf-8');
          if (this._buffer.length > 1 << 20) this._buffer = this._buffer.slice(-(1 << 19));
          this.emit('data', buf);
        });
        sock.on('error', (err) => this.emit('error', err));
        resolve(sock);
      });
      const onErr = (err) => reject(err);
      sock.once('error', onErr);
    });
  }

  /**
   * Write raw bytes to the kernel serial input. Paced in small chunks because the
   * kernel polls RX with no interrupt — a single large burst would overflow it.
   * Fire-and-forget (returns a promise that resolves when fully flushed).
   *
   * @param {string|Buffer} data
   */
  async write(data) {
    if (!this.socket) throw new Error('KhyOsRunner not connected');
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf-8');
    for (let off = 0; off < buf.length; off += WRITE_CHUNK) {
      const slice = buf.subarray(off, off + WRITE_CHUNK);
      await new Promise((resolve, reject) => {
        this.socket.write(slice, (err) => (err ? reject(err) : resolve()));
      });
      if (off + WRITE_CHUNK < buf.length) await sleep(WRITE_CHUNK_DELAY_MS);
    }
  }

  /**
   * Run a single shell command and return its output as text. Sends `cmd\r`,
   * waits for the next prompt to reappear, then strips the echoed command line,
   * the trailing prompt, and ANSI escapes. For headless/one-shot use (pip
   * `khy os run`). For interactive use, drive write()/'data' directly.
   *
   * @param {string} cmd
   * @param {object} [o]
   * @param {RegExp} [o.promptRe] - prompt matcher (defaults to the runner's)
   * @param {number} [o.timeoutMs=10000]
   * @returns {Promise<string>}
   */
  async runCommand(cmd, o = {}) {
    if (!this.socket) throw new Error('KhyOsRunner not connected');
    const promptRe = o.promptRe || this.promptRe;
    const timeoutMs = o.timeoutMs || 10000;

    this._buffer = '';
    await this.write(`${cmd}\r`);

    const deadline = Date.now() + timeoutMs;
    // Wait until the prompt reappears after our command echo.
    for (;;) {
      const stripped = stripAnsi(this._buffer);
      if (promptRe.test(stripped)) break;
      if (Date.now() > deadline) {
        throw new Error(`runCommand('${cmd}') timed out after ${timeoutMs}ms`);
      }
      await sleep(20);
    }

    let out = stripAnsi(this._buffer);
    // Drop the echoed command line (first line, which contains our cmd).
    out = out.replace(/\r/g, '');
    const lines = out.split('\n');
    if (lines.length && lines[0].includes(cmd)) lines.shift();
    // Drop the trailing prompt line.
    while (lines.length && promptRe.test(lines[lines.length - 1] + '')) lines.pop();
    return lines.join('\n').replace(/\s+$/, '');
  }

  /**
   * Wait until the kernel shell is interactive: the prompt token has appeared
   * AND the serial line has been quiet for `quietMs`. The quiescence check is
   * essential — at boot the shell prints its first prompt, then one-shot tasks
   * (the IPC demo) keep printing after it, so an end-anchored match would never
   * fire until a command nudges a fresh prompt.
   */
  async waitForPrompt(timeoutMs = 15000, quietMs = 400) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const seen = this._buffer.includes(this.promptToken);
      const quiet = this._lastDataAt && Date.now() - this._lastDataAt >= quietMs;
      if (seen && quiet) return;
      if (Date.now() > deadline) throw new Error('timed out waiting for KHY OS shell prompt');
      await sleep(50);
    }
  }

  /**
   * Capture the desktop framebuffer as a PNG.
   *
   * The kernel renders its windowed desktop to the VGA framebuffer even under
   * `-display none`, so QEMU's HMP `screendump` can snapshot it. We drive the
   * monitor listener opened in start() (requires enableDesktopCapture), write the
   * PPM to a private temp file, read+decode it, and return a compact PNG.
   *
   * Captures are serialized per runner: concurrent callers await the same frame.
   *
   * @returns {Promise<{ png: Buffer, width: number, height: number }>}
   */
  async captureScreen() {
    if (!this.enableDesktopCapture) {
      throw new Error('desktop capture not enabled (construct with enableDesktopCapture)');
    }
    if (!this._running) throw new Error('KhyOsRunner not running');
    if (this._captureInFlight) return this._captureInFlight;
    this._captureInFlight = this._captureScreenOnce()
      .finally(() => { this._captureInFlight = null; });
    return this._captureInFlight;
  }

  async _captureScreenOnce() {
    const sock = await this._ensureMonitorSocket();
    // Unique temp file per runner keeps two sessions from colliding on disk.
    const tmp = path.join(
      os.tmpdir(),
      `khyos-screen-${process.pid}-${this.monitorPort}.ppm`
    );
    // HMP `screendump <file>` writes a P6 PPM, then re-prompts "(qemu) ". Wait for
    // that prompt (bounded) so we read a fully-flushed file.
    await this._monitorCommand(sock, `screendump ${tmp}`, SCREENDUMP_WRITE_TIMEOUT_MS);
    let raw;
    try {
      raw = fs.readFileSync(tmp);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    }
    const { ppmToRgba } = require('./ppmFrame');
    const { rgbaToPng } = require('./rgbaToPng');
    const { width, height, rgba } = ppmToRgba(raw);
    const png = rgbaToPng(rgba, width, height);
    return { png, width, height };
  }

  /**
   * Inject one keypress into the running guest via HMP `sendkey`. `qemuKeyName`
   * is an already-mapped QEMU key name (e.g. "a", "ret", "spc", "kp_enter") or a
   * "-"-joined chord ("ctrl-c"); mapping from browser KeyboardEvent.key lives in
   * the backend, not here. Fail-soft: a stopped runner or unusable monitor is a
   * dropped keystroke, never a throw — interactive input must not crash a session.
   *
   * Reuses the same monitor socket + `_monitorCommand` plumbing as captureScreen;
   * does not touch capture state.
   *
   * @param {string} qemuKeyName
   * @returns {Promise<boolean>} true if the command was written, false if skipped
   */
  async sendKey(qemuKeyName) {
    if (!this._running) return false;
    if (typeof qemuKeyName !== 'string' || qemuKeyName.length === 0) return false;
    try {
      const sock = await this._ensureMonitorSocket();
      await this._monitorCommand(sock, `sendkey ${qemuKeyName}`, INPUT_COMMAND_TIMEOUT_MS);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Inject relative pointer motion and/or button state via HMP. QEMU's default
   * PS/2 mouse takes relative deltas (`mouse_move dx dy`) and an absolute button
   * bitmask (`mouse_button <state>`, bit0=left bit1=right bit2=middle). The guest
   * kernel accumulates the cursor position from the IRQ12 packets and draws its
   * own cursor — this only feeds it deltas + buttons.
   *
   * `dx`/`dy` default to 0 so a pure button press/release can be sent alone.
   * `buttons` is omitted (not sent) when undefined so motion-only frames don't
   * clobber a held button. Fail-soft, same as sendKey.
   *
   * @param {{ dx?: number, dy?: number, buttons?: number }} [move]
   * @returns {Promise<boolean>}
   */
  async sendMouse(move = {}) {
    if (!this._running) return false;
    const dx = Number.isFinite(move.dx) ? Math.trunc(move.dx) : 0;
    const dy = Number.isFinite(move.dy) ? Math.trunc(move.dy) : 0;
    const hasButtons = Number.isFinite(move.buttons);
    try {
      const sock = await this._ensureMonitorSocket();
      if (dx !== 0 || dy !== 0) {
        await this._monitorCommand(sock, `mouse_move ${dx} ${dy}`, INPUT_COMMAND_TIMEOUT_MS);
      }
      if (hasButtons) {
        const state = Math.trunc(move.buttons) & 0x7;
        await this._monitorCommand(sock, `mouse_button ${state}`, INPUT_COMMAND_TIMEOUT_MS);
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Connect (once, then reuse) to the HMP monitor listener. Retries briefly to
   * cover the `,nowait` TOCTOU window, mirroring the serial connect.
   */
  async _ensureMonitorSocket() {
    if (this.monitorSocket && !this.monitorSocket.destroyed) return this.monitorSocket;
    if (!this.monitorPort) throw new Error('monitor port not allocated');
    let lastErr;
    for (let i = 0; i < MONITOR_CONNECT_RETRIES; i++) {
      try {
        const sock = await new Promise((resolve, reject) => {
          const s = net.connect({ host: '127.0.0.1', port: this.monitorPort }, () => {
            s.removeListener('error', onErr);
            resolve(s);
          });
          const onErr = (err) => reject(err);
          s.once('error', onErr);
        });
        // A dropped monitor socket must not crash the process; drop the ref so the
        // next capture reconnects.
        sock.on('error', () => { if (this.monitorSocket === sock) this.monitorSocket = null; });
        sock.on('close', () => { if (this.monitorSocket === sock) this.monitorSocket = null; });
        this.monitorSocket = sock;
        return sock;
      } catch (err) {
        lastErr = err;
        await sleep(MONITOR_CONNECT_RETRY_DELAY_MS);
      }
    }
    throw new Error(
      `could not connect to KHY OS monitor on 127.0.0.1:${this.monitorPort}: ` +
        (lastErr ? lastErr.message : 'unknown')
    );
  }

  /**
   * Send one HMP command and resolve once the "(qemu) " prompt reappears (or the
   * timeout elapses — screendump has already flushed its file by the time the
   * prompt returns).
   */
  _monitorCommand(sock, cmd, timeoutMs) {
    return new Promise((resolve, reject) => {
      let buf = '';
      const onData = (d) => {
        buf += d.toString('utf-8');
        if (/\(qemu\)\s*$/.test(buf)) { cleanup(); resolve(); }
      };
      const onErr = (err) => { cleanup(); reject(err); };
      const timer = setTimeout(() => { cleanup(); resolve(); }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        sock.removeListener('data', onData);
        sock.removeListener('error', onErr);
      };
      sock.on('data', onData);
      sock.once('error', onErr);
      sock.write(`${cmd}\n`, (err) => { if (err) { cleanup(); reject(err); } });
    });
  }

  /** Kill QEMU and tear down the socket. Safe to call multiple times. */
  async stop() {
    this._stopping = true;
    this._running = false;
    if (this.socket) {
      try { this.socket.destroy(); } catch { /* ignore */ }
      this.socket = null;
    }
    if (this.monitorSocket) {
      try { this.monitorSocket.destroy(); } catch { /* ignore */ }
      this.monitorSocket = null;
    }
    const proc = this.proc;
    if (!proc) return;
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      proc.once('exit', finish);
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      // Hard-kill if it lingers.
      const t = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        finish();
      }, 3000);
      if (t.unref) t.unref();
    });
    this.proc = null;
  }
}

module.exports = { KhyOsRunner, stripAnsi, resolveQemuImg, qemuInstallHint };
