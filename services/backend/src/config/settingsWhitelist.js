/**
 * Allowed setting key prefixes for admin setting endpoints.
 * Both admin.js and settings.js reference this list — keep it in one place
 * so new prefixes are never out of sync.
 */
const ALLOWED_KEY_PREFIXES = ['system.', 'user.', 'security.', 'trading.', 'kline.'];

function isAllowedSettingKey(key) {
  // Non-string keys (null/undefined/number/object) fail closed instead of
  // throwing: admin 路由把这个函数当守卫用，抛 TypeError 会变成 500。
  if (typeof key !== 'string') return false;
  return ALLOWED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

module.exports = { ALLOWED_KEY_PREFIXES, isAllowedSettingKey };
