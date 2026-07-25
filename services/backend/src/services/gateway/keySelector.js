'use strict';

const STRATEGIES = Object.freeze({
  ROUND_ROBIN: 'round-robin',
  LEAST_FAIL: 'least-fail',
  LEAST_USED: 'least-used',
  HYBRID: 'hybrid',
  FILL_FIRST: 'fill-first',  // 借鉴 Hermes Agent: 耗尽单 key 配额再换
  RANDOM: 'random',
});

const _roundRobinCursors = new Map();

function normalizeStrategy(raw) {
  const normalized = String(raw || '').trim().toLowerCase();
  if (!normalized) return STRATEGIES.ROUND_ROBIN;
  if (['round-robin', 'roundrobin', 'rr'].includes(normalized)) return STRATEGIES.ROUND_ROBIN;
  if (['least-fail', 'least_fail', 'fail'].includes(normalized)) return STRATEGIES.LEAST_FAIL;
  if (['least-used', 'least_used', 'usage'].includes(normalized)) return STRATEGIES.LEAST_USED;
  if (['hybrid', 'balanced'].includes(normalized)) return STRATEGIES.HYBRID;
  if (['fill-first', 'fill_first', 'fill', 'exhaust'].includes(normalized)) return STRATEGIES.FILL_FIRST;
  if (['random', 'rand'].includes(normalized)) return STRATEGIES.RANDOM;
  return STRATEGIES.ROUND_ROBIN;
}

function parseStrategyMap(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;

  const input = String(raw || '').trim();
  if (!input) return {};

  if ((input.startsWith('{') && input.endsWith('}')) || (input.startsWith('[') && input.endsWith(']'))) {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      return {};
    }
    return {};
  }

  const mapped = {};
  const pairs = input.split(/\r?\n|,/g).map(s => s.trim()).filter(Boolean);
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!key || !value) continue;
    mapped[key] = value;
  }
  return mapped;
}

function resolveStrategy(provider, options = {}) {
  const providerKey = String(provider || '').trim().toLowerCase();
  const explicit = options.strategy !== undefined
    ? options.strategy
    : process.env.GATEWAY_KEY_SELECTION_STRATEGY;
  const mapRaw = options.strategyMap !== undefined
    ? options.strategyMap
    : process.env.GATEWAY_KEY_SELECTION_STRATEGY_MAP;
  const strategyMap = parseStrategyMap(mapRaw);

  let fromMap = null;
  if (providerKey && strategyMap && typeof strategyMap === 'object') {
    for (const [rawProvider, strategyName] of Object.entries(strategyMap)) {
      if (String(rawProvider || '').trim().toLowerCase() !== providerKey) continue;
      fromMap = strategyName;
      break;
    }
  }

  return normalizeStrategy(fromMap || explicit);
}

function sortByKeyId(a, b) {
  return String(a.keyId || '').localeCompare(String(b.keyId || ''));
}

function normalizeCandidate(row) {
  return {
    keyId: String(row.keyId || row.id || '').trim(),
    key: row.key || '',
    endpoint: row.endpoint || '',
    label: row.label || '',
    priority: Number(row.priority || 0),
    backoffLevel: Number(row.backoffLevel || 0),
    totalRequests: Number(row.totalRequests || 0),
    totalFailures: Number(row.totalFailures || 0),
    lastUsedAt: Number(row.lastUsedAt || 0),
  };
}

function computeFailureRate(candidate) {
  const requests = Math.max(1, Number(candidate.totalRequests || 0));
  const failures = Math.max(0, Number(candidate.totalFailures || 0));
  return failures / requests;
}

function selectRoundRobin(candidates, provider = '') {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const topPriority = Math.max(...candidates.map(c => Number(c.priority || 0)));
  const topGroup = candidates
    .filter(c => Number(c.priority || 0) === topPriority)
    .sort(sortByKeyId);
  if (topGroup.length === 0) return null;

  const cursorKey = `${String(provider || '').toLowerCase()}|${topPriority}`;
  const cursor = _roundRobinCursors.get(cursorKey) || 0;
  const selected = topGroup[cursor % topGroup.length];
  _roundRobinCursors.set(cursorKey, (cursor + 1) % topGroup.length);
  return selected;
}

function filterTopPriority(candidates) {
  const topPriority = Math.max(...candidates.map(c => Number(c.priority || 0)));
  return candidates.filter(c => Number(c.priority || 0) === topPriority);
}

function selectLeastFail(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const pool = filterTopPriority(candidates);
  const sorted = [...pool].sort((a, b) => {
    const rateDiff = computeFailureRate(a) - computeFailureRate(b);
    if (rateDiff !== 0) return rateDiff;
    const failureDiff = Number(a.totalFailures || 0) - Number(b.totalFailures || 0);
    if (failureDiff !== 0) return failureDiff;
    const reqDiff = Number(a.totalRequests || 0) - Number(b.totalRequests || 0);
    if (reqDiff !== 0) return reqDiff;
    return sortByKeyId(a, b);
  });
  return sorted[0] || null;
}

function selectLeastUsed(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const pool = filterTopPriority(candidates);
  const sorted = [...pool].sort((a, b) => {
    const reqDiff = Number(a.totalRequests || 0) - Number(b.totalRequests || 0);
    if (reqDiff !== 0) return reqDiff;
    const usedDiff = Number(a.lastUsedAt || 0) - Number(b.lastUsedAt || 0);
    if (usedDiff !== 0) return usedDiff;
    const failDiff = Number(a.totalFailures || 0) - Number(b.totalFailures || 0);
    if (failDiff !== 0) return failDiff;
    return sortByKeyId(a, b);
  });
  return sorted[0] || null;
}

function selectHybrid(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const pool = filterTopPriority(candidates);
  const sorted = [...pool].sort((a, b) => {
    const scoreA = (computeFailureRate(a) * 100)
      + (Number(a.backoffLevel || 0) * 8)
      + (Number(a.totalRequests || 0) * 0.05);
    const scoreB = (computeFailureRate(b) * 100)
      + (Number(b.backoffLevel || 0) * 8)
      + (Number(b.totalRequests || 0) * 0.05);
    const scoreDiff = scoreA - scoreB;
    if (Math.abs(scoreDiff) > 1e-9) return scoreDiff;
    return sortByKeyId(a, b);
  });
  return sorted[0] || null;
}

// ── 主动冷却阈值（借鉴 Hermes Agent credential_pool.py） ───────────
const COOLING_WINDOW_MS = 60_000;     // 1 分钟窗口
const COOLING_REQUEST_THRESHOLD = 40; // 窗口内 >40 次请求 → 降权
const _recentRequestTimestamps = new Map(); // keyId → timestamp[]

/**
 * 记录 key 使用时间戳（供冷却策略使用）
 */
function recordKeyUsage(keyId) {
  const now = Date.now();
  const ts = _recentRequestTimestamps.get(keyId) || [];
  ts.push(now);
  // 只保留最近窗口内的
  const cutoff = now - COOLING_WINDOW_MS;
  const recent = ts.filter(t => t > cutoff);
  _recentRequestTimestamps.set(keyId, recent);
}

/**
 * 检查 key 是否处于冷却状态（近 1 分钟请求过多）
 */
function isKeyCooling(keyId) {
  const now = Date.now();
  const ts = _recentRequestTimestamps.get(keyId) || [];
  const cutoff = now - COOLING_WINDOW_MS;
  const recent = ts.filter(t => t > cutoff);
  return recent.length >= COOLING_REQUEST_THRESHOLD;
}

/**
 * Fill-first 策略（借鉴 Hermes Agent）：
 * 优先用同一个 key 直到它被冷却或失败过多，再切换到下一个。
 * 适合有明确配额的 key（如按月限额的 API key）。
 */
function selectFillFirst(candidates, provider = '') {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const pool = filterTopPriority(candidates);
  if (pool.length === 0) return null;

  // 按 keyId 排序确保稳定
  const sorted = [...pool].sort(sortByKeyId);

  // 找到第一个不处于冷却状态的
  for (const c of sorted) {
    if (!isKeyCooling(c.keyId) && Number(c.backoffLevel || 0) === 0) {
      return c;
    }
  }

  // 所有 key 都冷却中 → 回退到最少使用
  return selectLeastUsed(candidates);
}

/**
 * Random 策略：随机选取（适合负载均衡无明确优先级的场景）
 */
function selectRandom(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const pool = filterTopPriority(candidates);
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

function selectCandidate(rawCandidates, options = {}) {
  const provider = String(options.provider || '').trim().toLowerCase();
  const strategy = resolveStrategy(provider, options);
  const candidates = Array.isArray(rawCandidates)
    ? rawCandidates.map(normalizeCandidate).filter(c => c.keyId && c.key)
    : [];
  if (candidates.length === 0) return null;

  if (strategy === STRATEGIES.LEAST_FAIL) return selectLeastFail(candidates);
  if (strategy === STRATEGIES.LEAST_USED) return selectLeastUsed(candidates);
  if (strategy === STRATEGIES.HYBRID) return selectHybrid(candidates);
  if (strategy === STRATEGIES.FILL_FIRST) return selectFillFirst(candidates, provider);
  if (strategy === STRATEGIES.RANDOM) return selectRandom(candidates);
  return selectRoundRobin(candidates, provider);
}

module.exports = {
  STRATEGIES,
  normalizeStrategy,
  parseStrategyMap,
  resolveStrategy,
  selectCandidate,
  recordKeyUsage,
  isKeyCooling,
};
