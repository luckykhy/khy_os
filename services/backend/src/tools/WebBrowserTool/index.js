const { BaseTool } = require('../_baseTool');

// Headless-automation actions: they drive a persistent Playwright session and
// therefore require playwright (Chromium). Plain `navigate` is intentionally NOT
// here — opening a page for the USER to see is a zero-dependency, OS-native
// operation (default browser), so it never blocks on Playwright. `goto` is the
// headless counterpart that loads a URL inside the automated session.
const HEADLESS_ACTIONS = new Set([
  'goto', 'click', 'fill', 'type', 'screenshot', 'getText', 'getContent',
  'evaluate', 'waitFor', 'scroll', 'autoScroll', 'jumpToIndex', 'selectOption',
  'newTab', 'listTabs', 'switchTab', 'closeSession',
  // Playwright agent-first 范式:可访问性快照 + ref 行动 + locator-first。
  'snapshot', 'actByRef', 'locate',
]);

class WebBrowserTool extends BaseTool {
  static toolName = 'WebBrowser';
  static category = 'system';
  static risk = 'medium';
  static aliases = ['browser', 'web_browser'];
  static searchHint = 'browser web page navigate open url screenshot click fill type scroll evaluate tab';
  static shouldDefer = true;

  isConcurrencySafe() { return false; }

  prompt() {
    return `Open or interact with web pages.
- "navigate" opens the URL in the user's DEFAULT browser (visible window, no extra dependency) — use this to SHOW the user a website.
- Headless automation drives a PERSISTENT browser session (cookies/login reused across calls): "goto" (load url), "click", "fill", "type", "screenshot", "getText", "getContent", "evaluate", "waitFor", "scroll", "selectOption", "newTab", "listTabs", "switchTab", "closeSession". These require playwright (Chromium) and prompt to install it when missing.
- Crawling: "autoScroll" fully scrolls a page to the bottom to trigger lazy-load/infinite-scroll, and with {harvest:true} incrementally collects+dedupes text from VIRTUALIZED lists (where the DOM recycles rows). "jumpToIndex" scrolls to a specific spot inside the page: the Nth item ({itemSelector,index}), an anchor ({anchor} or {hash}), an element containing text ({text}), or any CSS selector ({selector}).
- Agent-first (PREFER over screenshots + brittle CSS/XPath): "snapshot" returns the page as a readable accessibility tree where each interactive element carries a stable ref, e.g. \`- textbox "Search" [ref=e5]\` / \`- button "Submit" [ref=e8]\`. Then act by ref with "actByRef" {ref:"e5", action:"fill"|"click"|"type"|"check"|"text", value}. Refs come from the LATEST snapshot (re-snapshot after navigation). Alternatively select semantically with "locate" {by:"role", role:"button", name:"Submit", action:"click"} (by also: text/label/testid/placeholder/alttext/title). Both auto-wait for the element to be actionable before acting.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'navigate', 'goto', 'click', 'fill', 'type', 'screenshot', 'getText',
            'getContent', 'evaluate', 'waitFor', 'scroll', 'autoScroll', 'jumpToIndex',
            'selectOption', 'newTab', 'listTabs', 'switchTab', 'closeSession',
            'snapshot', 'actByRef', 'locate',
          ],
          description: '"navigate" opens the URL in the default browser; all others drive the headless Playwright session. "snapshot"/"actByRef"/"locate" are the agent-first a11y-tree + ref + locator-first actions.',
        },
        url: { type: 'string', description: 'URL for navigate / goto / newTab' },
        selector: { type: 'string', description: 'CSS selector for click/fill/type/getText/screenshot/waitFor/scroll/selectOption/jumpToIndex' },
        text: { type: 'string', description: 'Text to type; for jumpToIndex: the visible text to scroll to' },
        value: { type: 'string', description: 'Value for fill / selectOption' },
        script: { type: 'string', description: 'JS expression to evaluate in the page context' },
        timeoutMs: { type: 'number', description: 'Per-action timeout (ms)' },
        tabId: { type: 'number', description: 'Tab index for switchTab' },
        path: { type: 'string', description: 'Output file path for screenshot (defaults to a managed dir)' },
        fullPage: { type: 'boolean', description: 'Capture the full scrollable page in screenshot' },
        waitForSelector: { type: 'string', description: 'Selector to await after goto/navigate' },
        toBottom: { type: 'boolean', description: 'scroll: jump to page bottom' },
        x: { type: 'number', description: 'scroll: horizontal delta' },
        y: { type: 'number', description: 'scroll: vertical delta' },
        delay: { type: 'number', description: 'type: per-keystroke delay (ms)' },
        maxPasses: { type: 'number', description: 'autoScroll: max scroll iterations (default 60, hard cap on infinite scroll)' },
        settleMs: { type: 'number', description: 'autoScroll: wait after each scroll for lazy-load (ms, default 400)' },
        stableRounds: { type: 'number', description: 'autoScroll: stop after height stops growing for this many rounds (default 3)' },
        maxChars: { type: 'number', description: 'autoScroll harvest: character cap on collected text (default 2,000,000)' },
        stepRatio: { type: 'number', description: 'autoScroll: scroll innerHeight*stepRatio each pass (0.1–1, default 0.9)' },
        harvest: { type: 'boolean', description: 'autoScroll: incrementally collect+dedupe innerText (use for virtualized lists)' },
        harvestSelector: { type: 'string', description: 'autoScroll: container to harvest text from (defaults to body)' },
        toSelector: { type: 'string', description: 'autoScroll: stop early once this selector appears' },
        itemSelector: { type: 'string', description: 'jumpToIndex: selector matching the list items to index into' },
        index: { type: 'number', description: 'jumpToIndex: zero-based index of the item to scroll to' },
        anchor: { type: 'string', description: 'jumpToIndex: anchor id (with or without leading #)' },
        hash: { type: 'string', description: 'jumpToIndex: page hash/anchor to scroll to' },
        // agent-first: snapshot / actByRef / locate
        max: { type: 'number', description: 'snapshot: max nodes in the accessibility tree (default 2000, cap 5000)' },
        interactiveOnly: { type: 'boolean', description: 'snapshot: only interactive elements + headings (default true)' },
        ref: { type: 'string', description: 'actByRef: a ref from the latest snapshot, e.g. "e5"' },
        by: { type: 'string', enum: ['role', 'text', 'label', 'testid', 'placeholder', 'alttext', 'title'], description: 'locate: which semantic locator to use' },
        role: { type: 'string', description: 'locate: ARIA role when by="role" (e.g. button, textbox, link)' },
        name: { type: 'string', description: 'locate: accessible name / text to match' },
        exact: { type: 'boolean', description: 'locate: match name/text exactly (default false = substring/normalized)' },
        do: { type: 'string', enum: ['click', 'fill', 'type', 'check', 'text', 'count'], description: 'actByRef/locate: what to do with the matched element (default: actByRef→click, locate→text)' },
      },
      required: ['action'],
    };
  }

  /**
   * @param {object} [deps] test seam — `{ openDefault, session }` override the OS
   *   opener and the browser session module respectively.
   */
  async execute(params, deps = {}) {
    const action = params && params.action;

    // ── navigate: open the page in the user's default browser. No Playwright. ──
    if (action === 'navigate') {
      const url = String((params && params.url) || '').trim();
      if (!url) {
        return { success: false, error: 'WebBrowser navigate requires a "url".', note: 'WebBrowser navigate requires a "url".', action };
      }
      try {
        const openDefault = deps.openDefault || require('../platformUtils').openDefault;
        openDefault(url);
        return {
          success: true, action, opened: url, mode: 'default-browser',
          note: `已在系统默认浏览器打开 ${url}（如需无头自动化/截图/抓取请使用 goto/screenshot 等动作，缺 playwright 时会提示安装）`,
        };
      } catch (err) {
        const msg = (err && err.message) || String(err);
        return { success: false, action, url, error: `无法打开默认浏览器：${msg}`, note: `无法打开默认浏览器：${msg}` };
      }
    }

    // ── headless automation: needs playwright. Declare the dependency so the
    //    self-healing loop can offer an interactive install + retry. ──
    if (HEADLESS_ACTIONS.has(action)) {
      // closeSession / listTabs are pure session control — if the session was
      // never started they degrade gracefully without forcing an install.
      const needsBrowser = action !== 'closeSession' && action !== 'listTabs';
      if (needsBrowser) {
        try {
          const dep = require('../../services/dependency');
          const miss = dep.ensure('playwright');
          if (miss) return miss.toStructuredResult();
        } catch { /* resolver unavailable — fall through and let the op surface unavailable */ }
      }

      const session = deps.session || require('../../services/browser/session');
      try {
        const result = await this._dispatchHeadless(session, action, params);
        return { action, ...result };
      } catch (err) {
        const msg = (err && err.message) || String(err);
        return { success: false, action, error: `WebBrowser ${action} failed: ${msg}`, note: `WebBrowser ${action} 失败：${msg}` };
      }
    }

    return { success: false, error: `Unknown WebBrowser action: ${action}`, action };
  }

  /** Map a headless action to the corresponding session atomic op. */
  async _dispatchHeadless(session, action, p = {}) {
    const opts = {
      timeoutMs: p.timeoutMs, waitForSelector: p.waitForSelector, waitUntil: p.waitUntil,
      fullPage: p.fullPage, selector: p.selector, path: p.path,
      toBottom: p.toBottom, x: p.x, y: p.y, delay: p.delay,
      // crawler: autoScroll
      maxPasses: p.maxPasses, settleMs: p.settleMs, stableRounds: p.stableRounds,
      maxChars: p.maxChars, stepRatio: p.stepRatio, harvest: p.harvest,
      harvestSelector: p.harvestSelector, toSelector: p.toSelector,
      // crawler: jumpToIndex
      itemSelector: p.itemSelector, index: p.index, anchor: p.anchor, hash: p.hash, text: p.text,
    };
    switch (action) {
      case 'goto':         return session.navigate(String(p.url || ''), opts);
      case 'click':        return session.click(p.selector, opts);
      case 'fill':         return session.fill(p.selector, p.value != null ? p.value : p.text, opts);
      case 'type':         return session.type(p.selector, p.text, opts);
      case 'screenshot':   return session.screenshot(opts);
      case 'getText':      return session.getText(p.selector, opts);
      case 'getContent':   return session.getContent();
      case 'evaluate':     return session.evaluate(p.script, opts);
      case 'waitFor':      return session.waitFor(opts);
      case 'scroll':       return session.scroll(opts);
      case 'autoScroll':   return session.autoScroll(opts);
      case 'jumpToIndex':  return session.jumpToIndex(opts);
      case 'selectOption': return session.selectOption(p.selector, p.value, opts);
      case 'newTab':       return session.newTab(p.url ? String(p.url) : null, opts);
      case 'listTabs':     return session.listTabs();
      case 'switchTab':    return session.switchTab(p.tabId);
      case 'closeSession': return session.closeSession();
      // agent-first: 可访问性快照 + ref 行动 + locator-first
      case 'snapshot':     return session.snapshotForAI({ max: p.max, interactiveOnly: p.interactiveOnly });
      case 'actByRef':     return session.actByRef({ ref: p.ref, action: p.do, value: p.value != null ? p.value : p.text, timeoutMs: p.timeoutMs });
      case 'locate':       return session.locate({ by: p.by, role: p.role, name: p.name, value: p.value, exact: p.exact, action: p.do, timeoutMs: p.timeoutMs });
      default:             return { success: false, error: `unhandled headless action: ${action}` };
    }
  }

  getActivityDescription(input) { return `浏览器操作：${input.action} ${input.url || input.selector || ''}`; }
}

module.exports = WebBrowserTool;
