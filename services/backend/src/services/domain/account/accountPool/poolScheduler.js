/**
 * poolScheduler.js — Garbage collection and lease expiry timer management.
 *
 * Handles periodic cleanup of expired leases and auto-recovery of
 * cooldown-expired accounts. Extracted from accountPool.js for cohesion.
 *
 * @module services/accountPool/poolScheduler
 */
'use strict';

// ── Exports (factory) ──

/**
 * Create a scheduler instance bound to the pool's shared state.
 * @param {object} deps
 * @param {function} deps.getDb - returns the current sequelize instance (_db)
 * @param {number} deps.HEARTBEAT_TIMEOUT_MS
 * @param {number} deps.GC_INTERVAL_MS
 * @returns {{ startGC, runGC, stopGC }}
 */
module.exports = function createScheduler(deps) {
  const { getDb, HEARTBEAT_TIMEOUT_MS, GC_INTERVAL_MS } = deps;

  let _gcTimer = null;

  function startGC() {
    if (_gcTimer) {
      clearInterval(_gcTimer);
    }
    _gcTimer = setInterval(() => {
      runGC().catch(() => {});
    }, GC_INTERVAL_MS);
    _gcTimer.unref();
  }

  async function runGC() {
    const _db = getDb();
    if (!_db) {
      return;
    }

    try {
      const timeoutMinutes = Math.max(1, Math.floor(HEARTBEAT_TIMEOUT_MS / 60000));
      const [expired] = await _db.query(
        `SELECT request_id, account_id FROM account_leases
         WHERE status = 'active' AND (
           lease_until < datetime('now')
           OR last_heartbeat < datetime('now', :heartbeatClause)
         )`,
        { replacements: { heartbeatClause: `-${timeoutMinutes} minutes` } }
      );

      // Auto-recover cooldown-expired accounts
      await _db.query(
        `UPDATE account_pool SET status = 'available', cooldown_until = NULL, updated_at = datetime('now')
         WHERE status = 'cooldown' AND cooldown_until <= datetime('now')`
      );

      for (const lease of expired || []) {
        await _db.query(
          `UPDATE account_pool
           SET status = 'available', leased_by = NULL, lease_until = NULL, updated_at = datetime('now')
           WHERE id = :id`,
          { replacements: { id: lease.account_id } }
        );

        await _db.query(
          `UPDATE account_leases
           SET status = 'expired', released_at = datetime('now')
           WHERE request_id = :requestId`,
          { replacements: { requestId: lease.request_id } }
        );
      }
    } catch {
      // non-fatal
    }
  }

  function stopGC() {
    if (_gcTimer) {
      clearInterval(_gcTimer);
      _gcTimer = null;
    }
  }

  return { startGC, runGC, stopGC };
};
