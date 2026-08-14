const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    ignoreHTTPSErrors: true,
  });

  // Set auth token before navigation
  await context.addInitScript(() => {
    localStorage.setItem('token', 'mock-jwt-token');
    localStorage.setItem('khy_ai_user', JSON.stringify({ username: 'test', role: 'user' }));
  });

  const page = await context.newPage();
  const logs = [];
  page.on('console', msg => logs.push(msg.text()));
  page.on('pageerror', err => logs.push('PAGEERR: ' + err.message));

  console.log('Navigating to /chat ...');
  await page.goto('http://localhost:5173/chat', {
    waitUntil: 'networkidle',
    timeout: 30000,
  });

  console.log('URL:', page.url());
  console.log('Title:', await page.title());

  await page.waitForTimeout(5000);

  const bodyLen = await page.$eval('body', el => el.innerHTML.length);
  const bodyText = await page.textContent('body');
  console.log('Body HTML length:', bodyLen);
  console.log('Body text:', (bodyText || '').slice(0, 500));

  // Show Vue render errors
  const vueErrors = logs.filter(l => l.includes('Vue') || l.includes('Error') || l.includes('error') || l.includes('warn'));
  console.log('Vue/render logs:', vueErrors.join(' | '));

  // Check if #app has content
  const appHtml = await page.$eval('#app', el => el.innerHTML.length);
  console.log('#app innerHTML length:', appHtml);

  await browser.close();
})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
