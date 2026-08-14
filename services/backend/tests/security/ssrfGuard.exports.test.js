'use strict';

/**
 * Tests for services/ssrfGuard.js — SSRF prevention.
 */

const ssrfGuard = require('../../src/services/ssrfGuard');

describe('ssrfGuard exports', () => {
  test('exports all expected functions', () => {
    expect(typeof ssrfGuard.isBlockedHostname).toBe('function');
    expect(typeof ssrfGuard.isBlockedHostnameOrIp).toBe('function');
    expect(typeof ssrfGuard.isPrivateIpAddress).toBe('function');
    expect(typeof ssrfGuard.isPrivateIpv4).toBe('function');
    expect(typeof ssrfGuard.isPrivateIpv6).toBe('function');
    expect(typeof ssrfGuard.normalizeHostname).toBe('function');
    expect(typeof ssrfGuard.matchesHostnameAllowlist).toBe('function');
    expect(typeof ssrfGuard.normalizeHostnameAllowlist).toBe('function');
    expect(typeof ssrfGuard.parseIpv4ToInt).toBe('function');
    expect(typeof ssrfGuard.resolveAndValidate).toBe('function');
    expect(typeof ssrfGuard.validateUrl).toBe('function');
  });

  test('exports SsrfBlockedError class', () => {
    expect(typeof ssrfGuard.SsrfBlockedError).toBe('function');
    const err = new ssrfGuard.SsrfBlockedError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SsrfBlockedError');
  });

  test('exports BLOCKED_HOSTNAMES set', () => {
    expect(ssrfGuard.BLOCKED_HOSTNAMES).toBeInstanceOf(Set);
    expect(ssrfGuard.BLOCKED_HOSTNAMES.has('localhost')).toBe(true);
  });
});

describe('isBlockedHostname', () => {
  test('blocks localhost', () => {
    expect(ssrfGuard.isBlockedHostname('localhost')).toBe(true);
  });

  test('blocks metadata.google.internal', () => {
    expect(ssrfGuard.isBlockedHostname('metadata.google.internal')).toBe(true);
  });

  test('blocks .local suffix', () => {
    expect(ssrfGuard.isBlockedHostname('myhost.local')).toBe(true);
  });

  test('blocks empty hostname', () => {
    expect(ssrfGuard.isBlockedHostname('')).toBe(true);
    expect(ssrfGuard.isBlockedHostname(null)).toBe(true);
  });

  test('allows public hostnames', () => {
    expect(ssrfGuard.isBlockedHostname('api.openai.com')).toBe(false);
    expect(ssrfGuard.isBlockedHostname('google.com')).toBe(false);
  });
});

describe('isPrivateIpAddress', () => {
  test('detects private IPv4 ranges', () => {
    expect(ssrfGuard.isPrivateIpAddress('10.0.0.1')).toBe(true);
    expect(ssrfGuard.isPrivateIpAddress('172.16.0.1')).toBe(true);
    expect(ssrfGuard.isPrivateIpAddress('192.168.1.1')).toBe(true);
    expect(ssrfGuard.isPrivateIpAddress('127.0.0.1')).toBe(true);
  });

  test('detects IPv6 loopback', () => {
    expect(ssrfGuard.isPrivateIpAddress('::1')).toBe(true);
  });

  test('allows public IPs', () => {
    expect(ssrfGuard.isPrivateIpAddress('8.8.8.8')).toBe(false);
    expect(ssrfGuard.isPrivateIpAddress('1.1.1.1')).toBe(false);
  });

  test('returns true (fail-closed) for empty input', () => {
    expect(ssrfGuard.isPrivateIpAddress('')).toBe(true);
    expect(ssrfGuard.isPrivateIpAddress(null)).toBe(true);
  });
});

describe('normalizeHostname', () => {
  test('lowercases and trims', () => {
    expect(ssrfGuard.normalizeHostname('  API.OpenAI.COM  ')).toBe('api.openai.com');
  });

  test('strips trailing dot', () => {
    expect(ssrfGuard.normalizeHostname('example.com.')).toBe('example.com');
  });

  test('strips brackets for IPv6', () => {
    expect(ssrfGuard.normalizeHostname('[::1]')).toBe('::1');
  });

  test('returns empty for null/undefined', () => {
    expect(ssrfGuard.normalizeHostname(null)).toBe('');
    expect(ssrfGuard.normalizeHostname(undefined)).toBe('');
  });
});

describe('parseIpv4ToInt', () => {
  test('parses valid IPv4', () => {
    expect(ssrfGuard.parseIpv4ToInt('127.0.0.1')).toBe(0x7F000001);
    expect(ssrfGuard.parseIpv4ToInt('0.0.0.0')).toBe(0);
  });

  test('rejects octal notation (bypass prevention)', () => {
    expect(ssrfGuard.parseIpv4ToInt('0177.0.0.1')).toBeNull();
  });

  test('rejects hex notation', () => {
    expect(ssrfGuard.parseIpv4ToInt('0x7f.0.0.1')).toBeNull();
  });

  test('rejects malformed addresses', () => {
    expect(ssrfGuard.parseIpv4ToInt('256.0.0.1')).toBeNull();
    expect(ssrfGuard.parseIpv4ToInt('1.2.3')).toBeNull();
  });
});

describe('resolveAndValidate pre-DNS host classification', () => {
  const dns = require('dns');
  let origLookup;
  beforeEach(() => { origLookup = dns.lookup; });
  afterEach(() => { dns.lookup = origLookup; });

  // Regression: a plain public hostname must NOT be rejected pre-DNS. The bug was
  // that isPrivateIpAddress fails-closed for non-IP strings, and it was applied to
  // the raw hostname before DNS — so EVERY hostname (dash.pqjc.site, api.openai.com,
  // every real subscription/WebFetch target) was blocked with
  // "Blocked private/special-use IP". Non-literals must defer to DNS resolution.
  test('allows a public hostname (defers to DNS, not blocked pre-DNS)', async () => {
    dns.lookup = (h, o, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]);
    const r = await ssrfGuard.resolveAndValidate('dash.pqjc.site');
    expect(r.hostname).toBe('dash.pqjc.site');
    expect(r.addresses).toEqual(['93.184.216.34']);
  });

  test('still blocks private/metadata IP LITERALS pre-DNS', async () => {
    await expect(ssrfGuard.resolveAndValidate('169.254.169.254'))
      .rejects.toThrow(/Blocked private\/special-use IP/);
    await expect(ssrfGuard.resolveAndValidate('127.0.0.1'))
      .rejects.toThrow(/Blocked private\/special-use IP/);
    await expect(ssrfGuard.resolveAndValidate('192.168.1.1'))
      .rejects.toThrow(/Blocked private\/special-use IP/);
  });

  test('still blocks a hostname that DNS-resolves to a private IP (rebind)', async () => {
    dns.lookup = (h, o, cb) => cb(null, [{ address: '192.168.1.10', family: 4 }]);
    await expect(ssrfGuard.resolveAndValidate('evil-rebind.example.com'))
      .rejects.toThrow(/DNS resolved to private\/special-use IP/);
  });

  test('validateUrl accepts the reported subscription URL over a public IP', async () => {
    dns.lookup = (h, o, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]);
    const r = await ssrfGuard.validateUrl('https://dash.pqjc.site/api/v1/pq/07edda3228957e44f4f30516efb65642');
    expect(r.hostname).toBe('dash.pqjc.site');
  });
});
