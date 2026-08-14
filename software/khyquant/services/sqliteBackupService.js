'use strict';

/**
 * SQLite kline backup — lightweight no-op fallback.
 *
 * Restores the `./sqliteBackupService` module that klineDataService hard-requires
 * but which was missing from the tree (causing "Cannot find module
 * './sqliteBackupService'" at load time). klineDataService uses this purely as an
 * optional local backup layer: every call site is wrapped in try/catch and the
 * read path treats an empty result as "no backup" and falls through to the live
 * data sources ("Keep existing functionality intact when ... unavailable").
 *
 * This implementation provides that contract without pulling in a SQLite driver:
 * backups are accepted and discarded, reads return empty. Replace with a real
 * better-sqlite3-backed store here if persistent offline backup is needed; the
 * public surface (backupKlineData / getKlineData) stays the same.
 */

/**
 * Persist a kline array for (symbol, period). No-op in the fallback.
 * @returns {boolean} false — nothing was persisted.
 */
function backupKlineData(/* symbol, period, klineArray */) {
  return false;
}

/**
 * Read backed-up kline rows. The fallback has no store, so it returns an empty
 * array; callers interpret this as "no backup available".
 * @returns {Array} empty array
 */
function getKlineData(/* symbol, period, startDate, endDate, limit */) {
  return [];
}

module.exports = { backupKlineData, getKlineData };
