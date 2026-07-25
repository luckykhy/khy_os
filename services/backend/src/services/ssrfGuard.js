'use strict';

/**
 * ssrfGuard.js — SSRF prevention for outbound HTTP requests.
 *
 * Ported from OpenClaw's net/ssrf.ts.
 * Provides:
 *   - Private/special-use IP detection (IPv4 + IPv6)
 *   - Blocked hostname checking (localhost, .local, .internal, metadata)
 *   - Hostname allowlisting with wildcard support
 *   - DNS pinning to prevent DNS rebinding attacks
 *   - Policy-based validation with RFC exemptions
 */

const dns = require('dns');
const net = require('net');

// ── Constants ──────────────────────────────────────────────────────

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.google',
  'metadata',
]);

const BLOCKED_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal'];

/**
 * IPv4 private/special-use ranges (CIDR → [baseInt, maskInt]).
 * Includes: RFC 1918, RFC 5737, loopback, link-local, broadcast.
 */
const IPV4_PRIVATE_RANGES = [
  { cidr: '10.0.0.0/8',      base: 0x0A000000, mask: 0xFF000000 },     // RFC 1918
  { cidr: '172.16.0.0/12',    base: 0xAC100000, mask: 0xFFF00000 },     // RFC 1918
  { cidr: '192.168.0.0/16',   base: 0xC0A80000, mask: 0xFFFF0000 },     // RFC 1918
  { cidr: '127.0.0.0/8',      base: 0x7F000000, mask: 0xFF000000 },     // Loopback
  { cidr: '169.254.0.0/16',   base: 0xA9FE0000, mask: 0xFFFF0000 },     // Link-local
  { cidr: '0.0.0.0/8',        base: 0x00000000, mask: 0xFF000000 },     // "This network"
  { cidr: '100.64.0.0/10',    base: 0x64400000, mask: 0xFFC00000 },     // Shared address (CGNAT)
  { cidr: '192.0.0.0/24',     base: 0xC0000000, mask: 0xFFFFFF00 },     // IETF protocol assignments
  { cidr: '192.0.2.0/24',     base: 0xC0000200, mask: 0xFFFFFF00 },     // TEST-NET-1
  { cidr: '198.51.100.0/24',  base: 0xC6336400, mask: 0xFFFFFF00 },     // TEST-NET-2
  { cidr: '203.0.113.0/24',   base: 0xCB007100, mask: 0xFFFFFF00 },     // TEST-NET-3
  { cidr: '240.0.0.0/4',      base: 0xF0000000, mask: 0xF0000000 },     // Reserved
  { cidr: '255.255.255.255/32', base: 0xFFFFFFFF, mask: 0xFFFFFFFF },   // Broadcast
];

// RFC 2544 benchmark: 198.18.0.0/15
const RFC2544_RANGE = { cidr: '198.18.0.0/15', base: 0xC6120000, mask: 0xFFFE0000 };

// ── IPv4 Parsing & Classification ──────────────────────────────────

/**
 * Parse an IPv4 dotted-decimal string into a 32-bit unsigned integer.
 * Returns null if invalid or uses non-standard notation (octal/hex).
 */
function parseIpv4ToInt(ip) {
  // Reject octal/hex notation (security: prevents bypass)
  if (/0[xX]/.test(ip) || /\b0\d/.test(ip)) return null;

  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  let result = 0;
  for (let i = 0; i < 4; i++) {
    const n = Number(parts[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    result = (result << 8) | n;
  }
  return result >>> 0; // unsigned
}

/**
 * Check if an IPv4 integer falls within a private/special-use range.
 */
function isPrivateIpv4(ipInt, opts = {}) {
  // [SAFE] JavaScript's bitwise `&` evaluates in 32-bit SIGNED arithmetic: for any
  // address with the high bit set (>= 128.0.0.0 — i.e. 172.16/12, 192.168/16, the
  // 169.254/16 link-local block that hosts the cloud metadata endpoint, 240/4,
  // 255.255.255.255) `ipInt & range.mask` yields a NEGATIVE int32, while range.base
  // is a positive number literal (0xAC100000 = 2887057408). The two can never be
  // ===, so EVERY high-bit private range silently classified as PUBLIC — the SSRF
  // guard waved through 169.254.169.254 (AWS/GCP/Azure IAM-credential metadata) and
  // the entire RFC 1918 LAN, i.e. full SSRF / cloud-credential theft. Coerce the
  // masked result back to unsigned with `>>> 0` before comparing so both sides are
  // unsigned 32-bit. (10/8 and 127/8 happened to work only because their high bit
  // is clear.)
  for (const range of IPV4_PRIVATE_RANGES) {
    if (((ipInt & range.mask) >>> 0) === (range.base >>> 0)) return true;
  }
  // RFC 2544 benchmark range (optionally allowed)
  if (!opts.allowRfc2544) {
    if (((ipInt & RFC2544_RANGE.mask) >>> 0) === (RFC2544_RANGE.base >>> 0)) return true;
  }
  return false;
}

// ── IPv6 Classification ────────────────────────────────────────────

/**
 * Check if an IPv6 address string is private/special-use.
 * Handles: loopback (::1), link-local (fe80::), ULA (fc00::/7),
 *          IPv4-mapped (::ffff:x.x.x.x), unspecified (::).
 */
function isPrivateIpv6(address, opts = {}) {
  const lower = address.toLowerCase().trim();

  // Loopback
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;

  // Unspecified
  if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return true;

  // Link-local (fe80::/10)
  if (lower.startsWith('fe8') || lower.startsWith('fe9') ||
      lower.startsWith('fea') || lower.startsWith('feb')) return true;

  // Unique Local Address (fc00::/7) — optionally allowed
  if (!opts.allowUniqueLocal) {
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  }

  // IPv4-mapped (::ffff:x.x.x.x) — check the embedded IPv4
  const v4Mapped = lower.match(/^(?:::ffff:|0{0,4}:0{0,4}:0{0,4}:0{0,4}:0{0,4}:ffff:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) {
    const embeddedInt = parseIpv4ToInt(v4Mapped[1]);
    if (embeddedInt !== null && isPrivateIpv4(embeddedInt, opts)) return true;
  }

  // IPv4-mapped in HEX hextet form (::ffff:7f00:1 == 127.0.0.1) — the dotted branch
  // above only decodes `x.x.x.x`, so `::ffff:7f00:1` (loopback) / `::ffff:a9fe:a9fe`
  // (169.254.169.254 cloud metadata) slipped through as PUBLIC → SSRF bypass. The
  // sibling urlSafety.js already unwraps this via ipaddr.js; this closes the gap in
  // the hand-rolled layer. Gated KHY_SSRF_IPV4_MAPPED_HEX (default ON); OFF byte-reverts.
  let _ssrfHex = true;
  try { _ssrfHex = require('./flagRegistry').isFlagEnabled('KHY_SSRF_IPV4_MAPPED_HEX', opts && opts.env ? opts.env : process.env); } catch { _ssrfHex = true; }
  if (_ssrfHex) {
    const v4Hex = lower.match(/^(?:::ffff:|0{0,4}:0{0,4}:0{0,4}:0{0,4}:0{0,4}:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (v4Hex) {
      const embeddedInt = (((parseInt(v4Hex[1], 16) << 16) | parseInt(v4Hex[2], 16)) >>> 0);
      if (isPrivateIpv4(embeddedInt, opts)) return true;
    }
  }

  // Teredo (2001:0000::/32) — may contain private IPv4
  if (lower.startsWith('2001:0000:') || lower.startsWith('2001:0:')) return true;

  // Documentation (2001:db8::/32)
  if (lower.startsWith('2001:db8:') || lower.startsWith('2001:0db8:')) return true;

  return false;
}

// ── Hostname Classification ────────────────────────────────────────

/**
 * Normalize a hostname: lowercase, strip trailing dot, remove brackets.
 */
function normalizeHostname(hostname) {
  if (!hostname || typeof hostname !== 'string') return '';
  let h = hostname.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

/**
 * Check if a hostname is blocked (localhost, .local, .internal, metadata).
 */
function isBlockedHostname(hostname) {
  const h = normalizeHostname(hostname);
  if (!h) return true; // empty hostname is blocked
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (h.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * Check if an IP address string is private/special-use.
 */
function isPrivateIpAddress(address, opts = {}) {
  if (!address) return true;
  const trimmed = address.trim();

  // IPv4
  if (net.isIPv4(trimmed)) {
    const ipInt = parseIpv4ToInt(trimmed);
    if (ipInt === null) return true; // fail closed
    return isPrivateIpv4(ipInt, opts);
  }

  // IPv6
  if (net.isIPv6(trimmed) || trimmed.includes(':')) {
    return isPrivateIpv6(trimmed, opts);
  }

  // Not a recognized IP format — fail closed
  return true;
}

/**
 * Check if a hostname or IP is blocked by SSRF policy.
 */
function isBlockedHostnameOrIp(hostname, policy = {}) {
  const h = normalizeHostname(hostname);
  if (!h) return true;

  // Check hostname allowlist first
  if (policy.hostnameAllowlist && policy.hostnameAllowlist.length > 0) {
    if (matchesHostnameAllowlist(h, policy.hostnameAllowlist)) return false;
  }

  if (isBlockedHostname(h)) return true;
  if (isPrivateIpAddress(h, {
    allowRfc2544: policy.allowRfc2544BenchmarkRange,
    allowUniqueLocal: policy.allowIpv6UniqueLocalRange,
  })) return true;

  return false;
}

// ── Hostname Allowlisting ──────────────────────────────────────────

/**
 * Check if a hostname matches a wildcard allowlist.
 * Supports: "example.com" (exact), "*.example.com" (subdomains).
 */
function matchesHostnameAllowlist(hostname, allowlist) {
  if (!allowlist || allowlist.length === 0) return true; // empty = allow all
  const h = normalizeHostname(hostname);

  for (const pattern of allowlist) {
    const p = normalizeHostname(pattern);
    if (!p || p === '*' || p === '*.') continue;

    if (p.startsWith('*.')) {
      const suffix = p.slice(1); // ".example.com"
      if (h.endsWith(suffix) && h.length > suffix.length) return true;
    } else if (h === p) {
      return true;
    }
  }
  return false;
}

/**
 * Normalize an allowlist: deduplicate, filter, sort.
 */
function normalizeHostnameAllowlist(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const result = [];
  for (const v of values) {
    const h = normalizeHostname(v);
    if (!h || h === '*' || h === '*.') continue;
    if (seen.has(h)) continue;
    seen.add(h);
    result.push(h);
  }
  return result.sort();
}

// ── DNS Pinning ────────────────────────────────────────────────────

/**
 * Resolve hostname and validate resolved IPs against SSRF policy.
 * Returns pinned addresses for use in subsequent connections.
 *
 * @param {string} hostname
 * @param {object} [policy]
 * @returns {Promise<{ hostname: string, addresses: string[] }>}
 * @throws {SsrfBlockedError}
 */
async function resolveAndValidate(hostname, policy = {}) {
  const h = normalizeHostname(hostname);

  // Pre-DNS check
  if (isBlockedHostname(h)) {
    throw new SsrfBlockedError(`Blocked hostname: ${h}`);
  }
  // [SAFE] Only reject when `h` is *itself* a private/special-use IP LITERAL
  // (e.g. http://169.254.169.254, http://127.0.0.1). `isPrivateIpAddress` fails
  // CLOSED — it returns true for any string that is not a valid IP — which is the
  // correct policy when validating DNS-*resolved* addresses below, but applied to a
  // raw hostname it rejected EVERY plain hostname (`dash.pqjc.site`, every real
  // subscription/WebFetch target) with "Blocked private/special-use IP", i.e. the
  // guard blocked all outbound fetches. Non-literal hostnames must be judged by DNS
  // resolution + the post-resolution validation loop, not pre-DNS (mirrors the
  // sibling urlSafety.isPrivateOrLocalHostname, which defers non-literals to DNS).
  // Also map policy → opts key names (allowRfc2544BenchmarkRange, not allowRfc2544).
  if (net.isIP(h) !== 0 && isPrivateIpAddress(h, {
    allowRfc2544: policy.allowRfc2544BenchmarkRange,
    allowUniqueLocal: policy.allowIpv6UniqueLocalRange,
  })) {
    throw new SsrfBlockedError(`Blocked private/special-use IP: ${h}`);
  }

  // Resolve DNS
  let addresses;
  try {
    addresses = await new Promise((resolve, reject) => {
      dns.lookup(h, { all: true }, (err, results) => {
        if (err) return reject(err);
        resolve(results || []);
      });
    });
  } catch (err) {
    throw new SsrfBlockedError(`DNS resolution failed for ${h}: ${err.message}`);
  }

  if (!addresses || addresses.length === 0) {
    throw new SsrfBlockedError(`No DNS records for ${h}`);
  }

  // Post-DNS: validate all resolved addresses
  const validAddrs = [];
  for (const { address } of addresses) {
    if (isPrivateIpAddress(address, {
      allowRfc2544: policy.allowRfc2544BenchmarkRange,
      allowUniqueLocal: policy.allowIpv6UniqueLocalRange,
    })) {
      throw new SsrfBlockedError(`DNS resolved to private/special-use IP: ${address} (hostname: ${h})`);
    }
    if (!validAddrs.includes(address)) validAddrs.push(address);
  }

  // Prefer IPv4 for Happy Eyeballs compatibility
  validAddrs.sort((a, b) => {
    const aIsV4 = net.isIPv4(a) ? 0 : 1;
    const bIsV4 = net.isIPv4(b) ? 0 : 1;
    return aIsV4 - bIsV4;
  });

  return { hostname: h, addresses: validAddrs };
}

/**
 * Validate a URL against SSRF policy.
 * Shorthand for extracting hostname and calling resolveAndValidate.
 *
 * @param {string} url
 * @param {object} [policy]
 * @returns {Promise<{ hostname: string, addresses: string[] }>}
 */
async function validateUrl(url, policy = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfBlockedError(`Invalid URL: ${url}`);
  }

  // Only allow HTTP(S)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfBlockedError(`Blocked protocol: ${parsed.protocol}`);
  }

  return resolveAndValidate(parsed.hostname, policy);
}

// ── Error Class ────────────────────────────────────────────────────

class SsrfBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

module.exports = {
  isBlockedHostname,
  isBlockedHostnameOrIp,
  isPrivateIpAddress,
  isPrivateIpv4,
  isPrivateIpv6,
  matchesHostnameAllowlist,
  normalizeHostname,
  normalizeHostnameAllowlist,
  resolveAndValidate,
  validateUrl,
  parseIpv4ToInt,
  SsrfBlockedError,
  BLOCKED_HOSTNAMES,
  IPV4_PRIVATE_RANGES,
};
