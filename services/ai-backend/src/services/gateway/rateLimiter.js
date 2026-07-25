/**
 * In-memory token-bucket rate limiter for the data plane.
 *
 * Enforces per-token RPM (requests/min) and TPM (tokens/min). Limits resolve
 * with priority: token > customer > group default > env default.
 *
 * Default is in-memory (single-process). A Redis-backed mode can be added later
 * (gate on PROXY_RATELIMIT_REDIS) by borrowing the algorithm from
 * services/backend/src/services/gateway/redisRateLimiter.js — not imported
 * cross-service here.
 */
const WINDOW_MS = 60_000;

const ENV_RPM = parseInt(process.env.PROXY_DEFAULT_RPM, 10) || 0; // 0 = unlimited
const ENV_TPM = parseInt(process.env.PROXY_DEFAULT_TPM, 10) || 0;

// key -> { reqAvail, tokAvail, lastRefill, rpm, tpm }
const _buckets = new Map();

function nowMs() { return Date.now(); }

function resolveLimits({ tokenLimits, customerLimits, groupLimits } = {}) {
  const pick = (key) => {
    const t = tokenLimits?.[key];
    if (Number.isFinite(t) && t > 0) return t;
    const c = customerLimits?.[key];
    if (Number.isFinite(c) && c > 0) return c;
    const g = groupLimits?.[key];
    if (Number.isFinite(g) && g > 0) return g;
    const e = key === 'rpm' ? ENV_RPM : ENV_TPM;
    return e > 0 ? e : 0;
  };
  return { rpm: pick('rpm'), tpm: pick('tpm') };
}

function getBucket(key, rpm, tpm) {
  let b = _buckets.get(key);
  const t = nowMs();
  if (!b) {
    b = { reqAvail: rpm, tokAvail: tpm, lastRefill: t, rpm, tpm };
    _buckets.set(key, b);
    return b;
  }
  // Limits may have changed; keep available capped to new ceiling.
  b.rpm = rpm;
  b.tpm = tpm;
  // Lazy refill proportional to elapsed time (continuous refill).
  const elapsed = t - b.lastRefill;
  if (elapsed > 0) {
    if (rpm > 0) b.reqAvail = Math.min(rpm, b.reqAvail + (rpm * elapsed) / WINDOW_MS);
    if (tpm > 0) b.tokAvail = Math.min(tpm, b.tokAvail + (tpm * elapsed) / WINDOW_MS);
    b.lastRefill = t;
  }
  return b;
}

/**
 * Try to acquire 1 request + estTokens.
 * @returns {{ ok: boolean, scope?: 'rpm'|'tpm', retryAfterMs?: number }}
 */
function tryAcquire(key, { estTokens = 0, limits = {} } = {}) {
  const { rpm, tpm } = resolveLimits(limits);
  if (rpm <= 0 && tpm <= 0) return { ok: true }; // fully unlimited

  const b = getBucket(key, rpm, tpm);

  if (rpm > 0 && b.reqAvail < 1) {
    const deficit = 1 - b.reqAvail;
    return { ok: false, scope: 'rpm', retryAfterMs: Math.ceil((deficit / rpm) * WINDOW_MS) };
  }
  if (tpm > 0 && estTokens > 0 && b.tokAvail < estTokens) {
    const deficit = estTokens - b.tokAvail;
    return { ok: false, scope: 'tpm', retryAfterMs: Math.ceil((deficit / tpm) * WINDOW_MS) };
  }

  if (rpm > 0) b.reqAvail -= 1;
  if (tpm > 0 && estTokens > 0) b.tokAvail -= estTokens;
  return { ok: true };
}

/** Reconcile token bucket with the real output token count after a request. */
function reconcile(key, { estTokens = 0, actualTokens = 0 } = {}) {
  const b = _buckets.get(key);
  if (!b || b.tpm <= 0) return;
  const diff = actualTokens - estTokens; // positive = used more than reserved
  if (diff !== 0) b.tokAvail = Math.max(0, Math.min(b.tpm, b.tokAvail - diff));
}

/** Snapshot bucket state (for admin inspection). */
function snapshot() {
  const out = [];
  for (const [key, b] of _buckets.entries()) {
    out.push({
      key,
      rpm: b.rpm,
      tpm: b.tpm,
      reqAvail: Math.floor(b.reqAvail),
      tokAvail: Math.floor(b.tokAvail),
    });
  }
  return out;
}

module.exports = { tryAcquire, reconcile, resolveLimits, snapshot };
