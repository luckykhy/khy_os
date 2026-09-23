'use strict';

/**
 * keyStrategyDict.js — pure strategy dictionary + name/label normalization.
 *
 * Stateless leaf split out of keySelector.js so the strategy vocabulary
 * (canonical names, alias tables, strategy-map parsing) can be reused without
 * pulling in the stateful selection engine (round-robin cursors, cooling
 * counters, cleanup timer). Consumed by keySelector.js and cpaKeyPool.js.
 */

const STRATEGIES = Object.freeze({
  ROUND_ROBIN: 'round-robin',
  LEAST_FAIL: 'least-fail',
  LEAST_USED: 'least-used',
  HYBRID: 'hybrid',
  FILL_FIRST: 'fill-first', // 借鉴 Hermes Agent: 耗尽单 key 配额再换
  RANDOM: 'random',
});

function normalizeStrategy(raw) {
  const normalized = String(raw || '')
    .trim()
    .toLowerCase();
  if (!normalized) {
    return STRATEGIES.ROUND_ROBIN;
  }
  if (['round-robin', 'roundrobin', 'rr'].includes(normalized)) {
    return STRATEGIES.ROUND_ROBIN;
  }
  if (['least-fail', 'least_fail', 'fail'].includes(normalized)) {
    return STRATEGIES.LEAST_FAIL;
  }
  if (['least-used', 'least_used', 'usage'].includes(normalized)) {
    return STRATEGIES.LEAST_USED;
  }
  if (['hybrid', 'balanced'].includes(normalized)) {
    return STRATEGIES.HYBRID;
  }
  if (['fill-first', 'fill_first', 'fill', 'exhaust'].includes(normalized)) {
    return STRATEGIES.FILL_FIRST;
  }
  if (['random', 'rand'].includes(normalized)) {
    return STRATEGIES.RANDOM;
  }
  return STRATEGIES.ROUND_ROBIN;
}

function parseStrategyMap(raw) {
  if (!raw) {
    return {};
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw;
  }

  const input = String(raw || '').trim();
  if (!input) {
    return {};
  }

  if (
    (input.startsWith('{') && input.endsWith('}')) ||
    (input.startsWith('[') && input.endsWith(']'))
  ) {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      return {};
    }
    return {};
  }

  const mapped = {};
  const pairs = input
    .split(/\r?\n|,/g)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx <= 0) {
      continue;
    }
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!key || !value) {
      continue;
    }
    mapped[key] = value;
  }
  return mapped;
}

module.exports = {
  STRATEGIES,
  normalizeStrategy,
  parseStrategyMap,
};
