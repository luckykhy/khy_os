/**
 * Subscription Service — enforce tier limits via server-side validation.
 *
 * Architecture:
 * - Local code is FULL (open source, all features work locally)
 * - Pro value comes from CLOUD SERVICES that require server validation:
 *   - AI cloud tokens (Claude/GPT quota from our pool)
 *   - Real-time market data streaming
 *   - Cloud sync & backup
 *   - Marketplace purchases
 *   - Organization features
 *   - Priority API endpoints
 *
 * - pip users get complete local functionality for free
 * - Cloud features require login + valid subscription token
 * - Token is JWT signed by server, checked per request
 * - Local mode works 100% offline (no tier restriction)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROFILE_DIR = path.join(os.homedir(), '.khyquant');
const SUBSCRIPTION_CACHE_PATH = path.join(PROFILE_DIR, 'subscription.json');

// Tier definitions
const TIERS = {
  free: {
    name: 'Free',
    label: '免费版',
    limits: {
      cloud_ai_requests: 100,        // per month
      cloud_ai_tokens: 100000,       // per month
      cloud_storage_mb: 50,
      realtime_symbols: 5,
      marketplace_purchases: 0,
      devices: 1,
      org_members: 0,
    },
  },
  pro: {
    name: 'Pro',
    label: '专业版',
    limits: {
      cloud_ai_requests: 5000,
      cloud_ai_tokens: 5000000,
      cloud_storage_mb: 5120,
      realtime_symbols: 100,
      marketplace_purchases: -1,     // unlimited
      devices: 5,
      org_members: 0,
    },
  },
  enterprise: {
    name: 'Enterprise',
    label: '企业版',
    limits: {
      cloud_ai_requests: -1,         // unlimited
      cloud_ai_tokens: -1,           // unlimited
      cloud_storage_mb: 102400,
      realtime_symbols: -1,
      marketplace_purchases: -1,
      devices: -1,
      org_members: 50,
    },
  },
};

/**
 * Get cached subscription info (from last server sync).
 */
function getCachedSubscription() {
  try {
    if (fs.existsSync(SUBSCRIPTION_CACHE_PATH)) {
      const data = JSON.parse(fs.readFileSync(SUBSCRIPTION_CACHE_PATH, 'utf-8'));
      // Check if cache is still valid (max 24h)
      if (data.cachedAt && Date.now() - data.cachedAt < 24 * 60 * 60 * 1000) {
        return data;
      }
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Cache subscription info locally.
 */
function cacheSubscription(info) {
  try {
    if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });
    fs.writeFileSync(SUBSCRIPTION_CACHE_PATH, JSON.stringify({
      ...info,
      cachedAt: Date.now(),
    }, null, 2), 'utf-8');
  } catch { /* ignore */ }
}

/**
 * Get current user's subscription tier.
 * Falls back to 'free' if not logged in or offline.
 */
function getCurrentTier() {
  const cached = getCachedSubscription();
  if (cached?.tier) return cached.tier;
  return 'free';
}

/**
 * Get limits for current tier.
 */
function getCurrentLimits() {
  const tier = getCurrentTier();
  return TIERS[tier]?.limits || TIERS.free.limits;
}

/**
 * Check if a specific cloud feature is available at current tier.
 */
function canUseFeature(feature) {
  const limits = getCurrentLimits();
  const limit = limits[feature];
  if (limit === undefined) return true; // Unknown feature = allow
  if (limit === -1) return true; // Unlimited
  if (limit === 0) return false; // Disabled
  return true; // Has some limit (usage check is separate)
}

/**
 * Check remaining quota for a metered feature.
 * Returns { allowed, remaining, limit } or null if not metered.
 */
function checkQuota(feature) {
  const limits = getCurrentLimits();
  const limit = limits[feature];
  if (limit === undefined || limit === -1) return { allowed: true, remaining: Infinity, limit: -1 };
  if (limit === 0) return { allowed: false, remaining: 0, limit: 0 };

  const cached = getCachedSubscription();
  const usage = cached?.usage?.[feature] || 0;
  const remaining = Math.max(0, limit - usage);

  return { allowed: remaining > 0, remaining, limit };
}

/**
 * Validate subscription with server.
 * Called periodically and on login.
 */
async function validateWithServer() {
  try {
    const cloudSync = require('./cloudSync');
    if (!cloudSync.isLoggedIn()) return null;

    const endpoint = cloudSync.getEndpoint();
    const config = cloudSync.loadCloudConfig();

    const https = require('https');
    const http = require('http');
    const url = new URL(`${endpoint}/v1/subscription/status`);
    const transport = url.protocol === 'https:' ? https : http;

    return new Promise((resolve) => {
      const req = transport.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${config.token}`,
          'User-Agent': 'khy-quant-cli',
        },
        timeout: 8000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.tier) {
              cacheSubscription(result);
              resolve(result);
            } else {
              resolve(null);
            }
          } catch { resolve(null); }
        });
      });

      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    });
  } catch {
    return null;
  }
}

/**
 * Get subscription display info for CLI.
 */
function getSubscriptionDisplay() {
  const tier = getCurrentTier();
  const tierInfo = TIERS[tier];
  const cached = getCachedSubscription();

  return {
    tier,
    label: tierInfo?.label || '免费版',
    expiresAt: cached?.expiresAt,
    usage: cached?.usage || {},
    limits: tierInfo?.limits || TIERS.free.limits,
  };
}

/**
 * Check if user is in cloud mode (logged in with valid subscription).
 */
function isCloudMode() {
  try {
    const cloudSync = require('./cloudSync');
    return cloudSync.isLoggedIn();
  } catch {
    return false;
  }
}

module.exports = {
  TIERS,
  getCurrentTier,
  getCurrentLimits,
  canUseFeature,
  checkQuota,
  validateWithServer,
  getSubscriptionDisplay,
  cacheSubscription,
  isCloudMode,
};
