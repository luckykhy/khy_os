'use strict';

/**
 * ssrfIpv4MappedHex.test.js — R1 of /goal「做5轮khyos最值得治理的地方」(fourth batch).
 *
 * ssrfGuard.isPrivateIpv6's IPv4-mapped branch only decoded the dotted-decimal
 * form `::ffff:x.x.x.x`. The equivalent hextet HEX form (`::ffff:7f00:1` ==
 * 127.0.0.1, `::ffff:a9fe:a9fe` == 169.254.169.254 cloud-metadata) slipped
 * through classified as PUBLIC → SSRF bypass / cloud-credential theft. The
 * sibling urlSafety.js already unwraps this via ipaddr.js; this closes the gap
 * in the hand-rolled layer. Gated KHY_SSRF_IPV4_MAPPED_HEX (default ON);
 * OFF byte-reverts to the dotted-only behavior.
 */

const ssrf = require('../../src/services/ssrfGuard');

const OFF = { env: { KHY_SSRF_IPV4_MAPPED_HEX: '0' } };

describe('R1: IPv4-mapped IPv6 hex hextet form is classified private (ON)', () => {
  test.each([
    ['::ffff:7f00:1', '127.0.0.1 loopback'],
    ['::ffff:a9fe:a9fe', '169.254.169.254 cloud metadata'],
    ['::ffff:c0a8:1', '192.168.0.1 RFC1918'],
    ['::ffff:0a00:1', '10.0.0.1 RFC1918'],
    ['::ffff:ac10:1', '172.16.0.1 RFC1918'],
  ])('%s (%s) → private', (addr) => {
    expect(ssrf.isPrivateIpv6(addr)).toBe(true);
  });

  test('long-form ::ffff: prefix (0:0:0:0:0:ffff:) also decodes', () => {
    expect(ssrf.isPrivateIpv6('0:0:0:0:0:ffff:7f00:1')).toBe(true);
  });

  test('public hex-mapped addresses stay public (no false positive)', () => {
    expect(ssrf.isPrivateIpv6('::ffff:0808:0808')).toBe(false); // 8.8.8.8
    expect(ssrf.isPrivateIpv6('::ffff:0101:0101')).toBe(false); // 1.1.1.1
  });

  test('the existing dotted-decimal branch is unaffected', () => {
    expect(ssrf.isPrivateIpv6('::ffff:127.0.0.1')).toBe(true);
    expect(ssrf.isPrivateIpv6('::ffff:169.254.169.254')).toBe(true);
    expect(ssrf.isPrivateIpv6('::ffff:8.8.8.8')).toBe(false);
  });
});

describe('R1: OFF byte-reverts to dotted-only (hex hole reopens)', () => {
  test('hex-form loopback / metadata classified public when gate off', () => {
    expect(ssrf.isPrivateIpv6('::ffff:7f00:1', OFF)).toBe(false);
    expect(ssrf.isPrivateIpv6('::ffff:a9fe:a9fe', OFF)).toBe(false);
  });

  test('dotted-decimal still works with gate off (unchanged path)', () => {
    expect(ssrf.isPrivateIpv6('::ffff:127.0.0.1', OFF)).toBe(true);
  });
});

describe('R1: end-to-end via isPrivateIpAddress', () => {
  test('bracketed hex-mapped metadata address blocked through the public API', () => {
    expect(ssrf.isPrivateIpAddress('::ffff:a9fe:a9fe')).toBe(true);
  });
});

describe('R1: fail-soft', () => {
  test('non-mapped IPv6 and odd input never throw', () => {
    expect(() => ssrf.isPrivateIpv6('2606:4700:4700::1111')).not.toThrow();
    expect(ssrf.isPrivateIpv6('::1')).toBe(true);
    expect(ssrf.isPrivateIpv6('fe80::1')).toBe(true);
  });
});
