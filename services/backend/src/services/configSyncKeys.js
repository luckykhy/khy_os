'use strict';

// Pure data leaf for configSyncService: the sensitive-key vocabulary and the
// config key namespaces. No logic, no IO — lifted verbatim so the host module
// stays under the 400-line architecture ceiling while its public surface
// (KEY_NAMESPACE re-export, isSensitiveKey behavior) is preserved byte-for-byte.

// 敏感 key 判断词表：命中其中任一项（子串、大小写不敏感）即视为敏感字段。
const SENSITIVE_KEYS = new Set([
  'apiKey',
  'api_key',
  'anthropicApiKey',
  'openaiApiKey',
  'deepseekApiKey',
  'relayApiKey',
  'RELAY_API_KEY',
  'accessToken',
  'refreshToken',
  'password',
  'secret',
]);

// 配置 key 命名空间
// 统一命名: <domain>.<field>  例: gateway.apiKey, model.preferred, theme.mode
const KEY_NAMESPACE = Object.freeze({
  GATEWAY: 'gateway',
  MODEL: 'model',
  THEME: 'theme',
  PROVIDER: 'provider',
  UI: 'ui',
  MOBILE: 'mobile',
  CLI: 'cli',
});

module.exports = { SENSITIVE_KEYS, KEY_NAMESPACE };
