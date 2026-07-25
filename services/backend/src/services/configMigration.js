'use strict';

/**
 * Configuration Migration Service — automatically migrate configs across versions.
 *
 * Detects the current config version, applies sequential migrations,
 * and backs up the original config before changes.
 *
 * @module configMigration
 */

const fs = require('fs');
const path = require('path');
const log = require('../utils/logger');

// ── Migration Registry ──

/**
 * Each migration: { from, to, description, migrate(config) → config }
 * Migrations are applied sequentially: v1 → v2 → v3 → ...
 */
const MIGRATIONS = [
  {
    from: 1,
    to: 2,
    description: 'Flatten nested gateway config, move proxy to top-level',
    migrate(config) {
      // v1 had gateway.adapters[].config; v2 flattens to gateway.adapters[]
      if (config.gateway && config.gateway.adapters) {
        config.gateway.adapters = config.gateway.adapters.map((a) => {
          if (a.config) {
            const { config: nested, ...rest } = a;
            return { ...rest, ...nested };
          }
          return a;
        });
      }
      // v1 had proxy inside gateway; v2 moves to top-level
      if (config.gateway && config.gateway.proxy) {
        config.proxy = config.gateway.proxy;
        delete config.gateway.proxy;
      }
      return config;
    },
  },
  {
    from: 2,
    to: 3,
    description: 'Add permission system defaults, rename approval → permission',
    migrate(config) {
      // Rename approvalMode → permissionMode
      if (config.approvalMode) {
        config.permissionMode = config.approvalMode;
        delete config.approvalMode;
      }
      // Add default permission rules if missing
      if (!config.permissions) {
        config.permissions = {
          mode: config.permissionMode || 'ask',
          rules: [],
        };
      }
      return config;
    },
  },
  {
    from: 3,
    to: 4,
    description: 'Add i18n locale, session management, extension config',
    migrate(config) {
      // Add locale if missing
      if (!config.locale) config.locale = 'auto';
      // Add session config
      if (!config.session) {
        config.session = {
          autoTitle: true,
          recapThreshold: 10,
          persist: true,
        };
      }
      // Add extensions config
      if (!config.extensions) {
        config.extensions = {
          enabled: true,
          autoUpdate: false,
          registry: 'https://registry.khy.dev',
        };
      }
      return config;
    },
  },
];

const CURRENT_VERSION = 4;

// ── Public API ──

/**
 * Detect the version of a config object.
 * @param {object} config
 * @returns {number}
 */
function detectVersion(config) {
  if (!config || typeof config !== 'object') return 1;
  if (typeof config._configVersion === 'number') return config._configVersion;

  // Heuristic detection
  if (config.extensions && config.session && config.locale) return 4;
  if (config.permissions && config.permissionMode) return 3;
  if (config.proxy && !config.gateway?.proxy) return 2;
  return 1;
}

/**
 * Migrate a config object to the latest version.
 *
 * @param {object} config - The config object to migrate
 * @param {object} [options]
 * @param {number} [options.targetVersion] - Target version (default: CURRENT_VERSION)
 * @param {boolean} [options.dryRun] - If true, return migration plan without applying
 * @returns {{ config: object, migrations: string[], fromVersion: number, toVersion: number }}
 */
function migrateConfig(config, options) {
  const opts = options || {};
  const targetVersion = opts.targetVersion || CURRENT_VERSION;
  const dryRun = opts.dryRun || false;

  const fromVersion = detectVersion(config);
  const appliedMigrations = [];

  if (fromVersion >= targetVersion) {
    return { config, migrations: [], fromVersion, toVersion: fromVersion };
  }

  let current = dryRun ? config : JSON.parse(JSON.stringify(config)); // Deep clone
  let currentVersion = fromVersion;

  for (const migration of MIGRATIONS) {
    if (migration.from < currentVersion) continue;
    if (migration.from !== currentVersion) continue;
    if (migration.to > targetVersion) break;

    appliedMigrations.push(`v${migration.from}→v${migration.to}: ${migration.description}`);

    if (!dryRun) {
      try {
        current = migration.migrate(current);
        currentVersion = migration.to;
      } catch (err) {
        log.error(`Config migration v${migration.from}→v${migration.to} failed:`, err.message);
        throw new Error(`Migration v${migration.from}→v${migration.to} failed: ${err.message}`);
      }
    } else {
      currentVersion = migration.to;
    }
  }

  if (!dryRun) {
    current._configVersion = currentVersion;
  }

  return {
    config: dryRun ? config : current,
    migrations: appliedMigrations,
    fromVersion,
    toVersion: currentVersion,
  };
}

/**
 * Migrate a config file on disk. Creates a backup before modifying.
 *
 * @param {string} configPath - Path to the JSON config file
 * @param {object} [options]
 * @returns {{ success: boolean, migrations: string[], backupPath?: string }}
 */
function migrateConfigFile(configPath, options) {
  const absPath = path.resolve(configPath);

  if (!fs.existsSync(absPath)) {
    return { success: false, migrations: [], error: 'Config file not found' };
  }

  let config;
  try {
    const raw = fs.readFileSync(absPath, 'utf8');
    config = JSON.parse(raw);
  } catch (err) {
    return { success: false, migrations: [], error: `Failed to parse config: ${err.message}` };
  }

  const fromVersion = detectVersion(config);

  // Dry run first
  const plan = migrateConfig(config, { ...options, dryRun: true });
  if (plan.migrations.length === 0) {
    return { success: true, migrations: [], message: 'Already at latest version' };
  }

  // Create backup
  const backupPath = absPath + `.v${fromVersion}.bak`;
  try {
    fs.copyFileSync(absPath, backupPath);
  } catch (err) {
    return { success: false, migrations: [], error: `Failed to create backup: ${err.message}` };
  }

  // Apply migration
  const result = migrateConfig(config, options);

  // Write migrated config
  try {
    fs.writeFileSync(absPath, JSON.stringify(result.config, null, 2) + '\n', 'utf8');
  } catch (err) {
    // Restore backup
    try { fs.copyFileSync(backupPath, absPath); } catch { /* best effort */ }
    return { success: false, migrations: [], error: `Failed to write config: ${err.message}` };
  }

  log.info(`Config migrated v${result.fromVersion}→v${result.toVersion}: ${result.migrations.length} migration(s)`);

  return {
    success: true,
    migrations: result.migrations,
    backupPath,
    fromVersion: result.fromVersion,
    toVersion: result.toVersion,
  };
}

module.exports = {
  detectVersion,
  migrateConfig,
  migrateConfigFile,
  CURRENT_VERSION,
  MIGRATIONS,
};
