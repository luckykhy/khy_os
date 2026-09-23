'use strict';

/**
 * Lease credential providers.
 *
 * The broker is provider-agnostic: anything with getCredential() → {token,
 * expiresAt} can back a lease. OAuth-backed providers (token exchange with a
 * real expiry) give the strongest guarantee; the static-key provider below
 * gives host-side bounded exposure — the TTL is broker-enforced discipline on
 * the consumer, not provider-enforced revocation. Callers must say so honestly.
 */

function createStaticKeyProvider({ getSecret, ttlMs = 5 * 60 * 1000, label = '静态密钥' }) {
  return {
    kind: 'static-key',
    async getCredential() {
      const secret = typeof getSecret === 'function' ? getSecret() : getSecret;
      if (typeof secret !== 'string' || !secret) {
        throw Object.assign(
          new Error(`${label} 不可用：宿主未配置该凭据，运行 khy gateway config 配置或改用其他通道`),
          { code: 'no-credential' },
        );
      }
      return { token: secret, expiresAt: Date.now() + ttlMs };
    },
  };
}

module.exports = { createStaticKeyProvider };
