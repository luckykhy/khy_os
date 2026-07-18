'use strict';

/**
 * Circuit Breaker — fault isolation for external service calls.
 *
 * Prevents cascading failures by tracking failure rates and
 * opening the circuit when threshold is exceeded.
 *
 * States:
 *   CLOSED  → normal operation, requests pass through
 *   OPEN    → all requests fail-fast without calling the service
 *   HALF_OPEN → single probe request allowed to test recovery
 *
 * Inspired by LibreChat's MCP circuit breaker with exponential backoff.
 *
 * @module circuitBreaker
 */

// ── States ────────────────────────────────────────────────────────

const STATE = Object.freeze({
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half_open',
});

// ── Defaults ──────────────────────────────────────────────────────

const DEFAULTS = Object.freeze({
  failureThreshold: 5,        // failures before opening
  resetTimeoutMs: 30000,      // 30s before first probe
  maxResetTimeoutMs: 300000,  // 5min max backoff
  backoffMultiplier: 2,       // exponential factor
  slidingWindowMs: 120000,    // 2min sliding window for failure counting
  halfOpenMaxProbes: 1,       // simultaneous probe requests
  successThreshold: 2,        // successes in half-open before closing
});

// ── Canonical exponential backoff ─────────────────────────────────
//
// Single source of the "base · multiplier^attempt, capped at max" backoff math
// for the whole gateway stack. Before C-4 this formula was re-implemented inline
// in three places (the breaker below, aiGateway cooldown escalation, aiGateway
// rate-limit pre-retry wait); they now all delegate here so there is exactly one
// implementation to reason about. Pure, deterministic, no clock.
//
//   backoff = min(maxMs, baseMs · multiplier^clamp(attempt, 0, maxSteps))
//
// `attempt` is the number of escalation steps (0 ⇒ just baseMs). `maxSteps`
// bounds the exponent so a long failure streak cannot overflow before the cap.
function computeBackoffMs({
  baseMs,
  attempt = 0,
  multiplier = DEFAULTS.backoffMultiplier,
  maxMs = DEFAULTS.maxResetTimeoutMs,
  maxSteps = Infinity,
} = {}) {
  const base = Math.max(0, Number(baseMs) || 0);
  const m = Number(multiplier);
  const safeMultiplier = Number.isFinite(m) && m > 0 ? m : DEFAULTS.backoffMultiplier;
  const steps = Math.max(0, Math.min(Number(attempt) || 0, maxSteps));
  const cap = Number.isFinite(maxMs) ? maxMs : Infinity;
  return Math.min(cap, base * Math.pow(safeMultiplier, steps));
}

// ── Circuit Breaker Class ─────────────────────────────────────────

class CircuitBreaker {
  /**
   * @param {string} name - Service identifier
   * @param {object} [options]
   * @param {number} [options.failureThreshold]
   * @param {number} [options.resetTimeoutMs]
   * @param {number} [options.maxResetTimeoutMs]
   * @param {number} [options.backoffMultiplier]
   * @param {number} [options.slidingWindowMs]
   * @param {number} [options.successThreshold]
   * @param {Function} [options.onStateChange] - (name, from, to) => void
   */
  constructor(name, options = {}) {
    this.name = name;
    this.opts = { ...DEFAULTS, ...options };
    this.state = STATE.CLOSED;
    this._failures = [];           // timestamps of recent failures
    this._openedAt = 0;
    this._currentResetTimeout = this.opts.resetTimeoutMs;
    this._halfOpenSuccesses = 0;
    this._halfOpenProbes = 0;
    this._onStateChange = options.onStateChange || null;
  }

  /**
   * Execute a function through the circuit breaker.
   *
   * @param {Function} fn - async () => T
   * @returns {Promise<T>}
   * @throws {Error} If circuit is open
   */
  async execute(fn) {
    if (!this._canExecute()) {
      const err = new Error(`Circuit breaker "${this.name}" is OPEN. Retry after ${this._remainingOpenMs()}ms.`);
      err.name = 'CircuitBreakerOpenError';
      err.circuitBreaker = this.name;
      err.retryAfterMs = this._remainingOpenMs();
      throw err;
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure();
      throw err;
    }
  }

  /**
   * Check if a request can proceed.
   * @returns {boolean}
   */
  _canExecute() {
    switch (this.state) {
      case STATE.CLOSED:
        return true;

      case STATE.OPEN: {
        const elapsed = Date.now() - this._openedAt;
        if (elapsed >= this._currentResetTimeout) {
          this._transitionTo(STATE.HALF_OPEN);
          this._halfOpenProbes = 1;
          this._halfOpenSuccesses = 0;
          return true;
        }
        return false;
      }

      case STATE.HALF_OPEN:
        if (this._halfOpenProbes < this.opts.halfOpenMaxProbes) {
          this._halfOpenProbes++;
          return true;
        }
        return false;

      default:
        return true;
    }
  }

  /**
   * Record a successful execution.
   */
  _onSuccess() {
    switch (this.state) {
      case STATE.HALF_OPEN:
        this._halfOpenSuccesses++;
        if (this._halfOpenSuccesses >= this.opts.successThreshold) {
          this._currentResetTimeout = this.opts.resetTimeoutMs; // reset backoff
          this._transitionTo(STATE.CLOSED);
        }
        break;
      case STATE.CLOSED:
        // Clear old failures
        this._pruneFailures();
        break;
    }
  }

  /**
   * Record a failed execution.
   */
  _onFailure() {
    this._failures.push(Date.now());
    this._pruneFailures();

    switch (this.state) {
      case STATE.HALF_OPEN:
        // Probe failed — re-open with one more step of the canonical backoff.
        this._currentResetTimeout = computeBackoffMs({
          baseMs: this._currentResetTimeout,
          attempt: 1,
          multiplier: this.opts.backoffMultiplier,
          maxMs: this.opts.maxResetTimeoutMs,
        });
        this._transitionTo(STATE.OPEN);
        break;

      case STATE.CLOSED:
        if (this._failures.length >= this.opts.failureThreshold) {
          this._transitionTo(STATE.OPEN);
        }
        break;
    }
  }

  /**
   * Remove failures outside the sliding window.
   */
  _pruneFailures() {
    const cutoff = Date.now() - this.opts.slidingWindowMs;
    this._failures = this._failures.filter(t => t > cutoff);
  }

  /**
   * Remaining ms before circuit attempts half-open probe.
   * @returns {number}
   */
  _remainingOpenMs() {
    if (this.state !== STATE.OPEN) return 0;
    return Math.max(0, this._currentResetTimeout - (Date.now() - this._openedAt));
  }

  /**
   * Transition to a new state.
   * @param {string} newState
   */
  _transitionTo(newState) {
    const oldState = this.state;
    this.state = newState;
    if (newState === STATE.OPEN) {
      this._openedAt = Date.now();
    }
    if (this._onStateChange && oldState !== newState) {
      try { this._onStateChange(this.name, oldState, newState); } catch { /* ignore */ }
    }
  }

  /**
   * Force reset the circuit breaker to closed state.
   */
  reset() {
    this._failures = [];
    this._halfOpenSuccesses = 0;
    this._halfOpenProbes = 0;
    this._currentResetTimeout = this.opts.resetTimeoutMs;
    this._transitionTo(STATE.CLOSED);
  }

  /**
   * Get current status.
   * @returns {{ state: string, failures: number, remainingMs: number, resetTimeoutMs: number }}
   */
  getStatus() {
    this._pruneFailures();
    return {
      name: this.name,
      state: this.state,
      failures: this._failures.length,
      remainingMs: this._remainingOpenMs(),
      resetTimeoutMs: this._currentResetTimeout,
    };
  }
}

// ── Registry (shared breakers) ────────────────────────────────────

const _breakers = new Map();

/**
 * Get or create a circuit breaker by name.
 * @param {string} name
 * @param {object} [options]
 * @returns {CircuitBreaker}
 */
function getBreaker(name, options) {
  if (!_breakers.has(name)) {
    _breakers.set(name, new CircuitBreaker(name, options));
  }
  return _breakers.get(name);
}

/**
 * Get status of all circuit breakers.
 * @returns {Array<object>}
 */
function getAllStatus() {
  return [..._breakers.values()].map(b => b.getStatus());
}

/**
 * Reset all circuit breakers.
 */
function resetAll() {
  for (const b of _breakers.values()) b.reset();
}

module.exports = {
  CircuitBreaker,
  getBreaker,
  getAllStatus,
  resetAll,
  computeBackoffMs,
  STATE,
  DEFAULTS,
};
