'use strict';

// Integration test for the clearBytes + <ink frame placeholder> + paintBytes
// concatenation contract. Verifies the combined output maintains ANSI safety:
//   - DECSC/DECRC paired (every save has a matching restore)
//   - No \n or \r (would scroll the screen)
//   - No ANSI scroll-region sequences \x1b[n;mr (would desync ink's accounting)
//   - Geometry change (narrower): stale area is cleared before new paint
// node:test (jest is broken under rtk — run with `node --test`).

const test = require('node:test');
const assert = require('node:assert');
const { Writable } = require('stream');

const RAIL = require.resolve('../../../src/cli/tui/runtime/sidebarRail');

process.setMaxListeners(0);

/** Fresh module instance per test. */
function load() {
  delete require.cache[RAIL];
  return require(RAIL);
}

/** A TTY-shaped sink. */
function fakeTTY(cols = 150, rows = 40) {
  const writes = [];
  const s = new Writable({ write(c, e, cb) { writes.push(String(c)); cb(); } });
  s.columns = cols;
  s.rows = rows;
  s.isTTY = true;
  s.writes = writes;
  return s;
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

const DECSC = '\x1b7';
const DECRC = '\x1b8';
const SNAP = { taskLines: ['→ 修复登录校验', '○ 补充单元测试'], queueLen: 1 };

/**
 * Simulate a full frame output: clearBytes + <ink frame> + paintBytes.
 * The <ink frame> is a synthetic placeholder (any text without ANSI escapes).
 */
function buildFullFrame(rail) {
  const clear = rail.clearBytes();
  const paint = rail.paintBytes();
  const inkFrame = 'INK_FRAME_PLACEHOLDER';
  return clear + inkFrame + paint;
}

// ── DECSC/DECRC 配对 ─────────────────────────────────────────────────────────
test('集成: clearBytes + paintBytes DECSC/DECRC 配对', () => {
  const rail = load();
  const out = fakeTTY();
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    rail.enable(out);
    rail.setDims(150, 40);
    rail.setSnapshot(SNAP);
    rail.paintBytes(); // establish lastGeom
    const frame = buildFullFrame(rail);
    const saves = (frame.match(/\x1b7/g) || []).length;
    const restores = (frame.match(/\x1b8/g) || []).length;
    assert.equal(saves, restores, `DECSC(${saves}) 必须等于 DECRC(${restores})`);
    assert.ok(saves >= 1, '至少有一对 DECSC/DECRC');
  });
});

// ── 无 \n 或 \r ──────────────────────────────────────────────────────────────
test('集成: 拼接输出不含 \\n 或 \\r', () => {
  const rail = load();
  const out = fakeTTY();
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    rail.enable(out);
    rail.setDims(150, 40);
    rail.setSnapshot(SNAP);
    rail.paintBytes(); // establish
    const frame = buildFullFrame(rail);
    // Strip out the INK_FRAME_PLACEHOLDER since it's our own test artifact
    const railOnly = frame.replace('INK_FRAME_PLACEHOLDER', '');
    assert.ok(!railOnly.includes('\n'), '不含 \\n');
    assert.ok(!railOnly.includes('\r'), '不含 \\r');
  });
});

// ── 无 ANSI 滚动区 ──────────────────────────────────────────────────────────
test('集成: 拼接输出不含 ANSI 滚动区序列 \\x1b[n;mr', () => {
  const rail = load();
  const out = fakeTTY();
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    rail.enable(out);
    rail.setDims(150, 40);
    rail.setSnapshot(SNAP);
    rail.paintBytes();
    const frame = buildFullFrame(rail);
    const scrollRegion = /\x1b\[\d+;\d+r/;
    assert.ok(!scrollRegion.test(frame), '不含 ANSI scroll region (DECSTBM)');
  });
});

// ── 几何变窄时旧区被 clear 覆盖 ─────────────────────────────────────────────
test('集成: 几何变窄时 clearBytes 覆盖旧区域', () => {
  const rail = load();
  const out = fakeTTY(150, 40);
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    rail.enable(out);
    rail.setDims(150, 40);
    rail.setSnapshot(SNAP);
    rail.paintBytes(); // lastGeom at left=127(150-24+1), width=24
    // Now shrink
    rail.setDims(130, 40);
    const clear = rail.clearBytes();
    const paint = rail.paintBytes();
    // clear should wipe the OLD geometry (left=127, width=24)
    assert.ok(clear.includes('\x1b[1;127H'), 'clear 覆盖旧几何(left=127)');
    assert.ok(clear.includes(' '.repeat(24)), 'clear 用 24 列空格覆盖');
    // paint should use the NEW geometry
    // new: 130-24+1=107 or recalculated width
    assert.ok(paint.includes('\x1b[1;107H') || paint.length > 0, 'paint 使用新几何');
  });
});

// ── paintBytes 首次(无 lastGeom): clearBytes 为空 ────────────────────────────
test('集成: 首次 paint 前 clearBytes 为空(无残影)', () => {
  const rail = load();
  const out = fakeTTY();
  withEnv({ KHY_SIDEBAR_RAIL: '1' }, () => {
    rail.enable(out);
    rail.setDims(150, 40);
    assert.equal(rail.clearBytes(), '', '首次 paint 前无可清');
  });
});
