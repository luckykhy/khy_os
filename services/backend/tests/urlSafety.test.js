'use strict';

const {
  isPrivateOrLocalHostname,
  isPublicHttpUrl,
  assertPublicHttpUrl,
  assertPublicHttpUrlResolved,
  __setDnsLookupForTests,
} = require('../src/services/urlSafety');

afterEach(() => {
  __setDnsLookupForTests(); // restore real DNS
  delete process.env.KHY_FAKE_IP_CIDRS;
});

describe('isPrivateOrLocalHostname', () => {
  test('flags localhost and internal names', () => {
    for (const h of ['localhost', 'foo.localhost', 'box.local', 'svc.internal']) {
      expect(isPrivateOrLocalHostname(h)).toBe(true);
    }
  });

  test('flags private/loopback/link-local/metadata IP literals', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254', '0.0.0.0', '::1']) {
      expect(isPrivateOrLocalHostname(ip)).toBe(true);
    }
  });

  test('flags IPv4-mapped IPv6 loopback', () => {
    expect(isPrivateOrLocalHostname('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateOrLocalHostname('[::1]')).toBe(true);
  });

  test('allows public IP literals', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) {
      expect(isPrivateOrLocalHostname(ip)).toBe(false);
    }
  });

  test('defers plain hostnames to DNS (returns false synchronously)', () => {
    expect(isPrivateOrLocalHostname('example.com')).toBe(false);
  });
});

describe('isPublicHttpUrl', () => {
  test('rejects non-http(s) protocols', () => {
    expect(isPublicHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isPublicHttpUrl('ftp://example.com')).toBe(false);
    expect(isPublicHttpUrl('gopher://127.0.0.1')).toBe(false);
  });

  test('rejects private IP-literal URLs', () => {
    expect(isPublicHttpUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isPublicHttpUrl('https://127.0.0.1:8080/')).toBe(false);
  });

  test('accepts public host URLs', () => {
    expect(isPublicHttpUrl('https://example.com/path')).toBe(true);
  });
});

describe('assertPublicHttpUrl', () => {
  test('throws on non-http protocol', () => {
    expect(() => assertPublicHttpUrl('file:///etc/passwd')).toThrow(/HTTP or HTTPS/);
  });
  test('throws on private literal', () => {
    expect(() => assertPublicHttpUrl('http://10.0.0.1/')).toThrow(/private or local/);
  });
  test('passes for public host', () => {
    expect(() => assertPublicHttpUrl('https://example.com/')).not.toThrow();
  });
});

describe('assertPublicHttpUrlResolved', () => {
  test('rejects when DNS resolves to a private address (rebinding)', async () => {
    __setDnsLookupForTests(async () => [{ address: '127.0.0.1' }]);
    await expect(assertPublicHttpUrlResolved('https://evil.example/')).rejects.toThrow(/private or local/);
  });

  test('rejects when ANY resolved address is private', async () => {
    __setDnsLookupForTests(async () => [{ address: '8.8.8.8' }, { address: '192.168.0.10' }]);
    await expect(assertPublicHttpUrlResolved('https://mixed.example/')).rejects.toThrow(/private or local/);
  });

  test('passes when all resolved addresses are public', async () => {
    __setDnsLookupForTests(async () => [{ address: '93.184.216.34' }]);
    await expect(assertPublicHttpUrlResolved('https://example.com/')).resolves.toBeUndefined();
  });

  test('rejects when resolution fails', async () => {
    __setDnsLookupForTests(async () => { throw new Error('ENOTFOUND'); });
    await expect(assertPublicHttpUrlResolved('https://nope.example/')).rejects.toThrow(/could not be resolved/);
  });

  test('skips DNS for IP-literal hosts (public literal passes)', async () => {
    let called = false;
    __setDnsLookupForTests(async () => { called = true; return [{ address: '10.0.0.1' }]; });
    await expect(assertPublicHttpUrlResolved('https://8.8.8.8/')).resolves.toBeUndefined();
    expect(called).toBe(false);
  });

  test('honors KHY_FAKE_IP_CIDRS allowlist for proxy fake-ip pools', async () => {
    process.env.KHY_FAKE_IP_CIDRS = '198.18.0.0/16';
    __setDnsLookupForTests(async () => [{ address: '198.18.0.42' }]);
    await expect(assertPublicHttpUrlResolved('https://proxied.example/')).resolves.toBeUndefined();
  });
});
