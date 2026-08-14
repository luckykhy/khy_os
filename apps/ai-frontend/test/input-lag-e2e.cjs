/**
 * E2E: verify AIChat input responsiveness during streaming.
 * Uses system Chrome via playwright-core.
 */
const { chromium } = require('playwright-core');

const PORT = 5173;

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    ignoreHTTPSErrors: true,
  });

  // Set auth token in localStorage BEFORE navigation (bypasses login)
  await context.addInitScript(() => {
    localStorage.setItem('token', 'mock-jwt-token-for-testing');
    localStorage.setItem('khy_ai_user', JSON.stringify({ username: 'test', role: 'user' }));
  });

  const page = await context.newPage();

  // Intercept API calls to return mock data + SSE stream
  await page.route('**/api/auth/me', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { user: { username: 'test', role: 'user' } } }),
    });
  });

  await page.route('**/api/ai/models', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 'test-model', name: 'Test Model', adapter: 'test', isDefault: true }] }),
    });
  });

  await page.route('**/api/ai/conversations', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    });
  });

  await page.route('**/api/ai/chat', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ answer: 'fallback response', model: 'test-model' }),
    });
  });

  // Mock SSE stream endpoint — 100 chunks at realistic rate
  await page.route('**/api/ai/chat/stream', route => {
    const chunks = [];
    for (let i = 0; i < 100; i++) {
      chunks.push(Buffer.from('data: ' + JSON.stringify({
        type: 'chunk',
        content: 'AI回复内容段' + i + '，用于测试流式输出时输入框响应性能。'.slice(0, 15 + (i % 20))
      }) + '\n\n'));
    }
    const header = Buffer.from('data: ' + JSON.stringify({ type: 'start', model: 'test-model' }) + '\n\n');
    const footer = Buffer.from('data: ' + JSON.stringify({ type: 'done', model: 'test-model', content: '最终回复。' }) + '\n\n');
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
      body: Buffer.concat([header, ...chunks, footer]),
    });
  });

  // Navigate directly to chat page
  console.log('Navigating to http://localhost:' + PORT + '/chat');
  await page.goto('http://localhost:' + PORT + '/chat', { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('Page loaded at: ' + page.url());

  // Wait for Vue to mount and components to render
  await page.waitForTimeout(4000);

  // Log page console errors
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('ERROR') || text.includes('[chat]') || text.includes('error')) {
      console.log('  [PAGE] ' + text);
    }
  });

  // Inject input latency monitor
  await page.evaluate(() => {
    window.__perfEvents = [];
    const orig = window.EventTarget.prototype.addEventListener;
    window.EventTarget.prototype.addEventListener = function(type, fn, opts) {
      if (type === 'input' || type === 'keydown') {
        return orig.call(this, type, function(ev) {
          const t0 = performance.now();
          const r = fn.call(this, ev);
          const dt = performance.now() - t0;
          if (dt > 5) {
            window.__perfEvents.push({ type, dt: Math.round(dt), ts: Math.round(performance.now()) });
          }
          return r;
        }, opts);
      }
      return orig.call(this, type, fn, opts);
    };
  });

  // Find textarea
  const textarea = page.locator('textarea, .el-textarea__inner').first();
  const count = await textarea.count();
  console.log('Textarea count: ' + count);

  if (count === 0) {
    console.log('ERROR: No textarea found. URL: ' + page.url());
    console.log('Title: ' + await page.title());
    const bodyText = await page.textContent('body');
    console.log('Body preview: ' + (bodyText || '').slice(0, 300));
    await browser.close();
    process.exit(1);
  }

  await textarea.waitFor({ state: 'visible', timeout: 10000 });
  console.log('Textarea visible and enabled');

  // Focus textarea to trigger model loading
  await textarea.focus();
  await page.waitForTimeout(3000);

  // ── BASELINE: typing without streaming ──
  console.log('\n=== BASELINE: typing without streaming ===');
  await page.evaluate(() => { window.__perfEvents = []; });
  const baselineStart = Date.now();
  for (let i = 0; i < 5; i++) {
    await textarea.fill('baseline-test-' + i);
  }
  const baselineMs = Date.now() - baselineStart;
  const baselinePerf = await page.evaluate(() => window.__perfEvents);
  console.log('  5 fills in ' + baselineMs + 'ms');
  console.log('  Slow input handlers (>5ms): ' + baselinePerf.length);
  if (baselinePerf.length > 0) {
    console.log('  Max handler latency: ' + Math.max(...baselinePerf.map(e => e.dt)) + 'ms');
  }

  // ── STREAMING TEST ──
  console.log('\n=== TEST: typing DURING streaming ===');
  await textarea.fill('');
  await page.evaluate(() => { window.__perfEvents = []; });

  // Send message to trigger SSE streaming
  await textarea.fill('请给我一个很长的回复，包含很多内容');
  await page.keyboard.press('Enter');
  console.log('Message sent, waiting for stream to begin...');

  // Wait for stream to start
  await page.waitForTimeout(1000);

  // Type during active streaming — this is the critical test
  const streamStart = Date.now();
  const fillTimes = [];
  for (let i = 0; i < 10; i++) {
    const t0 = Date.now();
    await textarea.fill('during-stream-' + i);
    fillTimes.push(Date.now() - t0);
    await page.waitForTimeout(100);
  }
  const streamMs = Date.now() - streamStart;

  const streamPerf = await page.evaluate(() => window.__perfEvents);
  console.log('  10 fills during stream in ' + streamMs + 'ms');
  console.log('  Fill times: ' + fillTimes.map(t => t + 'ms').join(', '));
  console.log('  Slow input handlers (>5ms): ' + streamPerf.length);

  if (streamPerf.length > 0) {
    const inputEvents = streamPerf.filter(e => e.type === 'input');
    const maxDt = Math.max(...streamPerf.map(e => e.dt));
    const avgDt = Math.round(streamPerf.reduce((a, b) => a + b.dt, 0) / streamPerf.length);
    console.log('  Avg handler latency: ' + avgDt + 'ms');
    console.log('  Max handler latency: ' + maxDt + 'ms');
    console.log('  Input event handlers: ' + inputEvents.length);
    if (inputEvents.length > 0) {
      console.log('  Max input handler: ' + Math.max(...inputEvents.map(e => e.dt)) + 'ms');
    }
  }

  // ── VERDICT ──
  console.log('\n=== RESULTS ===');
  const avgFill = fillTimes.reduce((a, b) => a + b) / fillTimes.length;
  const maxFill = Math.max(...fillTimes);
  console.log('Baseline avg fill: ' + (baselineMs / 5).toFixed(0) + 'ms');
  console.log('During-stream avg fill: ' + avgFill.toFixed(0) + 'ms');
  console.log('During-stream max fill: ' + maxFill + 'ms');
  console.log('Input handler events during stream: ' + streamPerf.length);

  let verdict;
  if (avgFill < 300 && maxFill < 500) {
    verdict = 'PASS: Input is responsive during streaming (' + avgFill.toFixed(0) + 'ms avg, ' + maxFill + 'ms max)';
  } else if (avgFill < 800) {
    verdict = 'WARN: Noticeable but usable (' + avgFill.toFixed(0) + 'ms avg)';
  } else {
    verdict = 'FAIL: Input lag detected (' + avgFill.toFixed(0) + 'ms avg)';
  }
  console.log('Verdict: ' + verdict);

  // Wait for stream to finish
  await page.waitForTimeout(5000);

  await browser.close();
  console.log('\nTest complete.');
  process.exit(verdict.startsWith('FAIL') ? 1 : 0);
}

main().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
