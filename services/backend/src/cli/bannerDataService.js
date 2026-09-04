'use strict';

/**
 * bannerDataService.js — Shared banner data for TUI and Classic modes.
 *
 * Both modes need the same data (version, model, adapter, auth, gateway status,
 * working directory) for their startup banners. This module provides a single
 * source of truth so both modes stay in sync.
 *
 * Usage:
 *   const { getBannerData, renderBanner } = require('./bannerDataService');
 *   const data = getBannerData();
 *   renderBanner(data); // Renders appropriately for current mode
 */

const path = require('path');
const os = require('os');
const { isTuiActive } = require('./uiResponse');

/**
 * Gather banner data from various sources.
 * @param {object} [opts]
 * @param {string} [opts.version] - Override version string
 * @param {string} [opts.aiProvider] - Override AI provider name
 * @returns {object} Banner data for rendering
 */
function getBannerData(opts = {}) {
  const version = opts.version || require(path.join(__dirname, '../../package.json')).version;
  const aiProvider = opts.aiProvider || '';

  // ── Gateway / Model Info ──
  let modelName = '';
  let adapterName = '';
  let effortLabel = 'high effort';
  let billingType = 'API Usage Billing';
  let gatewayStatus = '';
  let contextWindow = '';

  try {
    const gateway = require('../services/gateway/aiGateway');
    const active = gateway.getActiveAdapter();
    if (active) {
      adapterName = active.name || active.type || '';
      modelName = active.activeModel || process.env.GATEWAY_PREFERRED_MODEL || '';
    }
    // Gateway status
    const statuses = typeof gateway.getStatus === 'function' ? gateway.getStatus() : [];
    const available = statuses.filter((s) => s.available);
    if (available.length > 0) {
      gatewayStatus = `${available.length} 个适配器就绪`;
    } else if (statuses.length > 0) {
      gatewayStatus = '已配置，检测中';
    } else {
      gatewayStatus = '就绪';
    }
    // Context window
    const contextLimit = typeof gateway.getContextLimit === 'function' ? gateway.getContextLimit() : 0;
    if (contextLimit > 0) {
      contextWindow = `${Math.round(contextLimit / 1000)}k 令牌`;
    }
  } catch {
    /* best effort */
  }

  if (!modelName) {
    modelName = process.env.GATEWAY_PREFERRED_MODEL || process.env.OLLAMA_MODEL || 'auto';
  }

  // CC 后端口径对齐:横幅显示友好模型名("Opus 4.8")而非裸 slug
  try {
    const fn = require('./ccModelName').formatModelLabel;
    if (typeof fn === 'function') {
      modelName = fn(modelName);
    }
  } catch {
    /* keep raw slug */
  }

  if (!adapterName) {
    adapterName = process.env.GATEWAY_PREFERRED_ADAPTER || aiProvider || 'auto';
  }

  // ── Billing Type ──
  if (/ollama|local|llama/i.test(adapterName)) {
    billingType = '本地模型';
  } else if (/relay|web|clipboard/i.test(adapterName)) {
    billingType = '中继通道';
  }

  // ── Effort Level ──
  try {
    const ai = require('./ai');
    const effort = ai.getEffort ? ai.getEffort() : 'high';
    const labels = { max: '最大强度', high: '高强度', medium: '中强度', low: '低强度' };
    effortLabel = labels[effort] || '高强度';
  } catch {
    /* best effort */
  }

  // ── Auth Method ──
  let authMethod = 'API 密钥';
  try {
    if (/relay|clipboard/i.test(adapterName)) {
      authMethod = '中继';
    } else if (/oauth/i.test(adapterName)) {
      authMethod = 'OAuth';
    } else if (/ollama|local/i.test(adapterName)) {
      authMethod = '本地';
    }
  } catch {
    /* best effort */
  }

  // ── Greeting Name ──
  let greetingName = process.env.USER || process.env.USERNAME || 'user';
  try {
    const cliAuth = require('../services/cliAuthService');
    if (cliAuth && typeof cliAuth.checkSession === 'function') {
      const session = cliAuth.checkSession();
      if (session && session.loggedIn && session.username) {
        greetingName = session.username;
      }
    }
  } catch {
    /* keep OS-user fallback */
  }

  // ── Working Directory ──
  const cwd = process.cwd();
  const home = os.homedir();
  const cwdShort = cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;

  // ── Buddy Sprite ──
  let buddyLines = [];
  try {
    const buddyModule = require('../buddy');
    const companion = buddyModule.getActiveCompanion ? buddyModule.getActiveCompanion() : null;
    if (companion && companion.sprite) {
      buddyLines = companion.sprite;
    }
  } catch {
    /* no buddy */
  }

  // ── Git Branch ──
  let gitBranch = '';
  try {
    const { execSync } = require('child_process');
    let gitPath = 'git';
    if (process.platform === 'win32') {
      try {
        const detected = require('../services/gitExecutableDetector').detectGitExecutable();
        if (detected) { gitPath = detected; }
      } catch {
        /* keep 'git' */
      }
    }
    const out = execSync(`${gitPath} -C "${cwd}" rev-parse --abbrev-ref HEAD`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000,
    });
    gitBranch = out.trim() || '';
  } catch {
    /* git unavailable */
  }

  // ── Update Line ──
  let updateLine = '';
  try {
    const updateCoordinator = require('../services/updateCoordinator');
    if (updateCoordinator && typeof updateCoordinator.getUpdateLine === 'function') {
      const line = updateCoordinator.getUpdateLine();
      if (line) { updateLine = line; }
    }
  } catch {
    /* update check optional */
  }

  return {
    version,
    modelName,
    adapterName,
    effortLabel,
    billingType,
    gatewayStatus,
    contextWindow,
    authMethod,
    greetingName,
    cwd: cwdShort,
    buddyLines,
    gitBranch,
    updateLine,
  };
}

/**
 * Render the banner in the appropriate mode.
 * @param {object} [data] - Banner data (from getBannerData). If omitted, fetches fresh data.
 * @returns {void|React.Element} - Nothing for Classic, React element for TUI
 */
function renderBanner(data) {
  const bannerData = data || getBannerData();

  if (isTuiActive()) {
    // TUI mode: return React element for <Static> rendering
    // The actual component is in tui/ink-components/WelcomeBanner.js
    return null; // TUI handles banner via WelcomeBanner component
  } else {
    // Classic mode: render to console
    renderClassicBanner(bannerData);
  }
}

/**
 * Render banner in classic mode (plain text + ASCII art).
 * @param {object} data - Banner data
 */
function renderClassicBanner(data) {
  const chalk = require('chalk');
  const {
    version, modelName, adapterName, billingType,
    gatewayStatus, contextWindow, authMethod,
    greetingName, cwd, buddyLines, updateLine,
  } = data;

  const d = chalk.dim;
  const orange = chalk.hex('#D77757');
  const green = chalk.green;
  const yellow = chalk.yellow;

  const buddy = buddyLines && buddyLines.length > 0
    ? buddyLines
    : getClassicMonsterPetLines(orange);

  console.log('');

  // Side-by-side layout: buddy left, info right
  const infoLines = [
    `── khy OS v${version} ──`,
    '',
    `欢迎你，${green.bold(greetingName)}`,
    '',
    yellow('系统'),
    d(`认证：${authMethod}${contextWindow ? ` · 上下文：${contextWindow}` : ''}`),
    '',
    yellow('状态'),
    d(`网关：${gatewayStatus}`),
    updateLine ? d(`更新：${updateLine}`) : null,
    '',
    d(`${modelName}::${adapterName} · 工作目录：${cwd}`),
  ].filter(Boolean);

  // Print side by side if terminal is wide enough
  const maxBuddyWidth = Math.max(...buddy.map((l) => l.length));
  const maxInfoWidth = Math.max(...infoLines.map((l) => {
    // Strip ANSI for width calculation
    return l.replace(/\u001b\[[0-9;]*m/g, '').length;
  }));
  const sideBySide = process.stdout.columns > maxBuddyWidth + maxInfoWidth + 4;

  if (sideBySide) {
    const maxLines = Math.max(buddy.length, infoLines.length);
    for (let i = 0; i < maxLines; i++) {
      const buddyLine = buddy[i] || '';
      const infoLine = infoLines[i] || '';
      console.log(`${buddyLine.padEnd(maxBuddyWidth + 4)}${infoLine}`);
    }
  } else {
    // Stacked: buddy on top, info below
    buddy.forEach((line) => console.log(line));
    console.log('');
    infoLines.forEach((line) => console.log(line));
  }

  console.log('');
}

/**
 * Classic monster pet sprite (fallback).
 * @param {object} color - Chalk color function
 * @returns {string[]}
 */
function getClassicMonsterPetLines(color) {
  return [
    `       ${color('▄█▄')}`,
    `     ${color('▄█▀█▀█▄')}`,
    `     ${color('█▌░▀░▐█')}`,
    `      ${color('▜███▛')}`,
    `  ${color('▗▟████████▙▖')}`,
    `   ${color('▝▀▀▄██▄▀▀▘')}`,
    `       ${color('▐▌')}`,
  ];
}

module.exports = { getBannerData, renderBanner };
