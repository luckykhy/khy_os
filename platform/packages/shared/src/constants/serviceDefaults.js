'use strict';

/**
 * serviceDefaults.js — @khy/shared single source of truth for endpoint defaults.
 *
 * Mirrors the backend's constants/serviceDefaults.js contract: any literal
 * endpoint/host:port default must live HERE and be imported from here, never
 * inlined in consuming modules (zero-hardcode rule; enforced by
 * scripts/ci/check-agent-rules.js which exempts exactly this path).
 */

// Redis connection for the Level-1 cache; env override first, loopback default
// second so a plain `docker run redis` works with zero configuration.
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

module.exports = {
  REDIS_URL,
};
