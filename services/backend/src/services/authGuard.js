/**
 * Auth Guard — lightweight shared gate for login-required features.
 */
const {
  buildGatewayManageFeatureLabel,
  buildGatewayRelayFeatureLabel,
  buildIdeAdapterFeatureLabel,
  buildFeatureFamilyPrefixRegex,
  buildProxyFeatureLabel,
} = require('./featureKeyBuilder');

const FEATURE_ACCESS_RULES = Object.freeze([
  {
    re: buildFeatureFamilyPrefixRegex('gateway', 'relay'),
    loginRequired: true,
    label: buildGatewayRelayFeatureLabel(),
  },
  {
    re: buildFeatureFamilyPrefixRegex('gateway', 'manage'),
    loginRequired: false,
    label: buildGatewayManageFeatureLabel(),
  },
  {
    re: buildFeatureFamilyPrefixRegex('proxy', 'root'),
    loginRequired: false,
    label: buildProxyFeatureLabel(),
  },
  { re: buildFeatureFamilyPrefixRegex('ide', 'families'), loginRequired: false, label: buildIdeAdapterFeatureLabel() },
]);

function getCliAuth() {
  try {
    // Lazy require to avoid boot-time side effects
    // eslint-disable-next-line global-require
    return require('./cliAuthService');
  } catch {
    return null;
  }
}

function hasValidSession() {
  try {
    const cliAuth = getCliAuth();
    if (!cliAuth || typeof cliAuth.checkSession !== 'function') return false;
    const session = cliAuth.checkSession();
    return !!(session && session.loggedIn);
  } catch {
    return false;
  }
}

function requireLogin(featureName = 'this feature') {
  if (hasValidSession()) return { ok: true };
  return {
    ok: false,
    error: `Login required for ${featureName}. Please run login first.`,
    errorType: 'auth',
  };
}

function getFeatureAccess(featureKey = '', fallbackLabel = '') {
  const normalized = String(featureKey || '').trim().toLowerCase();
  const fallback = String(fallbackLabel || '').trim() || 'this feature';
  const matched = FEATURE_ACCESS_RULES.find(rule => rule.re.test(normalized));
  if (!matched) {
    return {
      featureKey: normalized,
      loginRequired: true,
      label: fallback,
      source: 'default',
    };
  }
  return {
    featureKey: normalized,
    loginRequired: matched.loginRequired === true,
    label: matched.label || fallback,
    source: 'policy',
  };
}

function requireFeatureAccess(featureKey = '', fallbackLabel = '') {
  const policy = getFeatureAccess(featureKey, fallbackLabel);
  if (!policy.loginRequired) {
    return {
      ok: true,
      loginRequired: false,
      featureKey: policy.featureKey,
      label: policy.label,
    };
  }
  return {
    ...requireLogin(policy.label),
    featureKey: policy.featureKey,
    label: policy.label,
    loginRequired: true,
  };
}

module.exports = {
  getFeatureAccess,
  hasValidSession,
  requireFeatureAccess,
  requireLogin,
};
