'use strict';

/**
 * deployLedger — durable record of deployments performed by `khy deploy`.
 *
 * Each deployment is one entry tracking where it was deployed, how it is
 * started, its launched pid/port and last-known status. The ledger is the
 * single source of truth for `khy deploy list/status/stop/logs`.
 *
 * Storage lives under the data home (`<dataHome>/deployments/ledger.json`) so
 * it persists across CLI invocations and survives reinstalls of the source
 * tree. All filesystem access is injectable for tests.
 *
 * @typedef {Object} DeployRecord
 * @property {string} name       Stable id for the deployment.
 * @property {string} source     Absolute source directory.
 * @property {string} target     Absolute deploy target directory.
 * @property {string} type       Detected project type.
 * @property {string|null} startCmd Display form of the start command.
 * @property {number|null} pid   PID of the started process (if any).
 * @property {number|null} port  Port, if known.
 * @property {string|null} logFile Absolute path to captured log file.
 * @property {string} status     deployed|running|stopped|exited|failed
 * @property {string} startedAt  ISO timestamp of last start.
 * @property {string} updatedAt  ISO timestamp of last ledger write.
 */

const path = require('path');

function defaultDeps() {
  const fs = require('fs');
  const { getDataDir } = require('../../utils/dataHome');
  return {
    fs,
    dir: () => getDataDir('deployments'),
    now: () => new Date().toISOString(),
    isAlive: (pid) => {
      if (!pid) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        // ESRCH: no such process. EPERM: exists but not ours → treat as alive.
        return err && err.code === 'EPERM';
      }
    },
  };
}

function ledgerPath(deps) {
  return path.join(deps.dir(), 'ledger.json');
}

function load(deps = defaultDeps()) {
  const p = ledgerPath(deps);
  try {
    if (!deps.fs.existsSync(p)) return [];
    const raw = deps.fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    // Corrupt ledger must never crash the CLI; treat as empty and let the next
    // write heal it.
    return [];
  }
}

function save(records, deps = defaultDeps()) {
  const p = ledgerPath(deps);
  deps.fs.writeFileSync(p, JSON.stringify(records, null, 2), 'utf8');
  return p;
}

/** Insert or replace a record by name. */
function upsert(record, deps = defaultDeps()) {
  const records = load(deps);
  const idx = records.findIndex((r) => r.name === record.name);
  const merged = {
    ...(idx >= 0 ? records[idx] : {}),
    ...record,
    updatedAt: deps.now(),
  };
  if (idx >= 0) records[idx] = merged;
  else records.push(merged);
  save(records, deps);
  return merged;
}

function get(name, deps = defaultDeps()) {
  return load(deps).find((r) => r.name === name) || null;
}

function remove(name, deps = defaultDeps()) {
  const records = load(deps);
  const next = records.filter((r) => r.name !== name);
  save(next, deps);
  return records.length !== next.length;
}

/**
 * Return all records with their status reconciled against live process state.
 * A record marked running whose pid is dead is reported as 'exited'.
 */
function listReconciled(deps = defaultDeps()) {
  return load(deps).map((r) => {
    if (r.status === 'running' && !deps.isAlive(r.pid)) {
      return { ...r, status: 'exited' };
    }
    return r;
  });
}

module.exports = {
  defaultDeps,
  load,
  save,
  upsert,
  get,
  remove,
  listReconciled,
  ledgerPath,
};
