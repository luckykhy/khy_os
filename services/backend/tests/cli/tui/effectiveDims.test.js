'use strict';

// effectiveDims — the single source of truth for usable terminal dimensions
// (DESIGN-ARCH-103 P0-1 / H8). Unit tests run with `node --test`.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const MOD = require.resolve('../../../src/cli/tui/effectiveDims');

/** Fresh module instance per test — the sticky cache is module-level state. */
function load() {
  delete require.cache[MOD];
  return require(MOD);
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function withDims(fn) {
  const cDesc = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rDesc = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  const setCols = (v) => Object.defineProperty(process.stdout, 'columns', {
    value: v, configurable: true, writable: true,
  });
  const setRows = (v) => Object.defineProperty(process.stdout, 'rows', {
    value: v, configurable: true, writable: true,
  });
  try {
    return fn(setCols, setRows);
  } finally {
    if (cDesc) Object.defineProperty(process.stdout, 'columns', cDesc);
    else delete process.stdout.columns;
    if (rDesc) Object.defineProperty(process.stdout, 'rows', rDesc);
    else delete process.stdout.rows;
  }
}

// Neutralize every env knob the resolution chain reads.
const CLEAN = {
  KHY_SIDEBAR_RAIL: '1', KHY_SIDEBAR: undefined,
  KHY_TERM_FALLBACK_COLS: undefined, KHY_TERM_FALLBACK_ROWS: undefined,
  KHY_SIDEBAR_MIN_COLS: undefined, KHY_SIDEBAR_MIN_COLS_FALLBACK: undefined,
  KHY_SIDEBAR_WIDTH: undefined, KHY_SIDEBAR_WIDTH_MIN: undefined,
  KHY_SIDEBAR_WIDTH_MAX: undefined, KHY_TERM_STICKY_DIMS: undefined,
};

// ── conpty jitter sequence (120, undefined, 120, 0, 119) ─────────────────────
test('conpty 抖动序列: cols 120→undefined→120→0→119 全程取值稳定', () => {
  const dims = load();
  withEnv(CLEAN, () => withDims((setCols, setRows) => {
    setRows(40);
    setCols(120);
    assert.equal(dims.stickyCols(process.env), 120);
    setCols(undefined);
    assert.equal(dims.stickyCols(process.env), 120, '幻影帧沿用上一有效值');
    setCols(120);
    assert.equal(dims.stickyCols(process.env), 120);
    setCols(0);
    assert.equal(dims.stickyCols(process.env), 0, '0 是垃圾读数,绝不粘滞');
    setCols(119);
    assert.equal(dims.stickyCols(process.env), 119, '真 resize 立即生效');
  }));
});

test('conpty 抖动序列: rows 与 cols 同缓存纪律', () => {
  const dims = load();
  withEnv(CLEAN, () => withDims((setCols, setRows) => {
    setCols(120);
    setRows(30);
    assert.equal(dims.stickyRows(process.env), 30);
    setRows(undefined);
    assert.equal(dims.stickyRows(process.env), 30, 'rows 幻影帧粘滞');
    setRows(0);
    assert.equal(dims.stickyRows(process.env), 0);
    setRows(28);
    assert.equal(dims.stickyRows(process.env), 28);
  }));
});

// ── contentWidth / contentHeight fallbacks ────────────────────────────────────
test('contentWidth: rail 关 → 全宽; 首帧 unknown → fallback 收窄', () => {
  const dims = load();
  withEnv(CLEAN, () => withDims((setCols, setRows) => {
    const { sidebarWidth, fallbackCols } = require('../../../src/cli/tui/sidebarLayout');
    setCols(150);
    // band model (R1-2): in-band 150 activates the rail, and narrowing still
    // starts from the FULL width (mainColumnCols = 150 - sidebarWidth(150));
    // the quantized value only decides activation, not the subtracted base.
    assert.equal(dims.contentWidth(), 150 - sidebarWidth(150, process.env));
    dims._resetStickyForTest();
    setCols(undefined);
    const fb = fallbackCols(process.env);
    // fb (80) < BAND_ENTER (120) → out of band → no quantization, no narrowing.
    assert.equal(dims.contentWidth(), fb, '首帧 unknown(无缓存) → 假定宽度(带外不收窄)');
  }));
});

test('contentWidth: 栏位关 → 原样真实列宽', () => {
  const dims = load();
  withEnv({ ...CLEAN, KHY_SIDEBAR_RAIL: '0' }, () => withDims((setCols, setRows) => {
    setCols(150);
    assert.equal(dims.contentWidth(), 150);
  }));
});

test('contentHeight: 已知值 → 该值; unknown → 唯一 fallback(fallbackRows)', () => {
  const dims = load();
  withEnv(CLEAN, () => withDims((setCols, setRows) => {
    setCols(80);
    setRows(32);
    assert.equal(dims.contentHeight(), 32);
    setRows(undefined);
    assert.equal(dims.contentHeight(), 32, 'sticky rows');
    dims._resetStickyForTest();
    setRows(undefined);
    const { fallbackRows } = require('../../../src/cli/tui/sidebarLayout');
    assert.equal(dims.contentHeight(), fallbackRows(process.env));
  }));
});

// ── R1-2 band model ────────────────────────────────────────────────────────────
test('bandCols: 进入阈值 120 / 退出阈值 108 / 带内量化到 4 的倍数', () => {
  const { bandCols, BAND_ENTER, BAND_EXIT, QUANTUM } = load();
  assert.equal(BAND_ENTER, 120);
  assert.equal(BAND_EXIT, 108);
  assert.equal(QUANTUM, 4);
  // The band model is gated on the out-of-band rail being the active path
  // (KHY_SIDEBAR_RAIL opt-in); CLEAN sets it. bandCols(cols, wasActive, env).
  const ON = { KHY_SIDEBAR_RAIL: '1' };
  const OFF = { KHY_SIDEBAR_RAIL: '0' };
  // enter at 120, exit at/below 108 (12-col dead zone)
  assert.equal(bandCols(120, false, ON).active, true);
  assert.equal(bandCols(121, false, ON).active, true);
  assert.equal(bandCols(119, true, ON).active, true, '119 在死区内保持激活');
  assert.equal(bandCols(109, true, ON).active, true, '109 仍在带内');
  assert.equal(bandCols(108, true, ON).active, false, '108 = 退出阈值 → 退出');
  assert.equal(bandCols(107, true, ON).active, false, '107 退出');
  assert.equal(bandCols(119, false, ON).active, false, '未激活时 119 不进入');
  assert.equal(bandCols(109, false, ON).active, false, '死区 109:无先验不激活');
  // gate off → never active, quantized is the raw value
  assert.equal(bandCols(150, false, OFF).active, false, '门控关 → 不入带');
  assert.equal(bandCols(150, true, OFF).quantized, 150, '门控关 → 原样宽度');
  // in-band quantization: 1..3-col jitter within the band yields identical width
  assert.equal(bandCols(119, true, ON).quantized, bandCols(118, true, ON).quantized);
  assert.equal(bandCols(120, false, ON).quantized, 120);
  assert.equal(bandCols(121, false, ON).quantized, 120, '121 → 量化到 120');
  assert.equal(bandCols(123, false, ON).quantized, 124, '123 → 量化到 124');
  // out of band → raw value (no quantization)
  assert.equal(bandCols(80, false, ON).quantized, 80);
  assert.equal(bandCols(3, false, ON).quantized, 3, '带外如实报 3 列');
  assert.equal(bandCols(119, true, ON).quantized, 120, '带内 119 → 量化 120');
  assert.equal(bandCols(120, true, ON).quantized, 120);
  assert.equal(bandCols(116, true, ON).quantized, 116, '带内 116(4 的倍数)不变');
  assert.equal(bandCols(0, false, ON).active, false, '垃圾值不入带');
  assert.equal(bandCols(NaN, false, ON).active, false);
});

// ── reset ─────────────────────────────────────────────────────────────────────
test('_resetStickyForTest: 清零 cols/rows/rail 三份缓存', () => {
  const dims = load();
  withEnv(CLEAN, () => withDims((setCols, setRows) => {
    setCols(120);
    setRows(40);
    assert.equal(dims.stickyCols(process.env), 120);
    assert.equal(dims.stickyRows(process.env), 40);
    dims._resetStickyForTest();
    setCols(undefined);
    setRows(undefined);
    assert.equal(dims.stickyCols(process.env), null, 'cols 缓存已清');
    assert.equal(dims.stickyRows(process.env), null, 'rows 缓存已清');
  }));
});
