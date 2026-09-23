'use strict';

// Unit tests for effectiveCols — the single accessor for paintable columns —
// and its sticky-columns cache (board jitter/ghosting root cause B), plus the
// LIVE App.js wiring contracts for root causes A/B/C.
// node:test (jest is broken under rtk — run with `node --test`).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const MOD = require.resolve('../../../src/cli/tui/effectiveCols');
const DIMS_MOD = require.resolve('../../../src/cli/tui/effectiveDims');
const BACKEND_ROOT = path.resolve(__dirname, '../../../');

/**
 * Fresh module instance per test — the sticky cache lives in effectiveDims
 * (effectiveCols is a thin alias), so BOTH caches must be cleared.
 */
function load() {
  delete require.cache[MOD];
  delete require.cache[DIMS_MOD];
  return require(MOD);
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k];
  }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

// Neutralize every env knob the resolution chain reads, so the suite is
// deterministic regardless of the shell it runs in.
const CLEAN = {
  KHY_SIDEBAR_RAIL: '1', KHY_SIDEBAR: undefined,
  KHY_TERM_FALLBACK_COLS: undefined, KHY_TERM_FALLBACK_ROWS: undefined,
  KHY_SIDEBAR_MIN_COLS: undefined, KHY_SIDEBAR_MIN_COLS_FALLBACK: undefined,
  KHY_SIDEBAR_WIDTH: undefined, KHY_SIDEBAR_WIDTH_MIN: undefined,
  KHY_SIDEBAR_WIDTH_MAX: undefined, KHY_TERM_STICKY_DIMS: undefined,
};

/**
 * Run `fn` with process.stdout.columns override support. Hands `fn` a setter;
 * the original property descriptor is restored afterwards no matter what.
 */
function withColumns(fn) {
  const desc = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const set = (v) => Object.defineProperty(process.stdout, 'columns', {
    value: v, configurable: true, writable: true,
  });
  try { return fn(set); } finally {
    if (desc) Object.defineProperty(process.stdout, 'columns', desc);
    else delete process.stdout.columns;
  }
}

// ── stickyCols:帧间粘滞(根因 B) ────────────────────────────────────────────
test('stickyCols: 震荡序列 合法→undefined→合法 全程稳定', () => {
  const eff = load();
  withColumns((set) => withEnv(CLEAN, () => {
    set(150);
    assert.equal(eff.stickyCols(process.env), 150);
    set(undefined);
    assert.equal(eff.stickyCols(process.env), 150, '幻影帧沿用上一帧合法值');
    set(150);
    assert.equal(eff.stickyCols(process.env), 150);
  }));
});

test('stickyCols: 首帧即 unknown(无缓存) → null(调用方走放宽门控 fallback)', () => {
  const eff = load();
  withColumns((set) => withEnv(CLEAN, () => {
    set(undefined);
    assert.equal(eff.stickyCols(process.env), null);
  }));
});

test('stickyCols: 新的不同合法值到达 → 立即更新(不粘滞在旧宽度)', () => {
  const eff = load();
  withColumns((set) => withEnv(CLEAN, () => {
    set(150);
    assert.equal(eff.stickyCols(process.env), 150);
    set(130);
    assert.equal(eff.stickyCols(process.env), 130, '真 resize 必须立即生效');
    set(undefined);
    assert.equal(eff.stickyCols(process.env), 130, '之后的幻影帧粘在新值上');
  }));
});

test('stickyCols: 垃圾读数(0) → 0,即便有缓存也绝不粘滞', () => {
  const eff = load();
  withColumns((set) => withEnv(CLEAN, () => {
    set(150);
    eff.stickyCols(process.env);
    set(0);
    assert.equal(eff.stickyCols(process.env), 0, '垃圾是测量结果,不是未知');
  }));
});

test('stickyCols: KHY_TERM_STICKY_DIMS=0 → 逐字节回退(undefined 恒 null)', () => {
  const eff = load();
  withColumns((set) => withEnv({ ...CLEAN, KHY_TERM_STICKY_DIMS: '0' }, () => {
    set(150);
    assert.equal(eff.stickyCols(process.env), 150);
    set(undefined);
    assert.equal(eff.stickyCols(process.env), null, '门控关 → 不粘滞');
  }));
});

test('_resetStickyColsForTest: 清空缓存后 unknown 回到 null', () => {
  const eff = load();
  withColumns((set) => withEnv(CLEAN, () => {
    set(150);
    eff.stickyCols(process.env);
    eff._resetStickyColsForTest();
    set(undefined);
    assert.equal(eff.stickyCols(process.env), null);
  }));
});

// ── effectiveCols:经 sticky 后的收窄宽度 ──────────────────────────────────
test('effectiveCols: 震荡帧不再跌回 fallback 宽度(树宽稳定 = 不抖动)', () => {
  const eff = load();
  withColumns((set) => withEnv(CLEAN, () => {
    const { sidebarWidth } = require('../../../src/cli/tui/sidebarLayout');
    set(150);
    const w = eff.effectiveCols(80);
    assert.equal(w, 150 - sidebarWidth(150, process.env), '150 - 单一真源栏宽');
    set(undefined);
    assert.equal(eff.effectiveCols(80), w, '幻影帧输出与上一帧逐字节一致');
    set(150);
    assert.equal(eff.effectiveCols(80), w);
  }));
});

test('effectiveCols: 首帧 unknown → 与画笔 fallback 几何同源(带宽外不收窄)', () => {
  const eff = load();
  withColumns((set) => withEnv(CLEAN, () => {
    set(undefined);
    const { fallbackCols } = require('../../../src/cli/tui/sidebarLayout');
    const fb = fallbackCols(process.env);
    // R1-2 带宽模型(DESIGN-ARCH-103 §4.3,取代旧的 railActive + hysteresis):
    // 窄化只在 cols >= BAND_ENTER(120) 时发生。默认假定宽度 80 **不在带内**
    // → 不收窄,原样返回调用方 fallback。
    // 这条同时钉住「与画笔同源」:railGeometry 在 unknown 时也代入 fallbackCols,
    // 带外同样不窄化 —— 两边一致,不会出现「树窄了画笔没窄」的错位。
    assert.ok(fb < 120, `前提:默认假定宽度应在窄化带外(实际 ${fb})`);
    assert.equal(eff.effectiveCols(80), 80, '带外 → 不收窄,返回调用方 fallback');
    assert.equal(eff.effectiveCols(fb), fb, '假定宽度本身在带外 → 原样返回');
  }));
});

test('effectiveCols: 垃圾读数 → 调用方 fallback(legacy 行为)', () => {
  const eff = load();
  withColumns((set) => withEnv(CLEAN, () => {
    set(0);
    assert.equal(eff.effectiveCols(77), 77);
  }));
});

test('effectiveCols: 栏位关 → 原样真实列宽(逐字节 legacy)', () => {
  const eff = load();
  withColumns((set) => withEnv({ ...CLEAN, KHY_SIDEBAR_RAIL: '0' }, () => {
    set(150);
    assert.equal(eff.effectiveCols(80), 150);
  }));
});

// ── LIVE wiring(App.js)契约:根因 A/B/C 的接线不许回退 ─────────────────────
const APP_SRC = () => fs.readFileSync(
  path.join(BACKEND_ROOT, 'src/cli/tui/ink-components/App.js'), 'utf8');

test('App wiring(根因 B): 尺寸解析走 stickyCols / stickyDim,不再裸读 columns', () => {
  const src = APP_SRC();
  assert.ok(/stickyCols:\s*_stickyCols\s*\}\s*=\s*require\(['"]\.\.\/effectiveCols['"]\)/.test(src),
    'App must import stickyCols from ../effectiveCols');
  assert.ok(/const _rawCols = _stickyCols\(process\.env\);/.test(src),
    'the dims block must resolve columns through stickyCols');
  assert.ok(/sidebarLayout\.stickyDim\(\s*process\.stdout\.rows,\s*_stickyRowsRef\.current/.test(src),
    'rows must resolve through the same pure sticky rule');
  assert.ok(/const _rawC = _resCols;/.test(src),
    '_railContentCols must reuse the SAME resolved columns (no fresh stdout read)');
});

test('App wiring(根因 A): 每帧向画笔推送同一份解析尺寸', () => {
  const src = APP_SRC();
  assert.ok(/sidebarRail\.setDims\(_resCols,\s*_resRows\)/.test(src),
    'App must push its sticky-resolved dims to the painter every render');
});

test('App wiring(根因 C): StreamingBlock 拿到的宽度在 rail/看板激活时收窄', () => {
  // 接线点已从 App.js 迁到 ChatColumn.js(StreamingBlock 的实际渲染处,经
  // ThreeColumnLayout 转发)。App.js 侧不再渲染 StreamingBlock —— 它把
  // 转录 + streaming 投影成 `_mainContentLines` 交给 Viewport。
  // 因此本契约分两处钉住:
  //   ① 渲染方:必须把 mainCols(树内看板或 rail 收窄后的左列宽)优先传下去;
  //   ② 组件兜底:拿不到 prop 时也必须经 effectiveCols(rail 激活 → cols − 栏宽),
  //      而不是裸全宽 —— 否则代码框/表格按全宽折行后被 ink 二次软换行。
  const chat = TUI_SRC('ink-components/ChatColumn.js');
  assert.ok(/contentWidth:\s*mainCols\s*\|\|\s*contentWidth/.test(chat),
    'ChatColumn must pass mainCols first (in-tree board OR rail narrowing) to StreamingBlock');
  const sb = TUI_SRC('ink-components/StreamingBlock.js');
  assert.ok(/require\(['"]\.\.\/effectiveCols['"]\)/.test(sb),
    'StreamingBlock must import the effectiveCols single accessor for its width fallback');
  assert.ok(/effectiveCols\(/.test(sb),
    'StreamingBlock must actually call effectiveCols (not read stdout, not assume full width)');
});

// ── 评审 Major/Minor:全链路零裸读契约(唯一 sticky 缓存持有者) ───────────
// Bare `process.stdout.columns` reads OUTSIDE effectiveCols are divergence
// points: two call sites can observe different values on a conpty heartbeat
// frame and flip verdicts against each other. Contract: effectiveCols is the
// ONLY module allowed to read it; everything else goes through the sticky
// resolution. Comments are exempt (line-comment aware scan).
const TUI_SRC = (rel) => fs.readFileSync(path.join(BACKEND_ROOT, 'src/cli/tui', rel), 'utf8');

/** Lines with a bare process.stdout.columns read outside a // comment. */
function bareColumnReads(src) {
  const hits = [];
  src.split(/\r?\n/).forEach((line, i) => {
    const at = line.indexOf('process.stdout.columns');
    if (at === -1) return;
    const cm = line.indexOf('//');
    if (cm !== -1 && cm < at) return; // inside a line comment → exempt
    hits.push(`L${i + 1}: ${line.trim()}`);
  });
  return hits;
}

test('App wiring(评审 Major 1+2): App.js 代码层零裸读 columns(resize 已收敛)', () => {
  const src = APP_SRC();
  assert.deepEqual(bareColumnReads(src), [],
    'every columns access in App.js must funnel through stickyCols/effectiveCols');
  // resize 三态解析器:preferred → 上一帧稳定值 → fallback,全部经 _stickyCols 单一缓存。
  // (2026-09-16:此前这里还断言过 Ctrl+T「窄屏提示」的两行代码 —— 该提示已从 App.js
  //  移除,断言随之删除。宽度收敛的契约由下面的 _resolveResizeCols 断言承载。)
  assert.ok(/const _resolveResizeCols = \(preferred, prev\) =>/.test(src),
    'resize logic must resolve through the shared tri-state resolver');
  assert.ok(/const s = _stickyCols\(process\.env\);/.test(src),
    '_resolveResizeCols must resolve width through the _stickyCols single cache holder');
  assert.ok(/const curCols = _resolveResizeCols\(out \? out\.columns : null, _resizePrevCols\.current\);/.test(src),
    'curCols must not use a `||` falsy chain (0 vs undefined conflation)');
});

test('叶子 wiring(评审 Minor): PromptFrame/ToolLines/Transcript 列宽只经 effectiveCols', () => {
  for (const rel of ['ink-components/PromptFrame.js', 'ink-components/ToolLines.js', 'ink-components/Transcript.js']) {
    const src = TUI_SRC(rel);
    assert.deepEqual(bareColumnReads(src), [], `${rel}: no bare columns reads`);
    assert.ok(/require\(['"]\.\.\/effectiveCols['"]\)/.test(src),
      `${rel}: width must come from the effectiveCols single accessor`);
    assert.ok(/effectiveCols\(/.test(src), `${rel}: must actually call effectiveCols`);
  }
});

test('叶子 wiring(评审 Minor): FooterBar/WelcomeBanner 不自读宽度(不可能越过 effectiveCols 可用宽)', () => {
  for (const rel of ['ink-components/FooterBar.js', 'ink-components/WelcomeBanner.js']) {
    const src = TUI_SRC(rel);
    assert.deepEqual(bareColumnReads(src), [],
      `${rel}: must not self-measure — width is constrained by the parent Box, which derives from effectiveCols`);
  }
});

// ── 阶段二: 首帧 80 列锁定与 _lastRailActive 粘滞/重置 ─────────────────────────
test('effectiveCols: 首帧 unknown 且假定宽度在窄化带内 → 走 mainColumnCols 收窄', () => {
  const eff = load();
  withColumns((set) => withEnv({ ...CLEAN, KHY_TERM_FALLBACK_COLS: '150' }, () => {
    set(undefined); // 首帧:还不知道真实列宽
    const { mainColumnCols, fallbackCols } = require('../../../src/cli/tui/sidebarLayout');
    const fb = fallbackCols(process.env);
    assert.equal(fb, 150, '前提:门控把假定宽度抬进窄化带(>=120)');
    const w = eff.effectiveCols(80);
    assert.equal(w, mainColumnCols(fb, process.env), '带内 → 与 mainColumnCols 同源收窄');
    assert.ok(w < fb, `收窄后必须小于全宽(得到 ${w},全宽 ${fb})`);
  }));
});

test('_lastRailActive 粘滞: 连续帧边界值不拍(第一帧 120 激活后第二帧 119 仍激活)', () => {
  const eff = load();
  withColumns((set) => withEnv(CLEAN, () => {
    set(120);
    const w1 = eff.effectiveCols(80);
    // After first frame, _lastRailActive = true; now 119 should stay active via hysteresis
    set(119);
    const w2 = eff.effectiveCols(80);
    // Both should be narrowed (rail active)
    const { sidebarWidth } = require('../../../src/cli/tui/sidebarLayout');
    assert.equal(w1, 120 - sidebarWidth(120, process.env), '120 列收窄');
    assert.equal(w2, 119 - sidebarWidth(119, process.env), '119 列仍收窄(迟滞保持)');
  }));
});

test('_resetStickyColsForTest: 同时清零 _lastRailActive(死区模型:重置后 119 退出窄化带)', () => {
  const eff = load();
  withColumns((set) => withEnv(CLEAN, () => {
    set(120);
    eff.effectiveCols(80); // band verdict = active
    eff._resetStickyColsForTest(); // should reset both caches + band verdict
    set(119);
    // R1-2 band model (replaces the old boolean hysteresis): 119 < 120 is OUTSIDE
    // the enter threshold and no verdict is threaded after a reset → not active.
    const w = eff.effectiveCols(80);
    assert.equal(w, 119, '119 列重置后不在进入阈值内 → 不收窄');
  }));
});
