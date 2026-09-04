'use strict';

/**
 * bannerDataService.js — Shared banner data for TUI and Classic modes.
 *
 * Both modes need the same data (version, model, adapter, auth, gateway status,
 * working directory) for their startup banners. This module provides a single
 * source of truth so both modes stay in sync.
 */

const path = require('path');
const os = require('os');

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

module.exports = { getBannerData };
