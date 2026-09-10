'use strict';

/**
 * Unit tests for the host-side device-name resolver. Dependencies (executable
 * lookup, command runner, dns.reverse) are injected so the cascade can be tested
 * without touching the network or spawning processes.
 *   node --test tests/bridge/deviceNameResolver.test.js
 */
'use strict';
const resolver = require('../../src/bridge/deviceNameResolver');
const {
  resolveRealName,
  parseNetbios,
  parseAvahi,
  parseDscacheutil,
  uaModelToken,
  _normalizeIp,
  _isV4Lan,
} = resolver;
// ── parsers ───────────────────────────────────────────────────────────────
// ── resolveRealName cascade (injected deps) ─────────────────────────────────
function makeDeps({ platform = 'linux', tools = {}, reverse, run } = {}) {
  return {
    platform,
    searchExecutable: (t) => (tools[t] ? `/usr/bin/${t}` : null),
    reverse: reverse || (async () => { throw new Error('no ptr'); }),
    run: run || (async () => null),
  };
}

describe('Device Name Resolver', () => {
  test('parseNetbios: takes UNIQUE <00>, skips GROUP and __MSBROWSE__', async () => {
      const out = [
        '\tHOMEPC          <00> -         B <ACTIVE>',
        '\tWORKGROUP       <00> - <GROUP> B <ACTIVE>',
        '\t__MSBROWSE__    <01> - <GROUP> B <ACTIVE>',
      ].join('\n');
      expect(parseNetbios(out)).toBe('HOMEPC');
      expect(parseNetbios('')).toBe(null);
      expect(parseNetbios('no useful lines here')).toBe(null);
  });

  test('parseNetbios: Windows nbtstat layout', async () => {
      const out = [
        '           NetBIOS Remote Machine Name Table',
        '       Name               Type         Status',
        '    DESKTOP-ABC    <00>  UNIQUE      Registered',
        '    WORKGROUP      <00>  GROUP       Registered',
      ].join('\r\n');
      expect(parseNetbios(out)).toBe('DESKTOP-ABC');
  });

  test('parseAvahi / parseDscacheutil', async () => {
      expect(parseAvahi('192.168.1.5\txiaoming-mbp.local')).toBe('xiaoming-mbp.local');
      expect(parseAvahi('')).toBe(null);
      expect(parseDscacheutil('name: johns-mac.local\nip_address: 192.168.1.9')).toBe('johns-mac.local');
      expect(parseDscacheutil('no name here')).toBe(null);
  });

  test('uaModelToken: extracts Android model, empty for non-Android', async () => {
      expect(uaModelToken('Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ) Mobile')).toBe('Pixel 7');
      expect(uaModelToken('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile')).toBe('');
  });

  test('_normalizeIp / _isV4Lan', async () => {
      expect(_normalizeIp('::ffff:192.168.1.5')).toBe('192.168.1.5');
      expect(_normalizeIp('192.168.1.5')).toBe('192.168.1.5');
      expect(_normalizeIp('not-an-ip')).toBe(null);
      expect(_isV4Lan('192.168.1.5')).toBe(true);
      expect(_isV4Lan('127.0.0.1')).toBe(false);
  });

  test('cascade: client hints win over everything', async () => {
      const deps = makeDeps({
        tools: { nmblookup: true },
        run: async () => '\tHOMEPC <00> -  B <ACTIVE>',
      });
      const r = await resolveRealName({ ip: '192.168.1.5', hints: { model: 'Pixel 7' } }, { deps });
      assert.deepEqual(r, { name: 'Pixel 7', source: 'hints' });
  });

  test('cascade: falls to PTR when no hints', async () => {
      const deps = makeDeps({ reverse: async () => ['XiaoMing-MacBook.local'] });
      const r = await resolveRealName({ ip: '192.168.1.20' }, { deps });
      assert.deepEqual(r, { name: 'XiaoMing-MacBook', source: 'ptr' });
  });

  test('cascade: PTR fails �?NetBIOS when tool present', async () => {
      const deps = makeDeps({
        tools: { nmblookup: true },
        reverse: async () => { throw new Error('nxdomain'); },
        run: async (cmd) => (cmd === 'nmblookup' ? '\tHOMEPC          <00> -         B <ACTIVE>' : null),
      });
      const r = await resolveRealName({ ip: '192.168.1.30' }, { deps });
      assert.deepEqual(r, { name: 'HOMEPC', source: 'netbios' });
  });

  test('cascade: missing NetBIOS/mDNS tools are skipped (no throw), UA token used', async () => {
      const deps = makeDeps({
        tools: {}, // neither nmblookup nor avahi-resolve present
        reverse: async () => { throw new Error('nxdomain'); },
      });
      const r = await resolveRealName(
        { ip: '192.168.1.40', userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-G991B Build/X) Mobile' },
        { deps },
      );
      assert.deepEqual(r, { name: 'SM-G991B', source: 'ua' });
  });

  test('cascade: macOS uses dscacheutil for mDNS', async () => {
      const deps = makeDeps({
        platform: 'darwin',
        tools: { dscacheutil: true },
        reverse: async () => { throw new Error('nope'); },
        run: async (cmd) => (cmd === 'dscacheutil' ? 'name: johns-mac.local\nip_address: 192.168.1.9' : null),
      });
      const r = await resolveRealName({ ip: '192.168.1.9' }, { deps });
      assert.deepEqual(r, { name: 'johns-mac', source: 'mdns' });
  });

  test('cascade: nothing resolvable �?null (never throws)', async () => {
      const deps = makeDeps({ tools: {}, reverse: async () => { throw new Error('x'); }, run: async () => null });
      expect(await resolveRealName({ ip: '127.0.0.1' })).toBe({ deps });
      expect(await resolveRealName({ ip: '192.168.1.99' })).toBe({ deps });
      expect(await resolveRealName({})).toBe({ deps });
  });

  test('cascade: loopback / non-IP skips host probes but still uses UA', async () => {
      let reverseCalled = false;
      const deps = makeDeps({
        reverse: async () => { reverseCalled = true; return ['should-not-be-used']; },
      });
      const r = await resolveRealName(
        { ip: '127.0.0.1', userAgent: 'Mozilla/5.0 (Linux; Android 12; Mi 11 Build/Y) Mobile' },
        { deps },
      );
      expect(reverseCalled).toBe(false);
      assert.deepEqual(r, { name: 'Mi 11', source: 'ua' });
  });

  test('cascade: a host probe that throws does not abort the cascade', async () => {
      const deps = makeDeps({
        tools: { nmblookup: true },
        reverse: async () => { throw new Error('boom'); },
        run: async () => { throw new Error('exec exploded'); }, // both host probes throw
        // mDNS tool absent �?skipped; netbios run throws �?caught
      });
      const r = await resolveRealName(
        { ip: '192.168.1.50', userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 8 Build/Z) Mobile' },
        { deps },
      );
      assert.deepEqual(r, { name: 'Pixel 8', source: 'ua' });
  });

});

