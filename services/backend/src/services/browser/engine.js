'use strict';

/**
 * browser/engine.js — single source of truth for acquiring a Playwright browser.
 *
 * Extracted verbatim (behavior-preserving) from playwrightSearch.js so that BOTH
 * the search fallback (render-to-HTML) and the interactive WebBrowser tool share
 * ONE Playwright loader, ONE remote/local acquisition policy, and ONE proxy
 * resolution path. No duplicate Chromium-launch logic.
 *
 * Design constraints (inherited):
 *  - OPTIONAL: playwright is not a hard dependency. If neither `playwright` nor
 *    `playwright-core` is installed, loadPlaywright() returns null and callers
 *    degrade gracefully. Requiring this module never throws.
 *  - REMOTE-FRIENDLY: connect to an existing browser via WS/CDP endpoint so the
 *    host need not bundle Chromium.
 *
 * Env knobs:
 *  - KHY_PLAYWRIGHT_WS_ENDPOINT     = ws://...    connect() to a remote browser
 *  - KHY_PLAYWRIGHT_CDP_ENDPOINT    = http://...  connectOverCDP() to a browser
 *  - KHY_PLAYWRIGHT_HEADLESS        = 'false' to show the window (default headless)
 *  - KHY_PLAYWRIGHT_NAV_TIMEOUT_MS  = navigation timeout (default 20000)
 *  - KHY_PLAYWRIGHT_LAUNCH_TIMEOUT_MS = local Chromium launch timeout (default 15000)
 */

const DEFAULT_NAV_TIMEOUT_MS = 20_000;
const DEFAULT_LAUNCH_TIMEOUT_MS = 15_000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Lazily resolve a Playwright module. Cached across calls. `null` if absent.
let _pwModule = null; // resolved module or false (tried, missing)

/** Resolve the Playwright module (playwright → playwright-core), cached. */
function loadPlaywright() {
  if (_pwModule && _pwModule.chromium) return _pwModule; // already loaded
  for (const name of ['playwright', 'playwright-core']) {
    try {
      // eslint-disable-next-line import/no-dynamic-require, global-require
      const mod = require(name);
      if (mod && mod.chromium) { _pwModule = mod; return mod; }
    } catch { /* not installed — try next */ }
  }
  // Missing state is not permanently latched: a later require (after a mid-session
  // self-heal install of playwright) can still pick the module up.
  _pwModule = false;
  return null;
}

/** Navigation/connection timeout, env-tunable. */
function navTimeoutMs() {
  return Number(process.env.KHY_PLAYWRIGHT_NAV_TIMEOUT_MS) || DEFAULT_NAV_TIMEOUT_MS;
}

/** Local Chromium launch timeout, env-tunable. Bounds a broken/half-installed
 *  Chromium so `chromium.launch()` rejects (instead of hanging) when the browser
 *  binary can't start. */
function launchTimeoutMs() {
  const v = Number(process.env.KHY_PLAYWRIGHT_LAUNCH_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_LAUNCH_TIMEOUT_MS;
}

/** Whether the search-browser hard-timeout hardening is enabled (default on).
 *  Gate off → byte-identical legacy behavior (no explicit launch timeout →
 *  Playwright's built-in 30s default). */
function _hardTimeoutEnabled() {
  try {
    return require('../flagRegistry').isFlagEnabled('KHY_SEARCH_BROWSER_HARD_TIMEOUT', process.env);
  } catch {
    const raw = process.env.KHY_SEARCH_BROWSER_HARD_TIMEOUT;
    if (raw === undefined || raw === null || raw === '') return true;
    return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
  }
}

/** Resolve an active proxy server string for the browser, if configured. */
function getProxyServer() {
  try {
    const pcs = require('../proxyConfigService');
    const active = pcs.getActiveProxy ? pcs.getActiveProxy() : null;
    if (active) {
      if (typeof active === 'string') return active;
      if (active.url) return active.url;
    }
  } catch { /* ignore */ }
  return process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy || null;
}

/**
 * Acquire a browser instance: connect to a remote endpoint if configured,
 * otherwise launch a local headless Chromium. Returns { browser, isRemote }.
 * @param {object} chromium - the resolved `playwright.chromium` namespace.
 */
async function acquireBrowser(chromium) {
  const wsEndpoint = process.env.KHY_PLAYWRIGHT_WS_ENDPOINT;
  const cdpEndpoint = process.env.KHY_PLAYWRIGHT_CDP_ENDPOINT;
  const navTimeout = navTimeoutMs();

  if (wsEndpoint) {
    const browser = await chromium.connect({ wsEndpoint, timeout: Math.max(navTimeout, 30_000) });
    return { browser, isRemote: true };
  }
  if (cdpEndpoint) {
    const browser = await chromium.connectOverCDP(cdpEndpoint, { timeout: Math.max(navTimeout, 30_000) });
    return { browser, isRemote: true };
  }
  const headless = process.env.KHY_PLAYWRIGHT_HEADLESS !== 'false';
  const proxyServer = getProxyServer();
  const launchOpts = { headless, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (proxyServer) launchOpts.proxy = { server: proxyServer };
  // Bound the launch so a broken/half-installed Chromium rejects instead of
  // hanging. Gate off → byte-identical legacy behavior (Playwright's built-in
  // 30s default applies, no explicit timeout key).
  if (_hardTimeoutEnabled()) launchOpts.timeout = launchTimeoutMs();
  const browser = await chromium.launch(launchOpts);
  return { browser, isRemote: false };
}

module.exports = {
  DEFAULT_NAV_TIMEOUT_MS,
  DEFAULT_LAUNCH_TIMEOUT_MS,
  UA,
  loadPlaywright,
  navTimeoutMs,
  launchTimeoutMs,
  getProxyServer,
  acquireBrowser,
  // test hook — inject a fake chromium module.
  __setPlaywrightModuleForTests(mod) { _pwModule = mod == null ? null : mod; },
};
