'use strict';

/**
 * mobilePairingContract.test.js — the pairing QR contract, pinned at both ends.
 *
 * `khy mobile app` emits the payload; the Flutter companion
 * (`apps/khy-os-client-app/lib/core/gateway/pairing.dart`) consumes it. The two
 * sides never run in the same process, so nothing else can notice if the emitter
 * changes shape. This suite re-implements the Dart parser's normalisation
 * pipeline in JS and asserts the emitter still satisfies it.
 *
 * If you change `buildPairingPayload`, change `parseLikeDart` and the Dart
 * parser together — that is the whole point of this file.
 */

const { buildPairingPayload, resolveTargetUrl } = require('../../../src/cli/handlers/mobile');

/**
 * Faithful JS port of `PairingPayloadParser.parse` in pairing.dart.
 * Returns the normalised `apiBaseUrl`, or throws an Error whose message mirrors
 * the Dart exception text for the rejected cases.
 *
 * @param {string} raw - decoded QR text or pasted payload
 * @returns {string} normalised api base url (scheme included, no trailing slash)
 */
function parseLikeDart(raw) {
  // _stripDecoration
  let text = raw.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  for (const wrapper of ['"', "'", '`']) {
    if (text.length >= 2 && text.startsWith(wrapper) && text.endsWith(wrapper)) {
      text = text.slice(1, -1).trim();
      break;
    }
  }
  if (!text.startsWith('{') && text.includes('\n')) {
    text = text.split('\n').find((line) => line.trim() !== '') || '';
    text = text.trim();
  }
  if (text === '') {
    throw new Error('配对内容为空');
  }

  // _fromJson
  let candidate;
  if (text.startsWith('{')) {
    let decoded;
    try {
      decoded = JSON.parse(text);
    } catch (err) {
      throw new Error('配对内容不是合法 JSON');
    }
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      throw new Error('配对内容格式不对');
    }
    for (const key of ['apiBaseUrl', 'apiUrl', 'url', 'backend', 'api']) {
      const value = decoded[key];
      if (typeof value === 'string' && value.trim() !== '') return parseLikeDart(value);
    }
    throw new Error('配对内容缺少 apiBaseUrl 字段');
  }
  candidate = text;

  // _normalizeUrl
  text = candidate.trim();
  if (text === '') throw new Error('配对内容没有地址');
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text)) text = `http://${text}`;

  const matched = text.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/]*)(.*)$/);
  if (!matched) throw new Error('配对内容不是有效地址');
  const [, scheme, authority, rest] = matched;
  if (scheme !== 'http' && scheme !== 'https') {
    throw new Error('配对内容协议不支持');
  }

  // Mirrors Dart's `uri.hasAuthority && uri.host.isNotEmpty`. Dart strips the
  // brackets from an IPv6 literal host, so do the same before validating.
  let host = authority.split('@').pop() || '';
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    if (close === -1) throw new Error('配对内容不是有效地址');
    host = host.slice(1, close);
  } else {
    host = host.split(':')[0] || '';
  }
  if (host === '') throw new Error('配对内容不是有效地址');

  // Mirrors `_isDialableHost`: Dart's Uri is permissive enough to keep brackets,
  // quotes and spaces from a mis-scanned QR, and those can never be dialed.
  if (!isDialableHost(host)) {
    throw new Error(`配对内容的地址部分非法：${host}`);
  }

  // Mirrors `_rawPort` — never read `Uri.port`, which throws on non-numeric.
  const portText = rawPort(authority);
  if (portText !== '') {
    const port = /^\d+$/.test(portText) ? Number(portText) : NaN;
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      throw new Error(`配对内容端口越界：${portText}`);
    }
  }

  const path = rest.replace(/\/+$/, '');
  if (path === '/admin/ai-gateway' || path.startsWith('/admin/ai-gateway/')) {
    throw new Error('这是管理页二维码，不是配对二维码');
  }
  return `${scheme}://${authority}${path}`;
}

/** Mirror of `PairingPayloadParser._isDialableHost`. */
function isDialableHost(host) {
  if (host === '' || host.length > 253) return false;
  if (host.includes('..')) return false;
  if (host.startsWith('.') || host.endsWith('.')) return false;
  if (host.startsWith('-') || host.endsWith('-')) return false;
  if (host.includes(':')) return /^[0-9A-Fa-f:.]+$/.test(host);
  return /^[A-Za-z0-9._-]+$/.test(host);
}

/** Mirror of `PairingPayloadParser._rawPort` — never parse the port as a number. */
function rawPort(authority) {
  let a = authority;
  if (a.includes('@')) a = a.split('@').pop();
  if (a.startsWith('[')) {
    const close = a.indexOf(']');
    return close < 0 ? '' : a.slice(close + 1).replace(':', '');
  }
  const colon = a.lastIndexOf(':');
  return colon < 0 ? '' : a.slice(colon + 1);
}

describe('pairing QR contract — `khy mobile app` ⇄ Flutter PairingPayloadParser', () => {
  test('emits a single-key JSON envelope, never a bare URL', () => {
    const { payload, apiBaseUrl } = buildPairingPayload('192.168.1.9', 3000);

    expect(apiBaseUrl).toBe('http://192.168.1.9:3000');
    expect(typeof payload).toBe('string');
    // A bare URL here would silently break every pairing attempt.
    expect(payload.startsWith('http')).toBe(false);
    expect(payload.startsWith('{')).toBe(true);
    expect(Object.keys(JSON.parse(payload))).toEqual(['apiBaseUrl']);
  });

  test('the envelope value round-trips to the returned apiBaseUrl', () => {
    for (const [ip, port] of [['192.168.1.9', 3000], ['10.0.0.4', 8080], ['172.20.1.2', 9090]]) {
      const { payload, apiBaseUrl } = buildPairingPayload(ip, port);
      expect(JSON.parse(payload).apiBaseUrl).toBe(apiBaseUrl);
    }
  });

  test('every emitted payload parses through the Dart pipeline', () => {
    for (const [ip, port] of [['192.168.1.9', 3000], ['10.0.0.4', 8080], ['127.0.0.1', 3100]]) {
      const { payload, apiBaseUrl } = buildPairingPayload(ip, port);
      // The Dart side must land on exactly the URL the CLI printed under the QR.
      expect(parseLikeDart(payload)).toBe(apiBaseUrl);
      expect(apiBaseUrl.endsWith('/')).toBe(false);
    }
  });

  test('survives the decorations phones and terminals add', () => {
    const { payload } = buildPairingPayload('192.168.1.9', 3000);
    expect(parseLikeDart(payload)).toBe('http://192.168.1.9:3000');
    expect(parseLikeDart(`  ${payload}  `)).toBe('http://192.168.1.9:3000');
    expect(parseLikeDart(`"${payload}"`)).toBe('http://192.168.1.9:3000');
    expect(parseLikeDart(`\u200B${payload}\uFEFF`)).toBe('http://192.168.1.9:3000');
    expect(parseLikeDart(`\n${payload}\n`)).toBe('http://192.168.1.9:3000');
  });

  test('the envelope is resilient to trailing whitespace and multi-line JSON', () => {
    const { payload } = buildPairingPayload('192.168.1.9', 3000);
    const pretty = JSON.stringify(JSON.parse(payload), null, 2);
    expect(parseLikeDart(pretty)).toBe('http://192.168.1.9:3000');
  });

  test('alt key names still resolve (paste tolerance)', () => {
    expect(parseLikeDart(JSON.stringify({ apiUrl: 'http://192.168.1.9:3000' }))).toBe(
      'http://192.168.1.9:3000'
    );
    expect(parseLikeDart(JSON.stringify({ url: '192.168.1.9:3000' }))).toBe(
      'http://192.168.1.9:3000'
    );
  });

  test('bare forms are accepted too — a human can paste the address directly', () => {
    expect(parseLikeDart('http://192.168.1.9:3000')).toBe('http://192.168.1.9:3000');
    expect(parseLikeDart('https://10.0.0.4:8080')).toBe('https://10.0.0.4:8080');
    expect(parseLikeDart('192.168.1.9:3000')).toBe('http://192.168.1.9:3000');
    expect(parseLikeDart('khy-node.lan:3000')).toBe('http://khy-node.lan:3000');
  });

  test('trailing slashes are normalised away', () => {
    expect(parseLikeDart('http://192.168.1.9:3000/')).toBe('http://192.168.1.9:3000');
    expect(parseLikeDart('http://192.168.1.9:3000///')).toBe('http://192.168.1.9:3000');
  });

  test('rejection messages are actionable, not opaque', () => {
    const cases = [
      ['', /配对内容为空/],
      ['{not json', /不是合法 JSON/],
      ['{}', /缺少 apiBaseUrl/],
      [JSON.stringify({ host: '192.168.1.9', port: 3000 }), /缺少 apiBaseUrl/],
      ['ftp://192.168.1.9:3000', /协议不支持/],
      ['http://', /不是有效地址/],
      ['http:///3000', /不是有效地址/],
      // A JSON array is not an envelope. It has no `{`, so it falls through to
      // URL normalisation and is caught there as an undialable host — the same
      // outcome the Dart parser produces via `_isDialableHost`.
      ['[1,2,3]', /地址部分非法/],
      ['http://192.168.1"9:3000', /地址部分非法/],
      // `Uri.port` throws ArgumentError on a non-numeric port; the parser must
      // report it instead of crashing the screen.
      ['http://192.168.1.9:abc', /端口越界/],
      ['http://192.168.1.9:70000', /端口越界/],
      ['http://192.168.1.9:0', /端口越界/],
    ];
    for (const [input, pattern] of cases) {
      let threw = false;
      try {
        parseLikeDart(input);
      } catch (err) {
        threw = true;
        expect(err.message).toMatch(pattern);
      }
      expect(threw).toBe(true);
    }
  });
});

describe('the two QR kinds are not interchangeable', () => {
  // Documents why the Dart parser guards the management entry path at all:
  // `khy mobile` (no `app` subcommand) prints a browser URL whose path is the
  // admin UI. Scanning that with the companion would treat the admin path as an
  // API root and every request would 404.
  test('`khy mobile` targets the admin page, which the pairing parser rejects', () => {
    const managementUrl = resolveTargetUrl([], {}, '192.168.1.9');
    expect(managementUrl).toContain('/admin/ai-gateway');

    expect(() => parseLikeDart(managementUrl)).toThrow(/管理页二维码/);
    expect(() =>
      parseLikeDart(JSON.stringify({ apiBaseUrl: managementUrl }))
    ).toThrow(/管理页二维码/);
  });

  test('a `khy mobile app` payload is NOT mistaken for the admin page', () => {
    const { payload } = buildPairingPayload('192.168.1.9', 3000);
    // Must not throw, and must keep any legitimate sub-path.
    expect(parseLikeDart(payload)).toBe('http://192.168.1.9:3000');
    expect(parseLikeDart('http://192.168.1.9:3000/admin/ai-gateway-api')).toBe(
      'http://192.168.1.9:3000/admin/ai-gateway-api'
    );
  });
});
