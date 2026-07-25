/**
 * Customer Usage Service
 *
 * Tracks per-customer monthly usage (requests / tokens / cost) as the
 * authoritative counting source for quota enforcement.
 *
 * Concurrency model: in-memory authoritative counters mutated synchronously
 * (Node single-thread makes the increment atomic), with debounced persistence
 * and a flush on process exit. This avoids the read-modify-write race that a
 * per-request JSON rewrite would introduce.
 *
 * Persisted to ~/.khyquant/ai_gateway_customer_usage.json.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// 数据家单一真源:复用主 backend 的 getAppHome()/getAppDataDir(),与 backend 同根
// (避免全新 HOME 上 .khy / .khyquant 双写)。见 ../utils/dataHome。
const { getAppHome, getAppDataDir } = require('../utils/dataHome');
const KHY_DIR = getAppHome();
const USAGE_FILE = process.env.AI_GATEWAY_CUSTOMER_USAGE_FILE
  || getAppDataDir('ai_gateway_customer_usage.json');

const SAVE_DEBOUNCE_MS = 1000;

let _state = null;       // { [customerId]: { [YYYY-MM]: bucket } }
let _loaded = false;
let _saveTimer = null;
let _exitHooked = false;

function monthKey(date = new Date()) {
  return date.toISOString().slice(0, 7); // YYYY-MM
}

// 收敛到 utils/ensureDirSync 单一真源(跨根委托,调用点不变)
const ensureDir = require('../../../backend/src/utils/ensureDirSync');

function emptyBucket() {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costCny: 0,
    billedCny: 0,
  };
}

function ensureLoaded() {
  if (_loaded && _state) return;
  try {
    if (fs.existsSync(USAGE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8'));
      _state = raw && typeof raw === 'object' && raw.customers && typeof raw.customers === 'object'
        ? raw.customers
        : {};
    } else {
      _state = {};
    }
  } catch {
    _state = {};
  }
  _loaded = true;
  hookExitFlush();
}

function hookExitFlush() {
  if (_exitHooked) return;
  _exitHooked = true;
  const flush = () => { try { saveNow(); } catch { /* ignore */ } };
  process.on('exit', flush);
  process.on('SIGINT', () => { flush(); process.exit(0); });
  process.on('SIGTERM', () => { flush(); process.exit(0); });
}

function saveNow() {
  if (!_state) return;
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  ensureDir(path.dirname(USAGE_FILE));
  const payload = { version: 1, updatedAt: new Date().toISOString(), customers: _state };
  fs.writeFileSync(USAGE_FILE, JSON.stringify(payload, null, 2), 'utf-8');
}

function saveDebounced() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try { saveNow(); } catch { /* ignore */ }
  }, SAVE_DEBOUNCE_MS);
  // Don't keep the event loop alive solely for this timer.
  if (_saveTimer.unref) _saveTimer.unref();
}

/** Get the current-month usage bucket for a customer (read-only copy). */
function getMonthUsage(customerId, date = new Date()) {
  ensureLoaded();
  const cid = String(customerId || '');
  const mk = monthKey(date);
  const bucket = _state[cid]?.[mk];
  return { ...emptyBucket(), ...(bucket || {}), month: mk, customerId: cid };
}

/** Add usage to the current-month bucket. */
function addUsage(customerId, {
  requests = 0,
  inputTokens = 0,
  outputTokens = 0,
  tokens = 0,
  costCny = 0,
  billedCny = 0,
} = {}) {
  ensureLoaded();
  const cid = String(customerId || '');
  if (!cid) return;
  const mk = monthKey();
  if (!_state[cid]) _state[cid] = {};
  if (!_state[cid][mk]) _state[cid][mk] = emptyBucket();
  const b = _state[cid][mk];
  const total = tokens || (inputTokens + outputTokens);
  b.requests += requests;
  b.inputTokens += inputTokens;
  b.outputTokens += outputTokens;
  b.totalTokens += total;
  b.costCny += costCny;
  b.billedCny += billedCny;
  saveDebounced();
  return b;
}

/**
 * Check whether a customer is within quota for the current month.
 * quota: { monthlyRequests, monthlyTokens, monthlyBudgetCny }; 0 = unlimited.
 * Gate semantics: block when already-used >= limit (last request may slightly
 * overshoot; reconciled on settle).
 * @returns {{ ok: boolean, scope?: string, used?: number, limit?: number }}
 */
function checkQuota(customer) {
  const quota = customer?.quota || {};
  const usage = getMonthUsage(customer?.id);

  if (quota.monthlyRequests > 0 && usage.requests >= quota.monthlyRequests) {
    return { ok: false, scope: 'requests', used: usage.requests, limit: quota.monthlyRequests };
  }
  if (quota.monthlyTokens > 0 && usage.totalTokens >= quota.monthlyTokens) {
    return { ok: false, scope: 'tokens', used: usage.totalTokens, limit: quota.monthlyTokens };
  }
  if (quota.monthlyBudgetCny > 0 && usage.billedCny >= quota.monthlyBudgetCny) {
    return { ok: false, scope: 'budget', used: usage.billedCny, limit: quota.monthlyBudgetCny };
  }
  return { ok: true };
}

module.exports = {
  getMonthUsage,
  addUsage,
  checkQuota,
  saveNow,
  monthKey,
};
