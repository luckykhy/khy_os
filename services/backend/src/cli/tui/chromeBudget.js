'use strict';

/**
 * chromeBudget — the SINGLE chrome ledger (DESIGN-ARCH-103 P0-5 / H1).
 *
 * Historically the "how many rows are fixed (non-scrolling)" arithmetic lived
 * in THREE places — ccLayout.messageAreaCap, liveRegionBudget, railLayout
 * railBottomChrome — each with its own constants, so a change in one could
 * desync the others and the frame would quietly overflow the viewport. This
 * module is the one definition: chromeRows() sums the shares, liveBudget()
 * applies the H1 hard constraint (frame height <= rows - 1, the `-1` is the
 * conpty pending-wrap discipline).
 *
 * Pure leaf: no IO, never throws. The legacy functions become thin adapters
 * over this ledger, keeping their signatures so existing call sites and tests
 * keep working while the arithmetic converges on one source.
 */

const LIVE_MIN = 3; // the live region is never budgeted below 3 rows

// CC (CcApp) chrome constants — every number here is a row that was MEASURED on
// the painted frame, not guessed (BUG-77b evidence:
// .khy/feedback/tui-ux-audit-20260919/AU/repro-before-bug77b.txt).
const CC_LOGO_ROWS = 4;            // CcLogo: marginY 1×2 + title + tagline
const CC_LOGO_ROWS_NO_TAGLINE = 3; // CcLogo with subtitle=false
const CC_TRAILER_ROWS = 1;         // ink writes `output + '\n'` — the `- 1` of liveBudget
const CC_WINDOW_FLOOR_ROWS = 2;    // CcApp keeps the last message: marginTop + ≥ 1 line
const CC_HINT_ROWS = 1;            // 「⋯ 已收起上方 N 条」row
// BUG-91: the two blank rows a busy frame actually paints *below* the window
// floor — a message's own marginTop and CcStreamingMessage's marginTop. They
// are the last compressible rows once the logo ladder is already at 0, so the
// plan has to be able to say "no blank lines this frame" and CcApp has to
// render exactly that (ledger = paint, same rule as BUG-88b/89b's shed ladder).
const CC_MSG_GAP_ROWS = 1;         // marginTop in front of every committed message
const CC_BUSY_GAP_ROWS = 1;        // marginTop of CcStreamingMessage (busy only)
const CC_STATUS_ROWS = 1;          // CcStatusLine
const CC_MSG_ROWS = 1;             // one message's content row at the floor

/**
 * Sum of fixed (non-scrolling) rows.
 * @param {{inputRows?: number, statusRows?: number, toastRows?: number,
 *   messageBarRows?: number, agentTreeRows?: number, streamingRows?: number,
 *   extraRows?: number, slack?: number}} [shares]
 * @returns {number} ≥ 0
 */
function chromeRows(shares = {}) {
  const s = shares || {};
  const pick = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : d);
  return (
    pick(s.inputRows, 1) +
    pick(s.statusRows, 1) +
    pick(s.toastRows) +
    pick(s.messageBarRows) +
    pick(s.agentTreeRows) +
    pick(s.streamingRows) +
    pick(s.extraRows) +
    pick(s.slack, 2)
  );
}

/**
 * The H1 live-region budget: `rows - chrome - 1`, clamped to [LIVE_MIN, rows].
 * The `-1` is a hard discipline: the frame must never write the last screen
 * row (conpty pending-wrap) and must stay under Ink's fullscreen-repaint
 * trigger.
 * @param {number} rows
 * @param {{[k: string]: number}} [shares]
 * @returns {number}
 */
function liveBudget(rows, shares = {}) {
  const r = Math.floor(Number(rows));
  if (!Number.isFinite(r) || r <= 0) {
    return 0;
  }
  return Math.min(r, Math.max(LIVE_MIN, r - chromeRows(shares) - 1));
}

/**
 * The CC cap at ONE fixed logo block height. Kept private so the shed ladder
 * (ccChromePlan) and the legacy adapter (messageAreaCapCompat) cannot drift
 * apart in their arithmetic — they differ only in which logoRows they ask for.
 * @param {number} rows
 * @param {{[k: string]: unknown}} shares
 * @param {number} logoRows
 * @returns {number} ≥ 0
 */
function ccCapAtLogoRows(rows, shares, logoRows) {
  const n = Math.floor(Number(rows));
  if (!Number.isFinite(n) || n <= 0) {
    return 0;
  }
  const s = shares || {};
  const extra = Number.isFinite(Number(s.extraRows)) ? Number(s.extraRows) : 0;
  const chrome = chromeRows({
    inputRows: Math.max(1, Math.floor(Number(s.inputRows) || 1)),
    statusRows: 1,
    streamingRows: s.streaming ? 2 : 0,
    messageBarRows: s.messageBar ? 1 : 0,
    toastRows: s.toasts,
    agentTreeRows: s.agentTreeRows,
    extraRows: logoRows + extra,
    slack: 2,
  });
  // The trailer row is the same hard discipline liveBudget encodes as `- 1`:
  // ink picks the fullscreen branch at `outputHeight >= rows` (MEASURED, not
  // `>`), so a frame that fills rows exactly still ghosts the whole screen.
  return Math.max(0, n - chrome - CC_TRAILER_ROWS);
}

/**
 * The busy frame's painted floor at a given gap choice — the rows CcApp
 * actually writes when the message window is at its floor (one committed
 * message + the thinking row + status line + input). Exported so the guards
 * assert against THIS arithmetic instead of re-copying it (slice-9 lesson:
 * a second copy of the formula manufactures a fake green).
 *
 * This is deliberately NOT `cap`: cap also carries the wrap slack, which is
 * reserve rather than paint, and charging it here would make the last rung
 * unreachable.
 *
 * @param {{inputRows?:number, agentTreeRows?:number}} [shares]
 * @param {{msgGap?:boolean, busyGap?:boolean}} [gaps]
 * @param {number} [contentRows] rows the kept message itself paints (BUG-92:
 *   the floor was hard-coded to 1, which is only true for a message that fits
 *   on one line — a 3-line wrap reaches `rows` even with both blanks gone)
 * @returns {number} ≥ 0
 */
function ccFrameFloorRows(shares = {}, gaps = {}, contentRows = 1) {
  const s = shares || {};
  const g = gaps || {};
  const msgGap = g.msgGap !== false;
  const busyGap = g.busyGap !== false;
  const pick = (v, d) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : d);
  return Math.max(CC_MSG_ROWS, pick(contentRows, 1))
    + (msgGap ? CC_MSG_GAP_ROWS : 0)
    + CC_BUSY_GAP_ROWS + (busyGap ? CC_BUSY_GAP_ROWS : 0)
    + CC_STATUS_ROWS
    + Math.max(1, pick(s.inputRows, 1))
    + pick(s.agentTreeRows, 0);
}

/**
 * BUG-91: the LAST rung of the CC degradation ladder — the blank rows.
 *
 * The logo ladder in ccChromePlan can only shed the banner. On a short
 * terminal the busy frame's own floor (one message + the thinking row + status
 * line + input) already reaches `rows`, so ink takes its fullscreen branch
 * (`outputHeight >= stdout.rows`) and win32 conpty rolls the previous frame
 * into scrollback: a whole-screen ghost per turn. MEASURED at 80×5/6/7 with
 * three short messages — 3 frames carrying \x1b[2J at every one of those
 * heights, 0 at rows ≥ 8
 * (.khy/feedback/tui-ux-audit-20260919/AU/repro-before-bug91.txt).
 *
 * What is left to give are the two marginTop blank rows. They are given up in
 * the order that costs the least information: the message gap first (the
 * message text itself stays), then the gap above the thinking row (the dot
 * row stays). Below that the only remaining rows are the status line and the
 * input — shedding those is the already-registered rows ≤ 4 floor (BUG-88b),
 * not something this rung pretends to solve.
 *
 * @param {number} rows
 * @param {{inputRows?:number, agentTreeRows?:number}} [shares] busy geometry
 * @param {number} [contentRows] rows the kept message paints (BUG-92)
 * @returns {{msgGap:boolean, busyGap:boolean}}
 */
function ccGapPlan(rows, shares = {}, contentRows = 1) {
  const n = Math.floor(Number(rows));
  if (!Number.isFinite(n) || n <= 0) {
    return { msgGap: true, busyGap: true };
  }
  // H1: the frame must stay under `rows` (ink triggers at `>= rows`).
  const rungs = [[true, true], [false, true], [false, false]];
  for (const [msgGap, busyGap] of rungs) {
    if (ccFrameFloorRows(shares, { msgGap, busyGap }, contentRows) <= n - 1) {
      return { msgGap, busyGap };
    }
  }
  // Even the last rung cannot pay: nothing decorative is left (status line and
  // input are not decoration), so shed both and let the rows ≤ 4 floor stand.
  return { msgGap: false, busyGap: false };
}

/**
 * BUG-77b: on a short terminal the fixed chrome itself is what overflows the
 * frame — the message window is already at its floor (CcApp never drops the
 * last message), so no window arithmetic can save the frame height. The only
 * compressible chrome is decorative, so the ledger offers a degradation ladder
 * and the caller renders what the ladder chose (ledger and paint stay
 * same-source). Shed order = least useful first: tagline, then the whole
 * banner, then (BUG-91, see ccGapPlan) the two marginTop blank rows. The
 * collapse-hint row is reported separately rather than being a rung: dropping
 * it never enlarges `cap`, it just stops the frame from spending a row on
 * information.
 *
 * @param {number} rows
 * @param {{[k: string]: unknown}} [shares] same shape as messageAreaCapCompat;
 *   `streaming` is ignored on purpose (see below)
 * @param {number} [contentRows] rows the kept (last) message paints — BUG-92.
 *   With the default 1 this is exactly the pre-BUG-92 ledger.
 * @returns {{cap:number, logoRows:number, subtitle:boolean, banner:boolean,
 *   hint:boolean, msgGap:boolean, busyGap:boolean}}
 */
function ccChromePlan(rows, shares = {}, contentRows = 1) {
  // Evaluate the ladder against the BUSY geometry and keep that answer for both
  // states. The streaming row exists only while busy, so a rung chosen from
  // `shares.streaming` makes the plan a function of the turn: at 80×12 it answers
  // {cap 2, full banner} at rest and {cap 4, no banner} while thinking — the
  // decoration blinks once per turn and the message window resizes twice. Same
  // spread at 16 rows (6 ↔ 4) and 24 (14 ↔ 12). Cost: rest frames leave ~2 rows
  // unused. A frame that does not move is worth those rows.
  const stable = Object.assign({}, shares, { streaming: true });
  // BUG-92: the window floor is not 2 rows, it is "the last message + its blank"
  // — a message that wraps to 3 lines needs 4. Measured residual: 80×5..8 with a
  // folding message still wrote one \x1b[2J per turn under the 2-row floor
  // (.khy/feedback/tui-ux-audit-20260919/AU/repro-before-bug92.txt).
  const cRows = Number.isFinite(Number(contentRows))
    ? Math.max(1, Math.floor(Number(contentRows)))
    : 1;
  const need = Math.max(CC_WINDOW_FLOOR_ROWS, cRows + CC_MSG_GAP_ROWS);
  const ladder = (stable.logoSubtitle === false)
    ? [CC_LOGO_ROWS_NO_TAGLINE, 0]
    : [CC_LOGO_ROWS, CC_LOGO_ROWS_NO_TAGLINE, 0];
  let chosen = ladder[ladder.length - 1];
  let cap = 0;
  for (const logoRows of ladder) {
    const next = ccCapAtLogoRows(rows, stable, logoRows);
    chosen = logoRows;
    cap = next;
    if (next >= need) {
      break;
    }
  }
  // Shed order preserved: the banner is given up before the blank rows are.
  const gaps = (chosen === 0 && cap < need)
    ? ccGapPlan(rows, stable, cRows)
    : { msgGap: true, busyGap: true };
  return {
    cap,
    logoRows: chosen,
    subtitle: chosen >= CC_LOGO_ROWS,
    banner: chosen > 0,
    hint: cap >= CC_WINDOW_FLOOR_ROWS + CC_HINT_ROWS,
    ...gaps,
  };
}

/**
 * Adapter for ccLayout.messageAreaCap: same signature, arithmetic from the
 * single ledger. The CC-mode logo block (marginY*2 + title [+ tagline]) is the
 * only CC-specific chrome, so it is passed as `extraRows`.
 *
 * Like liveBudget, this reserves CC_TRAILER_ROWS (the `- 1` discipline); it
 * does NOT clamp to LIVE_MIN and floors at 0, so tiny terminals degrade to
 * "cap disabled" rather than a 3-row live region that would itself overflow.
 * Degenerate geometry that needs chrome shedding is ccChromePlan's job —
 * CcApp asks the plan, never this adapter, so ledger and paint stay together.
 * @param {number} cols - unused by the arithmetic (kept for signature parity)
 * @param {number} rows
 * @param {{inputRows?: number, streaming?: boolean, messageBar?: boolean,
 *   toasts?: number, agentTreeRows?: number, logoSubtitle?: boolean,
 *   extraRows?: number}} [shares]
 * @returns {number} ≥ 0 (0 = nothing fits at this logo level)
 */
function messageAreaCapCompat(cols, rows, shares = {}) {
  const s = shares || {};
  return ccCapAtLogoRows(
    rows,
    s,
    s.logoSubtitle === false ? CC_LOGO_ROWS_NO_TAGLINE : CC_LOGO_ROWS,
  );
}

/**
 * Adapter for railLayout.railBottomChrome: how many fixed rows sit under the
 * live region (input + status + slack).
 * @param {NodeJS.ProcessEnv} [env] - unused (kept for call-site parity)
 * @returns {number}
 */
function railBottomChromeCompat(env) {
  return chromeRows({ inputRows: 1, statusRows: 1, slack: 2 });
}

module.exports = {
  chromeRows,
  liveBudget,
  messageAreaCapCompat,
  ccFrameFloorRows,
  ccGapPlan,
  ccChromePlan,
  railBottomChromeCompat,
  LIVE_MIN,
  CC_LOGO_ROWS,
  CC_LOGO_ROWS_NO_TAGLINE,
  CC_TRAILER_ROWS,
  CC_WINDOW_FLOOR_ROWS,
  CC_HINT_ROWS,
  CC_MSG_GAP_ROWS,
  CC_BUSY_GAP_ROWS,
};
