/**
 * Symbol Resolver — translate human-friendly names to instrument codes.
 *
 * Supports:
 *   - Exact code:       "sh600519"  → "sh600519"
 *   - Numeric code:     "600519"    → "600519"
 *   - Chinese name:     "茅台"      → "sh600519" (fuzzy substring match)
 *   - Full name:        "贵州茅台"  → "sh600519"
 *   - Pinyin initials:  "gzmt"      → "sh600519" (if pinyin table loaded)
 */
const { muteDbLogs, restoreDbLogs } = require('./bootstrap');

// In-memory instrument cache: populated on first use
let _instruments = null;

/**
 * Whether the public-boundary input coercion guard is enabled.
 *
 * `resolveSymbol` / `searchInstruments` are exposed to third-party plugins
 * via the plugin `context.resolve` API (see plugins.js). Their documented
 * contract is `@param {string}`, and the real CLI path (routerHandlers
 * `resolveArg0`) always passes string tokens — so a non-string arrival is
 * NOT reachable from human input. This guard is defense-in-depth for the
 * plugin-facing contract only: it coerces non-string truthy inputs to a
 * string instead of throwing `input.trim is not a function`.
 *
 * When disabled, behavior is byte-identical to the legacy code for every
 * string input (String(str) === str); only the contrived non-string case
 * differs (legacy throws, guarded normalizes).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function _symbolInputGuardEnabled(env = process.env) {
  const raw = String((env && env.KHY_SYMBOL_INPUT_GUARD) || '').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return false;
  return true;
}

/**
 * Coerce a public-boundary input to a string when the guard is enabled.
 * Falsy values pass through unchanged (callers already handle them).
 */
function _coerceSymbolInput(value) {
  if (!_symbolInputGuardEnabled()) return value;
  // Falsy values pass through unchanged: callers already handle them
  // (resolveSymbol's `!input` early-return), so this stays byte-identical
  // to the legacy path for null/undefined/0/false/'' /NaN.
  if (!value) return value;
  if (typeof value === 'string') return value;
  try {
    return String(value);
  } catch {
    return '';
  }
}

// Simple pinyin-initial mapping for common stocks (extensible)
const PINYIN_MAP = {
  gzmt: 'sh600519', maotai: 'sh600519',
  zgpa: 'sh601318', pingan: 'sh601318',
  zsyh: 'sh600036', zhaoshang: 'sh600036',
  glyh: 'sh601398', gonghang: 'sh601398',
  wly: 'sz000858', wuliangye: 'sz000858',
  byd: 'sz002594', biyadi: 'sz002594',
  ndsd: 'sz300750', ningde: 'sz300750',
  dcfc: 'sz300059', dongfangcaifu: 'sz300059',
  mdjt: 'sz000333', meidi: 'sz000333',
  gldq: 'sz000651', geli: 'sz000651',
  hkws: 'sz002415', haikang: 'sz002415',
  szcs: 'sh000001',
  hs300: 'sh000300', hushen: 'sh000300',
  cybz: 'sz399006', chuangye: 'sz399006',
  szcz: 'sz399001',
  lt: 'rb_main', luowen: 'rb_main',
};

/**
 * Load instruments from database into cache.
 */
async function loadInstruments() {
  if (_instruments) return _instruments;

  try {
    const { bootstrap } = require('./bootstrap');
    await bootstrap({ silent: true });
    const { Instrument } = require('../models');
    const rows = await Instrument.findAll({ raw: true });
    _instruments = rows || [];
  } catch {
    _instruments = [];
  }
  return _instruments;
}

/**
 * Resolve a user input to a symbol code.
 * @param {string} input - e.g. "茅台", "sh600519", "600519", "gzmt"
 * @returns {Promise<{ symbol: string, name: string, matched: boolean }>}
 */
async function resolveSymbol(input) {
  input = _coerceSymbolInput(input);
  if (!input) return { symbol: input, name: '', matched: false };

  const trimmed = input.trim();

  // 1. Already looks like a code (starts with sh/sz/number or contains underscore)
  if (/^(sh|sz|[0-9])/i.test(trimmed) || /_/.test(trimmed)) {
    // Try to find name in DB for display
    const instruments = await loadInstruments();
    const found = instruments.find(i =>
      i.symbol === trimmed || i.symbol === trimmed.toLowerCase() || i.symbol === trimmed.toUpperCase()
    );
    return {
      symbol: trimmed,
      name: found ? found.name : '',
      matched: !!found,
    };
  }

  // 2. Check pinyin map
  const pyKey = trimmed.toLowerCase();
  if (PINYIN_MAP[pyKey]) {
    const instruments = await loadInstruments();
    const found = instruments.find(i => i.symbol === PINYIN_MAP[pyKey]);
    return {
      symbol: PINYIN_MAP[pyKey],
      name: found ? found.name : '',
      matched: true,
    };
  }

  // 3. Chinese name — fuzzy substring match in DB
  const instruments = await loadInstruments();

  // Exact name match first
  const exact = instruments.find(i => i.name === trimmed);
  if (exact) {
    return { symbol: exact.symbol, name: exact.name, matched: true };
  }

  // Substring match
  const partial = instruments.filter(i => i.name && i.name.includes(trimmed));
  if (partial.length === 1) {
    return { symbol: partial[0].symbol, name: partial[0].name, matched: true };
  }
  if (partial.length > 1) {
    // Return first match but include alternatives
    return {
      symbol: partial[0].symbol,
      name: partial[0].name,
      matched: true,
      alternatives: partial.slice(1, 5).map(i => `${i.symbol} ${i.name}`),
    };
  }

  // 4. No match — return as-is (might be a valid code not in our DB)
  return { symbol: trimmed, name: '', matched: false };
}

/**
 * Search instruments by keyword (for `search` command).
 * @param {string} keyword
 * @returns {Promise<Array<{ symbol, name, type, market }>>}
 */
async function searchInstruments(keyword) {
  if (_symbolInputGuardEnabled() && typeof keyword !== 'string') {
    keyword = keyword == null ? '' : _coerceSymbolInput(keyword);
    if (typeof keyword !== 'string') keyword = '';
  }
  const instruments = await loadInstruments();
  const kw = keyword.toLowerCase();

  return instruments.filter(i =>
    (i.symbol && i.symbol.toLowerCase().includes(kw)) ||
    (i.name && i.name.includes(keyword)) ||
    (i.market && i.market.toLowerCase().includes(kw)) ||
    (i.type && i.type.toLowerCase().includes(kw))
  );
}

/**
 * Clear the instrument cache (after db seed, etc.).
 */
function clearCache() {
  _instruments = null;
}

module.exports = { resolveSymbol, searchInstruments, clearCache, PINYIN_MAP, _symbolInputGuardEnabled, _coerceSymbolInput };
