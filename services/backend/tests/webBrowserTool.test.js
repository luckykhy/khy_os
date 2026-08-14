'use strict';

/**
 * WebBrowserTool — navigate must open the user's default browser with NO
 * dependency; the headless-automation actions drive a persistent Playwright
 * session and gate on `playwright`.
 */

const WebBrowserTool = require('../src/tools/WebBrowserTool');

describe('WebBrowserTool', () => {
  test('navigate opens the URL via the default-browser opener, no playwright', async () => {
    const tool = new WebBrowserTool();
    const calls = [];
    const openDefault = (url) => { calls.push(url); };

    const res = await tool.execute({ action: 'navigate', url: 'https://example.com/path?a=1&b=2' }, { openDefault });

    expect(res.success).toBe(true);
    expect(res.mode).toBe('default-browser');
    expect(res.opened).toBe('https://example.com/path?a=1&b=2');
    expect(calls).toEqual(['https://example.com/path?a=1&b=2']);
  });

  test('navigate without a url fails structurally and never opens anything', async () => {
    const tool = new WebBrowserTool();
    let opened = false;
    const res = await tool.execute({ action: 'navigate' }, { openDefault: () => { opened = true; } });

    expect(res.success).toBe(false);
    expect(opened).toBe(false);
    expect(String(res.error)).toMatch(/url/i);
  });

  test('navigate surfaces opener failure honestly (state transparency)', async () => {
    const tool = new WebBrowserTool();
    const res = await tool.execute(
      { action: 'navigate', url: 'https://x.test' },
      { openDefault: () => { throw new Error('no display'); } },
    );
    expect(res.success).toBe(false);
    expect(String(res.error)).toMatch(/no display/);
  });

  test('headless action routes through the playwright dependency gate', async () => {
    jest.resetModules();
    const sentinel = { __structured: true };
    jest.doMock('../src/services/dependency', () => ({
      ensure: (id) => (id === 'playwright'
        ? { toStructuredResult: () => sentinel }
        : null),
    }), { virtual: false });

    const FreshTool = require('../src/tools/WebBrowserTool');
    const tool = new FreshTool();
    const res = await tool.execute({ action: 'goto', url: 'https://x.test' });

    expect(res).toBe(sentinel);
    jest.dontMock('../src/services/dependency');
  });

  test('headless ops are dispatched to the session with mapped params', async () => {
    const tool = new WebBrowserTool();
    const seen = [];
    const ok = (name) => (...args) => { seen.push([name, ...args]); return { success: true, [name]: true }; };
    const session = {
      navigate: ok('navigate'), click: ok('click'), fill: ok('fill'), type: ok('type'),
      screenshot: ok('screenshot'), getText: ok('getText'), getContent: ok('getContent'),
      evaluate: ok('evaluate'), waitFor: ok('waitFor'), scroll: ok('scroll'),
      selectOption: ok('selectOption'), newTab: ok('newTab'), listTabs: ok('listTabs'),
      switchTab: ok('switchTab'), closeSession: ok('closeSession'),
    };
    // Dependency present (ensure returns null) → flows straight to the session.
    const deps = { session, _dep: { ensure: () => null } };
    // Patch the dependency require by injecting via a session-only deps object is
    // not enough; instead stub require cache:
    jest.resetModules();
    jest.doMock('../src/services/dependency', () => ({ ensure: () => null }), { virtual: false });
    const FreshTool = require('../src/tools/WebBrowserTool');
    const t = new FreshTool();

    const goto = await t.execute({ action: 'goto', url: 'https://a.test', waitForSelector: '#x' }, deps);
    expect(goto.success).toBe(true);
    expect(seen[0][0]).toBe('navigate');
    expect(seen[0][1]).toBe('https://a.test');
    expect(seen[0][2].waitForSelector).toBe('#x');

    await t.execute({ action: 'click', selector: '#btn', timeoutMs: 1234 }, deps);
    const clickCall = seen.find((c) => c[0] === 'click');
    expect(clickCall[1]).toBe('#btn');
    expect(clickCall[2].timeoutMs).toBe(1234);

    await t.execute({ action: 'fill', selector: '#u', value: 'alice' }, deps);
    const fillCall = seen.find((c) => c[0] === 'fill');
    expect(fillCall[1]).toBe('#u');
    expect(fillCall[2]).toBe('alice');

    await t.execute({ action: 'switchTab', tabId: 2 }, deps);
    const switchCall = seen.find((c) => c[0] === 'switchTab');
    expect(switchCall[1]).toBe(2);

    jest.dontMock('../src/services/dependency');
  });

  test('closeSession / listTabs do not force a playwright install', async () => {
    jest.resetModules();
    // ensure() throws would mean the gate ran; assert it is NOT consulted by
    // making ensure throw and confirming the op still completes via the session.
    jest.doMock('../src/services/dependency', () => ({
      ensure: () => { throw new Error('gate should not run for closeSession'); },
    }), { virtual: false });
    const FreshTool = require('../src/tools/WebBrowserTool');
    const tool = new FreshTool();
    const session = { closeSession: async () => ({ success: true, closed: true }), listTabs: async () => ({ success: true, tabs: [] }) };

    const close = await tool.execute({ action: 'closeSession' }, { session });
    expect(close.success).toBe(true);
    expect(close.closed).toBe(true);

    const tabs = await tool.execute({ action: 'listTabs' }, { session });
    expect(tabs.success).toBe(true);

    jest.dontMock('../src/services/dependency');
  });
});

describe('browser/session — atomic ops over an injected fake chromium', () => {
  const engine = require('../src/services/browser/engine');
  const session = require('../src/services/browser/session');

  function fakeChromium(record) {
    const page = {
      _url: 'about:blank',
      async goto(u) { this._url = u; record.push(['goto', u]); },
      url() { return this._url; },
      async title() { return 'T'; },
      async click(s) { record.push(['click', s]); },
      async fill(s, v) { record.push(['fill', s, v]); },
      async type(s, t) { record.push(['type', s, t]); },
      async waitForSelector(s) { record.push(['waitForSelector', s]); },
      async waitForTimeout(ms) { record.push(['waitForTimeout', ms]); },
      async content() { return '<html>hi</html>'; },
      async evaluate(fn, arg) { record.push(['evaluate', arg]); return 'EVAL_RESULT'; },
      async selectOption(s, v) { record.push(['selectOption', s, v]); return [v]; },
      async $(s) { return s === '#missing' ? null : { async innerText() { return 'inner'; }, async screenshot() { return Buffer.from('img'); } }; },
      async screenshot() { return Buffer.from('shot'); },
      async bringToFront() {},
    };
    const context = {
      async newPage() { return page; },
      async storageState() { return {}; },
      async close() {},
    };
    const browser = {
      async newContext() { return context; },
      async newPage() { return page; },
      async close() { record.push(['browser.close']); },
    };
    return { chromium: { async launch() { return browser; } }, _page: page };
  }

  afterEach(async () => {
    await session.closeSession().catch(() => {});
    session.__resetForTests();
    engine.__setPlaywrightModuleForTests(null);
    delete process.env.KHY_BROWSER_PERSIST_STATE;
  });

  test('goto → getText(body) → screenshot(base64) → closeSession reuse one browser', async () => {
    process.env.KHY_BROWSER_PERSIST_STATE = '0'; // no storageState writes in tests
    const record = [];
    const fake = fakeChromium(record);
    engine.__setPlaywrightModuleForTests(fake);

    const nav = await session.navigate('https://a.test');
    expect(nav.success).toBe(true);
    expect(record.some((r) => r[0] === 'goto' && r[1] === 'https://a.test')).toBe(true);

    const txt = await session.getText();
    expect(txt.success).toBe(true);
    expect(txt.text).toBe('EVAL_RESULT'); // body innerText goes through page.evaluate

    const tmp = require('path').join(require('os').tmpdir(), 'khytest-shot.png');
    const shot = await session.screenshot({ path: tmp }); // explicit path → returns path
    expect(shot.success).toBe(true);
    expect(shot.path).toBe(tmp);

    // base64 mode when no managed path is resolvable
    const shot2 = await session.screenshot({ selector: '#has' });
    expect(shot2.success).toBe(true);

    expect(session.isActive()).toBe(true);
    const closed = await session.closeSession();
    expect(closed.closed).toBe(true);
    expect(session.isActive()).toBe(false);
  });

  test('unavailable Playwright → ops return { unavailable: true } and never throw', async () => {
    engine.__setPlaywrightModuleForTests(null); // loadPlaywright() → null
    // Force the loader to re-resolve as missing by pointing at a module without chromium.
    const r = await session.click('#x');
    expect(r.unavailable || r.success === false).toBeTruthy();
  });
});

describe('browser/session — crawler ops (autoScroll / jumpToIndex) over a scripted fake', () => {
  const engine = require('../src/services/browser/engine');
  const session = require('../src/services/browser/session');

  // A fake whose page.evaluate yields scripted results from a queue, so we can
  // drive the autoScroll termination loop and jumpToIndex deterministically.
  function scriptedChromium(evalQueue) {
    const queue = evalQueue.slice();
    const page = {
      _url: 'about:blank',
      async goto(u) { this._url = u; },
      url() { return this._url; },
      async title() { return 'T'; },
      async waitForTimeout() {},
      async evaluate() { return queue.length ? queue.shift() : (evalQueue[evalQueue.length - 1] || {}); },
    };
    const context = { async newPage() { return page; }, async storageState() { return {}; }, async close() {} };
    const browser = { async newContext() { return context; }, async newPage() { return page; }, async close() {} };
    return { chromium: { async launch() { return browser; } }, _page: page };
  }

  afterEach(async () => {
    await session.closeSession().catch(() => {});
    session.__resetForTests();
    engine.__setPlaywrightModuleForTests(null);
    delete process.env.KHY_BROWSER_PERSIST_STATE;
    delete process.env.KHY_BROWSER_AUTOSCROLL;
  });

  test('autoScroll stops "stable" once height stops growing, and dedupes harvested text', async () => {
    process.env.KHY_BROWSER_PERSIST_STATE = '0';
    // height grows then plateaus; harvest text recycles duplicate lines (virtual scroll).
    engine.__setPlaywrightModuleForTests(scriptedChromium([
      { height: 1000, text: 'a\nb', targetFound: false },
      { height: 2000, text: 'a\nb\nc', targetFound: false },
      { height: 2000, text: 'b\nc', targetFound: false },   // recycled rows reappear
      { height: 2000, text: 'c\nd', targetFound: false },
      { height: 2000, text: 'c\nd', targetFound: false },
    ]));

    const r = await session.autoScroll({ harvest: true, settleMs: 0 });
    expect(r.success).toBe(true);
    expect(r.autoScroll).toBe(true);
    expect(r.stopReason).toBe('stable');
    expect(r.passes).toBeLessThanOrEqual(5);
    // Deduped union of all chunks, first-seen order.
    expect(r.text).toBe('a\nb\nc\nd');
    expect(r.lines).toBe(4);
    expect(r.truncated).toBe(false);
  });

  test('autoScroll respects maxPasses as a hard cap', async () => {
    process.env.KHY_BROWSER_PERSIST_STATE = '0';
    // Height keeps growing forever → only the pass cap can stop it.
    const ever = Array.from({ length: 10 }, (_, i) => ({ height: (i + 1) * 1000, text: '', targetFound: false }));
    engine.__setPlaywrightModuleForTests(scriptedChromium(ever));
    const r = await session.autoScroll({ maxPasses: 3, settleMs: 0 });
    expect(r.stopReason).toBe('max-passes');
    expect(r.passes).toBe(3);
  });

  test('autoScroll stops early at target-found when toSelector appears', async () => {
    process.env.KHY_BROWSER_PERSIST_STATE = '0';
    engine.__setPlaywrightModuleForTests(scriptedChromium([
      { height: 1000, text: '', targetFound: false },
      { height: 2000, text: '', targetFound: true },
    ]));
    const r = await session.autoScroll({ toSelector: '#end', settleMs: 0 });
    expect(r.stopReason).toBe('target-found');
    expect(r.passes).toBe(2);
  });

  test('autoScroll gate off → single scroll fallback (autoScroll:false)', async () => {
    process.env.KHY_BROWSER_PERSIST_STATE = '0';
    process.env.KHY_BROWSER_AUTOSCROLL = 'off';
    engine.__setPlaywrightModuleForTests(scriptedChromium([{}]));
    const r = await session.autoScroll({ harvest: true });
    expect(r.success).toBe(true);
    expect(r.autoScroll).toBe(false);
    expect(r.reason).toBe('disabled');
  });

  test('jumpToIndex(index) returns matched + snippet from the page', async () => {
    process.env.KHY_BROWSER_PERSIST_STATE = '0';
    engine.__setPlaywrightModuleForTests(scriptedChromium([
      { matched: true, total: 100, index: 50, snippet: 'item-50' },
    ]));
    const r = await session.jumpToIndex({ itemSelector: '.item', index: 50 });
    expect(r.success).toBe(true);
    expect(r.mode).toBe('index');
    expect(r.matched).toBe(true);
    expect(r.snippet).toBe('item-50');
  });

  test('jumpToIndex with no target → structured error (never throws)', async () => {
    process.env.KHY_BROWSER_PERSIST_STATE = '0';
    engine.__setPlaywrightModuleForTests(scriptedChromium([{}]));
    const r = await session.jumpToIndex({});
    expect(r.success).toBe(false);
    expect(String(r.error)).toMatch(/anchor|index|text|selector/i);
  });

  test('autoScroll unavailable Playwright → { unavailable: true }', async () => {
    engine.__setPlaywrightModuleForTests(null);
    const r = await session.autoScroll({});
    expect(r.unavailable || r.success === false).toBeTruthy();
  });
});

describe('browser/session — agent-first ops (snapshot / actByRef / locate) over a fake', () => {
  const engine = require('../src/services/browser/engine');
  const session = require('../src/services/browser/session');

  // A fake page that yields scripted accessibility nodes from evaluate, and records
  // ref-based / locator-based actions so we can assert auto-wait + dispatch.
  function ariaChromium({ nodes = [], locator } = {}) {
    const record = [];
    const page = {
      _url: 'https://a.test',
      async goto(u) { this._url = u; },
      url() { return this._url; },
      async title() { return 'T'; },
      async evaluate() { return nodes; },
      async waitForSelector(sel, opts) { record.push(['waitForSelector', sel, opts && opts.state]); },
      async click(sel) { record.push(['click', sel]); },
      async fill(sel, v) { record.push(['fill', sel, v]); },
      async type(sel, v) { record.push(['type', sel, v]); },
      async check(sel) { record.push(['check', sel]); },
      async $(sel) { record.push(['$', sel]); return { async innerText() { return 'REF_TEXT'; } }; },
      getByRole(role, opts) { record.push(['getByRole', role, opts]); return locator(record); },
      getByText(t, opts) { record.push(['getByText', t, opts]); return locator(record); },
      async bringToFront() {},
    };
    const context = { async newPage() { return page; }, async storageState() { return {}; }, async close() {} };
    const browser = { async newContext() { return context; }, async newPage() { return page; }, async close() {} };
    return { mod: { chromium: { async launch() { return browser; } } }, record, page };
  }

  afterEach(async () => {
    await session.closeSession().catch(() => {});
    session.__resetForTests();
    engine.__setPlaywrightModuleForTests(null);
    delete process.env.KHY_BROWSER_PERSIST_STATE;
    delete process.env.KHY_BROWSER_ARIA;
  });

  test('snapshotForAI serializes scripted nodes into the Playwright a11y-tree text', async () => {
    process.env.KHY_BROWSER_PERSIST_STATE = '0';
    const fake = ariaChromium({ nodes: [
      { depth: 0, role: 'heading', name: 'Todos', level: 1, ref: 'e1' },
      { depth: 1, role: 'textbox', name: 'What needs to be done?', ref: 'e2' },
    ] });
    engine.__setPlaywrightModuleForTests(fake.mod);

    const r = await session.snapshotForAI({});
    expect(r.success).toBe(true);
    expect(r.aria).toBe(true);
    expect(r.count).toBe(2);
    expect(r.snapshot).toBe('- heading "Todos" [level=1] [ref=e1]\n  - textbox "What needs to be done?" [ref=e2]');
  });

  test('snapshotForAI gate off → plain-text degradation (aria:false), never throws', async () => {
    process.env.KHY_BROWSER_PERSIST_STATE = '0';
    process.env.KHY_BROWSER_ARIA = 'off';
    const fake = ariaChromium({ nodes: 'PLAIN BODY TEXT' });
    engine.__setPlaywrightModuleForTests(fake.mod);

    const r = await session.snapshotForAI({});
    expect(r.success).toBe(true);
    expect(r.aria).toBe(false);
    expect(r.snapshot).toBe('PLAIN BODY TEXT');
  });

  test('actByRef auto-waits for visibility then acts; rejects an invalid ref (injection guard)', async () => {
    process.env.KHY_BROWSER_PERSIST_STATE = '0';
    const fake = ariaChromium({});
    engine.__setPlaywrightModuleForTests(fake.mod);

    const filled = await session.actByRef({ ref: 'e2', action: 'fill', value: 'milk' });
    expect(filled.success).toBe(true);
    expect(filled.did).toBe('fill');
    // visibility wait happened before the fill, against the data-khy-ref selector.
    expect(fake.record).toContainEqual(['waitForSelector', '[data-khy-ref="e2"]', 'visible']);
    expect(fake.record).toContainEqual(['fill', '[data-khy-ref="e2"]', 'milk']);

    // Injection attempt → rejected by the leaf, no DOM touched.
    const bad = await session.actByRef({ ref: 'e2"], [onclick', action: 'click' });
    expect(bad.success).toBe(false);
    expect(String(bad.error)).toMatch(/invalid ref/);
  });

  test('locate builds the native getByRole locator, auto-waits, and clicks', async () => {
    process.env.KHY_BROWSER_PERSIST_STATE = '0';
    const locator = (record) => ({
      first() { return this; },
      async waitFor(opts) { record.push(['loc.waitFor', opts && opts.state]); },
      async click() { record.push(['loc.click']); },
      async innerText() { return 'LOC_TEXT'; },
      async count() { return 3; },
    });
    const fake = ariaChromium({ locator });
    engine.__setPlaywrightModuleForTests(fake.mod);

    const r = await session.locate({ by: 'role', role: 'button', name: 'Submit', action: 'click' });
    expect(r.success).toBe(true);
    expect(r.did).toBe('click');
    expect(fake.record).toContainEqual(['getByRole', 'button', { name: 'Submit' }]);
    expect(fake.record).toContainEqual(['loc.waitFor', 'visible']);
    expect(fake.record).toContainEqual(['loc.click']);

    const bad = await session.locate({ by: 'xpath', name: '//a' });
    expect(bad.success).toBe(false);
    expect(String(bad.error)).toMatch(/invalid locator/);
  });

  test('unavailable Playwright → agent-first ops return { unavailable: true }', async () => {
    engine.__setPlaywrightModuleForTests(null);
    const r = await session.snapshotForAI({});
    expect(r.unavailable || r.success === false).toBeTruthy();
  });
});

describe('WebBrowserTool — agent-first action dispatch', () => {
  test('snapshot / actByRef / locate map to session ops with mapped params', async () => {
    const seen = [];
    const ok = (name) => (...args) => { seen.push([name, ...args]); return { success: true, [name]: true }; };
    const session = { snapshotForAI: ok('snapshotForAI'), actByRef: ok('actByRef'), locate: ok('locate') };

    jest.resetModules();
    jest.doMock('../src/services/dependency', () => ({ ensure: () => null }), { virtual: false });
    const FreshTool = require('../src/tools/WebBrowserTool');
    const t = new FreshTool();
    const deps = { session };

    const snap = await t.execute({ action: 'snapshot', max: 50, interactiveOnly: false }, deps);
    expect(snap.success).toBe(true);
    expect(seen[0][0]).toBe('snapshotForAI');
    expect(seen[0][1]).toEqual({ max: 50, interactiveOnly: false });

    await t.execute({ action: 'actByRef', ref: 'e5', do: 'fill', value: 'x' }, deps);
    const act = seen.find((c) => c[0] === 'actByRef');
    expect(act[1].ref).toBe('e5');
    expect(act[1].action).toBe('fill');
    expect(act[1].value).toBe('x');

    await t.execute({ action: 'locate', by: 'role', role: 'button', name: 'Go', do: 'click' }, deps);
    const loc = seen.find((c) => c[0] === 'locate');
    expect(loc[1].by).toBe('role');
    expect(loc[1].role).toBe('button');
    expect(loc[1].name).toBe('Go');
    expect(loc[1].action).toBe('click');

    jest.dontMock('../src/services/dependency');
  });
});

describe('WebBrowserTool — crawler action dispatch', () => {
  test('autoScroll / jumpToIndex map to session ops with params', async () => {
    const seen = [];
    const ok = (name) => (...args) => { seen.push([name, ...args]); return { success: true, [name]: true }; };
    const session = { autoScroll: ok('autoScroll'), jumpToIndex: ok('jumpToIndex') };

    jest.resetModules();
    jest.doMock('../src/services/dependency', () => ({ ensure: () => null }), { virtual: false });
    const FreshTool = require('../src/tools/WebBrowserTool');
    const t = new FreshTool();
    const deps = { session };

    const as = await t.execute(
      { action: 'autoScroll', harvest: true, maxPasses: 12, harvestSelector: '.feed', toSelector: '#end' }, deps,
    );
    expect(as.success).toBe(true);
    expect(seen[0][0]).toBe('autoScroll');
    expect(seen[0][1].harvest).toBe(true);
    expect(seen[0][1].maxPasses).toBe(12);
    expect(seen[0][1].harvestSelector).toBe('.feed');
    expect(seen[0][1].toSelector).toBe('#end');

    await t.execute({ action: 'jumpToIndex', itemSelector: '.row', index: 7, anchor: 'sec' }, deps);
    const jump = seen.find((c) => c[0] === 'jumpToIndex');
    expect(jump[1].itemSelector).toBe('.row');
    expect(jump[1].index).toBe(7);
    expect(jump[1].anchor).toBe('sec');

    jest.dontMock('../src/services/dependency');
  });
});
