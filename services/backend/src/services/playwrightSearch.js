/**
 * playwrightSearch — optional headless-browser fallback for bot-blocked engines.
 *
 * Some search engines serve a JS challenge / CAPTCHA page to plain HTTP clients,
 * yielding zero parseable results. A real browser renders the results page and
 * defeats most of those gates. This module is the THIN browser layer: it returns
 * the rendered HTML for a URL and nothing more — parsing stays in webSearchService
 * (single source of truth for the cheerio selectors).
 *
 * Design constraints:
 *  - OPTIONAL: playwright is not a hard dependency. If neither `playwright` nor
 *    `playwright-core` is installed, every call degrades to { unavailable: true }
 *    and the caller silently skips it. Requiring this module never throws.
 *  - LEAN: one browser + one page per call, closed in finally. No process pools,
 *    no native interop — unlike open-webSearch's heavyweight playwrightClient.
 *  - REMOTE-FRIENDLY: connect to an existing browser via WS/CDP endpoint so the
 *    host need not bundle Chromium.
 *
 * Env knobs:
 *  - KHY_SEARCH_MODE                = request | auto | playwright   (default auto)
 *  - KHY_PLAYWRIGHT_WS_ENDPOINT     = ws://...    connect() to a remote browser
 *  - KHY_PLAYWRIGHT_CDP_ENDPOINT    = http://...  connectOverCDP() to a browser
 *  - KHY_PLAYWRIGHT_HEADLESS        = 'false' to show the window (default headless)
 *  - KHY_PLAYWRIGHT_NAV_TIMEOUT_MS  = navigation timeout (default 20000)
 *  - KHY_SEARCH_BROWSER_HARD_TIMEOUT    = hard wall-clock guard on the whole browser
 *                                         pass, default on (off-words: 0/false/off/no)
 *  - KHY_SEARCH_BROWSER_BUDGET_MS   = that guard's budget (default max(nav+10s, 30000))
 */
'use strict';

// Playwright acquisition (loader / remote-or-local launch / proxy) lives in the
// shared browser/engine.js single source of truth, consumed by both this search
// fallback and the interactive WebBrowser tool.
const engine = require('./browser/engine');
const { UA } = engine;

// Markers that a "200 OK" page is actually a bot wall rather than real results.
const _BOT_BLOCK_MARKERS = [
  'unusual traffic', 'are you a robot', 'captcha', 'verify you are human',
  'access denied', 'enable javascript', '人机验证', '安全验证', '请输入验证码',
  '百度安全验证', '网络不给力',
];

const _DEFAULT_BROWSER_BUDGET_MS = 30_000;
// A wedged browser.close()/context.close() must never hang teardown; bound each
// close attempt so teardown always reaches the SIGKILL fallback and returns.
const _CLOSE_BOUND_MS = 3_000;

/**
 * Whether the hard wall-clock guard on the whole browser pass is enabled
 * (default on). Gate off → byte-identical legacy behavior (teardown in finally
 * only, no outer race). Never throws.
 * @returns {boolean}
 */
function _hardTimeoutEnabled() {
  try {
    return require('./flagRegistry').isFlagEnabled('KHY_SEARCH_BROWSER_HARD_TIMEOUT', process.env);
  } catch {
    const raw = process.env.KHY_SEARCH_BROWSER_HARD_TIMEOUT;
    if (raw === undefined || raw === null || raw === '') return true;
    return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
  }
}

/**
 * Wall-clock budget for the entire browser pass (acquire → context → page →
 * goto → content → teardown). Must exceed the nav timeout with headroom, else
 * the outer guard would fire before a legitimately-slow-but-progressing goto
 * gets its own chance. env KHY_SEARCH_BROWSER_BUDGET_MS overrides.
 * @param {number} navTimeout
 * @returns {number}
 */
function _browserBudgetMs(navTimeout) {
  const raw = Number(process.env.KHY_SEARCH_BROWSER_BUDGET_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  const floor = Number.isFinite(navTimeout) && navTimeout > 0 ? navTimeout + 10_000 : _DEFAULT_BROWSER_BUDGET_MS;
  return Math.max(floor, _DEFAULT_BROWSER_BUDGET_MS);
}

/**
 * Heuristic: does this HTML look like a bot-challenge page (or empty shell)
 * rather than a real results page? Used by the caller to decide whether a
 * browser pass is worth attempting.
 * @param {string} html
 * @returns {boolean}
 */
function looksBotBlocked(html) {
  if (!html || html.length < 2000) return true; // suspiciously small = challenge/shell
  const lower = html.toLowerCase();
  return _BOT_BLOCK_MARKERS.some((m) => lower.includes(m.toLowerCase()));
}

/**
 * Current search mode. 'auto' (default) uses request-based scraping and only
 * falls back to a browser when empty; 'playwright' forces the browser path;
 * 'request' disables the browser entirely.
 * @returns {'request'|'auto'|'playwright'}
 */
function getSearchMode() {
  const m = String(process.env.KHY_SEARCH_MODE || 'auto').trim().toLowerCase();
  return (m === 'request' || m === 'playwright') ? m : 'auto';
}

/** True unless explicitly disabled via request mode. */
function isEnabled() {
  return getSearchMode() !== 'request';
}

/**
 * Await `p` but never longer than `ms` — a wedged close() resolves to a
 * timeout sentinel instead of hanging the caller. Never throws.
 * @param {Promise<any>} p
 * @param {number} ms
 */
function _bounded(p, ms) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve({ __closeTimedOut: true }); } }, ms);
    if (t && typeof t.unref === 'function') t.unref();
    Promise.resolve(p).then(
      (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } },
      () => { if (!done) { done = true; clearTimeout(t); resolve({ __closeError: true }); } },
    );
  });
}

/**
 * Fetch the fully rendered HTML of `url` using a headless browser.
 *
 * HARDENED: every step of the browser pass (launch → newContext → newPage →
 * goto → content) can wedge in a broken/half-installed Chromium, and the
 * teardown in `finally` never runs if an await is stuck — so a stuck pass would
 * freeze the whole search AND leak a zombie Chromium process, progressively.
 * With KHY_SEARCH_BROWSER_HARD_TIMEOUT on (default), the entire pass races a
 * hard wall-clock budget; on budget expiry we force-tear-down (close, then
 * SIGKILL the local process) and return a structured error instead of hanging.
 * Gate off → byte-identical legacy path (teardown in finally only).
 *
 * @param {string} url
 * @param {{waitForSelector?: string}} [opts]
 * @returns {Promise<{success:true, html:string} | {unavailable:true} | {success:false, error:string}>}
 */
async function fetchRenderedHtml(url, opts = {}) {
  const pw = engine.loadPlaywright();
  const chromium = pw && pw.chromium;
  if (!chromium) return { unavailable: true };

  const navTimeout = engine.navTimeoutMs();
  let browser = null;
  let isRemote = false;
  let context = null;
  let tornDown = false;

  // Idempotent, non-hanging teardown: close context + browser (each bounded so a
  // wedged close can never stall), and for a wedged LOCAL launch force-kill the
  // process so a stuck browser can never leak Chromium. Always reaches SIGKILL.
  const teardown = async () => {
    if (tornDown) return;
    tornDown = true;
    try { if (context) await _bounded(context.close(), _CLOSE_BOUND_MS); } catch { /* ignore */ }
    try { if (browser && typeof browser.close === 'function') await _bounded(browser.close(), _CLOSE_BOUND_MS); } catch { /* ignore */ }
    // Belt-and-suspenders: if the local browser process survived close(), kill it.
    try {
      if (browser && !isRemote && typeof browser.process === 'function') {
        const proc = browser.process();
        if (proc && typeof proc.kill === 'function' && proc.killed !== true) proc.kill('SIGKILL');
      }
    } catch { /* ignore */ }
  };

  const run = async () => {
    ({ browser, isRemote } = await engine.acquireBrowser(chromium));
    context = await browser.newContext({
      userAgent: UA,
      locale: 'zh-CN',
      viewport: { width: 1280, height: 800 },
    });
    // Belt for every default-timeout-honoring op inside this context.
    try { if (typeof context.setDefaultTimeout === 'function') context.setDefaultTimeout(navTimeout); } catch { /* ignore */ }
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout });
    if (opts.waitForSelector) {
      // Best-effort: results may already be present; don't fail the whole pass
      // just because the selector wait timed out.
      try { await page.waitForSelector(opts.waitForSelector, { timeout: Math.min(navTimeout, 8000) }); }
      catch { /* fall through and grab whatever rendered */ }
    }
    const html = await page.content();
    return { success: true, html };
  };

  // Gate off → legacy path: run with the original teardown-in-finally only
  // (byte-identical to the pre-hardening behavior: unbounded close, no kill).
  if (!_hardTimeoutEnabled()) {
    try {
      return await run();
    } catch (err) {
      return { success: false, error: `Playwright fetch failed: ${err && err.message ? err.message : err}` };
    } finally {
      try { if (context) await context.close(); } catch { /* ignore */ }
      try { if (browser && typeof browser.close === 'function') await browser.close(); } catch { /* ignore */ }
    }
  }

  // Hardened path: race the whole pass against a hard wall-clock budget. On
  // budget expiry, return a structured error; the finally block's bounded
  // teardown then reaps the wedged browser (SIGKILL) — never an infinite hang.
  const budgetMs = _browserBudgetMs(navTimeout);
  let timer = null;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __budgetExceeded: true }), budgetMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });

  try {
    const outcome = await Promise.race([
      run().then((r) => r, (err) => ({ __runError: err })),
      timeoutPromise,
    ]);
    if (outcome && outcome.__budgetExceeded) {
      return {
        success: false,
        error: `Playwright fetch exceeded ${budgetMs}ms hard budget; browser pass aborted`,
      };
    }
    if (outcome && outcome.__runError) {
      const err = outcome.__runError;
      return { success: false, error: `Playwright fetch failed: ${err && err.message ? err.message : err}` };
    }
    return outcome;
  } finally {
    if (timer) { try { clearTimeout(timer); } catch { /* ignore */ } }
    // Bounded + idempotent: reaps the browser (force-kill if wedged) before we
    // return, so a stuck pass can neither hang the search nor leak Chromium.
    await teardown();
  }
}

module.exports = {
  getSearchMode,
  isEnabled,
  looksBotBlocked,
  fetchRenderedHtml,
  // test hook — forwards to the shared engine's loader cache.
  __setPlaywrightModuleForTests(mod) { engine.__setPlaywrightModuleForTests(mod); },
};
