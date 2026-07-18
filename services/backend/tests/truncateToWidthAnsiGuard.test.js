'use strict';

/**
 * Round-16 regression: truncateToWidth ANSI-branch DoS + correctness guard.
 *
 * The legacy ESC branch was both quadratic and wrong. On every ESC byte
 * (cp 0x1B) it ran `str.slice([...str].indexOf(ch))`, which spreads the ENTIRE
 * string into an array (O(n)) and always resolves the FIRST ESC's offset rather
 * than the current one. A garbled / mojibake paste carrying a run of raw ESC
 * bytes ahead of any width-bearing text therefore grinds O(n^2) — measured
 * ~13 s at 40 000 ESC, ~55 s at 80 000. The `for (k …)` "skip" loop was dead
 * code (allocates an iterator, does nothing), so the CSI body (`[0;31m`) leaked
 * into the width count.
 *
 * Honest reachability: `truncateToWidth` is a shared width primitive used by
 * panels/spinner/markdown-table/gateway sinks. Most callers pass ANSI-stripped
 * plain text, so raw ESC bytes only arrive via a crafted / mojibake paste that
 * dodges upstream sanitisation (e.g. a user request brief rendered in a task
 * panel). That makes this defense-in-depth against crafted paste, not a
 * routinely-hit P1 — but the O(n^2) freeze and the wrong-offset correctness bug
 * are both genuine.
 *
 * The linear path (KHY_TRUNCATE_ANSI_LINEAR, default on) walks code points by
 * index and matches CSI-SGR sequences with a STICKY regex anchored at the
 * current offset — no slice, no spread — appending them verbatim at zero width.
 * For any ANSI-free input it is byte-identical to the legacy branch (the ESC
 * branch is never taken). Off -> legacy quadratic/leaky branch (load-bearing).
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const MOD = path.join(__dirname, '..', 'src', 'cli', 'formatters.js');

function load(gate) {
  delete require.cache[require.resolve(MOD)];
  if (gate === undefined) delete process.env.KHY_TRUNCATE_ANSI_LINEAR;
  else process.env.KHY_TRUNCATE_ANSI_LINEAR = gate;
  return require(MOD);
}

test.afterEach(() => { delete process.env.KHY_TRUNCATE_ANSI_LINEAR; });

function escRun(n) {
  return '\x1b'.repeat(n) + 'hello world this text is definitely wider than the cap';
}

test('a huge leading run of raw ESC bytes no longer freezes (was ~55s at 80k)', () => {
  const F = load(undefined);
  const t0 = process.hrtime.bigint();
  const out = F.truncateToWidth(escRun(200000), 25);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 1500, `should stay linear, took ${ms}ms`);
  // Still truncates the width-bearing tail to the cap.
  assert.ok(F.displayWidth(out) <= 25);
  assert.ok(out.endsWith('...'), 'ellipsis appended past the cap');
});

test('ANSI-free inputs are byte-identical gate on vs off (real-caller case)', () => {
  const on = load(undefined);
  const off = load('0');
  const samples = [
    'short',
    'a'.repeat(200),
    '中文测试很长很长的一段文字需要被截断处理掉尾巴',
    'mixed 中英 abc def ghijklmnop qrstuvwxyz 0123456789',
    'path/to/some/really/deeply/nested/file/name.tsx',
    'emoji 😀😁😂 and text that overflows the small width budget here',
    '',
    '组合字符 test',
  ];
  for (const s of samples) {
    for (const w of [5, 10, 25, 30, 36, 119]) {
      assert.strictEqual(
        on.truncateToWidth(s, w),
        off.truncateToWidth(s, w),
        `mismatch for ${JSON.stringify(s.slice(0, 24))} @ ${w}`);
    }
  }
});

test('CSI-SGR colour sequences are preserved verbatim at zero width', () => {
  const F = load(undefined);
  const colored = '\x1b[31mRED\x1b[0m plus a long tail that must be truncated for sure';
  const out = F.truncateToWidth(colored, 10);
  // Colour codes kept, only visible glyphs count toward the width budget.
  assert.ok(out.includes('\x1b[31m'), 'opening SGR preserved');
  assert.ok(out.includes('RED'), 'visible glyphs preserved');
  assert.ok(out.endsWith('...'), 'ellipsis appended past the visible cap');
  assert.ok(F.displayWidth(out) <= 10, `visible width bounded, got ${F.displayWidth(out)}`);
});

test('the second and later ESC no longer mis-resolves to the first ESC offset', () => {
  const F = load(undefined);
  // Two separate colour spans; legacy indexOf would always slice from the FIRST
  // ESC, so the second span was mis-handled. Correct path keeps both verbatim.
  const s = '\x1b[31mAA\x1b[0m BB \x1b[32mCC\x1b[0m and a tail wide enough to truncate';
  const out = F.truncateToWidth(s, 20);
  assert.ok(out.includes('\x1b[31m') && out.includes('\x1b[32m'), 'both SGR spans handled');
});

test('gate disabled reproduces the legacy quadratic cost (load-bearing)', () => {
  const off = load('0');
  const t0 = process.hrtime.bigint();
  off.truncateToWidth(escRun(20000), 25);
  const offMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const on = load(undefined);
  const t1 = process.hrtime.bigint();
  on.truncateToWidth(escRun(20000), 25);
  const onMs = Number(process.hrtime.bigint() - t1) / 1e6;

  assert.ok(onMs * 10 < offMs || offMs > 200,
    `expected quadratic OFF (${offMs}ms) >> linear ON (${onMs}ms)`);
});

test('disable-token variants all select the legacy branch', () => {
  for (const tok of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.strictEqual(load(tok)._truncateAnsiLinearEnabled(), false, `token ${tok}`);
  }
  assert.strictEqual(load(undefined)._truncateAnsiLinearEnabled(), true);
  assert.strictEqual(load('1')._truncateAnsiLinearEnabled(), true);
});
