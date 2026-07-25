'use strict';

/**
 * KhyOsView — full-screen overlay that bridges the TUI to the bare-metal KHY OS
 * kernel running under QEMU (Phase 2a of the de-island plan).
 *
 * Unlike ShellView (a passive read-only peek at the AI's tool output), this view
 * owns input: it mounts a KhyOsRunner (@khy/shared/runtime/khyos) on mount,
 * tears it down on unmount, renders the kernel's serial output, and translates
 * keystrokes into serial input bytes. The kernel is unchanged — this is pure
 * host-side bridging over the QEMU serial TCP socket.
 *
 * Rendering: the kernel shell does in-place line editing with \r and \b only
 * (no cursor ANSI — VGA can't interpret it; see shell.c). So a tiny line model
 * (\r → col 0, \b → col-1, \n → new line, printable → write+advance) faithfully
 * reproduces the console without a full terminal emulator. CSI color/cursor
 * escapes (should any appear) are stripped.
 *
 * Input → bytes (matches shell.c handle_char):
 *   Enter→\r, Backspace/Delete→0x7f, Ctrl+letter→control code,
 *   ↑↓←→→ESC[A/B/C/D, Home→ESC[H, End→ESC[F.
 *   Esc (lone) exits the view back to the AI chat.
 *
 * Props:
 *   onExit  — () => void, called when the user leaves (Esc) or the runner exits.
 *   isoPath — optional explicit ISO; otherwise resolved via ensureKhyosIso().
 *   diskPath— optional KhyFS disk image for persistence.
 */

const React = require('react');
const inkRuntime = require('../inkRuntime');

const MAX_ROWS = 200; // ring-buffer cap on retained screen lines
const FLUSH_MS = 40; // coalesce serial bursts into ~25fps repaints

// CSI sequences (ESC [ ... final) and 2-char escapes — the kernel shell does not
// emit these for editing, but strip them defensively so nothing leaks as text.
function stripCsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[=>NO]/g, '');
}

/**
 * Minimal line-discipline screen model. Mutated in place by feed(); render reads
 * `lines`. Tracks a cursor (row,col) so \r/\b overwrite within the current line.
 */
function makeScreen() {
  return { lines: [''], row: 0, col: 0 };
}

function feed(scr, text) {
  const clean = stripCsi(text);
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '\n') {
      scr.row += 1;
      scr.col = 0;
      if (!scr.lines[scr.row]) scr.lines[scr.row] = '';
    } else if (ch === '\r') {
      scr.col = 0;
    } else if (ch === '\b') {
      if (scr.col > 0) scr.col -= 1;
    } else if (ch === '\t') {
      const next = (scr.col + 8) & ~7;
      const line = scr.lines[scr.row] || '';
      scr.lines[scr.row] = line.padEnd(next, ' ');
      scr.col = next;
    } else if (ch >= ' ' || ch.charCodeAt(0) >= 0x80) {
      let line = scr.lines[scr.row] || '';
      if (scr.col > line.length) line = line.padEnd(scr.col, ' ');
      scr.lines[scr.row] = line.slice(0, scr.col) + ch + line.slice(scr.col + 1);
      scr.col += 1;
    }
    // other control bytes ignored
  }
  // Trim the ring buffer.
  if (scr.lines.length > MAX_ROWS) {
    const drop = scr.lines.length - MAX_ROWS;
    scr.lines.splice(0, drop);
    scr.row = Math.max(0, scr.row - drop);
  }
}

// Translate an Ink (input, key) pair to the bytes the kernel shell expects.
function keyToBytes(input, key) {
  if (key.return) return '\r';
  if (key.backspace || key.delete) return '\x7f';
  if (key.upArrow) return '\x1b[A';
  if (key.downArrow) return '\x1b[B';
  if (key.rightArrow) return '\x1b[C';
  if (key.leftArrow) return '\x1b[D';
  if (key.pageUp || key.pageDown) return ''; // not handled by the kernel shell
  if (key.tab) return '\t';
  if (key.ctrl && input && input.length === 1) {
    // Ctrl+letter → control code (Ctrl-A=0x01 … Ctrl-Z=0x1a), matches shell.c.
    return String.fromCharCode(input.toLowerCase().charCodeAt(0) & 0x1f);
  }
  if (input) return input;
  return '';
}

function KhyOsView({ onExit, isoPath, diskPath }) {
  const { Box, Text, useInput } = inkRuntime.get();
  const h = React.createElement;

  const runnerRef = React.useRef(null);
  const screenRef = React.useRef(makeScreen());
  const dirtyRef = React.useRef(false);
  const [, setVersion] = React.useState(0);
  const [status, setStatus] = React.useState('booting'); // booting|ready|error|exited
  const [statusMsg, setStatusMsg] = React.useState('');

  // Mount: resolve ISO, start the runner, wire serial → screen.
  React.useEffect(() => {
    let alive = true;
    let runner = null;
    (async () => {
      let khyos;
      try {
        khyos = require('@khy/shared/runtime/khyos');
      } catch (err) {
        if (alive) { setStatus('error'); setStatusMsg('无法加载 KHY OS 运行时：' + err.message); }
        return;
      }
      try {
        const iso = isoPath || (await khyos.ensureKhyosIso());
        if (!alive) return;
        runner = new khyos.KhyOsRunner({ isoPath: iso, diskPath: diskPath || undefined });
        runnerRef.current = runner;
        runner.on('data', (buf) => {
          feed(screenRef.current, buf.toString('utf-8'));
          dirtyRef.current = true;
        });
        runner.on('error', (err) => {
          if (!alive) return;
          setStatus('error');
          setStatusMsg(err.message || String(err));
        });
        runner.on('exit', () => {
          if (!alive) return;
          setStatus('exited');
        });
        // First-run portable-QEMU download (~30–40MB): show progress instead of
        // a frozen "booting" line. Additive — no event fires when QEMU is present.
        runner.on('status', (s) => {
          if (!alive || !s || s.phase !== 'provisioning-qemu') return;
          const pct = s.total > 0 ? Math.min(100, Math.floor((s.downloaded / s.total) * 100)) : 0;
          setStatusMsg(s.done ? '便携 QEMU 下载完成，正在启动…' : `正在下载便携 QEMU… ${pct}%`);
        });
        await runner.start();
        if (alive) setStatus('ready');
      } catch (err) {
        if (alive) { setStatus('error'); setStatusMsg(err.message || String(err)); }
      }
    })();

    // Repaint timer: coalesce serial bursts.
    const timer = setInterval(() => {
      if (dirtyRef.current) {
        dirtyRef.current = false;
        setVersion((v) => (v + 1) & 0xffff);
      }
    }, FLUSH_MS);

    return () => {
      alive = false;
      clearInterval(timer);
      if (runner) { try { runner.stop(); } catch { /* ignore */ } }
      runnerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((input, key) => {
    // Lone Esc leaves the view (arrow keys arrive as key.upArrow etc, not escape).
    if (key.escape) { onExit && onExit(); return; }
    const runner = runnerRef.current;
    if (!runner || status !== 'ready') return;
    const bytes = keyToBytes(input, key);
    if (bytes) { runner.write(bytes).catch(() => { /* surfaced via 'error' */ }); }
  });

  // Bounded viewport: show the tail of the screen buffer.
  const rows = process.stdout.rows && process.stdout.rows > 0 ? process.stdout.rows : 24;
  const maxBody = Math.max(6, rows - 6);
  const all = screenRef.current.lines;
  const body = all.slice(Math.max(0, all.length - maxBody));

  const statusLine = (() => {
    if (status === 'booting') return ['yellow', '◆ 启动 QEMU / 连接内核串口…'];
    if (status === 'ready') return ['green', '● KHY OS 内核已连接 · 输入即发往 shell · Esc 返回'];
    if (status === 'exited') return ['gray', '○ QEMU 已退出 · Esc 返回'];
    return ['red', '✗ ' + (statusMsg || '内核启动失败') + ' · Esc 返回'];
  })();

  return h(
    Box,
    { flexDirection: 'column', marginTop: 1, borderStyle: 'round', borderColor: 'cyan', paddingX: 1 },
    h(Box, { key: 'title' },
      h(Text, { color: 'cyan', bold: true }, '⊞ KHY OS 内核终端  '),
      h(Text, { color: statusLine[0] }, statusLine[1])
    ),
    h(Box, { key: 'body', flexDirection: 'column', marginTop: 1 },
      ...body.map((ln, i) => h(Text, { key: i }, ln || ' '))
    )
  );
}

module.exports = KhyOsView;
