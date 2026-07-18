'use strict';

/**
 * browser/session.js — process-wide PERSISTENT Playwright session: the single
 * source of truth for interactive headless browsing (the WebBrowser tool drives
 * it). Unlike playwrightSearch (open → render one URL → close), this keeps ONE
 * browser + ONE context alive across tool calls so multi-step flows (login →
 * navigate → fill → click → screenshot) share cookies and DOM state.
 *
 * Design (mirrors the memory-leak governance constraints):
 *  - LAZY: nothing launches until the first atomic op. loadPlaywright() absent →
 *    every op returns { unavailable: true } and never throws.
 *  - SINGLE BROWSER: one browser, one context, an ordered list of pages (tabs);
 *    activeIndex selects the page atomic ops act on.
 *  - LOGIN REUSE: the context is seeded from a persisted storageState file
 *    (KHY_BROWSER_STORAGE_STATE or <dataHome>/browser/storageState.json) and the
 *    state is written back on teardown, so cookies/localStorage survive restarts.
 *  - SELF-CLOSING: an idle TTL timer (.unref()) tears the session down after
 *    inactivity, and process exit hooks guarantee the browser process is closed
 *    (no handle leak). Teardown always persists storageState first.
 *
 * Env knobs (browser launch/connect knobs live in browser/engine.js):
 *  - KHY_BROWSER_STORAGE_STATE   explicit storageState file path (login reuse)
 *  - KHY_BROWSER_IDLE_TTL_MS     idle teardown delay (default 300000 = 5 min)
 *  - KHY_BROWSER_PERSIST_STATE   '0' to disable storageState persistence
 */

const fs = require('fs');
const path = require('path');
const engine = require('./engine');
const scrollPlan = require('./scrollPlan');
const ariaSnapshot = require('./ariaSnapshot');
const _evalTimeout = require('./_evalTimeout');
const { UA } = engine;

const DEFAULT_IDLE_TTL_MS = 300_000;

// ── module-level singleton state ──────────────────────────────────────────
let _browser = null;
let _context = null;
let _isRemote = false;
let _pages = [];          // ordered tabs
let _activeIndex = 0;
let _idleTimer = null;
let _exitHooksInstalled = false;
let _launching = null;     // in-flight launch promise (coalesce concurrent ops)

/** Resolve the storageState file path (login reuse), or null if disabled. */
function _storageStatePath() {
  if (String(process.env.KHY_BROWSER_PERSIST_STATE || '') === '0') return null;
  const explicit = process.env.KHY_BROWSER_STORAGE_STATE;
  if (explicit) return path.resolve(explicit);
  try {
    const { getDataDir } = require('../../utils/dataHome');
    return path.join(getDataDir('browser'), 'storageState.json');
  } catch {
    return null;
  }
}

function _idleTtlMs() {
  const n = Number(process.env.KHY_BROWSER_IDLE_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_IDLE_TTL_MS;
}

/** Re-arm the idle teardown timer on every activity. */
function _touch() {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => { closeSession().catch(() => {}); }, _idleTtlMs());
  if (typeof _idleTimer.unref === 'function') _idleTimer.unref();
}

function _installExitHooks() {
  if (_exitHooksInstalled) return;
  _exitHooksInstalled = true;
  const bye = () => { try { _hardClose(); } catch { /* ignore */ } };
  process.once('exit', bye);
  process.once('SIGINT', () => { bye(); process.exit(130); });
  process.once('SIGTERM', () => { bye(); process.exit(143); });
}

/** Best-effort synchronous-ish close for exit hooks (fire-and-forget). */
function _hardClose() {
  const b = _browser;
  _browser = null; _context = null; _pages = []; _activeIndex = 0;
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  if (b && typeof b.close === 'function') { try { b.close(); } catch { /* ignore */ } }
}

/** Persist the context's storageState (cookies + localStorage) for login reuse. */
async function _persistState() {
  const sp = _storageStatePath();
  if (!sp || !_context || typeof _context.storageState !== 'function') return;
  try {
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    await _context.storageState({ path: sp });
  } catch { /* non-fatal: a failed save just forfeits this run's login reuse */ }
}

/**
 * Ensure the singleton browser + context + at least one page exist. Returns the
 * active page, or null when Playwright is unavailable. Concurrent callers share
 * one in-flight launch.
 */
async function _ensurePage() {
  if (_browser && _pages.length) { _touch(); return _pages[_activeIndex] || _pages[0]; }
  if (_launching) { await _launching; _touch(); return _pages[_activeIndex] || _pages[0] || null; }

  _launching = (async () => {
    const pw = engine.loadPlaywright();
    const chromium = pw && pw.chromium;
    if (!chromium) return null;
    _installExitHooks();

    ({ browser: _browser, isRemote: _isRemote } = await engine.acquireBrowser(chromium));

    const ctxOpts = { userAgent: UA, locale: 'zh-CN', viewport: { width: 1280, height: 800 } };
    const sp = _storageStatePath();
    if (sp) { try { if (fs.existsSync(sp)) ctxOpts.storageState = sp; } catch { /* ignore */ } }
    _context = await _browser.newContext(ctxOpts);

    const page = await _context.newPage();
    _pages = [page];
    _activeIndex = 0;
    return page;
  })();

  try {
    const page = await _launching;
    if (page) _touch();
    return page;
  } finally {
    _launching = null;
  }
}

const UNAVAILABLE = { unavailable: true, error: 'Playwright not installed (browser session unavailable).' };
const _navTimeout = () => engine.navTimeoutMs();

// ── atomic operations ───────────────────────────────────────────────────────
// Each returns a plain serializable result. Failures are returned, not thrown,
// so the tool layer can surface honest structured errors.

async function navigate(url, opts = {}) {
  const page = await _ensurePage();
  if (!page) return UNAVAILABLE;
  const timeout = opts.timeoutMs || _navTimeout();
  await page.goto(url, { waitUntil: opts.waitUntil || 'domcontentloaded', timeout });
  if (opts.waitForSelector) {
    try { await page.waitForSelector(opts.waitForSelector, { timeout: Math.min(timeout, 8000) }); }
    catch { /* best-effort */ }
  }
  return { success: true, url: page.url(), title: await page.title().catch(() => '') };
}

async function click(selector, opts = {}) {
  const page = await _ensurePage();
  if (!page) return UNAVAILABLE;
  await page.click(selector, { timeout: opts.timeoutMs || _navTimeout() });
  return { success: true, clicked: selector };
}

async function fill(selector, value, opts = {}) {
  const page = await _ensurePage();
  if (!page) return UNAVAILABLE;
  await page.fill(selector, String(value == null ? '' : value), { timeout: opts.timeoutMs || _navTimeout() });
  return { success: true, filled: selector };
}

async function type(selector, text, opts = {}) {
  const page = await _ensurePage();
  if (!page) return UNAVAILABLE;
  await page.type(selector, String(text == null ? '' : text), {
    delay: opts.delay || 0,
    timeout: opts.timeoutMs || _navTimeout(),
  });
  return { success: true, typed: selector };
}

async function screenshot(opts = {}) {
  const page = await _ensurePage();
  if (!page) return UNAVAILABLE;
  let outPath = opts.path;
  if (!outPath) {
    try {
      const { getDataDir } = require('../../utils/dataHome');
      const stamp = `${Date.now()}-${Math.floor(process.hrtime()[1] % 1e6)}`;
      outPath = path.join(getDataDir('browser', 'screenshots'), `shot-${stamp}.png`);
    } catch { outPath = null; }
  }
  const shotOpts = { fullPage: !!opts.fullPage };
  const target = opts.selector ? await page.$(opts.selector) : page;
  if (opts.selector && !target) return { success: false, error: `selector not found: ${opts.selector}` };
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await target.screenshot({ ...shotOpts, path: outPath });
    return { success: true, path: outPath };
  }
  const buf = await target.screenshot(shotOpts);
  return { success: true, base64: Buffer.from(buf).toString('base64') };
}

async function getText(selector, opts = {}) {
  const page = await _ensurePage();
  if (!page) return UNAVAILABLE;
  if (selector) {
    const el = await page.$(selector);
    if (!el) return { success: false, error: `selector not found: ${selector}` };
    return { success: true, text: await el.innerText() };
  }
  const text = await page.evaluate(() => document.body && document.body.innerText || '');
  return { success: true, text };
}

async function getContent() {
  const page = await _ensurePage();
  if (!page) return UNAVAILABLE;
  return { success: true, html: await page.content(), url: page.url() };
}

/**
 * 从 _pages 中丢弃一个被顶死(或已关)的标签页并强制 close 它,修正 _activeIndex。
 * 关键:被求值脚本顶死的是**渲染线程**,无法从 Node 侧中断;唯一可靠解法是 page.close()——它经
 * 浏览器进程(CDP)驱动,独立于那条被占满的渲染线程。close 也可能因页面顶死而挂,故 best-effort
 * 且不 await 其完成(fire-and-forget + catch),绝不让清理本身再把事件循环拖住。
 */
function _dropPage(page) {
  const i = _pages.indexOf(page);
  if (i >= 0) {
    _pages.splice(i, 1);
    // 修正 activeIndex:落在被删页之后的索引左移一位;越界则钳到最后一个有效页(或 0)。
    if (_activeIndex > i) _activeIndex -= 1;
    if (_activeIndex >= _pages.length) _activeIndex = Math.max(0, _pages.length - 1);
  }
  try {
    const p = page && typeof page.close === 'function'
      ? page.close({ runBeforeUnload: false })
      : null;
    if (p && typeof p.then === 'function') p.then(() => {}, () => {});
  } catch { /* ignore */ }
}

async function evaluate(script, opts = {}) {
  const page = await _ensurePage();
  if (!page) return UNAVAILABLE;
  // Runs in the PAGE context (like the DevTools console), not the Node process —
  // it cannot touch the host filesystem/env. Still page-trusted JS; the tool
  // layer gates this behind the normal tool-risk approval.
  const evalP = page.evaluate((src) => {
    // eslint-disable-next-line no-eval
    return eval(src);
  }, String(script));

  // 门控关 → 字节回退今日行为(直接 await,无墙钟)。
  if (!_evalTimeout.isEvalTimeoutEnabled(process.env)) {
    const result = await evalP;
    return { success: true, result };
  }

  // 门控开 → 墙钟竞赛。page.evaluate 无 timeout 选项,含死循环的脚本会顶死渲染线程使其永不 resolve;
  // 超时则 page.close() 强杀该标签页(经浏览器进程,独立于被顶死的渲染线程),把页从 _pages 丢掉。
  // 被丢弃的 evalP 之后会以「Target closed」reject,须 .catch 吞掉以免 unhandled rejection。
  const ms = _evalTimeout.resolveEvalTimeoutMs(process.env);
  let timer = null;
  const timeoutP = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __evalTimedOut: true }), ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  try {
    const raced = await Promise.race([
      evalP.then((result) => ({ __evalResult: result })),
      timeoutP,
    ]);
    if (raced && raced.__evalTimedOut) {
      evalP.catch(() => {}); // 丢弃的 promise 会因 close reject;吞掉。
      _dropPage(page);
      const msg = `页内脚本执行超时(${ms}ms),已强制关闭该标签页(疑似死循环/忙等)。`;
      return { success: false, error: msg, code: 'TIMEOUT', timedOut: true };
    }
    return { success: true, result: raced.__evalResult };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitFor(opts = {}) {
  const page = await _ensurePage();
  if (!page) return UNAVAILABLE;
  if (opts.selector) {
    await page.waitForSelector(opts.selector, { timeout: opts.timeoutMs || _navTimeout() });
    return { success: true, waited: opts.selector };
  }
  const ms = Math.max(0, Number(opts.timeoutMs) || 0);
  await page.waitForTimeout(ms);
  return { success: true, waitedMs: ms };
}

async function scroll(opts = {}) {
  const page = await _ensurePage();
  if (!page) return UNAVAILABLE;
  await page.evaluate((o) => {
    if (o.selector) {
      const el = document.querySelector(o.selector);
      if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'instant', block: 'center' });
      return;
    }
    if (o.toBottom) { window.scrollTo(0, document.body.scrollHeight); return; }
    window.scrollBy(o.x || 0, o.y || 0);
  }, { selector: opts.selector || null, toBottom: !!opts.toBottom, x: opts.x || 0, y: opts.y || 0 });
  return { success: true };
}

/**
 * 强力爬虫核心：把页面**完整滚动到底**（触发懒加载 / 无限滚动），并支持**虚拟滚动**
 * 的增量文本采集（DOM 回收时同一项反复出现 → 经 scrollPlan.mergeHarvest 去重）。
 *
 * 所有「何时停 / 如何去重 / 配置夹取」的判断都在纯叶子 scrollPlan.js；本函数只负责
 * page.evaluate 的滚动与文本读取这类 IO。门控 KHY_BROWSER_AUTOSCROLL 关 → 字节回退
 * 到单次「滚到底」。
 *
 * @param {Object} [opts]  maxPasses / settleMs / stableRounds / maxChars / stepRatio /
 *                         harvest(bool) / harvestSelector / toSelector
 * @returns {Object}  { success, autoScroll, passes, finalHeight, stopReason,
 *                      [text, harvestedChars, lines, truncated] }
 */
async function autoScroll(opts = {}) {
  const page = await _ensurePage();
  if (!page) return UNAVAILABLE;

  // 门控关：字节回退到一次性滚到底（不做循环 / 不采集）。
  if (!scrollPlan.isEnabled(process.env)) {
    await page.evaluate(() => {
      const se = document.scrollingElement || document.documentElement || document.body;
      window.scrollTo(0, se ? se.scrollHeight : 0);
    });
    return { success: true, autoScroll: false, reason: 'disabled' };
  }

  const cfg = scrollPlan.normalizeScrollConfig(opts, process.env);
  let prevHeight = NaN;
  let stagnantStreak = 0;
  let harvestState = scrollPlan.newHarvestState();
  let stopReason = 'max-passes';
  let pass = 0;

  for (pass = 1; pass <= cfg.maxPasses; pass++) {
    // 一次滚动 + 探测：滚一屏、读 scrollHeight、（可选）读 innerText、（可选）查目标是否出现。
    const probe = await page.evaluate((c) => {
      const se = document.scrollingElement || document.documentElement || document.body;
      window.scrollBy(0, Math.round((window.innerHeight || 800) * c.stepRatio));
      const height = se ? se.scrollHeight : 0;
      let text = '';
      if (c.harvest) {
        const root = c.harvestSelector ? document.querySelector(c.harvestSelector) : document.body;
        text = root ? (root.innerText || '') : '';
      }
      let targetFound = false;
      if (c.toSelector) targetFound = !!document.querySelector(c.toSelector);
      return { height, text, targetFound };
    }, { stepRatio: cfg.stepRatio, harvest: cfg.harvest, harvestSelector: cfg.harvestSelector, toSelector: cfg.toSelector });

    if (cfg.settleMs > 0) await page.waitForTimeout(cfg.settleMs);

    if (cfg.harvest) harvestState = scrollPlan.mergeHarvest(harvestState, probe.text || '', cfg.maxChars);
    stagnantStreak = scrollPlan.nextStagnant(stagnantStreak, prevHeight, probe.height);
    prevHeight = probe.height;

    // 指定了 toSelector 且已出现 → 提前停。
    if (cfg.toSelector && probe.targetFound) { stopReason = 'target-found'; break; }

    const d = scrollPlan.decideContinue({
      pass,
      maxPasses: cfg.maxPasses,
      stagnantStreak,
      stableRounds: cfg.stableRounds,
      harvestedChars: harvestState.chars,
      maxChars: cfg.maxChars,
    });
    if (!d.cont) { stopReason = d.reason; break; }
  }

  const passes = pass > cfg.maxPasses ? cfg.maxPasses : pass;
  const result = {
    success: true,
    autoScroll: true,
    passes,
    finalHeight: Number.isFinite(prevHeight) ? prevHeight : 0,
    stopReason,
  };
  if (cfg.harvest) {
    result.text = harvestState.text;
    result.harvestedChars = harvestState.chars;
    result.lines = harvestState.lines;
    result.truncated = harvestState.truncated;
  }
  return result;
}

/**
 * 在当前页内**跳转到对应索引**：第 N 项 / 锚点(#id, a[name]) / 含文本的元素 / 任意 CSS 选择器。
 * 目标归一由纯叶子 scrollPlan.resolveIndexTarget 完成；本函数只在页内 scrollIntoView。
 *
 * @param {Object} [opts]  anchor / hash / index(+itemSelector) / text(+selector) / selector
 * @returns {Object}  { success, mode, matched, [snippet, total, index] }
 */
async function jumpToIndex(opts = {}) {
  const page = await _ensurePage();
  if (!page) return UNAVAILABLE;

  const target = scrollPlan.resolveIndexTarget(opts);
  if (target.mode === 'none') {
    return { success: false, error: 'jumpToIndex requires one of: anchor/hash, index(+itemSelector), text, or selector' };
  }

  const r = await page.evaluate((t) => {
    const snip = (el) => ((el && (el.innerText || el.textContent)) || '').trim().slice(0, 200);
    let el = null;
    if (t.mode === 'anchor') {
      el = document.getElementById(t.value)
        || document.querySelector('a[name="' + t.value + '"]')
        || document.querySelector('#' + t.value);
    } else if (t.mode === 'index') {
      let list = [];
      try { list = document.querySelectorAll(t.itemSelector); } catch { list = []; }
      el = list[t.index] || null;
      if (!el) return { matched: false, total: list.length };
      el.scrollIntoView({ behavior: 'instant', block: 'center' });
      return { matched: true, total: list.length, index: t.index, snippet: snip(el) };
    } else if (t.mode === 'text') {
      let scope = [];
      try {
        scope = t.selector ? document.querySelectorAll(t.selector)
          : document.querySelectorAll('h1,h2,h3,h4,h5,h6,a,[id],li,p');
      } catch { scope = []; }
      for (const node of scope) {
        if (((node.innerText || node.textContent) || '').includes(t.text)) { el = node; break; }
      }
    } else if (t.mode === 'selector') {
      try { el = document.querySelector(t.selector); } catch { el = null; }
    }
    if (!el) return { matched: false };
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    return { matched: true, snippet: snip(el) };
  }, target);

  return { success: true, mode: target.mode, ...r };
}

async function selectOption(selector, value, opts = {}) {
  const page = await _ensurePage();
  if (!page) return UNAVAILABLE;
  const selected = await page.selectOption(selector, value, { timeout: opts.timeoutMs || _navTimeout() });
  return { success: true, selected };
}

// ── Playwright「agent-first」范式:可访问性快照 + ref 句柄 + locator-first + 自动等待 ──
// 让 agent 不靠截图、不靠脆弱选择器,而把页面读成可读的可访问性树(每个可交互元素带稳定
// ref),再按 ref 或语义化 getByRole/getByText 行动,行动前自动等待可操作。所有确定性判断
// (排版/locator 映射/可操作/ref→选择器注入防护)都在纯叶子 ariaSnapshot.js。

/**
 * snapshotForAI — 给 AI 看的页面**可访问性树**:在页内遍历 DOM 计算每个可交互/标题元素的
 * role + 可访问名,给它打上 `data-khy-ref="eN"`(供随后 actByRef 按 ref 行动),再经纯叶子
 * 序列化成 `- textbox "搜索" [ref=e5]` 这样的文本。
 *
 * 门控 KHY_BROWSER_ARIA 关 → 降级为纯 innerText 转储(honest degradation,绝不崩)。
 *
 * @param {Object} [opts]  max(节点上界) / interactiveOnly(默认 true:只收可交互+标题)
 * @returns {Object}  { success, aria, snapshot, count, url, title }
 */
async function snapshotForAI(opts = {}) {
  const page = await _ensurePage();
  if (!page) return UNAVAILABLE;

  // 门控关:降级为纯文本(不打 ref、不建树)。
  if (!ariaSnapshot.isEnabled(process.env)) {
    const text = await page.evaluate(() => (document.body && document.body.innerText) || '');
    return { success: true, aria: false, snapshot: text, count: 0, url: page.url() };
  }

  const max = ariaSnapshot.clampMax(opts.max);
  const interactiveOnly = opts.interactiveOnly !== false;

  // 页内遍历:算 role/name、打 data-khy-ref、收集节点(纯 IO,所有"怎么排版"的判断在叶子)。
  const nodes = await page.evaluate(({ max: cap, interactiveOnly: io }) => {
    const INTERACTIVE = new Set(['link', 'button', 'textbox', 'checkbox', 'radio',
      'combobox', 'slider', 'tab', 'menuitem', 'menuitemcheckbox', 'option', 'switch', 'searchbox']);
    const HEADING = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

    function roleOf(el) {
      const explicit = (el.getAttribute('role') || '').trim().toLowerCase();
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (HEADING[tag]) return 'heading';
      const type = (el.getAttribute('type') || '').toLowerCase();
      switch (tag) {
        case 'a': return el.hasAttribute('href') ? 'link' : '';
        case 'button': return 'button';
        case 'select': return 'combobox';
        case 'textarea': return 'textbox';
        case 'nav': return 'navigation';
        case 'main': return 'main';
        case 'img': return el.getAttribute('alt') != null ? 'img' : '';
        case 'input':
          if (type === 'hidden') return '';
          if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
          if (type === 'checkbox') return 'checkbox';
          if (type === 'radio') return 'radio';
          if (type === 'range') return 'slider';
          if (type === 'search') return 'searchbox';
          return 'textbox';
        default: return '';
      }
    }
    function nameOf(el) {
      const al = (el.getAttribute('aria-label') || '').trim();
      if (al) return al;
      const lb = el.getAttribute('aria-labelledby');
      if (lb) {
        let t = '';
        lb.split(/\s+/).forEach((id) => { const n = document.getElementById(id); if (n) t += ' ' + (n.textContent || ''); });
        t = t.trim();
        if (t) return t;
      }
      if (el.id) {
        try {
          const esc = (window.CSS && CSS.escape) ? CSS.escape(el.id) : el.id;
          const lab = document.querySelector('label[for="' + esc + '"]');
          if (lab) { const t = (lab.textContent || '').trim(); if (t) return t; }
        } catch (e) { /* ignore */ }
      }
      const ph = (el.getAttribute('placeholder') || '').trim();
      if (ph) return ph;
      const alt = (el.getAttribute('alt') || '').trim();
      if (alt) return alt;
      const title = (el.getAttribute('title') || '').trim();
      if (title) return title;
      return ((el.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, 120);
    }
    function visible(el) {
      const st = window.getComputedStyle(el);
      if (!st || st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }

    const out = [];
    let counter = 0;
    function walk(el, depth) {
      if (out.length >= cap) return;
      let nextDepth = depth;
      const role = roleOf(el);
      const emit = !!role && (!io || INTERACTIVE.has(role) || role === 'heading');
      if (emit && visible(el)) {
        const ref = 'e' + (++counter);
        el.setAttribute('data-khy-ref', ref);
        const node = { depth, role, name: nameOf(el), ref };
        const tag = el.tagName.toLowerCase();
        if (HEADING[tag]) node.level = HEADING[tag];
        const lvl = Number(el.getAttribute('aria-level'));
        if (Number.isFinite(lvl) && lvl > 0) node.level = lvl;
        if (role === 'checkbox' || role === 'radio' || role === 'switch') {
          node.checked = el.getAttribute('aria-checked') === 'mixed'
            ? 'mixed'
            : (el.getAttribute('aria-checked') === 'true' || el.checked === true);
        }
        if (el.getAttribute('aria-selected') === 'true') node.selected = true;
        if (el.getAttribute('aria-expanded') === 'true') node.expanded = true;
        if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') node.disabled = true;
        out.push(node);
        nextDepth = depth + 1;
      }
      const kids = el.children || [];
      for (let i = 0; i < kids.length; i++) walk(kids[i], nextDepth);
    }
    if (document.body) walk(document.body, 0);
    return out;
  }, { max, interactiveOnly });

  const snapshot = ariaSnapshot.serializeAriaTree(nodes);
  return {
    success: true, aria: true, snapshot,
    count: Array.isArray(nodes) ? nodes.length : 0,
    url: page.url(), title: await page.title().catch(() => ''),
  };
}

/**
 * actByRef — 按上一次 snapshotForAI 发出的 **ref** 行动。ref→选择器经纯叶子做注入防护
 * (只接受 e<数字>),行动前自动等待元素**可见**(Playwright auto-wait 的显式化)。
 *
 * @param {Object} opts  ref(必填,形如 e5) / action(click|fill|type|check|text,默认 click)
 *                       / value / timeoutMs
 */
async function actByRef(opts = {}) {
  const page = await _ensurePage();
  if (!page) return UNAVAILABLE;
  const sel = ariaSnapshot.refSelector(opts.ref);
  if (!sel) return { success: false, error: `invalid ref: ${opts.ref == null ? '' : opts.ref}` };

  const action = ariaSnapshot.REF_ACTIONS.includes(opts.action) ? opts.action : 'click';
  const timeout = opts.timeoutMs || _navTimeout();

  // 自动等待可操作:先等元素可见,等不到则诚实回报"不可操作"而非盲目点击。
  try {
    await page.waitForSelector(sel, { state: 'visible', timeout });
  } catch {
    return { success: false, ref: opts.ref, error: `ref not actionable (not visible): ${opts.ref}` };
  }

  switch (action) {
    case 'click': await page.click(sel, { timeout }); return { success: true, ref: opts.ref, did: 'click' };
    case 'fill': await page.fill(sel, String(opts.value == null ? '' : opts.value), { timeout }); return { success: true, ref: opts.ref, did: 'fill' };
    case 'type': await page.type(sel, String(opts.value == null ? '' : opts.value), { timeout }); return { success: true, ref: opts.ref, did: 'type' };
    case 'check': await page.check(sel, { timeout }); return { success: true, ref: opts.ref, did: 'check' };
    case 'text': {
      const el = await page.$(sel);
      return { success: true, ref: opts.ref, text: el ? await el.innerText() : '' };
    }
    default: return { success: false, ref: opts.ref, error: `unsupported ref action: ${action}` };
  }
}

/**
 * locate — locator-first:用语义化、抗变化的原生 getByRole/getByText/getByLabel/
 * getByTestId/getByPlaceholder 选元素并行动(行动前自动等待可见)。映射规则在纯叶子。
 *
 * @param {Object} opts  by(role|text|label|testid|placeholder|alttext|title) /
 *                       role(by=role 时的 ARIA 角色) / name(名字或文本) / exact /
 *                       action(text|count|click|fill|check,默认 text) / value / timeoutMs
 */
async function locate(opts = {}) {
  const page = await _ensurePage();
  if (!page) return UNAVAILABLE;

  const spec = ariaSnapshot.buildLocatorSpec(opts);
  if (!spec) return { success: false, error: `invalid locator (by=${opts.by == null ? '' : opts.by})` };
  if (typeof page[spec.method] !== 'function') {
    return { success: false, error: `locator method unavailable: ${spec.method}` };
  }

  const action = ariaSnapshot.LOCATOR_ACTIONS.includes(opts.action) ? opts.action : 'text';
  const timeout = opts.timeoutMs || _navTimeout();

  let loc;
  try {
    loc = spec.options ? page[spec.method](spec.primary, spec.options) : page[spec.method](spec.primary);
  } catch (err) {
    return { success: false, error: `locator build failed: ${(err && err.message) || err}` };
  }

  try {
    if (action === 'count') return { success: true, count: await loc.count() };
    const first = typeof loc.first === 'function' ? loc.first() : loc;
    if (action !== 'text') await first.waitFor({ state: 'visible', timeout }); // 自动等待
    switch (action) {
      case 'click': await first.click({ timeout }); return { success: true, did: 'click', by: spec.method };
      case 'fill': await first.fill(String(opts.value == null ? '' : opts.value), { timeout }); return { success: true, did: 'fill', by: spec.method };
      case 'check': await first.check({ timeout }); return { success: true, did: 'check', by: spec.method };
      case 'text': return { success: true, text: await first.innerText({ timeout }), by: spec.method };
      default: return { success: false, error: `unsupported locator action: ${action}` };
    }
  } catch (err) {
    return { success: false, error: `locate ${action} failed: ${(err && err.message) || err}`, by: spec.method };
  }
}

async function newTab(url, opts = {}) {
  if (!(await _ensurePage())) return UNAVAILABLE;
  const page = await _context.newPage();
  _pages.push(page);
  _activeIndex = _pages.length - 1;
  if (url) {
    await page.goto(url, { waitUntil: opts.waitUntil || 'domcontentloaded', timeout: opts.timeoutMs || _navTimeout() });
  }
  _touch();
  return { success: true, tabId: _activeIndex, url: url || page.url() };
}

async function listTabs() {
  if (!_browser || !_pages.length) return { success: true, tabs: [], activeIndex: 0 };
  const tabs = [];
  for (let i = 0; i < _pages.length; i++) {
    tabs.push({ tabId: i, url: _pages[i].url(), title: await _pages[i].title().catch(() => ''), active: i === _activeIndex });
  }
  return { success: true, tabs, activeIndex: _activeIndex };
}

async function switchTab(tabId) {
  const i = Number(tabId);
  if (!_pages[i]) return { success: false, error: `no such tab: ${tabId}` };
  _activeIndex = i;
  try { await _pages[i].bringToFront(); } catch { /* headless: no-op */ }
  _touch();
  return { success: true, tabId: i, url: _pages[i].url() };
}

/** Tear the session down: persist login state, then close the browser. */
async function closeSession() {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  await _persistState();
  const b = _browser;
  _browser = null; _context = null; _pages = []; _activeIndex = 0; _isRemote = false;
  if (b && typeof b.close === 'function') { try { await b.close(); } catch { /* ignore */ } }
  return { success: true, closed: true };
}

/** True when a live browser is currently held. */
function isActive() { return !!_browser; }

module.exports = {
  navigate, click, fill, type, screenshot, getText, getContent, evaluate,
  waitFor, scroll, autoScroll, jumpToIndex, selectOption, newTab, listTabs,
  switchTab, closeSession,
  // Playwright agent-first 范式:可访问性快照 + ref 行动 + locator-first。
  snapshotForAI, actByRef, locate,
  isActive,
  // test seam — reset singleton state between cases.
  __resetForTests() { _hardClose(); _launching = null; _exitHooksInstalled = _exitHooksInstalled; },
};
