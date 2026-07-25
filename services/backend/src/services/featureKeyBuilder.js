'use strict';

const FEATURE_LABELS = Object.freeze({
  gatewayRelay: 'gateway relay',
  gatewayManage: 'gateway manage',
  proxy: 'proxy',
  ideAdapter: 'ide adapter',
  webRelay: 'web relay',
  clipboardRelay: 'clipboard relay',
});
// Agent-backend launch families — must include every agentLauncherRegistry
// launcher command so `<cmd>.launch` resolves login-free (see authGuard
// FEATURE_ACCESS_RULES). Locked in sync by agentLauncherRegistry.test.js.
const IDE_FAMILY_KEYS = Object.freeze([
  'claude', 'codex', 'cursor', 'kiro', 'trae',
  'opencode', 'warp', 'vscode', 'windsurf',
]);
const FEATURE_PREFIX_REGISTRY = Object.freeze({
  gateway: Object.freeze({
    root: 'gateway',
    relay: 'gateway.relay',
    manage: 'gateway.manage',
  }),
  proxy: Object.freeze({
    root: 'proxy',
    relay: 'proxy.relay',
  }),
  ide: Object.freeze({
    families: IDE_FAMILY_KEYS,
  }),
});
const INTERNAL_COMPATIBILITY_HELPERS = Object.freeze([
  'buildGatewayRelayFeatureKey',
  'buildGatewayManageFeaturePrefix',
  'buildGatewayManageFeatureKey',
  'buildIdeFeaturePrefixRegex',
  'buildIdeLaunchFeatureKey',
  'buildProxyFeaturePrefix',
  'buildProxyRelayFeatureKey',
]);

function normalizeFeatureKeySegment(value = '', fallback = '') {
  const text = String(value || fallback || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/\.+/g, '.')
    .replace(/^\.+|\.+$/g, '');
  return text || String(fallback || '').trim().toLowerCase();
}

function joinFeatureKey(...parts) {
  return parts
    .map(part => normalizeFeatureKeySegment(part))
    .filter(Boolean)
    .join('.');
}

function buildFeaturePrefixRegex(prefix = '') {
  const normalized = String(prefix || '').trim();
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}(?:\\.|$)`);
}

function buildAlternationPrefixRegex(values = []) {
  const normalizedValues = (Array.isArray(values) ? values : [])
    .map(value => normalizeFeatureKeySegment(value))
    .filter(Boolean)
    .map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (normalizedValues.length === 0) return /^$/;
  return new RegExp(`^(?:${normalizedValues.join('|')})(?:\\.|$)`);
}

function getFeatureFamilyConfig(familyName = '') {
  const key = normalizeFeatureKeySegment(familyName);
  return FEATURE_PREFIX_REGISTRY[key] || null;
}

function getFeatureFamilyPrefix(familyName = '', scope = 'root') {
  const config = getFeatureFamilyConfig(familyName);
  if (!config) return '';
  const value = config[scope];
  return Array.isArray(value) ? '' : String(value || '').trim();
}

function buildFeatureFamilyPrefixRegex(familyName = '', scope = 'root') {
  const config = getFeatureFamilyConfig(familyName);
  if (!config) return /^$/;
  const value = config[scope];
  if (Array.isArray(value)) {
    return buildAlternationPrefixRegex(value);
  }
  return buildFeaturePrefixRegex(String(value || '').trim());
}

function isInternalCompatibilityHelper(name = '') {
  return INTERNAL_COMPATIBILITY_HELPERS.includes(String(name || '').trim());
}

// Internal compatibility wrappers.
// New code should prefer getFeatureFamilyPrefix(...),
// buildFeatureFamilyPrefixRegex(...), and joinFeatureKey(...).
function buildGatewayRelayFeatureKey() {
  return getFeatureFamilyPrefix('gateway', 'relay');
}

function buildGatewayRelayFeatureLabel() {
  return FEATURE_LABELS.gatewayRelay;
}

function buildGatewayManageFeaturePrefix() {
  return getFeatureFamilyPrefix('gateway', 'manage');
}

function buildGatewayManageFeatureKey(action = 'open') {
  return joinFeatureKey(buildGatewayManageFeaturePrefix(), action || 'open');
}

function buildGatewayManageFeatureLabel() {
  return FEATURE_LABELS.gatewayManage;
}

function buildIdeLaunchFeatureKey(ideName = '') {
  return joinFeatureKey(ideName, 'launch');
}

function buildIdeAdapterFeatureLabel() {
  return FEATURE_LABELS.ideAdapter;
}

function buildIdeFeaturePrefixRegex() {
  return buildFeatureFamilyPrefixRegex('ide', 'families');
}

function buildIdeLaunchFeatureLabel(ideName = '') {
  const normalized = normalizeFeatureKeySegment(ideName);
  return normalized ? `${normalized.replace(/\./g, ' ')} adapter` : FEATURE_LABELS.ideAdapter;
}

function buildProxyFeaturePrefix() {
  return getFeatureFamilyPrefix('proxy', 'root');
}

function buildProxyRelayFeatureKey(channel = '') {
  return joinFeatureKey(getFeatureFamilyPrefix('proxy', 'relay'), channel);
}

function buildProxyFeatureLabel() {
  return FEATURE_LABELS.proxy;
}

function buildProxyRelayFeatureLabel(channel = '') {
  const normalized = normalizeFeatureKeySegment(channel);
  if (normalized === 'web') return FEATURE_LABELS.webRelay;
  if (normalized === 'clipboard') return FEATURE_LABELS.clipboardRelay;
  return normalized ? `${normalized.replace(/\./g, ' ')} relay` : FEATURE_LABELS.proxy;
}

module.exports = {
  FEATURE_LABELS,
  FEATURE_PREFIX_REGISTRY,
  IDE_FAMILY_KEYS,
  INTERNAL_COMPATIBILITY_HELPERS,
  buildAlternationPrefixRegex,
  buildFeatureFamilyPrefixRegex,
  buildFeaturePrefixRegex,
  buildGatewayRelayFeatureKey,
  buildGatewayRelayFeatureLabel,
  buildGatewayManageFeaturePrefix,
  buildGatewayManageFeatureKey,
  buildGatewayManageFeatureLabel,
  buildIdeAdapterFeatureLabel,
  buildIdeFeaturePrefixRegex,
  buildIdeLaunchFeatureKey,
  buildIdeLaunchFeatureLabel,
  buildProxyFeaturePrefix,
  buildProxyFeatureLabel,
  buildProxyRelayFeatureKey,
  buildProxyRelayFeatureLabel,
  getFeatureFamilyConfig,
  getFeatureFamilyPrefix,
  isInternalCompatibilityHelper,
  joinFeatureKey,
  normalizeFeatureKeySegment,
};
