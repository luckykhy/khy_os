'use strict';

const {
  FEATURE_PREFIX_REGISTRY,
  IDE_FAMILY_KEYS,
  INTERNAL_COMPATIBILITY_HELPERS,
  buildAlternationPrefixRegex,
  buildFeatureFamilyPrefixRegex,
  buildFeaturePrefixRegex,
  buildGatewayManageFeatureLabel,
  buildGatewayManageFeatureKey,
  buildGatewayManageFeaturePrefix,
  buildGatewayRelayFeatureLabel,
  buildGatewayRelayFeatureKey,
  buildIdeAdapterFeatureLabel,
  buildIdeFeaturePrefixRegex,
  buildIdeLaunchFeatureLabel,
  buildIdeLaunchFeatureKey,
  buildProxyFeatureLabel,
  buildProxyRelayFeatureKey,
  buildProxyRelayFeatureLabel,
  getFeatureFamilyConfig,
  getFeatureFamilyPrefix,
  isInternalCompatibilityHelper,
  joinFeatureKey,
  normalizeFeatureKeySegment,
} = require('../../src/services/featureKeyBuilder');

describe('featureKeyBuilder', () => {
  test('normalizes feature key segments', () => {
    expect(normalizeFeatureKeySegment(' Claude Adapter ')).toBe('claude.adapter');
  });

  test('joins normalized feature key segments', () => {
    expect(joinFeatureKey('gateway', 'manage', 'Open Mode')).toBe('gateway.manage.open.mode');
  });

  test('builds feature prefix regex', () => {
    const regex = buildFeaturePrefixRegex(buildGatewayManageFeaturePrefix());
    expect(regex.test('gateway.manage.open')).toBe(true);
    expect(regex.test('gateway.manage')).toBe(true);
    expect(regex.test('gateway.manager')).toBe(false);
  });

  test('exports feature prefix registry', () => {
    expect(FEATURE_PREFIX_REGISTRY.gateway.manage).toBe('gateway.manage');
    expect(FEATURE_PREFIX_REGISTRY.proxy.relay).toBe('proxy.relay');
    expect(FEATURE_PREFIX_REGISTRY.ide.families).toEqual(IDE_FAMILY_KEYS);
  });

  test('exports internal compatibility helper list', () => {
    expect(INTERNAL_COMPATIBILITY_HELPERS).toEqual([
      'buildGatewayRelayFeatureKey',
      'buildGatewayManageFeaturePrefix',
      'buildGatewayManageFeatureKey',
      'buildIdeFeaturePrefixRegex',
      'buildIdeLaunchFeatureKey',
      'buildProxyFeaturePrefix',
      'buildProxyRelayFeatureKey',
    ]);
  });

  test('builds alternation prefix regex', () => {
    const regex = buildAlternationPrefixRegex(['claude', 'codex']);
    expect(regex.test('claude.launch')).toBe(true);
    expect(regex.test('codex.launch')).toBe(true);
    expect(regex.test('cursor.launch')).toBe(false);
  });

  test('reads feature family config and prefix from registry', () => {
    expect(getFeatureFamilyConfig('gateway')).toEqual(FEATURE_PREFIX_REGISTRY.gateway);
    expect(getFeatureFamilyPrefix('gateway', 'relay')).toBe('gateway.relay');
    expect(getFeatureFamilyPrefix('proxy', 'root')).toBe('proxy');
  });

  test('identifies internal compatibility helpers', () => {
    expect(isInternalCompatibilityHelper('buildGatewayRelayFeatureKey')).toBe(true);
    expect(isInternalCompatibilityHelper('buildProxyRelayFeatureKey')).toBe(true);
    expect(isInternalCompatibilityHelper('getFeatureFamilyPrefix')).toBe(false);
  });

  test('builds feature family prefix regex from registry', () => {
    const gatewayRegex = buildFeatureFamilyPrefixRegex('gateway', 'manage');
    expect(gatewayRegex.test('gateway.manage.open')).toBe(true);
    expect(gatewayRegex.test('gateway.manager')).toBe(false);

    const ideRegex = buildFeatureFamilyPrefixRegex('ide', 'families');
    expect(ideRegex.test('claude.launch')).toBe(true);
    expect(ideRegex.test('unknown.launch')).toBe(false);
  });

  test('builds gateway relay feature key', () => {
    expect(buildGatewayRelayFeatureKey()).toBe('gateway.relay');
  });

  test('builds gateway relay feature label', () => {
    expect(buildGatewayRelayFeatureLabel()).toBe('gateway relay');
  });

  test('builds gateway manage feature key', () => {
    expect(buildGatewayManageFeatureKey('status')).toBe('gateway.manage.status');
  });

  test('builds gateway manage feature label', () => {
    expect(buildGatewayManageFeatureLabel()).toBe('gateway manage');
  });

  test('builds ide launch feature key', () => {
    expect(buildIdeLaunchFeatureKey('Claude')).toBe('claude.launch');
  });

  test('builds ide adapter feature label', () => {
    expect(buildIdeAdapterFeatureLabel()).toBe('ide adapter');
  });

  test('exports IDE family keys and builds IDE prefix regex', () => {
    expect(IDE_FAMILY_KEYS).toEqual(['claude', 'codex', 'cursor', 'kiro', 'trae']);
    const regex = buildIdeFeaturePrefixRegex();
    expect(regex.test('claude.launch')).toBe(true);
    expect(regex.test('kiro.launch')).toBe(true);
    expect(regex.test('unknown.launch')).toBe(false);
  });

  test('builds ide launch feature label', () => {
    expect(buildIdeLaunchFeatureLabel('Unknown-IDE')).toBe('unknown ide adapter');
  });

  test('builds proxy relay feature key', () => {
    expect(buildProxyRelayFeatureKey('web')).toBe('proxy.relay.web');
  });

  test('builds proxy feature label', () => {
    expect(buildProxyFeatureLabel()).toBe('proxy');
  });

  test('builds proxy relay feature label', () => {
    expect(buildProxyRelayFeatureLabel('clipboard')).toBe('clipboard relay');
  });
});
