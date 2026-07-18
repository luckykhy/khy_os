/**
 * Clipboard Relay Adapter — automated web AI relay via system clipboard.
 *
 * Workflow (simulated human interaction with web AI services):
 *   1. Copy prompt text to system clipboard
 *   2. Open browser tab if not already open (optional)
 *   3. Wait for user to paste prompt into web AI (智谱清言 / ChatGPT / Kimi etc.)
 *   4. User copies the AI response back to clipboard
 *   5. Detect clipboard change → read response → return to caller
 *
 * This provides FREE access to web-only AI services without API keys.
 * Supports: 智谱清言(GLM), ChatGPT, Kimi, 通义千问, 文心一言, etc.
 *
 * Platform-specific clipboard access:
 *   - Linux:   xclip / xsel / wl-copy + wl-paste
 *   - macOS:   pbcopy / pbpaste
 *   - Windows: PowerShell [Clipboard]::SetText / GetText
 */
const { execSync, exec } = require('child_process');
const os = require('os');

const EXEC_OPTS = { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] };
const MAX_WAIT_MS = 5 * 60 * 1000;  // 5 minutes max wait for response
const POLL_INTERVAL_MS = 1500;       // poll clipboard every 1.5s
const RESPONSE_SETTLE_MS = 3000;     // wait 3s after first change for streaming to finish

// Known web AI service URLs
const WEB_AI_SERVICES = {
  zhipu:    { name: '智谱清言 (GLM-5)', url: 'https://chatglm.cn' },
  chatgpt:  { name: 'ChatGPT',          url: 'https://chatgpt.com' },
  kimi:     { name: 'Kimi (月之暗面)',   url: 'https://kimi.moonshot.cn' },
  tongyi:   { name: '通义千问',          url: 'https://tongyi.aliyun.com/qianwen' },
  wenxin:   { name: '文心一言',          url: 'https://yiyan.baidu.com' },
  doubao:   { name: '豆包 (字节)',       url: 'https://www.doubao.com/chat' },
  deepseek: { name: 'DeepSeek',          url: 'https://chat.deepseek.com' },
};

let _preferredService = process.env.CLIPBOARD_RELAY_SERVICE || 'zhipu';

// ── Platform-specific clipboard operations ─────────────────────────

/**
 * Write text to system clipboard.
 * @param {string} text
 */
function writeClipboard(text) {
  const platform = os.platform();

  if (platform === 'darwin') {
    execSync('pbcopy', { input: text, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
    return;
  }

  if (platform === 'win32') {
    // Use 'clip' with stdin pipe to avoid command injection
    execSync('clip', { input: text, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
    return;
  }

  // Linux: try xclip → xsel → wl-copy
  const linuxCmds = [
    'xclip -selection clipboard',
    'xsel --clipboard --input',
    'wl-copy',
  ];
  for (const cmd of linuxCmds) {
    try {
      execSync(cmd, { input: text, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
      return;
    } catch { /* try next */ }
  }
  throw new Error('No clipboard tool found. Install xclip, xsel, or wl-clipboard.');
}

/**
 * Read text from system clipboard.
 * @returns {string}
 */
function readClipboard() {
  const platform = os.platform();

  if (platform === 'darwin') {
    return execSync('pbpaste', EXEC_OPTS).toString();
  }

  if (platform === 'win32') {
    return execSync(
      'powershell -command "Get-Clipboard"',
      EXEC_OPTS
    ).toString();
  }

  // Linux: try xclip → xsel → wl-paste
  const linuxCmds = [
    'xclip -selection clipboard -o',
    'xsel --clipboard --output',
    'wl-paste',
  ];
  for (const cmd of linuxCmds) {
    try {
      return execSync(cmd, EXEC_OPTS).toString();
    } catch { /* try next */ }
  }
  throw new Error('No clipboard tool found.');
}

/**
 * Open a URL in the default browser.
 * @param {string} url
 */
function openBrowser(url) {
  const platform = os.platform();
  try {
    if (platform === 'darwin') {
      exec(`open "${url}"`);
    } else if (platform === 'win32') {
      exec(`start "" "${url}"`);
    } else {
      // Linux: try xdg-open, then fallback
      exec(`xdg-open "${url}" 2>/dev/null || sensible-browser "${url}" 2>/dev/null`);
    }
  } catch { /* browser open is best-effort */ }
}

// ── Core adapter interface ──────────────────────────────────────────

/**
 * Check if clipboard relay is available (needs clipboard tools).
 */
function detect() {
  try {
    readClipboard();
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate a response via clipboard relay.
 *
 * Flow:
 *   1. Save prompt to clipboard
 *   2. Notify user to paste into web AI
 *   3. Poll clipboard for response (different from prompt)
 *   4. Return response
 *
 * @param {string} prompt
 * @param {object} [options]
 * @param {string} [options.service] - preferred web AI service key
 * @param {boolean} [options.openBrowser] - auto-open browser (default: false)
 * @param {function} [options.onStatus] - status callback
 * @returns {Promise<object>} standard gateway result
 */
async function generate(prompt, options = {}) {
  const service = options.service || _preferredService;
  const serviceInfo = WEB_AI_SERVICES[service] || WEB_AI_SERVICES.zhipu;
  const onStatus = options.onStatus || (() => {});

  // Step 1: Write prompt to clipboard
  try {
    writeClipboard(prompt);
  } catch (err) {
    return {
      success: false,
      content: `剪贴板写入失败: ${err.message}`,
      provider: `clipboard-relay (${serviceInfo.name})`,
      adapter: 'clipboard',
      attempts: [{ provider: serviceInfo.name, success: false, error: err.message }],
    };
  }

  onStatus({ phase: 'clipboard_ready', message: `提示已复制到剪贴板 → 请粘贴到 ${serviceInfo.name}` });

  // Step 2: Optionally open browser
  if (options.openBrowser) {
    openBrowser(serviceInfo.url);
    onStatus({ phase: 'browser_opened', message: `已打开 ${serviceInfo.name}` });
  }

  // Step 3: Print instructions (via console for immediate feedback)
  const chalk = require('chalk').default || require('chalk');
  console.log('');
  console.log(chalk.cyan('  ┌─────────────────────────────────────────────────┐'));
  console.log(chalk.cyan('  │') + chalk.bold.white(` 📋 剪贴板 AI 中继 — ${serviceInfo.name}`) + chalk.cyan((' ').repeat(Math.max(0, 48 - 22 - serviceInfo.name.length)) + '│'));
  console.log(chalk.cyan('  ├─────────────────────────────────────────────────┤'));
  console.log(chalk.cyan('  │') + chalk.white(' 1. 提示已复制到剪贴板                           ') + chalk.cyan('│'));
  console.log(chalk.cyan('  │') + chalk.white(` 2. 切换到浏览器 → 粘贴到 ${serviceInfo.name}`) + chalk.cyan((' ').repeat(Math.max(0, 48 - 26 - serviceInfo.name.length)) + '│'));
  console.log(chalk.cyan('  │') + chalk.white(' 3. 等待 AI 回复完成                             ') + chalk.cyan('│'));
  console.log(chalk.cyan('  │') + chalk.white(' 4. 全选 AI 回复 → 复制                          ') + chalk.cyan('│'));
  console.log(chalk.cyan('  │') + chalk.white(' 5. 切换回终端 — 自动检测剪贴板变化              ') + chalk.cyan('│'));
  console.log(chalk.cyan('  └─────────────────────────────────────────────────┘'));
  console.log(chalk.dim(`  等待中... (最长 ${MAX_WAIT_MS / 60000} 分钟)`));
  console.log('');

  // Step 4: Poll clipboard for response
  const promptFingerprint = prompt.trim().slice(0, 100);
  const startTime = Date.now();

  return new Promise((resolve) => {
    let lastContent = '';
    let settleTimer = null;

    const pollTimer = setInterval(() => {
      // Check timeout
      if (Date.now() - startTime > MAX_WAIT_MS) {
        clearInterval(pollTimer);
        if (settleTimer) clearTimeout(settleTimer);
        resolve({
          success: false,
          content: '剪贴板中继超时 — 未在限定时间内检测到回复',
          provider: `clipboard-relay (${serviceInfo.name})`,
          adapter: 'clipboard',
          attempts: [{ provider: serviceInfo.name, success: false, error: 'timeout' }],
        });
        return;
      }

      try {
        const current = readClipboard().trim();

        // Skip if empty or still the same as prompt
        if (!current) return;
        if (current === prompt.trim()) return;
        if (current.startsWith(promptFingerprint)) return;
        if (current.length < 10) return;  // too short to be a real response

        // Clipboard has changed — potential response
        if (current !== lastContent) {
          lastContent = current;

          // Reset settle timer (wait for streaming to finish)
          if (settleTimer) clearTimeout(settleTimer);
          settleTimer = setTimeout(() => {
            clearInterval(pollTimer);
            const elapsed = Date.now() - startTime;

            console.log(chalk.green(`  ✓ 已检测到 AI 回复 (${(elapsed / 1000).toFixed(1)}s)`));
            console.log('');

            onStatus({ phase: 'response_received', message: '回复已接收', elapsed });

            resolve({
              success: true,
              content: lastContent,
              provider: `clipboard-relay (${serviceInfo.name})`,
              adapter: 'clipboard',
              model: service,
              attempts: [{ provider: serviceInfo.name, success: true }],
            });
          }, RESPONSE_SETTLE_MS);
        }
      } catch { /* clipboard read error — skip this poll */ }
    }, POLL_INTERVAL_MS);
  });
}

/**
 * Get adapter status.
 */
function getStatus() {
  const available = detect();
  const serviceInfo = WEB_AI_SERVICES[_preferredService] || WEB_AI_SERVICES.zhipu;
  return {
    name: `剪贴板中继 (${serviceInfo.name})`,
    type: 'clipboard',
    available,
    detail: available
      ? `就绪 — 当前服务: ${serviceInfo.name}`
      : '不可用 — 未找到剪贴板工具 (需要 xclip/pbcopy)',
  };
}

/**
 * Set preferred web AI service.
 * @param {string} serviceKey - key from WEB_AI_SERVICES
 */
function setService(serviceKey) {
  if (WEB_AI_SERVICES[serviceKey]) {
    _preferredService = serviceKey;
    return true;
  }
  return false;
}

/**
 * Get available web AI services.
 */
function getServices() {
  return { ...WEB_AI_SERVICES };
}

/**
 * Get preferred service key.
 */
function getPreferredService() {
  return _preferredService;
}

module.exports = {
  detect,
  generate,
  getStatus,
  setService,
  getServices,
  getPreferredService,
  writeClipboard,
  readClipboard,
  openBrowser,
  WEB_AI_SERVICES,
};
