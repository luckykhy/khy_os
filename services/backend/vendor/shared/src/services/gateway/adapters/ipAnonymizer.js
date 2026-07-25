/**
 * IP Anonymization utility for outgoing HTTP requests.
 *
 * Strips or replaces headers that could reveal the user's real IP address
 * when proxying requests through IDE adapters.
 */

// Headers that commonly carry client IP information
const IP_HEADERS = [
  'x-forwarded-for',
  'x-real-ip',
  'cf-connecting-ip',
  'true-client-ip',
  'x-client-ip',
  'forwarded',
  'x-cluster-client-ip',
  'x-originating-ip',
  'via',
];

/**
 * Generate a random private-range IP for header spoofing.
 * Uses 10.x.x.x range (RFC 1918 private) to avoid spoofing real addresses.
 */
function generateFakeIp() {
  return `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
}

/**
 * Clean outgoing headers: remove all IP-identifying headers.
 * @param {object} headers - Request headers object
 * @returns {object} Cleaned headers (mutates in place)
 */
function stripIpHeaders(headers) {
  for (const h of IP_HEADERS) {
    delete headers[h];
    // Also check capitalized variants
    delete headers[h.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join('-')];
  }
  return headers;
}

/**
 * Build sanitized headers for outgoing HTTPS requests.
 * Removes IP-revealing headers and optionally injects a fake IP.
 * @param {object} baseHeaders - Original headers
 * @param {object} [opts] - Options
 * @param {boolean} [opts.injectFakeIp=false] - If true, add fake X-Forwarded-For
 * @returns {object} Clean headers
 */
function sanitizeOutgoingHeaders(baseHeaders = {}, opts = {}) {
  const cleaned = stripIpHeaders({ ...baseHeaders });
  if (opts.injectFakeIp) {
    const fakeIp = generateFakeIp();
    cleaned['X-Forwarded-For'] = fakeIp;
  }
  return cleaned;
}

module.exports = { stripIpHeaders, sanitizeOutgoingHeaders, generateFakeIp, IP_HEADERS };
