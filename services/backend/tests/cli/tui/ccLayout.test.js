'use strict';

// ccLayout.test.js — pure-leaf tests for the CC-mode layout helpers, plus a
// source-level contract that CcApp's resize listener (P0-3) stays wired.
//
// Why source-level for CcApp: the real component needs ink (ESM-only), which
// node:test cannot mount without --experimental-vm-modules. The wiring
// regression this guards against (setCols/setRows gaining zero callers again,
// debounce dropped, listener cleanup removed) is fully visible in the source,
// so we assert on it the same way uiDesignContract.test.js does.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const LAYOUT_PATH = join(__dirname, '../../../src/cli/tui/utils/ccLayout');
const CCAPP_PATH = join(__dirname, '../../../src/cli/tui/ink-components/CcApp.js');

const cc = require(LAYOUT_PATH);

// ── sanitizeDim: tri-state dimension reading ─────────────────────────────
// Mirrors App.js _resolveResizeCols discipline: 0 (garbage measurement) and
// undefined (unknown) are NOT usable values — only a finite positive number is
// committed; null means "keep the previous value".

test('sanitizeDim accepts positive ints as-is', () => {
  assert.equal(cc.sanitizeDim(80), 80);
  assert.equal(cc.sanitizeDim(24), 24);
  assert.equal(cc.sanitizeDim(300), 300);
});

test('sanitizeDim floors positive fractions', () => {
  assert.equal(cc.sanitizeDim(120.7), 120);
  assert.equal(cc.sanitizeDim(99.999), 99);
});

test('sanitizeDim coerces numeric strings', () => {
  assert.equal(cc.sanitizeDim('100'), 100);
});

test('sanitizeDim rejects 0 — garbage measurement, not a valid dim', () => {
  assert.equal(cc.sanitizeDim(0), null);
  assert.equal(cc.sanitizeDim('0'), null);
});

test('sanitizeDim rejects undefined/NaN/negative/Infinity as null', () => {
  assert.equal(cc.sanitizeDim(undefined), null);
  assert.equal(cc.sanitizeDim(NaN), null);
  assert.equal(cc.sanitizeDim(-5), null);
  assert.equal(cc.sanitizeDim(Infinity), null);
  assert.equal(cc.sanitizeDim(-Infinity), null);
});

test('sanitizeDim rejects null/garbage objects as null', () => {
  assert.equal(cc.sanitizeDim(null), null);
  assert.equal(cc.sanitizeDim({}), null);
  assert.equal(cc.sanitizeDim(''), null);
});

// ── getLayout: recompute per dims (the resize payoff) ─────────────────────
// The whole point of CcApp's resize listener is that getLayout results change
// when the terminal dims change. Freeze those relationships here so a future
// refactor cannot silently decouple them.

test('getLayout widens sidebar as cols grow (single source: sidebarLayout)', () => {
  const narrow = cc.getLayout(80, 24);
  const wide = cc.getLayout(200, 24);
  assert.equal(narrow.sidebarWidth, 0, '80 < minCols(120) → 无看板');
  assert.ok(
    wide.sidebarWidth > narrow.sidebarWidth,
    `sidebarWidth must grow with cols (got ${narrow.sidebarWidth} → ${wide.sidebarWidth})`
  );
  assert.equal(cc.sidebarWidth, undefined, 'ccLayout.sidebarWidth 已删除(102 §4.2 单源)');
  assert.equal(wide.sidebarWidth, 32, '200 列 → clamp(round(200×0.16),24,36) = 32');
});

test('getLayout grows message area as rows grow', () => {
  const short = cc.getLayout(100, 10);
  const tall = cc.getLayout(100, 60);
  assert.ok(
    tall.messageHeight > short.messageHeight,
    `messageHeight must grow with rows (got ${short.messageHeight} → ${tall.messageHeight})`
  );
});

test('getLayout hides sidebar below 120 cols', () => {
  assert.equal(cc.shouldShowSidebar(119), false);
  assert.equal(cc.shouldShowSidebar(120), true);
});

// ── CcApp resize wiring contract (source-level) ──────────────────────────

test('CcApp listens to stdout resize with debounced commit', () => {
  const src = readFileSync(CCAPP_PATH, 'utf8');
  assert.ok(
    src.includes("process.stdout.on('resize'"),
    'CcApp must register a process.stdout resize listener'
  );
  assert.ok(
    src.includes('setTimeout('),
    'resize handler must be debounced (setTimeout) so drag-resize commits once'
  );
  assert.ok(
    src.includes("process.stdout.off('resize'"),
    'resize listener must be removed on unmount (cleanup return)'
  );
  assert.ok(
    src.includes('setCols(') && src.includes('setRows('),
    'settled dims must be committed via setCols/setRows (the P0-3 regression: zero callers)'
  );
  assert.ok(
    src.includes('ccTerminalDims('),
    'resize must commit the resolved pair from ccTerminalDims (BUG-83: the repo '
      + 'has ONE sticky + KHY_TERM_FALLBACK_* accessor; a cc-local sanitizeDim copy '
      + 'ignored both the shared cache and the documented env contract)'
  );
  // BUG-83 structural guard: subscribing to 'resize' is legitimate, READING the
  // size is not (DESIGN-ARCH-102 P4/H8 — effectiveDims is the only sanctioned
  // reader). Anything that re-interprets a screen coordinate against a freshly
  // read stdout can disagree with the frame that was actually painted.
  const bareReads = src
    .split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .filter(([, l]) => /process\.stdout\s*\.\s*(rows|columns)/.test(l));
  assert.deepEqual(
    bareReads,
    [],
    'CcApp must not read process.stdout.rows/columns directly: '
      + bareReads.map(([n, l]) => `L${n}: ${l.trim()}`).join(' | ')
  );
});

// ── messageAreaCap: P0-2 frame-height discipline for CcApp's message window ─
// Fixed shares (all absolute, mirroring the current components):
//   logo = marginY 1×2 + 1 content + 1 subtitle = 4
//   status line = 1, input ≥ 1 (caller passes real max), frame slack = 2
//   streaming row = 2, messageBar = 1, each toast = 1, agentTree = caller rows
//   trailer = 1 (BUG-77b: ink writes `output + '\n'`, so a frame of exactly
//   `rows` lines still trips the fullscreen branch — same `- 1` liveBudget uses)

test('messageAreaCap: default 30-row terminal with input 10 → 12', () => {
  assert.equal(cc.messageAreaCap(100, 30, { inputRows: 10 }), 12);
});

test('messageAreaCap: every optional share subtracts from the window', () => {
  const base = cc.messageAreaCap(100, 40, { inputRows: 8 });
  assert.equal(base, 24); // 40 − 4 − 1 − 8 − 2 − 1(trailer)
  assert.equal(
    cc.messageAreaCap(100, 40, { inputRows: 8, streaming: true }),
    base - 2
  );
  assert.equal(
    cc.messageAreaCap(100, 40, { inputRows: 8, messageBar: true }),
    base - 1
  );
  assert.equal(
    cc.messageAreaCap(100, 40, { inputRows: 8, toasts: 3 }),
    base - 3
  );
  assert.equal(
    cc.messageAreaCap(100, 40, { inputRows: 8, agentTreeRows: 5 }),
    base - 5
  );
});

test('messageAreaCap: logo without subtitle frees one row', () => {
  assert.equal(
    cc.messageAreaCap(100, 30, { inputRows: 10, logoSubtitle: false }),
    cc.messageAreaCap(100, 30, { inputRows: 10 }) + 1
  );
});

test('messageAreaCap: input floor is 1 (never below the prompt)', () => {
  assert.equal(
    cc.messageAreaCap(100, 30, { inputRows: 0 }),
    cc.messageAreaCap(100, 30, { inputRows: 1 })
  );
  assert.equal(
    cc.messageAreaCap(100, 30, {}),
    cc.messageAreaCap(100, 30, { inputRows: 1 })
  );
});

test('messageAreaCap: saturates to 0 (cap off) on tiny terminals, never negative', () => {
  // 10 rows − logo 4 − status 1 − input 1 − slack 2 = 2; + streaming/toasts/bar saturates it
  const tiny = cc.messageAreaCap(100, 10, {
    inputRows: 3,
    streaming: true,
    messageBar: true,
    toasts: 2,
  });
  assert.equal(tiny, 0);
  assert.ok(cc.messageAreaCap(100, 1, {}) === 0, '1-row terminal → 0');
  assert.ok(
    Number.isFinite(cc.messageAreaCap(100, 10, {})) && cc.messageAreaCap(100, 10, {}) >= 0,
    'never negative'
  );
});

test('messageAreaCap: degenerate geometry (0/NaN/negative rows) → 0', () => {
  assert.equal(cc.messageAreaCap(100, 0, {}), 0);
  assert.equal(cc.messageAreaCap(100, NaN, {}), 0);
  assert.equal(cc.messageAreaCap(100, -3, {}), 0);
  assert.equal(cc.messageAreaCap(100, undefined, {}), 0);
});

// ── CcApp message window wiring contract (source-level, P0-2) ─────────────

test('CcApp windows committed messages through the chrome plan', () => {
  const src = readFileSync(CCAPP_PATH, 'utf8');
  assert.ok(
    src.includes('ccChromePlan('),
    'CcApp must size its window AND its chrome from one plan (BUG-77b)'
  );
  assert.ok(
    !src.includes('messageAreaCap('),
    'CcApp must not also call messageAreaCap directly — two callers, one budget '
      + 'is how the ledger and the paint drifted apart in the first place'
  );
  assert.ok(
    src.includes('visibleMessages'),
    'CcApp must render the tail window (visibleMessages), not the full list'
  );
  assert.ok(
    src.includes('KHY_CC_MESSAGE_CAP'),
    'the window must be gated (KHY_CC_MESSAGE_CAP) so off = full render'
  );
  assert.ok(
    /messages\.slice\(start\)/.test(src),
    'the window is a tail slice (slice from computed start)'
  );
  assert.ok(
    /Ctrl\+O 查看完整转录/.test(src),
    'truncation must surface an honest hint pointing at the transcript view'
  );
});

// ── BUG-77b: the plan is ONE object feeding window + logo + hint + projection ─
// The defect was structural, not arithmetic: CcApp's "恒留最后一条" floor paints
// regardless of the cap, so on a short terminal the FLOOR plus fixed chrome alone
// reached `rows` and ink's fullscreen branch ghosted the whole screen. Guard that
// every surface that draws those rows asks the same plan.

test('BUG-77b: logo / hint / projection all read the same chromePlan', () => {
  const src = readFileSync(CCAPP_PATH, 'utf8');
  assert.ok(
    /chromePlan\.cap/.test(src),
    'the window must consume the plan cap, not a second ledger call'
  );
  assert.ok(
    /chromePlan\.banner/.test(src) && /chromePlan\.subtitle/.test(src),
    'the welcome banner must be rendered from the plan (ledger = paint)'
  );
  assert.ok(
    /hintOn && visibleMessages\.length < messages\.length/.test(src),
    'the collapse-hint row must only be painted when the plan budgeted it'
  );
  const proj = readFileSync(
    join(__dirname, '../../../src/cli/tui/ink-components/ccMessageProjection.js'),
    'utf8'
  );
  assert.ok(
    /chrome && chrome\.banner === false/.test(proj) && /chrome\.hint !== false/.test(proj),
    'the row projection must shed the same rows, or drag-select maps rows onto '
      + 'the wrong text on a short terminal'
  );
});

test('CcApp defines its agent-tree/estimate symbols (mount regression, P0-2)', () => {
  // Regression: KHY_CC_TUI=1 used to throw `estimateAllAgents is not defined`
  // on mount — three bare references with no import. Freeze the fix.
  const src = readFileSync(CCAPP_PATH, 'utf8');
  assert.ok(
    src.includes("require('../utils/ccTaskEstimate')"),
    'estimateAllAgents/formatDuration must be imported from ccTaskEstimate'
  );
  assert.ok(
    !/(^|[^.\w])AgentTree\s*[,{(]/.test(src.replace(/getAgentTree/g, '')),
    'AgentTree must be resolved via getAgentTree() lazy loader, not a bare ref'
  );
  assert.ok(
    !/(^|[^.\w])CcTranscriptView\s*[,{(]/.test(src.replace(/getCcTranscriptView/g, '')),
    'CcTranscriptView must be resolved via getCcTranscriptView() lazy loader'
  );
});

// ── ccTerminalDims: BUG-83 — the CC surface's ONE terminal-size resolution ──
// Before this accessor existed, CcApp carried its own copy of the size rules
// (`process.stdout.rows || 24` at mount + sanitizeDim/if-guard on resize). The
// copy dropped the documented KHY_TERM_FALLBACK_ROWS/COLS contract and the
// sticky last-valid cache, so on a conpty session that reports 0/undefined the
// CC surface laid a 24-row frame onto a 12-row screen → ink's fullscreen branch
// fired → full-screen repaint while Legacy on the SAME terminal was correct.
// Repro: .khy/feedback/tui-ux-audit-20260919/AU/repro-before-bug83.txt

const EFF_PATH = join(__dirname, '../../../src/cli/tui/effectiveDims');

function withStdoutDims(dims, fn) {
  const before = { rows: process.stdout.rows, cols: process.stdout.columns };
  const setter = (key, v) => {
    try {
      Object.defineProperty(process.stdout, key, { value: v, configurable: true, writable: true });
    } catch { /* frozen stdout → skip this axis */ }
  };
  const apply = (next) => {
    setter('rows', next.rows);
    setter('columns', next.cols);
  };
  apply(dims);
  require(EFF_PATH)._resetStickyForTest();
  try {
    // fn receives `apply` so a case can walk the SAME session from a valid
    // reading into a garbage one — that transition is what stickiness is about,
    // and resetting the cache between the two would test nothing.
    return fn(apply);
  } finally {
    apply(before);
    require(EFF_PATH)._resetStickyForTest();
  }
}

test('ccTerminalDims: unknown stdout size honours KHY_TERM_FALLBACK_ROWS/COLS (the documented remedy)', () => {
  withStdoutDims({ rows: undefined, cols: undefined }, () => {
    const d = cc.ccTerminalDims({ KHY_TERM_FALLBACK_ROWS: '12', KHY_TERM_FALLBACK_COLS: '100' });
    assert.deepEqual(d, { cols: 100, rows: 12 }, 'CC must lay out the screen the operator declared');
  });
});

test('ccTerminalDims: unknown size with no env override → documented 80×24 defaults', () => {
  withStdoutDims({ rows: undefined, cols: undefined }, () => {
    assert.deepEqual(cc.ccTerminalDims({}), { cols: 80, rows: 24 });
  });
});

test('ccTerminalDims: sticky — an UNKNOWN reading keeps the last valid size, a 0 reading is a measurement', () => {
  withStdoutDims({ rows: 40, cols: 132 }, (apply) => {
    assert.deepEqual(cc.ccTerminalDims({}), { cols: 132, rows: 40 }, 'valid reading is used');
    // effectiveDims 的三态契约：undefined = 未知 → 复用上次有效值；0 = 量出来的垃圾
    // 读数 → 不粘，回到声明/假定的尺寸。Legacy 走的是同一判据（App.js:5580 的
    // _dimsKnown 分支），这里锁的是「两个表面同一个答案」，不是新发明。
    apply({ rows: undefined, cols: undefined });
    assert.deepEqual(
      cc.ccTerminalDims({ KHY_TERM_FALLBACK_ROWS: '12', KHY_TERM_FALLBACK_COLS: '100' }),
      { cols: 132, rows: 40 },
      'undefined must not collapse a known size'
    );
    apply({ rows: 0, cols: 0 });
    assert.deepEqual(
      cc.ccTerminalDims({ KHY_TERM_FALLBACK_ROWS: '12', KHY_TERM_FALLBACK_COLS: '100' }),
      { cols: 100, rows: 12 },
      'a 0 reading is a measurement → resolved size, not the previous one'
    );
  });
});

test('ccTerminalDims: garbage env values never leak NaN/0 into the layout', () => {
  withStdoutDims({ rows: undefined, cols: undefined }, () => {
    const d = cc.ccTerminalDims({ KHY_TERM_FALLBACK_ROWS: 'abc', KHY_TERM_FALLBACK_COLS: '-5' });
    assert.ok(Number.isInteger(d.cols) && d.cols > 0, 'cols must be a positive int');
    assert.ok(Number.isInteger(d.rows) && d.rows > 0, 'rows must be a positive int');
  });
});

test('ccTerminalDims agrees with the Legacy surface on the same reading', () => {
  const eff = require(EFF_PATH);
  const sb = require('../../../src/cli/tui/sidebarLayout');
  for (const dims of [{ rows: undefined, cols: undefined }, { rows: 30, cols: 110 }]) {
    withStdoutDims(dims, () => {
      const env = { KHY_TERM_FALLBACK_ROWS: '12', KHY_TERM_FALLBACK_COLS: '100' };
      const ccDims = cc.ccTerminalDims(env);
      // App.js:5566-5582 resolves the pair the same way for the Legacy surface.
      const legacyCols = eff.stickyCols(env) > 0 ? eff.stickyCols(env) : sb.fallbackCols(env);
      const legacyRows = eff.stickyRows(env) > 0 ? eff.stickyRows(env) : sb.fallbackRows(env);
      assert.deepEqual(ccDims, { cols: legacyCols, rows: legacyRows },
        `both surfaces must resolve the same pair for reading ${JSON.stringify(dims)}`);
    });
  }
});

// ── inputWindow: 输入框高度窗口把省略号行算进预算（BUG-84）─────────────────
// 病灶：组件与投影都写「取满 maxRenderRows，再往上追加 1–2 行省略号」，
// 而宿主只按 layout.inputMaxHeight 扣账 → 「账本 N 行 / 实画 N+2 行」。
// 下面第一条是硬不变量：无论怎么组合，窗口占屏行数不得超过 cap。

test('inputWindow never paints more rows than the budget, for every shape', () => {
  for (let cap = 1; cap <= 12; cap += 1) {
    for (let total = 0; total <= 40; total += 1) {
      for (let caret = 0; caret < Math.max(1, total); caret += 1) {
        const w = cc.inputWindow(total, cap, caret);
        assert.ok(w.rows <= w.cap,
          `cap=${cap} total=${total} caret=${caret} → rows=${w.rows} 越过预算 ${JSON.stringify(w)}`);
        assert.ok(w.start >= 0 && w.end <= total && w.end >= w.start,
          `窗口越界 cap=${cap} total=${total} caret=${caret} ${JSON.stringify(w)}`);
        assert.ok(!w.above || w.start > 0, 'above 行必须有真被藏起的行');
        assert.ok(!w.below || w.end < total, 'below 行必须有真被藏起的行');
        assert.equal(w.rows, (w.end - w.start) + (w.above ? 1 : 0) + (w.below ? 1 : 0),
          'rows 必须等于实画行数');
        if (total > 0) {
          assert.ok(w.start <= caret && caret < w.end,
            `光标行必须留在窗口内 cap=${cap} total=${total} caret=${caret} ${JSON.stringify(w)}`);
        }
        // 截断一旦发生就不许白留预算行：省下的标记行要还给内容。
        if (w.start > 0 || w.end < total) {
          assert.equal(w.rows, w.cap,
            `截断时应占满预算 cap=${cap} total=${total} caret=${caret} ${JSON.stringify(w)}`);
        }
      }
    }
  }
});

test('inputWindow gives the ellipsis rows back to content, not to the screen', () => {
  // 7 行预算、光标居中：旧算式画 7 行内容 + 2 行省略号 = 9 行。
  const w = cc.inputWindow(30, 7, 15);
  assert.equal(w.rows, 7, '占屏总行数必须正好等于预算');
  assert.equal(w.end - w.start, 5, '两块省略号 ⇒ 内容只剩 5 行');
  assert.ok(w.above && w.below);
  assert.ok(w.start <= 15 && 15 < w.end, '光标行必须留在窗口内');
});

test('inputWindow keeps the content row when the budget cannot fit a marker', () => {
  // cap=1 放不下省略号（1 内容 + 1 标记 = 2 就超预算）→ 只画内容行。
  const one = cc.inputWindow(30, 1, 15);
  assert.equal(one.rows, 1);
  assert.equal(one.above, false);
  assert.equal(one.below, false);
  // cap=2 只放得下一块标记：保留「藏得更多」的那一侧（此处上下各 14/14 → 上）。
  const two = cc.inputWindow(30, 2, 15);
  assert.equal(two.rows, 2);
  assert.notEqual(two.above && two.below, true, '两块标记会越过 2 行预算');
});

test('inputWindow leaves short input alone', () => {
  const w = cc.inputWindow(5, 7, 2);
  assert.deepEqual({ ...w }, { start: 0, end: 5, above: false, below: false, rows: 5, cap: 7 });
});

test('inputWindow honours the same null/NaN fallback as inputRenderRows', () => {
  assert.equal(cc.inputWindow(30, null, 0).cap, cc.INPUT_MAX_ROWS_DEFAULT);
  assert.equal(cc.inputWindow(30, undefined, 0).cap, cc.INPUT_MAX_ROWS_DEFAULT);
  assert.equal(cc.inputWindow(30, Number.NaN, 0).cap, cc.INPUT_MAX_ROWS_DEFAULT);
  assert.equal(cc.inputWindow(30, 0, 0).cap, 1);
});

test('CcPromptInput and ccMessageProjection both window through inputWindow', () => {
  // 账本与画面同源的前提：两边不许再各写一份 slice/半窗算式（BUG-81 的教训）。
  const READ = (p) => readFileSync(join(__dirname, '../../../src/cli/tui/ink-components', p), 'utf8');
  for (const f of ['CcPromptInput.js', 'ccMessageProjection.js']) {
    const src = READ(f);
    assert.match(src, /inputWindow\s*\(/, `${f} 必须经 ccLayout.inputWindow 求窗口`);
    assert.doesNotMatch(src, /Math\.floor\(\s*\w*[Rr]enderRows\s*\/\s*2\s*\)/,
      `${f} 里不该再出现第二份半窗算式`);
  }
});
