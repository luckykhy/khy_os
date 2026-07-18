/**
 * Allowed setting key prefixes for admin setting endpoints.
 * Both admin.js and settings.js reference this list — keep it in one place
 * so new prefixes are never out of sync.
 */
const ALLOWED_KEY_PREFIXES = [
  'system.',
  'user.',
  'security.',
  'trading.',
  'kline.',
];

function isAllowedSettingKey(key) {
  return ALLOWED_KEY_PREFIXES.some(prefix => key.startsWith(prefix));
}

module.exports = { ALLOWED_KEY_PREFIXES, isAllowedSettingKey };
