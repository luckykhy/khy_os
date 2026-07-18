'use strict';

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const {
  detectVersion,
  migrateConfig,
  CURRENT_VERSION,
  MIGRATIONS,
} = require('../src/services/configMigration');

describe('configMigration', () => {
  // ── detectVersion ──

  describe('detectVersion()', () => {
    test('returns 1 for null/undefined/non-object input', () => {
      expect(detectVersion(null)).toBe(1);
      expect(detectVersion(undefined)).toBe(1);
      expect(detectVersion('string')).toBe(1);
    });

    test('returns 1 for a bare v1 config (no distinctive fields)', () => {
      const config = { gateway: { adapters: [{ config: { key: 'val' } }] } };
      expect(detectVersion(config)).toBe(1);
    });

    test('returns 2 for a config with top-level proxy and no gateway.proxy', () => {
      const config = { proxy: { host: '127.0.0.1' }, gateway: { adapters: [] } };
      expect(detectVersion(config)).toBe(2);
    });

    test('returns 3 for a config with permissions and permissionMode', () => {
      const config = { permissions: { mode: 'ask', rules: [] }, permissionMode: 'ask' };
      expect(detectVersion(config)).toBe(3);
    });

    test('returns 4 for a config with extensions, session, and locale', () => {
      const config = {
        extensions: { enabled: true },
        session: { autoTitle: true },
        locale: 'en',
      };
      expect(detectVersion(config)).toBe(4);
    });

    test('uses _configVersion field when present', () => {
      const config = { _configVersion: 3 };
      expect(detectVersion(config)).toBe(3);
    });

    test('_configVersion takes priority over heuristic', () => {
      const config = {
        _configVersion: 2,
        extensions: { enabled: true },
        session: { autoTitle: true },
        locale: 'en',
      };
      expect(detectVersion(config)).toBe(2);
    });
  });

  // ── migrateConfig ──

  describe('migrateConfig()', () => {
    test('migrates v1 config to v4 (latest)', () => {
      const v1Config = {
        gateway: {
          adapters: [{ name: 'openai', config: { apiKey: 'sk-123' } }],
          proxy: { host: 'localhost', port: 7890 },
        },
        approvalMode: 'auto',
      };

      const result = migrateConfig(v1Config);
      expect(result.fromVersion).toBe(1);
      expect(result.toVersion).toBe(4);
      expect(result.migrations.length).toBe(3);
      expect(result.config._configVersion).toBe(4);

      // v1->v2: adapters flattened, proxy moved to top-level
      expect(result.config.gateway.adapters[0].apiKey).toBe('sk-123');
      expect(result.config.proxy).toBeDefined();
      expect(result.config.gateway.proxy).toBeUndefined();

      // v2->v3: approvalMode -> permissionMode
      expect(result.config.approvalMode).toBeUndefined();
      expect(result.config.permissionMode).toBe('auto');
      expect(result.config.permissions).toBeDefined();

      // v3->v4: locale, session, extensions added
      expect(result.config.locale).toBe('auto');
      expect(result.config.session).toBeDefined();
      expect(result.config.extensions).toBeDefined();
    });

    test('migrates v2 config to v4', () => {
      const v2Config = {
        proxy: { host: '127.0.0.1' },
        gateway: { adapters: [] },
        approvalMode: 'ask',
      };

      const result = migrateConfig(v2Config);
      expect(result.fromVersion).toBe(2);
      expect(result.toVersion).toBe(4);
      expect(result.migrations.length).toBe(2);
      expect(result.config.permissionMode).toBe('ask');
      expect(result.config.locale).toBe('auto');
    });

    test('migrates v3 config to v4', () => {
      const v3Config = {
        _configVersion: 3,
        permissions: { mode: 'ask', rules: [] },
        permissionMode: 'ask',
      };

      const result = migrateConfig(v3Config);
      expect(result.fromVersion).toBe(3);
      expect(result.toVersion).toBe(4);
      expect(result.migrations.length).toBe(1);
      expect(result.config.locale).toBe('auto');
      expect(result.config.session.autoTitle).toBe(true);
      expect(result.config.extensions.enabled).toBe(true);
    });

    test('returns no migrations when already at latest version', () => {
      const v4Config = {
        _configVersion: 4,
        locale: 'en',
        session: { autoTitle: true },
        extensions: { enabled: true },
      };

      const result = migrateConfig(v4Config);
      expect(result.fromVersion).toBe(4);
      expect(result.toVersion).toBe(4);
      expect(result.migrations.length).toBe(0);
      expect(result.config).toBe(v4Config); // Same reference, no clone
    });
  });

  // ── dryRun ──

  describe('dryRun mode', () => {
    test('does not modify the original config', () => {
      const v1Config = {
        gateway: {
          adapters: [{ name: 'openai', config: { apiKey: 'sk-123' } }],
          proxy: { host: 'localhost' },
        },
      };

      const result = migrateConfig(v1Config, { dryRun: true });
      expect(result.migrations.length).toBe(3);
      expect(result.fromVersion).toBe(1);
      expect(result.toVersion).toBe(4);

      // Original config should NOT be modified
      expect(result.config).toBe(v1Config);
      expect(v1Config._configVersion).toBeUndefined();
      expect(v1Config.gateway.proxy).toBeDefined();
    });
  });

  // ── Individual migrations ──

  describe('individual migration v1->v2', () => {
    test('flattens adapter config', () => {
      const localModelHost = 'localhost';
      const localModelPort = 11434;
      const v1Config = {
        _configVersion: 1,
        gateway: {
          adapters: [
            { name: 'openai', config: { apiKey: 'sk-abc', baseUrl: 'https://api.openai.com' } },
            { name: 'ollama', endpoint: `http://${localModelHost}:${localModelPort}` },
          ],
        },
      };

      const result = migrateConfig(v1Config, { targetVersion: 2 });
      const adapters = result.config.gateway.adapters;
      expect(adapters[0].name).toBe('openai');
      expect(adapters[0].apiKey).toBe('sk-abc');
      expect(adapters[0].baseUrl).toBe('https://api.openai.com');
      expect(adapters[0].config).toBeUndefined();
      // Second adapter without nested config should be unchanged
      expect(adapters[1].name).toBe('ollama');
    });

    test('moves gateway.proxy to top-level proxy', () => {
      const v1Config = {
        _configVersion: 1,
        gateway: {
          proxy: { host: '127.0.0.1', port: 7890 },
          adapters: [],
        },
      };

      const result = migrateConfig(v1Config, { targetVersion: 2 });
      expect(result.config.proxy).toEqual({ host: '127.0.0.1', port: 7890 });
      expect(result.config.gateway.proxy).toBeUndefined();
    });
  });

  describe('individual migration v2->v3', () => {
    test('renames approvalMode to permissionMode', () => {
      const v2Config = {
        _configVersion: 2,
        approvalMode: 'auto',
      };

      const result = migrateConfig(v2Config, { targetVersion: 3 });
      expect(result.config.permissionMode).toBe('auto');
      expect(result.config.approvalMode).toBeUndefined();
      expect(result.config.permissions).toBeDefined();
      expect(result.config.permissions.mode).toBe('auto');
    });

    test('adds default permissions when not present', () => {
      const v2Config = { _configVersion: 2 };

      const result = migrateConfig(v2Config, { targetVersion: 3 });
      expect(result.config.permissions).toEqual({
        mode: 'ask',
        rules: [],
      });
    });
  });

  describe('individual migration v3->v4', () => {
    test('adds locale, session, and extensions defaults', () => {
      const v3Config = {
        _configVersion: 3,
        permissions: { mode: 'ask', rules: [] },
      };

      const result = migrateConfig(v3Config, { targetVersion: 4 });
      expect(result.config.locale).toBe('auto');
      expect(result.config.session).toEqual({
        autoTitle: true,
        recapThreshold: 10,
        persist: true,
      });
      expect(result.config.extensions).toEqual({
        enabled: true,
        autoUpdate: false,
        registry: 'https://registry.khy.dev',
      });
    });

    test('does not overwrite existing locale/session/extensions', () => {
      const v3Config = {
        _configVersion: 3,
        locale: 'zh',
        session: { autoTitle: false },
        extensions: { enabled: false },
      };

      const result = migrateConfig(v3Config, { targetVersion: 4 });
      expect(result.config.locale).toBe('zh');
      expect(result.config.session.autoTitle).toBe(false);
      expect(result.config.extensions.enabled).toBe(false);
    });
  });

  // ── Constants ──

  describe('constants', () => {
    test('CURRENT_VERSION is 4', () => {
      expect(CURRENT_VERSION).toBe(4);
    });

    test('MIGRATIONS has 3 entries covering v1 through v4', () => {
      expect(MIGRATIONS.length).toBe(3);
      expect(MIGRATIONS[0].from).toBe(1);
      expect(MIGRATIONS[0].to).toBe(2);
      expect(MIGRATIONS[2].from).toBe(3);
      expect(MIGRATIONS[2].to).toBe(4);
    });
  });
});
