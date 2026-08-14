/**
 * Reference price provider for price-limit validation.
 *
 * Resolution order:
 *   1. Sina Finance real-time API  (marketDataService)
 *   2. Last known close from DB    (klineDataService)
 *   3. Static fallback table       (for offline / demo use)
 *
 * Prices are cached in-memory for 5 minutes to avoid hammering
 * external APIs on every order submission.
 */

const MarketDataService = require('../services/marketDataService');
const KlineDataService = require('../services/klineDataService');

const STATIC_FALLBACK = {
  'sh000300': 4660, '000300': 4660, 'sh000001': 3350, '000001': 3350,
  'sz399001': 10800, 'sz399006': 2100, 'sh600519': 1680, '600519': 1680,
  'sh600036': 38, 'sz000001': 11, 'sz000858': 148, 'sh600000': 7.8,
  'sh601318': 52, 'sz002594': 280, 'sz000002': 8.5,
  'rb_main': 3380, 'rb2510': 3380, 'IF_main': 4660, 'cu_main': 69500,
  'au_main': 580, 'ag_main': 7200, 'sc_main': 560,
};

// Singleton service instances (lazy-initialized)
let mds = null;
let kds = null;

function getMarketDataService() {
  if (!mds) mds = new MarketDataService();
  return mds;
}

function getKlineDataService() {
  if (!kds) kds = new KlineDataService();
  return kds;
}

// In-memory cache: symbol -> { price, expiresAt }
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get reference price for a symbol.
 * @param {string} symbol - e.g. 'sh600519' or '600519'
 * @returns {Promise<number|null>}
 */
async function getReferencePrice(symbol) {
  if (!symbol) return null;

  const cleanSym = symbol.replace(/^(sh|sz)/i, '');

  // Check cache first
  const cached = cache.get(symbol) || cache.get(cleanSym);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.price;
  }

  let price = null;

  // Priority 1: real-time quote from Sina
  try {
    const quote = await getMarketDataService().getRealTimeQuote(symbol);
    if (quote && quote.preClose > 0) {
      price = quote.preClose; // use previous close as reference for ±10% limits
    }
  } catch {
    // Sina unavailable, fall through
  }

  // Priority 2: last known close from database
  if (!price) {
    try {
      const svc = getKlineDataService();
      const dbPrice = await svc.getLastClosePrice(symbol) ||
                      await svc.getLastClosePrice(cleanSym);
      if (dbPrice && dbPrice > 0) {
        price = dbPrice;
      }
    } catch {
      // DB unavailable, fall through
    }
  }

  // Priority 3: static fallback
  if (!price) {
    price = STATIC_FALLBACK[symbol] || STATIC_FALLBACK[cleanSym] || null;
  }

  // Cache the result
  if (price) {
    const entry = { price, expiresAt: Date.now() + CACHE_TTL_MS };
    cache.set(symbol, entry);
    cache.set(cleanSym, entry);
  }

  return price;
}

module.exports = { getReferencePrice, STATIC_FALLBACK };
