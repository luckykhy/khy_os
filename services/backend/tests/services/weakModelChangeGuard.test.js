'use strict';

const {
  classifyChangeRisk,
  assessWeakModelChange,
  weakModelChangeGuardEnabled,
  buildWeakModelAdvisory,
  _internals,
} = require('../../src/services/weakModelChangeGuard');

describe('weakModelChangeGuard', () => {
  describe('classifyChangeRisk', () => {
    test('returns red-line for .env files', () => {
      expect(classifyChangeRisk('.env')).toBe('red-line');
      expect(classifyChangeRisk('.env.local')).toBe('red-line');
      expect(classifyChangeRisk('path/to/.env')).toBe('red-line');
    });

    test('returns red-line for release scripts', () => {
      expect(classifyChangeRisk('scripts/release/deploy.sh')).toBe('red-line');
    });

    test('returns red-line for CI scripts', () => {
      expect(classifyChangeRisk('scripts/ci/check.sh')).toBe('red-line');
    });

    test('returns red-line for .github', () => {
      expect(classifyChangeRisk('.github/workflows/ci.yml')).toBe('red-line');
    });

    test('returns red-line for flagRegistry.js', () => {
      expect(classifyChangeRisk('flagRegistry.js')).toBe('red-line');
    });

    test('returns red-line for pyproject.toml', () => {
      expect(classifyChangeRisk('pyproject.toml')).toBe('red-line');
    });

    test('returns red-line for package.json', () => {
      expect(classifyChangeRisk('package.json')).toBe('red-line');
    });

    test('returns red-line for .git', () => {
      expect(classifyChangeRisk('.git/refs/heads/main')).toBe('red-line');
    });

    test('returns sensitive for aiGateway.js', () => {
      expect(classifyChangeRisk('aiGateway.js')).toBe('sensitive');
    });

    test('returns sensitive for toolUseLoop.js', () => {
      expect(classifyChangeRisk('toolUseLoop.js')).toBe('sensitive');
      expect(classifyChangeRisk('toolUseLoopCore.js')).toBe('sensitive');
    });

    test('returns sensitive for replSession.js', () => {
      expect(classifyChangeRisk('replSession.js')).toBe('sensitive');
    });

    test('returns sensitive for harness.js', () => {
      expect(classifyChangeRisk('harness.js')).toBe('sensitive');
    });

    test('returns sensitive for sessionPersistence.js', () => {
      expect(classifyChangeRisk('sessionPersistence.js')).toBe('sensitive');
    });

    test('returns normal for regular files', () => {
      expect(classifyChangeRisk('src/utils/helper.js')).toBe('normal');
      expect(classifyChangeRisk('README.md')).toBe('normal');
      expect(classifyChangeRisk('test.test.js')).toBe('normal');
    });

    test('returns normal for empty path', () => {
      expect(classifyChangeRisk('')).toBe('normal');
      expect(classifyChangeRisk(null)).toBe('normal');
      expect(classifyChangeRisk(undefined)).toBe('normal');
    });

    test('normalizes backslashes', () => {
      expect(classifyChangeRisk('path\\to\\.env')).toBe('red-line');
    });
  });

  describe('weakModelChangeGuardEnabled', () => {
    test('returns true by default', () => {
      expect(weakModelChangeGuardEnabled({})).toBe(true);
    });

    test('returns true for non-off values', () => {
      expect(weakModelChangeGuardEnabled({ KHY_WEAK_MODEL_EDIT_GUARD: '1' })).toBe(true);
      expect(weakModelChangeGuardEnabled({ KHY_WEAK_MODEL_EDIT_GUARD: 'true' })).toBe(true);
    });

    test('returns false for off values', () => {
      expect(weakModelChangeGuardEnabled({ KHY_WEAK_MODEL_EDIT_GUARD: '0' })).toBe(false);
      expect(weakModelChangeGuardEnabled({ KHY_WEAK_MODEL_EDIT_GUARD: 'false' })).toBe(false);
      expect(weakModelChangeGuardEnabled({ KHY_WEAK_MODEL_EDIT_GUARD: 'off' })).toBe(false);
      expect(weakModelChangeGuardEnabled({ KHY_WEAK_MODEL_EDIT_GUARD: 'no' })).toBe(false);
    });

    test('is case-insensitive', () => {
      expect(weakModelChangeGuardEnabled({ KHY_WEAK_MODEL_EDIT_GUARD: 'FALSE' })).toBe(false);
    });
  });

  describe('assessWeakModelChange', () => {
    test('returns null when disabled', () => {
      const result = assessWeakModelChange({
        filePath: '.env',
        tier: 'T3',
        env: { KHY_WEAK_MODEL_EDIT_GUARD: '0' },
      });
      expect(result).toBeNull();
    });

    test('returns null for missing filePath', () => {
      const result = assessWeakModelChange({ tier: 'T3', env: {} });
      expect(result).toBeNull();
    });

    test('allows strong model (T0)', () => {
      const result = assessWeakModelChange({
        filePath: '.env',
        tier: 'T0',
        env: {},
      });
      expect(result.allow).toBe(true);
      expect(result.reason).toBe('strong-model');
    });

    test('allows strong model (T1)', () => {
      const result = assessWeakModelChange({
        filePath: '.env',
        tier: 'T1',
        env: {},
      });
      expect(result.allow).toBe(true);
      expect(result.reason).toBe('strong-model');
    });

    test('blocks weak model (T2) from red-line', () => {
      const result = assessWeakModelChange({
        filePath: '.env',
        tier: 'T2',
        env: {},
      });
      expect(result.allow).toBe(false);
      expect(result.risk).toBe('red-line');
      expect(result.action).toBe('require-strong-review');
    });

    test('blocks weak model (T3) from red-line', () => {
      const result = assessWeakModelChange({
        filePath: '.env',
        tier: 'T3',
        env: {},
      });
      expect(result.allow).toBe(false);
      expect(result.risk).toBe('red-line');
    });

    test('requires confirm for weak model on sensitive', () => {
      const result = assessWeakModelChange({
        filePath: 'aiGateway.js',
        tier: 'T3',
        env: {},
      });
      expect(result.allow).toBe(true);
      expect(result.requireConfirm).toBe(true);
      expect(result.risk).toBe('sensitive');
    });

    test('allows weak model on normal files', () => {
      const result = assessWeakModelChange({
        filePath: 'src/utils/helper.js',
        tier: 'T3',
        env: {},
      });
      expect(result.allow).toBe(true);
      expect(result.risk).toBe('normal');
    });

    test('handles unknown tier', () => {
      const result = assessWeakModelChange({
        filePath: '.env',
        env: {},
      });
      expect(result.allow).toBe(true);
      expect(result.requireConfirm).toBe(true);
      expect(result.tier).toBeNull();
    });

    test('includes changeKind', () => {
      const result = assessWeakModelChange({
        filePath: 'test.js',
        tier: 'T3',
        changeKind: 'delete',
        env: {},
      });
      expect(result.changeKind).toBe('delete');
    });
  });

  describe('buildWeakModelAdvisory', () => {
    test('returns null when disabled', () => {
      const result = buildWeakModelAdvisory({
        filePath: '.env',
        tier: 'T3',
        env: { KHY_WEAK_MODEL_EDIT_GUARD: '0' },
      });
      expect(result).toBeNull();
    });

    test('returns null for strong model', () => {
      const result = buildWeakModelAdvisory({
        filePath: '.env',
        tier: 'T0',
        env: {},
      });
      expect(result).toBeNull();
    });

    test('returns null for normal file', () => {
      const result = buildWeakModelAdvisory({
        filePath: 'src/utils/helper.js',
        tier: 'T3',
        env: {},
      });
      expect(result).toBeNull();
    });

    test('returns advisory for weak model on red-line', () => {
      const result = buildWeakModelAdvisory({
        filePath: '.env',
        tier: 'T3',
        env: {},
      });
      expect(result).not.toBeNull();
      expect(result.humanLine).toContain('红线文件');
      expect(result.aiNote).toContain('WEAK-MODEL-EDIT-GUARD');
    });

    test('returns advisory for weak model on sensitive', () => {
      const result = buildWeakModelAdvisory({
        filePath: 'aiGateway.js',
        tier: 'T3',
        env: {},
      });
      expect(result).not.toBeNull();
      expect(result.humanLine).toContain('敏感文件');
    });
  });

  describe('_internals', () => {
    test('has RED_LINE_PATTERNS', () => {
      expect(_internals.RED_LINE_PATTERNS).toBeDefined();
      expect(Array.isArray(_internals.RED_LINE_PATTERNS)).toBe(true);
    });

    test('has SENSITIVE_PATTERNS', () => {
      expect(_internals.SENSITIVE_PATTERNS).toBeDefined();
      expect(Array.isArray(_internals.SENSITIVE_PATTERNS)).toBe(true);
    });

    test('_isWeakTier works correctly', () => {
      expect(_internals._isWeakTier('T2')).toBe(true);
      expect(_internals._isWeakTier('T3')).toBe(true);
      expect(_internals._isWeakTier('T0')).toBe(false);
      expect(_internals._isWeakTier('T1')).toBe(false);
    });
  });
});
