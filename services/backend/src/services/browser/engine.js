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
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Lazily resolve a Playwright module. Cached across calls. `null` if absent.
let _pwModule = null; // resolved module or false (tried, missing)
let _pwModuleOverride; // undefined = autodetect; any other value is a test override

// 可选浏览器能力的候选包，按优先级排列。真源就是这里：
// services/backend/package.json 把这两个名字声明为 peerDependenciesMeta.optional
// （「能被 require 的东西必须有名字」，但有名字不等于要装 —— .npmrc 的
// auto-install-peers=false 保证默认一个字节都不装）。加减包时同步改那边。
const PLAYWRIGHT_CANDIDATES = Object.freeze(['playwright', 'playwright-core']);

// 缺依赖提示每进程只打一次：loadPlaywright() 在每次搜索/每个浏览器原子操作前都会被
// 调用，逐次打印会把降级提示变成刷屏噪音，而刷屏的提示等于没有提示。
let _pwHintShown = false;

/**
 * 未装浏览器依赖时打印一次中文、可照做的启用提示。
 *
 * 两条路径都给出来，因为代价差三个数量级：本地浏览器要下载约 700 MB，而 engine.js
 * 本来就支持连远端浏览器（WS/CDP），那条路只需要 playwright-core，不下载任何浏览器。
 * 不写清体积就等于替使用者做了一个几百 MB 的决定。
 */
function _warnPlaywrightMissing() {
  if (_pwHintShown) return;
  _pwHintShown = true;
  try {
    const total = PLAYWRIGHT_CANDIDATES.length;
    console.warn(
      `[browser] 加载浏览器渲染依赖失败（${total} 个候选包 0 个就位：` +
        `${PLAYWRIGHT_CANDIDATES.join(' / ')}）；本次以「仅 HTTP 请求」模式继续，其余功能不受影响。`
    );
    console.warn(
      '[browser] 需要本地浏览器：npm install --no-save playwright && npx playwright install chromium' +
        '（会另外下载约 700 MB 浏览器到用户缓存目录，请先确认磁盘与网络）。'
    );
    console.warn(
      '[browser] 已有远端浏览器：npm install --no-save playwright-core，' +
        '并设置 KHY_PLAYWRIGHT_WS_ENDPOINT 或 KHY_PLAYWRIGHT_CDP_ENDPOINT —— 不下载浏览器。'
    );
  } catch {
    /* 提示打不出来也绝不能影响降级路径本身 */
  }
}

/** Resolve the Playwright module (playwright → playwright-core), cached. */
function loadPlaywright() {
  if (_pwModuleOverride !== undefined) {
    return _pwModuleOverride;
  }
  if (_pwModule && _pwModule.chromium) {
    return _pwModule;
  } // already loaded
  for (const name of PLAYWRIGHT_CANDIDATES) {
    try {
      const mod = require(name);
      if (mod && mod.chromium) {
        _pwModule = mod;
        return mod;
      }
    } catch {
      /* not installed — try next */
    }
  }
  _warnPlaywrightMissing();
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
    if (raw === undefined || raw === null || raw === '') {
      return true;
    }
    return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
  }
}

/** Resolve an active proxy server string for the browser, if configured. */
function getProxyServer() {
  try {
    const pcs = require('../proxyConfigService');
    const active = pcs.getActiveProxy ? pcs.getActiveProxy() : null;
    if (active) {
      if (typeof active === 'string') {
        return active;
      }
      if (active.url) {
        return active.url;
      }
    }
  } catch {
    /* ignore */
  }
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    null
  );
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
    const browser = await chromium.connectOverCDP(cdpEndpoint, {
      timeout: Math.max(navTimeout, 30_000),
    });
    return { browser, isRemote: true };
  }
  const headless = process.env.KHY_PLAYWRIGHT_HEADLESS !== 'false';
  const proxyServer = getProxyServer();
  const launchOpts = { headless, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (proxyServer) {
    launchOpts.proxy = { server: proxyServer };
  }
  // Bound the launch so a broken/half-installed Chromium rejects instead of
  // hanging. Gate off → byte-identical legacy behavior (Playwright's built-in
  // 30s default applies, no explicit timeout key).
  if (_hardTimeoutEnabled()) {
    launchOpts.timeout = launchTimeoutMs();
  }
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
  // test hook — inject a fake module; null simulates absence; undefined restores autodetect.
  __setPlaywrightModuleForTests(mod) {
    _pwModuleOverride = mod;
  },
};
