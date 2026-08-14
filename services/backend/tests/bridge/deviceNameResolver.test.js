/**
 * Unit tests for the host-side device-name resolver. Dependencies (executable
 * lookup, command runner, dns.reverse) are injected so the cascade can be tested
 * without touching the network or spawning processes.
 *   node --test tests/bridge/deviceNameResolver.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
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

test('parseNetbios: takes UNIQUE <00>, skips GROUP and __MSBROWSE__', () => {
  const out = [
    '\tHOMEPC          <00> -         B <ACTIVE>',
    '\tWORKGROUP       <00> - <GROUP> B <ACTIVE>',
    '\t__MSBROWSE__    <01> - <GROUP> B <ACTIVE>',
  ].join('\n');
  assert.equal(parseNetbios(out), 'HOMEPC');
  assert.equal(parseNetbios(''), null);
  assert.equal(parseNetbios('no useful lines here'), null);
});

test('parseNetbios: Windows nbtstat layout', () => {
  const out = [
    '           NetBIOS Remote Machine Name Table',
    '       Name               Type         Status',
    '    DESKTOP-ABC    <00>  UNIQUE      Registered',
    '    WORKGROUP      <00>  GROUP       Registered',
  ].join('\r\n');
  assert.equal(parseNetbios(out), 'DESKTOP-ABC');
});

test('parseAvahi / parseDscacheutil', () => {
  assert.equal(parseAvahi('192.168.1.5\txiaoming-mbp.local'), 'xiaoming-mbp.local');
  assert.equal(parseAvahi(''), null);
  assert.equal(parseDscacheutil('name: johns-mac.local\nip_address: 192.168.1.9'), 'johns-mac.local');
  assert.equal(parseDscacheutil('no name here'), null);
});

test('uaModelToken: extracts Android model, empty for non-Android', () => {
  assert.equal(uaModelToken('Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ) Mobile'), 'Pixel 7');
  assert.equal(uaModelToken('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile'), '');
});

test('_normalizeIp / _isV4Lan', () => {
  assert.equal(_normalizeIp('::ffff:192.168.1.5'), '192.168.1.5');
  assert.equal(_normalizeIp('192.168.1.5'), '192.168.1.5');
  assert.equal(_normalizeIp('not-an-ip'), null);
  assert.equal(_isV4Lan('192.168.1.5'), true);
  assert.equal(_isV4Lan('127.0.0.1'), false);
});

// ── resolveRealName cascade (injected deps) ─────────────────────────────────

function makeDeps({ platform = 'linux', tools = {}, reverse, run } = {}) {
  return {
    platform,
    searchExecutable: (t) => (tools[t] ? `/usr/bin/${t}` : null),
    reverse: reverse || (async () => { throw new Error('no ptr'); }),
    run: run || (async () => null),
  };
}

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

test('cascade: PTR fails → NetBIOS when tool present', async () => {
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

test('cascade: nothing resolvable → null (never throws)', async () => {
  const deps = makeDeps({ tools: {}, reverse: async () => { throw new Error('x'); }, run: async () => null });
  assert.equal(await resolveRealName({ ip: '127.0.0.1' }, { deps }), null);
  assert.equal(await resolveRealName({ ip: '192.168.1.99' }, { deps }), null);
  assert.equal(await resolveRealName({}, { deps }), null);
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
  assert.equal(reverseCalled, false, 'reverse DNS not attempted for loopback');
  assert.deepEqual(r, { name: 'Mi 11', source: 'ua' });
});

test('cascade: a host probe that throws does not abort the cascade', async () => {
  const deps = makeDeps({
    tools: { nmblookup: true },
    reverse: async () => { throw new Error('boom'); },
    run: async () => { throw new Error('exec exploded'); }, // both host probes throw
    // mDNS tool absent → skipped; netbios run throws → caught
  });
  const r = await resolveRealName(
    { ip: '192.168.1.50', userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 8 Build/Z) Mobile' },
    { deps },
  );
  assert.deepEqual(r, { name: 'Pixel 8', source: 'ua' });
});
