'use strict';

// TEMP measurement harness (delete after use):
// Mounts the REAL Ink TUI with a stubbed TTY, injects a typed message + Enter,
// and measures submit-time -> first stdout frame containing the message
// (transcript commit; the input box clears in the same React batch as the
// user-message commit, so any post-Enter frame containing the marker IS the
// transcript row).
//
// Usage:
//   node tmp-measure-enter-paint.js            # warm: submit 4s after mount
//   MEASURE_WARM_MS=300 KHY_TUI_PREWARM=0 node tmp-measure-enter-paint.js  # cold

const MARKER = 'LATENCY_PROBE_' + Math.random().toString(36).slice(2, 8);
const WARM_MS = Number(process.env.MEASURE_WARM_MS || 4000);

// ── stdout stub: pretend TTY, capture frames, swallow actual output ──
const out = process.stdout;
try { out.isTTY = true; } catch { /* some streams disallow */ }
try { out.rows = 32; out.columns = 100; } catch { /* ignore */ }

let submitAt = 0;
let paintedAt = 0;
let firstFrameAt = 0;
let postSubmitBuf = '';
let allFrames = ''; // dumped to tmp-frames.log on exit for diagnosis

const origWrite = out.write.bind(out);
out.write = function (chunk) {
  try {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (allFrames.length < 2e6) allFrames += s;
    if (!firstFrameAt && s.length > 0) firstFrameAt = Date.now();
    if (submitAt && !paintedAt) {
      postSubmitBuf += s;
      if (postSubmitBuf.includes(MARKER)) {
        paintedAt = Date.now();
        process.stderr.write(`[MEASURE] enter->paint = ${paintedAt - submitAt}ms (marker=${MARKER})\n`);
        setTimeout(() => process.exit(0), 100);
      }
      if (postSubmitBuf.length > 1e6) postSubmitBuf = postSubmitBuf.slice(-1e5);
    }
  } catch { /* measurement must not break rendering */ }
  return true; // swallow frames — keep the harness console clean
};

// ── stdin stub: replace process.stdin with a fake raw-mode-capable TTY stream
// (the sandbox's real stdin is a non-TTY pipe that Ink cannot read keys from).
const { PassThrough } = require('stream');
const fakeStdin = new PassThrough();
fakeStdin.isTTY = true;
fakeStdin.setRawMode = function () { return fakeStdin; };
fakeStdin.ref = function () { return fakeStdin; };
fakeStdin.unref = function () { return fakeStdin; };
Object.defineProperty(process, 'stdin', { configurable: true, get: () => fakeStdin });

const type = (s) => { fakeStdin.write(Buffer.from(s, 'utf8')); };

// ── mount the real TUI ──
process.env.KHY_TUI_DIAG = process.env.KHY_TUI_DIAG || '1';
const { startInkApp } = require('./services/backend/src/cli/tui/app.jsx');
startInkApp({}).catch((e) => {
  process.stderr.write(`[MEASURE] startInkApp error: ${e && e.stack || e}\n`);
  process.exit(1);
});

// Schedule injection WARM_MS after the first painted frame (mount complete).
const waitMount = setInterval(() => {
  if (!firstFrameAt) return;
  clearInterval(waitMount);
  setTimeout(() => {
    type(MARKER);
    // Give the echo frames a beat to flush, then press Enter and stamp t0.
    setTimeout(() => {
      submitAt = Date.now();
      type('\r');
      process.stderr.write(`[MEASURE] enter injected at +${submitAt - firstFrameAt}ms after first frame\n`);
    }, 200);
  }, WARM_MS);
}, 20);

setTimeout(() => {
  try { require('fs').writeFileSync('tmp-frames.log', allFrames); } catch { /* ignore */ }
  process.stderr.write('[MEASURE] TIMEOUT: 用户消息 60s 内未出现在渲染帧 (submitAt=' + submitAt + ')\n');
  process.exit(2);
}, WARM_MS + 60000);
