'use strict';
/**
 * pgPaths.js — single source of truth for locating a PostgreSQL install.
 *
 * Previously this logic lived in two divergent places:
 *   - server.js `_discoverPgPaths`  (dynamic: PG_HOME override + drive scan)
 *   - start-with-db.js `findPostgreSQLPath` (six hardcoded C:/D: paths, no env)
 * The hardcoded copy was the portability hazard (rule 1: no fixed absolute
 * paths). Both now resolve through here.
 *
 * Pure + injectable: the filesystem probes are passed in so this is unit
 * testable without a real install.
 */

const fs = require('fs');
const path = require('path');

// Versions to consider when scanning (newest first) for an auto-start.
const PG_VERSIONS = [18, 17, 16, 15, 14];
const PG_PREFIXES = ['Program Files', 'Program Files (x86)'];

/**
 * Candidate PostgreSQL *base* paths (the dir containing bin/ + data/).
 *   1. PG_HOME env override wins outright (a single explicit path).
 *   2. Non-Windows: static common locations.
 *   3. Windows: scan every accessible drive's Program Files for known versions.
 * @param {{fsExistsSync?: (p:string)=>boolean, platform?: string}} [opts]
 * @returns {string[]}
 */
function discoverPgBasePaths(opts = {}) {
  const exists = opts.fsExistsSync || ((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;

  if (env.PG_HOME) {
    return [env.PG_HOME];
  }

  if (platform !== 'win32') {
    return ['/usr/lib/postgresql', '/usr/local/pgsql'];
  }

  const drives = [];
  for (let code = 67; code <= 90; code++) {
    // C..Z
    const letter = String.fromCharCode(code);
    if (exists(`${letter}:\\`)) drives.push(`${letter}:`);
  }
  const out = [];
  for (const drive of drives) {
    for (const prefix of PG_PREFIXES) {
      for (const ver of PG_VERSIONS) {
        out.push(path.join(drive, prefix, 'PostgreSQL', String(ver)));
      }
    }
  }
  return out;
}

/**
 * Find a usable PostgreSQL install (one whose bin/pg_ctl + data dir exist).
 * @returns {{pgCtlPath:string, pgDataPath:string, basePath:string}|null}
 */
function findPostgresInstall(opts = {}) {
  const exists = opts.fsExistsSync || ((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  const platform = opts.platform || process.platform;
  const pgCtlName = platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl';

  for (const base of discoverPgBasePaths(opts)) {
    const pgCtlPath = path.join(base, 'bin', pgCtlName);
    const pgDataPath = path.join(base, 'data');
    if (exists(pgCtlPath) && exists(pgDataPath)) {
      return { pgCtlPath, pgDataPath, basePath: base };
    }
  }
  return null;
}

module.exports = {
  discoverPgBasePaths,
  findPostgresInstall,
  PG_VERSIONS,
  PG_PREFIXES,
};
