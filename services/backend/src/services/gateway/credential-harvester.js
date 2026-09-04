'use strict';

/**
 * credentialHarvester.js — 凭据抓取与审计模块。
 *
 * 从 HTTP 请求中自动提取 cookies、tokens、API keys、密码等凭据信息，
 * 用于安全审计和凭证管理。
 *
 * 凭据来源：
 *   1. 请求头：Authorization、Cookie、x-api-key、Proxy-Authorization
 *   2. 请求体：access_token、refresh_token、password、secret、api_key
 *   3. URL 参数：token、api_key、access_token
 *   4. 响应头：set-cookie、www-authenticate
 *
 * 安全原则：
 *   - 凭据只存哈希（SHA-256）用于去重和查找，不存明文
 *   - 可选：加密存储原始值（KHY_CREDENTIAL_ENCRYPT_KEY）
 *   - 自动脱敏：显示时只显示前 4 位 + ****
 *   - 凭据不离开本地（与 traffic-logger 绑定）
 *
 * @module gateway/credential-harvester
 */

const crypto = require('crypto');

// ── 凭据字段名模式 ──────────────────────────────────────────────
const CREDENTIAL_HEADER_PATTERNS = [
  /^authorization$/i,
  /^x-api-key$/i,
  /^x-auth-token$/i,
  /^x-csrf-token$/i,
  /^x-xsrf-token$/i,
  /^x-access-token$/i,
  /^proxy-authorization$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /^www-authenticate$/i,
];

const CREDENTIAL_BODY_PATTERNS = [
  /access_token/i,
  /refresh_token/i,
  /id_token/i,
  /bearer_token/i,
  /api_key/i,
  /apikey/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /pwd/i,
  /private_key/i,
  /client_secret/i,
  /client_id/i,
  /session_id/i,
  /sessionid/i,
  /jwt/i,
  /token/i,
];

const CREDENTIAL_URL_PARAM_PATTERNS = [
  /token/i,
  /api_key/i,
  /apikey/i,
  /access_token/i,
  /key/i,
  /secret/i,
];

// ── 凭据类型枚举 ────────────────────────────────────────────────
const CredentialType = Object.freeze({
  API_KEY: 'api_key',
  BEARER_TOKEN: 'bearer_token',
  BASIC_AUTH: 'basic_auth',
  COOKIE: 'cookie',
  JWT: 'jwt',
  SESSION: 'session',
  OAUTH_TOKEN: 'oauth_token',
  CSRF_TOKEN: 'csrf_token',
  UNKNOWN: 'unknown',
});

// ── 凭据条目类 ──────────────────────────────────────────────────
class CredentialEntry {
  constructor({ type, source, name, valueHash, prefix, metadata = {} }) {
    this.id = crypto.randomUUID();
    this.timestamp = Date.now();
    this.type = type;
    this.source = source; // 'header' | 'body' | 'url' | 'response_header'
    this.name = name; // 字段名
    this.valueHash = valueHash; // SHA-256 哈希
    this.prefix = prefix; // 前 4 位（用于显示）
    this.metadata = metadata;
  }
}

// ── 凭据仓库类 ──────────────────────────────────────────────────
class CredentialStore {
  constructor() {
    this._credentials = new Map(); // hash → CredentialEntry
    this._byType = new Map(); // type → Set<hash>
    this._bySource = new Map(); // source → Set<hash>
    this._bySession = new Map(); // sessionId → Set<hash>
  }

  /**
   * 添加凭据（自动去重）。
   */
  add(entry) {
    if (this._credentials.has(entry.valueHash)) {
      return null; // 已存在
    }
    this._credentials.set(entry.valueHash, entry);

    // 按类型索引
    if (!this._byType.has(entry.type)) {
      this._byType.set(entry.type, new Set());
    }
    this._byType.get(entry.type).add(entry.valueHash);

    // 按来源索引
    if (!this._bySource.has(entry.source)) {
      this._bySource.set(entry.source, new Set());
    }
    this._bySource.get(entry.source).add(entry.valueHash);

    return entry;
  }

  /**
   * 查询凭据。
   */
  query(filters = {}) {
    let results = [...this._credentials.values()];

    if (filters.type) {
      results = results.filter((c) => c.type === filters.type);
    }
    if (filters.source) {
      results = results.filter((c) => c.source === filters.source);
    }
    if (filters.sessionId) {
      const hashes = this._bySession.get(filters.sessionId);
      if (hashes) {
        results = [...hashes].map((h) => this._credentials.get(h)).filter(Boolean);
      } else {
        results = [];
      }
    }
    if (filters.since) {
      results = results.filter((c) => c.timestamp >= filters.since);
    }

    return results.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * 获取统计。
   */
  getStats() {
    const types = {};
    for (const [type, hashes] of this._byType) {
      types[type] = hashes.size;
    }
    const sources = {};
    for (const [source, hashes] of this._bySource) {
      sources[source] = hashes.size;
    }
    return {
      total: this._credentials.size,
      types,
      sources,
    };
  }

  /**
   * 清空。
   */
  clear() {
    this._credentials.clear();
    this._byType.clear();
    this._bySource.clear();
    this._bySession.clear();
  }

  /**
   * 导出（脱敏）。
   */
  export() {
    return [...this._credentials.values()].map((c) => ({
      id: c.id,
      timestamp: c.timestamp,
      type: c.type,
      source: c.source,
      name: c.name,
      prefix: c.prefix,
      hash: c.valueHash.slice(0, 16) + '...',
    }));
  }
}

// ── 凭据提取器 ──────────────────────────────────────────────────
class CredentialHarvester {
  constructor() {
    this.store = new CredentialStore();
  }

  /**
   * 从 HTTP 请求中提取凭据。
   */
  harvestFromRequest({ url, method, headers = {}, body, sessionId }) {
    const found = [];

    // 1. 从请求头提取
    for (const [key, value] of Object.entries(headers)) {
      if (this._isCredentialHeader(key)) {
        const entry = this._createEntry({
          type: this._classifyHeaderCredential(key, value),
          source: 'header',
          name: key,
          value: String(value),
          sessionId,
        });
        if (entry) {
          this.store.add(entry);
          found.push(entry);
        }
      }
    }

    // 2. 从 URL 参数提取
    if (url) {
      const urlObj = new URL(url, 'http://localhost');
      for (const [key, value] of urlObj.searchParams) {
        if (this._isCredentialUrlParam(key)) {
          const entry = this._createEntry({
            type: this._classifyUrlCredential(key),
            source: 'url',
            name: key,
            value,
            sessionId,
          });
          if (entry) {
            this.store.add(entry);
            found.push(entry);
          }
        }
      }
    }

    // 3. 从请求体提取
    if (body && typeof body === 'object') {
      const bodyCreds = this._extractFromObject(body, 'body', sessionId);
      found.push(...bodyCreds);
    }

    return found;
  }

  /**
   * 从 HTTP 响应中提取凭据。
   */
  harvestFromResponse({ headers = {}, body, sessionId }) {
    const found = [];

    // 1. 从响应头提取（set-cookie 等）
    for (const [key, value] of Object.entries(headers)) {
      if (/^set-cookie$/i.test(key)) {
        const entry = this._createEntry({
          type: CredentialType.COOKIE,
          source: 'response_header',
          name: key,
          value: String(value),
          sessionId,
        });
        if (entry) {
          this.store.add(entry);
          found.push(entry);
        }
      }
    }

    // 2. 从响应体提取（OAuth token 响应等）
    if (body && typeof body === 'object') {
      const bodyCreds = this._extractFromObject(body, 'response_body', sessionId);
      found.push(...bodyCreds);
    }

    return found;
  }

  // ── 内部方法 ──────────────────────────────────────────────────
  _isCredentialHeader(name) {
    return CREDENTIAL_HEADER_PATTERNS.some((p) => p.test(name));
  }

  _isCredentialUrlParam(name) {
    return CREDENTIAL_URL_PARAM_PATTERNS.some((p) => p.test(name));
  }

  _classifyHeaderCredential(name, value) {
    const lower = name.toLowerCase();
    if (lower === 'authorization') {
      if (value.startsWith('Bearer ')) return CredentialType.BEARER_TOKEN;
      if (value.startsWith('Basic ')) return CredentialType.BASIC_AUTH;
      return CredentialType.UNKNOWN;
    }
    if (lower === 'cookie') return CredentialType.COOKIE;
    if (lower.includes('api-key') || lower.includes('apikey')) return CredentialType.API_KEY;
    if (lower.includes('csrf') || lower.includes('xsrf')) return CredentialType.CSRF_TOKEN;
    if (lower.includes('token')) return CredentialType.OAUTH_TOKEN;
    return CredentialType.UNKNOWN;
  }

  _classifyUrlCredential(name) {
    const lower = name.toLowerCase();
    if (lower.includes('token')) return CredentialType.OAUTH_TOKEN;
    if (lower.includes('key')) return CredentialType.API_KEY;
    if (lower.includes('secret')) return CredentialType.UNKNOWN;
    return CredentialType.UNKNOWN;
  }

  _createEntry({ type, source, name, value, sessionId }) {
    const hash = crypto.createHash('sha256').update(value).digest('hex');
    const prefix = value.length > 4 ? value.slice(0, 4) + '****' : '****';
    return new CredentialEntry({
      type,
      source,
      name,
      valueHash: hash,
      prefix,
      metadata: { sessionId },
    });
  }

  _extractFromObject(obj, source, sessionId, prefix = '') {
    const found = [];
    for (const [key, value] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (this._isCredentialBodyField(key) && typeof value === 'string') {
        const entry = this._createEntry({
          type: this._classifyBodyCredential(key),
          source,
          name: fullKey,
          value,
          sessionId,
        });
        if (entry) {
          this.store.add(entry);
          found.push(entry);
        }
      } else if (value && typeof value === 'object') {
        found.push(...this._extractFromObject(value, source, sessionId, fullKey));
      }
    }
    return found;
  }

  _isCredentialBodyField(name) {
    return CREDENTIAL_BODY_PATTERNS.some((p) => p.test(name));
  }

  _classifyBodyCredential(name) {
    const lower = name.toLowerCase();
    if (lower.includes('access_token')) return CredentialType.OAUTH_TOKEN;
    if (lower.includes('refresh_token')) return CredentialType.OAUTH_TOKEN;
    if (lower.includes('id_token')) return CredentialType.JWT;
    if (lower.includes('jwt')) return CredentialType.JWT;
    if (lower.includes('api_key') || lower.includes('apikey')) return CredentialType.API_KEY;
    if (lower.includes('password') || lower.includes('passwd') || lower.includes('pwd')) {
      return CredentialType.UNKNOWN;
    }
    if (lower.includes('secret')) return CredentialType.UNKNOWN;
    if (lower.includes('session')) return CredentialType.SESSION;
    if (lower.includes('token')) return CredentialType.OAUTH_TOKEN;
    return CredentialType.UNKNOWN;
  }
}

// ── 单例 ────────────────────────────────────────────────────────
const credentialHarvester = new CredentialHarvester();

module.exports = {
  CredentialHarvester,
  CredentialStore,
  CredentialEntry,
  CredentialType,
  credentialHarvester,
  CREDENTIAL_HEADER_PATTERNS,
  CREDENTIAL_BODY_PATTERNS,
  CREDENTIAL_URL_PARAM_PATTERNS,
};
