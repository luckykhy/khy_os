/**
 * E2E test: verify AIChat.vue input responsiveness during streaming.
 *
 * Simulates a streaming AI response (the scenario that caused input lag)
 * and measures whether keystrokes during that stream are responsive.
 */

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 5173;
const SSE_PORT = 5174; // mock SSE server

// ── Mock SSE server that streams a realistic AI response ──
function createSseServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/ai/chat/stream' && req.method === 'POST') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        const lines = [
          { type: 'start', model: 'mock-model' },
          ...Array.from({ length: 80 }, (_, i) => ({
            type: 'chunk',
            content: `这是模拟的AI回复第${i + 1}段内容，用来测试流式输出时输入框是否卡顿。`.slice(0, 20 + Math.random() * 30 | 0),
          })),
          { type: 'done', model: 'mock-model', content: '这是模拟的AI回复的最终完整内容。' },
        ];

        let idx = 0;
        const interval = setInterval(() => {
          if (idx >= lines.length) {
            res.end();
            clearInterval(interval);
            return;
          }
          const line = lines[idx++];
          res.write(`data: ${JSON.stringify(line)}\n\n`);
        }, 50); // 20 events/sec, realistic streaming rate
      });
      return;
    }

    // Auth endpoint
    if (req.url === '/api/auth/me') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { user: { username: 'test', role: 'user' } } }));
      return;
    }

    // Model list
    if (req.url === '/api/ai/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-model', name: 'Mock Model', adapter: 'mock' }] }));
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  return server;
}

async function runTest() {
  const sseServer = createSseServer();
  await new Promise(r => sseServer.listen(SSE_PORT, r));
  console.log(`Mock SSE server on :${SSE_PORT}`);

  // Override API URL in the Vite HMR to point to mock server
  // We'll use a Service Worker approach instead - intercept fetch

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });

  // Intercept API calls to redirect to mock server
  await context.route('**/api/ai/chat/stream', route => {
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: generateSseStream(),
    });
  });

  await context.route('**/api/auth/me', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { user: { username: 'test', role: 'user' } } }),
    });
  });

  await context.route('**/api/ai/models**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 'test-model', name: 'Test Model', adapter: 'test' }] }),
    });
  });

  // Intercept conversation endpoints
  await context.route('**/api/ai/conversations**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    });
  });

  const page = await context.newPage();

  // Collect performance metrics
  const inputEvents = [];
  let streamStartTime = 0;
  let streamEndTime = 0;

  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('[perf]')) {
      console.log('PAGE:', text);
    }
  });

  // Inject performance monitoring into the page
  await page.addInitScript(() => {
    // Monitor input event latency
    const originalAddEventListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function(type, listener, options) {
      if (type === 'input' || type === 'keydown') {
        const wrapped = function(event) {
          const start = performance.now();
          const result = listener.call(this, event);
          const latency = performance.now() - start;
          if (latency > 16) { // slower than one frame
            console.log(`[perf] ${type} handler took ${latency.toFixed(1)}ms`);
          }
          return result;
        };
        return originalAddEventListener.call(this, type, wrapped, options);
      }
      return originalAddEventListener.call(this, type, listener, options);
    };
  });

  console.log('Opening page...');
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle', timeout: 30000 });

  // Wait for the chat input to appear
  const inputSelector = 'textarea.el-textarea__inner, .chat-input-row textarea';
  await page.waitForSelector(inputSelector, { timeout: 15000 });
  console.log('Chat input found');

  const chatInput = page.locator(inputSelector).first();

  // Measure baseline typing speed (no streaming)
  console.log('\n--- Baseline: typing without streaming ---');
  const baselineTimes = [];
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now();
    await chatInput.fill('test' + i);
    baselineTimes.push(performance.now() - t0);
  }
  const baselineAvg = baselineTimes.reduce((a, b) => a + b) / baselineTimes.length;
  console.log(`Baseline avg fill time: ${baselineAvg.toFixed(1)}ms`);

  // Clear input
  await chatInput.fill('');

  // Select a model (trigger model load)
  const modelSelect = page.locator('.model-selector .el-select').first();
  if (await modelSelect.count() > 0) {
    await modelSelect.click();
    await page.waitForTimeout(500);
    // Select first option
    const firstOption = page.locator('.el-select-dropdown .el-select-dropdown__item').first();
    if (await firstOption.count() > 0) {
      await firstOption.click();
    }
  }

  console.log('\n--- Test: typing DURING streaming ---');

  // Start streaming by sending a message
  await chatInput.fill('Hello, please give me a long response');
  await page.keyboard.press('Enter');

  // Wait for streaming to start (loading indicator)
  await page.waitForTimeout(500);

  // Measure typing responsiveness DURING streaming
  const streamingTimes = [];
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now();
    await chatInput.fill('during-stream-' + i);
    streamingTimes.push(performance.now() - t0);
    await page.waitForTimeout(100);
  }

  const streamingAvg = streamingTimes.reduce((a, b) => a + b) / streamingTimes.length;
  console.log(`During-stream avg fill time: ${streamingAvg.toFixed(1)}ms`);

  // Wait for stream to complete
  await page.waitForTimeout(5000);

  // Results
  const ratio = streamingAvg / baselineAvg;
  console.log('\n=== RESULTS ===');
  console.log(`Baseline avg: ${baselineAvg.toFixed(1)}ms`);
  console.log(`During-stream avg: ${streamingAvg.toFixed(1)}ms`);
  console.log(`Ratio: ${ratio.toFixed(2)}x`);

  if (ratio < 3) {
    console.log('\nPASS: Input remains responsive during streaming (< 3x baseline)');
  } else if (ratio < 10) {
    console.log('\nWARN: Input slower during streaming but not severely degraded (< 10x)');
  } else {
    console.log('\nFAIL: Input severely degraded during streaming (>= 10x baseline)');
  }

  // Also measure raw keydown latency
  console.log('\n--- Raw keydown latency test ---');
  await chatInput.fill('');
  const keydownLatencies = [];

  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    await page.keyboard.type('hello', { delay: 50 });
    keydownLatencies.push(performance.now() - t0);
    await page.waitForTimeout(200);
  }

  const avgKeydown = keydownLatencies.reduce((a, b) => a + b) / keydownLatencies.length;
  console.log(`5 chars typed avg: ${avgKeydown.toFixed(0)}ms (target: <250ms)`);

  await browser.close();
  sseServer.close();
  console.log('\nTest complete.');
}

function generateSseStream() {
  let idx = 0;
  const lines = [
    { type: 'start', model: 'mock' },
    ...Array.from({ length: 100 }, (_, i) => ({
      type: 'chunk',
      content: '这是一段很长的AI回复内容，用来测试在流式输出过程中输入框的响应性能。'.slice(0, 15 + (i % 20)),
    })),
    { type: 'done', model: 'mock', content: '最终回复内容。' },
  ];
  let interval;
  return new ReadableStream({
    start(controller) {
      interval = setInterval(() => {
        if (idx >= lines.length) {
          controller.close();
          clearInterval(interval);
          return;
        }
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(lines[idx++])}\n\n`));
      }, 40);
    },
    cancel() { clearInterval(interval); }
  });
}

runTest().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
