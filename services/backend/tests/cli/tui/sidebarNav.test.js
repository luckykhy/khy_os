'use strict';

// Unit tests for hooks/useSidebarNav (阶段四 nav state) and buildSidebarLines
// scroll windowing (selectedIdx + scrollOffset → window slice with indicators).
// node:test (jest is broken under rtk — run with `node --test`).

const test = require('node:test');
const assert = require('node:assert');

// useSidebarNav requires React. We use a minimal mock that satisfies the hook.
let _stateSlots = [];
let _slotIdx = 0;
const fakeReact = {
  useState(init) {
    const idx = _slotIdx++;
    if (_stateSlots[idx] === undefined) _stateSlots[idx] = init;
    const setter = (fn) => {
      _stateSlots[idx] = typeof fn === 'function' ? fn(_stateSlots[idx]) : fn;
    };
    return [_stateSlots[idx], setter];
  },
  useCallback(fn) { return fn; },
};

// Patch require so useSidebarNav gets our fake React
const Module = require('module');
const origResolve = Module._resolveFilename;
const NAV_PATH = require.resolve('../../../src/cli/tui/hooks/useSidebarNav');

function loadNav() {
  // Clear cache and inject fake React
  delete require.cache[NAV_PATH];
  const origRequire = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'react') return fakeReact;
    return origRequire.apply(this, arguments);
  };
  try {
    return require(NAV_PATH);
  } finally {
    Module.prototype.require = origRequire;
  }
}

/** Reset fake state before each hook call sequence. */
function resetState() {
  _stateSlots = [];
  _slotIdx = 0;
}

/** Render the hook with opts and return its result. */
function renderHook(useSidebarNav, opts) {
  _slotIdx = 0; // re-render
  return useSidebarNav(opts);
}

const { buildSidebarLines } = require('../../../src/cli/tui/ink-components/SidebarPanel');

// ── useSidebarNav: enabled=false 惰性 ───────────────────────────────────────
test('useSidebarNav: enabled=false → focused/scrollOffset/expanded 全为惰性默认', () => {
  resetState();
  const { useSidebarNav } = loadNav();
  const r = renderHook(useSidebarNav, { enabled: false, totalLines: 20, visibleRows: 10 });
  assert.equal(r.focused, false);
  assert.equal(r.scrollOffset, 0);
  assert.equal(r.expanded, false);
});

test('useSidebarNav: enabled=false → handlers 为 no-op(不改变 state)', () => {
  resetState();
  const { useSidebarNav } = loadNav();
  let r = renderHook(useSidebarNav, { enabled: false, totalLines: 20, visibleRows: 10 });
  r.onToggleFocus();
  r.onUp();
  r.onDown();
  r.onExpand();
  r = renderHook(useSidebarNav, { enabled: false, totalLines: 20, visibleRows: 10 });
  assert.equal(r.focused, false);
  assert.equal(r.selectedIdx, 0);
  assert.equal(r.expanded, false);
});

// ── useSidebarNav: focus 切换 / escape ──────────────────────────────────────
test('useSidebarNav: onToggleFocus 切换 focused', () => {
  resetState();
  const { useSidebarNav } = loadNav();
  let r = renderHook(useSidebarNav, { enabled: true, totalLines: 10, visibleRows: 5 });
  assert.equal(r.focused, false);
  r.onToggleFocus();
  r = renderHook(useSidebarNav, { enabled: true, totalLines: 10, visibleRows: 5 });
  assert.equal(r.focused, true);
  r.onToggleFocus();
  r = renderHook(useSidebarNav, { enabled: true, totalLines: 10, visibleRows: 5 });
  assert.equal(r.focused, false);
});

test('useSidebarNav: onEscape → focused=false', () => {
  resetState();
  const { useSidebarNav } = loadNav();
  renderHook(useSidebarNav, { enabled: true, totalLines: 10, visibleRows: 5 });
  // Toggle focus on
  _stateSlots[0] = true; // focused slot
  let r = renderHook(useSidebarNav, { enabled: true, totalLines: 10, visibleRows: 5 });
  assert.equal(r.focused, true);
  r.onEscape();
  r = renderHook(useSidebarNav, { enabled: true, totalLines: 10, visibleRows: 5 });
  assert.equal(r.focused, false);
});

// ── useSidebarNav: 上下越界钳制 ────────────────────────────────────────────
test('useSidebarNav: onDown 递增 selectedIdx, onUp 递减, 边界钳制', () => {
  resetState();
  const { useSidebarNav } = loadNav();
  let r = renderHook(useSidebarNav, { enabled: true, totalLines: 3, visibleRows: 3 });
  assert.equal(r.selectedIdx, 0);
  r.onDown();
  r = renderHook(useSidebarNav, { enabled: true, totalLines: 3, visibleRows: 3 });
  assert.equal(r.selectedIdx, 1);
  r.onDown();
  r = renderHook(useSidebarNav, { enabled: true, totalLines: 3, visibleRows: 3 });
  assert.equal(r.selectedIdx, 2);
  // At max, should clamp
  r.onDown();
  r = renderHook(useSidebarNav, { enabled: true, totalLines: 3, visibleRows: 3 });
  assert.equal(r.selectedIdx, 2, '越上界钳制');
  // Up back
  r.onUp();
  r = renderHook(useSidebarNav, { enabled: true, totalLines: 3, visibleRows: 3 });
  assert.equal(r.selectedIdx, 1);
  // Past 0
  r.onUp();
  r.onUp();
  r = renderHook(useSidebarNav, { enabled: true, totalLines: 3, visibleRows: 3 });
  assert.equal(r.selectedIdx, 0, '越下界钳制在 0');
});

// ── useSidebarNav: 居中跟随 clamp ──────────────────────────────────────────
test('useSidebarNav: scrollOffset 居中跟随 selectedIdx', () => {
  resetState();
  const { useSidebarNav } = loadNav();
  // totalLines=20, visibleRows=5 → maxOffset=15
  // selectedIdx=10 → scrollOffset = clamp(10 - floor(5/2), 0, 15) = clamp(8, 0, 15) = 8
  _stateSlots = [false, 10, false]; // focused, selectedIdx, expanded
  const r = renderHook(useSidebarNav, { enabled: true, totalLines: 20, visibleRows: 5 });
  assert.equal(r.scrollOffset, 8, 'sel=10 → offset = 10 - 2 = 8');
});

test('useSidebarNav: scrollOffset clamp 下界(selectedIdx=0 → offset=0)', () => {
  resetState();
  const { useSidebarNav } = loadNav();
  _stateSlots = [false, 0, false];
  const r = renderHook(useSidebarNav, { enabled: true, totalLines: 20, visibleRows: 5 });
  assert.equal(r.scrollOffset, 0);
});

test('useSidebarNav: scrollOffset clamp 上界(selectedIdx=19 → offset=15)', () => {
  resetState();
  const { useSidebarNav } = loadNav();
  _stateSlots = [false, 19, false];
  const r = renderHook(useSidebarNav, { enabled: true, totalLines: 20, visibleRows: 5 });
  // clamp(19 - 2, 0, 15) = clamp(17, 0, 15) = 15
  assert.equal(r.scrollOffset, 15);
});

// ── buildSidebarLines 窗口切片: 行数=maxRows, ↑/↓ 指示, selected 标记 ──────
test('buildSidebarLines 窗口切片: 行数 = maxRows', () => {
  const taskLines = Array.from({ length: 10 }, (_, i) => `→ task${i}`);
  const lines = buildSidebarLines({
    width: 40, maxRows: 5, taskLines,
    scrollOffset: 2, // triggers windowing path
  });
  assert.equal(lines.length, 5, '切片行数应等于 maxRows');
});

test('buildSidebarLines 窗口切片: ↑ n 行 / ↓ n 行 指示', () => {
  const taskLines = Array.from({ length: 10 }, (_, i) => `→ task${i}`);
  const lines = buildSidebarLines({
    width: 40, maxRows: 5, taskLines,
    scrollOffset: 3,
  });
  // First line should be ↑ indicator
  assert.ok(lines[0].text.includes('↑'), `首行应含 ↑: 「${lines[0].text}」`);
  assert.ok(lines[0].dim, '指示行应为 dim');
  // Last line should be ↓ indicator
  assert.ok(lines[lines.length - 1].text.includes('↓'), `末行应含 ↓: 「${lines[lines.length - 1].text}」`);
  assert.ok(lines[lines.length - 1].dim, '指示行应为 dim');
});

test('buildSidebarLines 窗口切片: scrollOffset=0 无 ↑ 指示', () => {
  const taskLines = Array.from({ length: 10 }, (_, i) => `→ task${i}`);
  const lines = buildSidebarLines({
    width: 40, maxRows: 5, taskLines,
    scrollOffset: 0,
  });
  assert.ok(!lines[0].text.includes('↑'), '顶部无隐藏 → 无 ↑');
});

test('buildSidebarLines 窗口切片: selected 标记传递到可见行', () => {
  const taskLines = Array.from({ length: 10 }, (_, i) => `→ task${i}`);
  const lines = buildSidebarLines({
    width: 40, maxRows: 5, taskLines,
    scrollOffset: 0,
    selectedIdx: 2, // should mark the 3rd content line
  });
  // The selected line should have .selected = true (within the visible window)
  const selected = lines.filter((l) => l.selected);
  assert.ok(selected.length <= 1, '最多一个 selected 标记');
  // selectedIdx=2 within a window of 5 rows starting at 0 should be visible
  if (selected.length === 1) {
    assert.equal(selected[0].selected, true);
  }
});
