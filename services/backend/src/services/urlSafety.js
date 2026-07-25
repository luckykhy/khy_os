/**
 * urlSafety — SSRF guard for outbound HTTP fetches.
 *
 * Any tool that fetches a model- or user-supplied URL (WebFetch, future
 * content extractors) must route through here before opening a socket.
 * The danger is a public-looking hostname that resolves to — or redirects
 * to — an internal target: cloud metadata (169.254.169.254), loopback,
 * RFC1918 ranges, link-local, etc. We reject those.
 *
 * Two tiers:
 *   - assertPublicHttpUrl()         — synchronous: protocol + IP-literal check.
 *   - assertPublicHttpUrlResolved() — async: also DNS-resolves the hostname
 *                                     and rejects if ANY answer is private.
 *
 * Modeled on open-webSearch's urlSafety.ts; adapted to CommonJS + Node core.
 */
'use strict';

const dns = require('node:dns/promises');
const { isIP } = require('node:net');
const ipaddr = require('ipaddr.js');

// Optional allowlist for fake-IP CIDRs (e.g. Clash fake-ip pool 198.18.0.0/16),
// where a "private-looking" resolved address is actually a proxy placeholder.
// Comma-separated CIDRs in KHY_FAKE_IP_CIDRS.
function _fakeIpCidrs() {
  const raw = process.env.KHY_FAKE_IP_CIDRS;
  if (!raw) return [];
  return raw.split(',').map((c) => c.trim()).filter(Boolean);
}

// URL.hostname keeps the brackets for IPv6 literals (`[::1]`), which break
// isIP and dns.lookup. Strip them once here.
function _stripIpv6Brackets(host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function _isAllowedFakeIp(address) {
  const cidrs = _fakeIpCidrs();
  if (isIP(address) === 0 || cidrs.length === 0) return false;
  try {
    const parsed = ipaddr.parse(address);
    return cidrs.some((cidr) => parsed.match(ipaddr.parseCIDR(cidr)));
  } catch {
    return false;
  }
}

/**
 * True if the hostname is localhost, an internal name, or an IP literal that
 * is NOT a public unicast address. Plain (non-literal) hostnames return false
 * here — they must go through DNS resolution to be judged (see *Resolved).
 * @param {string} hostname
 * @returns {boolean}
 */
function isPrivateOrLocalHostname(hostname) {
  const host = _stripIpv6Brackets(String(hostname || '').trim().toLowerCase());
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true;
  // Common internal TLDs that should never reach the public internet.
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (isIP(host) === 0) return false; // not an IP literal — defer to DNS
  try {
    let addr = ipaddr.parse(host);
    // Unwrap IPv4-mapped IPv6 (::ffff:127.0.0.1) so the IPv4 ranges apply.
    if (addr.kind() === 'ipv6' && typeof addr.isIPv4MappedAddress === 'function' && addr.isIPv4MappedAddress()) {
      addr = addr.toIPv4Address();
    }
    return addr.range() !== 'unicast';
  } catch {
    return false;
  }
}

/**
 * True if the URL is a well-formed http(s) URL whose host is not an obvious
 * private/local IP literal. Does NOT perform DNS resolution.
 * @param {string} url
 * @returns {boolean}
 */
function isPublicHttpUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return !isPrivateOrLocalHostname(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Throw if the URL is not http(s) or points to a private/local IP literal.
 * @param {string|URL} url
 * @param {string} label
 */
function assertPublicHttpUrl(url, label = 'URL') {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  if (isPrivateOrLocalHostname(parsed.hostname)) {
    throw new Error(`${label} points to a private or local network target, which is not allowed`);
  }
}

// Indirection point so tests can stub DNS without real network access.
let _dnsLookup = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

function __setDnsLookupForTests(lookup) {
  _dnsLookup = lookup || ((hostname) => dns.lookup(hostname, { all: true, verbatim: true }));
}

/**
 * Like assertPublicHttpUrl, but also DNS-resolves the hostname and rejects if
 * ANY resolved address is private/local. This closes the DNS-rebinding and
 * "public CNAME → internal A record" holes. Skipped for IP-literal hosts
 * (already judged synchronously).
 * @param {string|URL} url
 * @param {string} label
 * @returns {Promise<void>}
 */
async function assertPublicHttpUrlResolved(url, label = 'URL') {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  assertPublicHttpUrl(parsed, label);

  const host = _stripIpv6Brackets(parsed.hostname);
  if (isIP(host) !== 0) return; // IP literal already validated

  let resolved;
  try {
    resolved = await _dnsLookup(host);
  } catch {
    throw new Error(`${label} could not be resolved`);
  }
  const list = Array.isArray(resolved) ? resolved : [];
  if (list.some((entry) => isPrivateOrLocalHostname(entry.address) && !_isAllowedFakeIp(entry.address))) {
    throw new Error(`${label} resolves to a private or local network target, which is not allowed`);
  }
}

module.exports = {
  isPrivateOrLocalHostname,
  isPublicHttpUrl,
  assertPublicHttpUrl,
  assertPublicHttpUrlResolved,
  __setDnsLookupForTests,
};
