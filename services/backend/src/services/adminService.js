/**
 * Admin Management Service — Protected administration functions.
 *
 * Provides management capabilities for the system administrator:
 * - View aggregated training data from user installations
 * - Export collected interaction data
 * - Monitor system health across deployments
 *
 * ALL admin functions require password: khyguanli0203
 * This module is obfuscated in production builds.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { getAppHome, _appHomeLiveResolveEnabled } = require('../utils/dataHome');

const ADMIN_PASSWORD = process.env.KHY_ADMIN_PASSWORD || 'khyguanli0203';

// 及时同步(admin↔user data):resolve the data home LAZILY per read, not once at
// require time. adminService is required very early (server boot) — freezing
// DATA_DIR at module load pinned it to the empty ~/.khy before any user-data
// producer established ~/.khyquant, so the admin dashboard read a parallel empty
// store for the whole process and only converged after a restart. Re-resolving
// via getAppHome() on every access lets admin see user data as soon as it lands.
//
// Gate off (KHY_APP_HOME_LIVE_RESOLVE={0,false,off,no}) → freeze on first access,
// byte-identical to the historical module-load freeze behavior.
let _frozenDataDir = null;
function _dataDir() {
  if (_appHomeLiveResolveEnabled()) return getAppHome();
  if (!_frozenDataDir) _frozenDataDir = getAppHome();
  return _frozenDataDir;
}
function _telemetryDir() {
  return path.join(_dataDir(), 'telemetry');
}

/**
 * Verify admin password.
 */
function verifyAdminPassword(password) {
  if (!password || typeof password !== 'string') return false;
  return password.trim() === ADMIN_PASSWORD;
}

/**
 * Initialize telemetry directory.
 */
function initTelemetry() {
  try {
    fs.mkdirSync(_telemetryDir(), { recursive: true });
  } catch { /* best effort */ }
}

/**
 * Collect anonymous usage data for model improvement.
 * Only collects interaction patterns, NOT personal data.
 */
function collectUsageData() {
  initTelemetry();

  const data = {
    deviceHash: crypto.createHash('sha256').update(`${os.hostname()}-${os.userInfo().username}`).digest('hex').slice(0, 16),
    timestamp: new Date().toISOString(),
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
  };

  // Collect training data stats (not raw data)
  try {
    const trainingFile = path.join(_dataDir(), 'training', 'interaction_records.jsonl');
    if (fs.existsSync(trainingFile)) {
      const lines = fs.readFileSync(trainingFile, 'utf-8').split(/\r?\n/).filter(Boolean);
      data.interactionCount = lines.length;
      data.lastInteraction = lines.length > 0 ? JSON.parse(lines[lines.length - 1]).timestamp : null;
    }
  } catch { /* ignore */ }

  // Collect growth summary
  try {
    const growthFile = path.join(_dataDir(), 'growth', 'manifest.json');
    if (fs.existsSync(growthFile)) {
      const manifest = JSON.parse(fs.readFileSync(growthFile, 'utf-8'));
      data.totalInteractions = manifest.totalInteractions;
    }
  } catch { /* ignore */ }

  return data;
}

/**
 * Export training data (admin only, requires password).
 */
function exportTrainingData(password, options = {}) {
  if (!verifyAdminPassword(password)) {
    return { success: false, error: '密码错误' };
  }

  const trainingFile = path.join(_dataDir(), 'training', 'interaction_records.jsonl');
  if (!fs.existsSync(trainingFile)) {
    return { success: false, error: '无训练数据' };
  }

  const lines = fs.readFileSync(trainingFile, 'utf-8').split(/\r?\n/).filter(Boolean);
  const records = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  // Filter by date range if specified
  let filtered = records;
  if (options.since) {
    const since = new Date(options.since).getTime();
    filtered = records.filter(r => new Date(r.timestamp).getTime() >= since);
  }

  // Export as JSONL
  const outputPath = options.output || path.join(_dataDir(), 'admin_export.jsonl');
  fs.writeFileSync(outputPath, filtered.map(r => JSON.stringify(r)).join('\n'));

  return { success: true, count: filtered.length, path: outputPath };
}

/**
 * Export growth data (admin only, requires password).
 */
function exportGrowthData(password) {
  if (!verifyAdminPassword(password)) {
    return { success: false, error: '密码错误' };
  }

  try {
    const growthService = require('./growthService');
    const outputPath = path.join(_dataDir(), 'admin_growth_export.tar.gz');
    const exported = growthService.exportGrowth(outputPath);
    return { success: true, path: exported };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Get system-wide stats (admin only).
 */
function getAdminStats(password) {
  if (!verifyAdminPassword(password)) {
    return { success: false, error: '密码错误' };
  }

  const stats = {
    usageData: collectUsageData(),
  };

  // Security events
  try {
    const secLog = path.join(_dataDir(), 'security.log');
    if (fs.existsSync(secLog)) {
      const lines = fs.readFileSync(secLog, 'utf-8').split(/\r?\n/).filter(Boolean);
      stats.securityEvents = lines.length;
    }
  } catch { /* ignore */ }

  // Model registry
  try {
    const registry = path.join(_dataDir(), 'training', 'model_registry.json');
    if (fs.existsSync(registry)) {
      stats.models = JSON.parse(fs.readFileSync(registry, 'utf-8'));
    }
  } catch { /* ignore */ }

  // Token usage
  try {
    const tokenFile = path.join(_dataDir(), 'token_usage.json');
    if (fs.existsSync(tokenFile)) {
      const usage = JSON.parse(fs.readFileSync(tokenFile, 'utf-8'));
      stats.tokenUsage = {
        totalTokens: usage.allTime?.totalTokens || 0,
        totalCost: usage.allTime?.totalCost || 0,
      };
    }
  } catch { /* ignore */ }

  return { success: true, stats };
}

/**
 * Prepare telemetry payload for server sync (opt-in).
 * This collects anonymous usage statistics to improve the system.
 * Only interaction COUNTS and patterns, never raw conversation content.
 */
function prepareTelemetryPayload() {
  const payload = collectUsageData();

  // Add anonymous strategy performance data
  try {
    const perfFile = path.join(_dataDir(), 'growth', 'strategy_performance.json');
    if (fs.existsSync(perfFile)) {
      const perf = JSON.parse(fs.readFileSync(perfFile, 'utf-8'));
      payload.strategyUsage = (perf.records || []).length;
      payload.bestStrategies = perf.insights?.bestStrategyByCondition || {};
    }
  } catch { /* ignore */ }

  // Add knowledge level
  try {
    const knFile = path.join(_dataDir(), 'growth', 'knowledge.json');
    if (fs.existsSync(knFile)) {
      const kn = JSON.parse(fs.readFileSync(knFile, 'utf-8'));
      payload.knowledgeLevel = kn.level;
      payload.knowledgeXP = kn.xp;
    }
  } catch { /* ignore */ }

  return payload;
}

/**
 * Sync telemetry to server (if configured and user opted in).
 * Called periodically in background.
 */
async function syncTelemetry() {
  try {
    const configFile = path.join(_dataDir(), 'config.json');
    if (!fs.existsSync(configFile)) return { synced: false, reason: 'no_config' };

    const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    if (!config.telemetryEnabled) return { synced: false, reason: 'opt_out' };

    const serverUrl = config.telemetryServer
      || require('../constants/serviceDefaults').TELEMETRY_DEFAULT_ENDPOINT;
    const payload = prepareTelemetryPayload();

    const https = require('https');
    const url = new URL(serverUrl);
    const body = JSON.stringify(payload);

    return new Promise((resolve) => {
      const req = https.request({
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 5000,
      }, (res) => {
        resolve({ synced: true, status: res.statusCode });
      });
      req.on('error', () => resolve({ synced: false, reason: 'network_error' }));
      req.on('timeout', () => { req.destroy(); resolve({ synced: false, reason: 'timeout' }); });
      req.write(body);
      req.end();
    });
  } catch {
    return { synced: false, reason: 'error' };
  }
}

module.exports = {
  verifyAdminPassword,
  collectUsageData,
  exportTrainingData,
  exportGrowthData,
  getAdminStats,
  prepareTelemetryPayload,
  syncTelemetry,
};
