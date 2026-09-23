'use strict';

// chromeBudget — single chrome ledger (DESIGN-ARCH-103 P0-5 / H1).
// `node --test`.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const BACKEND = path.resolve(__dirname, '../../..');
const CB = require(path.join(BACKEND, 'src/cli/tui/chromeBudget'));
const { chromeRows, liveBudget, LIVE_MIN } = CB;

// ── H1 property: liveBudget <= rows - 1 for any shares ───────────────────────
test('H1: liveBudget(rows, shares) <= rows - 1 over random combinations', () => {
  for (let i = 0; i < 100; i++) {
    const rows = 4 + i; // 4..103
    const shares = {
      inputRows: (i % 4) + 1,
      statusRows: 1 + (i % 2),
      toastRows: i % 5,
      messageBarRows: i % 3,
      agentTreeRows: i % 4,
      streamingRows: i % 2,
      extraRows: i % 3,
      slack: 2,
    };
    const b = liveBudget(rows, shares);
    assert.ok(b <= rows - 1, `rows=${rows} budget=${b} exceeds rows-1`);
    assert.ok(b >= LIVE_MIN, `rows=${rows} budget=${b} below LIVE_MIN`);
  }
});

test('liveBudget: degenerate rows → 0', () => {
  assert.equal(liveBudget(0, {}), 0);
  assert.equal(liveBudget(-5, {}), 0);
  assert.equal(liveBudget(NaN, {}), 0);
});

// ── parity with the legacy call sites (single ledger, no drift) ─────────────
test('parity: ccLayout.messageAreaCap === chromeBudget adapter', () => {
  const L = require(path.join(BACKEND, 'src/cli/tui/utils/ccLayout'));
  for (const rows of [24, 40, 60]) {
    for (const shares of [
      { inputRows: 3, toasts: 2 },
      { inputRows: 1 },
      { inputRows: 4, streaming: true, messageBar: true, agentTreeRows: 2, toasts: 3 },
      { inputRows: 1, logoSubtitle: false },
    ]) {
      const legacy = L.messageAreaCap(100, rows, shares);
      // recompute via the ledger path (adapter is what L.messageAreaCap calls)
      const viaLedger = require(path.join(BACKEND, 'src/cli/tui/chromeBudget')).messageAreaCapCompat(100, rows, shares);
      assert.equal(legacy, viaLedger, `rows=${rows} ${JSON.stringify(shares)}`);
    }
  }
});

test('parity: liveRegionBudget.resolveStreamReserve ON default === 9 + toolRows', () => {
  const LRB = require(path.join(BACKEND, 'src/cli/tui/ink-components/liveRegionBudget'));
  assert.equal(LRB.resolveStreamReserve({ toolCount: 3 }, {}), 12);
  assert.equal(LRB.resolveStreamReserve({ toolCount: 8, taskLineCount: 0 }, {}), 15);
  assert.equal(LRB.resolveStreamReserve({ toolCount: 0 }, { KHY_LIVE_HEIGHT_BUDGET: '0' }), 9);
});

test('parity: railLayout.railBottomChrome defaults unchanged (2 base)', () => {
  const RL = require(path.join(BACKEND, 'src/cli/tui/railLayout'));
  assert.equal(RL.railBottomChrome({}, {}), 2);
  assert.equal(RL.railBottomChrome({ collabActive: true }, {}), 3);
  assert.equal(RL.railBottomChrome({}, { KHY_SIDEBAR_RAIL_BOTTOM_CHROME: '5' }), 5);
});

// ── BUG-77b: the CC cap must reserve ink's trailer row, and the degradation
// ladder must never leave chrome on screen that the ledger did not pay for ───

test('BUG-77b: messageAreaCapCompat reserves the trailer row (H1 parity with liveBudget)', () => {
  // 30 − (input 10 + status 1 + logo 4 + slack 2) − 1 trailer = 12.
  // Before the fix this returned 13, i.e. a frame of exactly `rows` — measured
  // to trip ink's fullscreen branch (AU/repro-before-bug77b.txt: 80×12 → 2 次
  // \x1b[2J、100×8 → 7 次整屏残影).
  assert.equal(CB.messageAreaCapCompat(100, 30, { inputRows: 10 }), 12);
  assert.equal(CB.CC_TRAILER_ROWS, 1);
});

test('ccChromePlan: full banner wherever it is affordable', () => {
  for (const rows of [24, 40]) {
    const p = CB.ccChromePlan(rows, { inputRows: Math.min(10, Math.floor(rows * 0.3)) });
    assert.equal(p.banner, true, `rows=${rows} banner`);
    assert.equal(p.subtitle, true, `rows=${rows} tagline`);
    assert.equal(p.hint, true, `rows=${rows} hint row`);
    assert.equal(p.logoRows, CB.CC_LOGO_ROWS);
  }
  // 16 rows is where the ladder stops being able to buy a hint row: the plan
  // budgets the streaming row even at rest (see the streaming-invariance test),
  // so a banner is still affordable while the hint is not.
  const p = CB.ccChromePlan(16, { inputRows: 4 });
  assert.equal(p.banner, true);
  assert.equal(p.hint, false);
});

test('ccChromePlan: sheds tagline, then the banner, as rows shrink', () => {
  // 12 rows: even the title row cannot be paid for next to a 3-row prompt and
  // the streaming line, so the ladder goes all the way down to bannerless.
  const p = CB.ccChromePlan(12, { inputRows: 3 });
  assert.equal(p.banner, false);
  assert.equal(p.logoRows, 0);
  assert.equal(p.subtitle, false);
  assert.ok(p.cap >= CB.CC_WINDOW_FLOOR_ROWS + CB.CC_HINT_ROWS,
    'the rows the banner gave back must land in the message window');
  // 14 rows buys the tagline-less title row back — one rung, not two.
  const mid = CB.ccChromePlan(14, { inputRows: 3 });
  assert.equal(mid.banner, true);
  assert.equal(mid.subtitle, false);
  assert.equal(mid.logoRows, CB.CC_LOGO_ROWS_NO_TAGLINE);
});

test('ccChromePlan: streaming never changes the plan (the banner must not blink)', () => {
  // The streaming row exists only while busy. If the ladder read `shares.streaming`,
  // the plan would be a function of the turn: {cap 2, full banner} at rest vs
  // {cap 4, no banner} while thinking at 12 rows, 6↔4 at 16, 14↔12 at 24 —
  // the decoration blinks and the window resizes twice per answer.
  for (const rows of [8, 12, 14, 16, 24, 30, 40]) {
    const idle = CB.ccChromePlan(rows, { inputRows: 3 });
    const busy = CB.ccChromePlan(rows, { inputRows: 3, streaming: true });
    assert.deepEqual(busy, idle, `rows=${rows} plan changed with streaming`);
  }
});

test('ccChromePlan property: every row it keeps is budgeted (rows 4..60)', () => {
  const shareSets = [
    { inputRows: 1 },
    { inputRows: 3, streaming: true },
    { inputRows: 10, messageBar: true, toasts: 2, agentTreeRows: 1 },
  ];
  for (const shares of shareSets) {
    let prevLogo = -1;
    for (let rows = 4; rows <= 60; rows++) {
      const p = CB.ccChromePlan(rows, shares);
      assert.ok(Number.isInteger(p.cap) && p.cap >= 0, `rows=${rows} cap=${p.cap}`);
      // More rows never means LESS chrome kept. (The cap itself legitimately
      // DIPS the moment the ladder re-adopts a banner row — that row went to
      // the banner, not to nowhere — so it is not asserted monotone here.)
      assert.ok(p.logoRows >= prevLogo, `rows=${rows} logo ${p.logoRows} < ${prevLogo}`);
      prevLogo = p.logoRows;
      if (p.banner) {
        assert.ok(p.cap >= CB.CC_WINDOW_FLOOR_ROWS,
          `rows=${rows} kept a banner it cannot pay the message floor for`);
      }
      if (p.hint) {
        assert.ok(p.cap >= CB.CC_WINDOW_FLOOR_ROWS + CB.CC_HINT_ROWS,
          `rows=${rows} budgeted a hint row inside the floor`);
      }
    }
  }
});

test('ccChromePlan: logoSubtitle:false starts the ladder one rung down', () => {
  // Same geometry, two operators: the one that already asked for no tagline
  // must not spend the extra row back on a title-only banner.
  const withTagline = CB.ccChromePlan(15, { inputRows: 3 });
  const noTagline = CB.ccChromePlan(15, { inputRows: 3, logoSubtitle: false });
  assert.equal(withTagline.logoRows, CB.CC_LOGO_ROWS);
  assert.equal(withTagline.subtitle, true);
  assert.equal(noTagline.logoRows, CB.CC_LOGO_ROWS_NO_TAGLINE);
  assert.equal(noTagline.subtitle, false);
  assert.equal(noTagline.cap, withTagline.cap + 1);
});

// ── BUG-91: 让位梯的最后一档 —— 两条 marginTop 空行 ───────────────────────────
//
// 复现存证 .khy/feedback/tui-ux-audit-20260919/AU/repro-before-bug91.txt：
// 80×5 / 80×6 / 80×7 上发三条短消息，每一档都有 3 帧带 \x1b[2J（一轮回答一次），
// 80×8 起为 0。ink 的判据是 `outputHeight >= stdout.rows`（ink.js:320），而
// busy 帧的**地板**（一条消息 + 思考行 + 状态栏 + 输入框，含各自的 marginTop）
// 在 rows ≤ 7 时正好等于 rows —— 横幅那三档此时早已全 shed，账本再无可让之处。
// 所以让位必须继续往下走到「空行」这一档，且画面、投影、估高三处都得跟着账本走。

test('ccGapPlan：让位顺序 = 消息空行 → 思考行空行，且随 rows 单调不反向', () => {
  const G = (rows, shares) => CB.ccGapPlan(rows, shares);
  // 顺序：先省消息前那一行，文字本体留下；再省思考行前那一行，● 那行留下。
  assert.deepEqual(G(8, { inputRows: 2 }), { msgGap: true, busyGap: true });
  assert.deepEqual(G(7, { inputRows: 2 }), { msgGap: false, busyGap: true });
  assert.deepEqual(G(5, { inputRows: 1 }), { msgGap: false, busyGap: false });
  let prev = null;
  for (let rows = 1; rows <= 40; rows++) {
    const g = G(rows, { inputRows: 2 });
    // 更宽的终端绝不比更窄的省得更多（否则同一 session 里空行会随刷新闪动）。
    if (prev) {
      assert.ok(Number(g.msgGap) >= Number(prev.msgGap), `msgGap 倒挂 @${rows}`);
      assert.ok(Number(g.busyGap) >= Number(prev.busyGap), `busyGap 倒挂 @${rows}`);
    }
    prev = g;
  }
});

test('ccGapPlan 只在横幅已全让位之后才登场：banner 还在就不许吃空行', () => {
  for (let rows = 4; rows <= 40; rows++) {
    const p = CB.ccChromePlan(rows, { inputRows: Math.max(1, Math.floor(rows / 4)) });
    if (p.banner) assert.ok(p.msgGap && p.busyGap, `rows=${rows} 横幅与空行同时在场，让位顺序倒了`);
  }
});

test('H1(实画地板)：真实几何下 rows ≥ 5 的 busy 帧地板恒 ≤ rows-1；rows ≤ 4 落已登记地板', () => {
  const { getLayout } = require(path.join(BACKEND, 'src/cli/tui/utils/ccLayout'));
  for (let rows = 5; rows <= 40; rows++) {
    const shares = { inputRows: getLayout(80, rows).inputMaxHeight };
    const p = CB.ccChromePlan(rows, Object.assign({ messageBar: false, toasts: 0, agentTreeRows: 0 }, shares));
    const floor = CB.ccFrameFloorRows(shares, p);
    assert.ok(floor <= rows - 1, `rows=${rows} 地板 ${floor} 顶到 rows（ink 会走全屏分支）`);
  }
  // rows ≤ 4：状态栏与输入框不是装饰，收掉它们就不是「让位」而是「少一个部件」。
  // 这一档已在 BUG-88b 登记不修，此处只锁「账本已让到最后一档」，不假装解掉了。
  const p4 = CB.ccChromePlan(4, { inputRows: 1 });
  assert.deepEqual({ msgGap: p4.msgGap, busyGap: p4.busyGap }, { msgGap: false, busyGap: false });
  assert.ok(CB.ccFrameFloorRows({ inputRows: 1 }, p4) >= 4);
});

test('ccFrameFloorRows 与 ccGapPlan 同口径：省一行空行就少账一行', () => {
  const base = CB.ccFrameFloorRows({ inputRows: 2 }, { msgGap: true, busyGap: true });
  assert.equal(CB.ccFrameFloorRows({ inputRows: 2 }, { msgGap: false, busyGap: true }), base - 1);
  assert.equal(CB.ccFrameFloorRows({ inputRows: 2 }, { msgGap: false, busyGap: false }), base - 2);
  // 缺省（老调用方不传 gaps）必须是「两行空行都在」，否则本文件之外的账本会静默变松。
  assert.equal(CB.ccFrameFloorRows({ inputRows: 2 }), base);
  // agentTreeRows 也进地板：树那一行不是装饰，但它是真实占用。
  assert.equal(CB.ccFrameFloorRows({ inputRows: 2, agentTreeRows: 1 }, { msgGap: true, busyGap: true }), base + 1);
});

// ── BUG-92：让位判据必须知道「窗口恒留那条消息实画几行」 ────────────────────

test('ccLayout.ccChromePlan 是薄适配器：位置参数必须整串转发（BUG-92 病根本体）', () => {
  const { ccChromePlan: viaLayout } = require(path.join(BACKEND, 'src/cli/tui/utils/ccLayout'));
  const shares = { inputRows: 2, logoSubtitle: true };
  // 第三个位置参数（contentRows）落在适配器上被吞掉时，调用方拿到的是
  // 「按最宽松档算出的 plan」——账本自洽、画面不动，2J 就是这么留下的。
  assert.deepEqual(viaLayout(8, shares, 3), CB.ccChromePlan(8, shares, 3));
  assert.notDeepEqual(viaLayout(8, shares, 3), viaLayout(8, shares, 1),
    'contentRows 没能穿过适配器：两个不同内容高度给出了同一份 plan');
  // 同一条判据也适用于 shares（防有人把适配器改回 `(rows, shares)` 两参形）。
  assert.deepEqual(
    viaLayout(8, Object.assign({}, shares, { agentTreeRows: 1 })),
    CB.ccChromePlan(8, Object.assign({}, shares, { agentTreeRows: 1 })),
  );
});

test('contentRows 单调：内容越高 → 让位只会更狠，装饰不会更慷慨', () => {
  for (let rows = 4; rows <= 30; rows++) {
    const shares = { inputRows: Math.max(1, Math.floor(rows / 4)) };
    const p1 = CB.ccChromePlan(rows, shares, 1);
    const p3 = CB.ccChromePlan(rows, shares, 3);
    assert.ok(Number(p3.msgGap) <= Number(p1.msgGap), `msgGap 反向 @${rows}`);
    assert.ok(Number(p3.busyGap) <= Number(p1.busyGap), `busyGap 反向 @${rows}`);
    assert.ok(Number(p3.banner) <= Number(p1.banner), `banner 反向 @${rows}`);
    // 判据同一条：plan 的空行档必须就是 ccGapPlan 在该内容高度下的答案
    // （两处各写一份公式 = 第 9 片那条教训的重演）。
    assert.deepEqual(
      { msgGap: p3.msgGap, busyGap: p3.busyGap },
      CB.ccGapPlan(rows, shares, 3),
      `plan 与 ccGapPlan 不同源 @${rows}`,
    );
  }
});

test('contentRows 缺省为 1：不传第三参的旧调用方逐字节保持改前判据（棘轮）', () => {
  const shares = { inputRows: 2 };
  assert.deepEqual(CB.ccChromePlan(8, shares), CB.ccChromePlan(8, shares, 1));
  assert.deepEqual(CB.ccFrameFloorRows(shares, { msgGap: true, busyGap: true }),
    CB.ccFrameFloorRows(shares, { msgGap: true, busyGap: true }, 1));
  // 80×8 上「1 行消息」这一档的已知形状：横幅让位、两条空行都留。
  // 钉绝对值而不是钉关系式 —— 关系式在常数漂移时会跟着一起错。
  assert.deepEqual(CB.ccChromePlan(8, shares), {
    cap: 0, logoRows: 0, subtitle: false, banner: false, hint: false,
    msgGap: true, busyGap: true,
  });
});
