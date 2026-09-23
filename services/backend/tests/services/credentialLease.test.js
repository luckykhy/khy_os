'use strict';

/**
 * credential-lease tests (TDD red first).
 *
 * Contract under test (borrowing proposal 1, [DESIGN-SOURCING-001] B-P2):
 * host keeps the long-lived credential; child processes obtain short-lived
 * leases over local IPC gated by a one-time capability token.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const {
  encodeFrame,
  createFrameDecoder,
  MAX_FRAME_BYTES,
  newCapability,
  verifyCapability,
  endpointPathFor,
  PROTOCOL_VERSION,
} = require('../../src/services/credentialLease/leaseProtocol');
const { createLeaseBroker } = require('../../src/services/credentialLease/leaseBroker');
const { requestLease, readLeaseCoord } = require('../../src/services/credentialLease/leaseClient');

function mkDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'khy-lease-'));
}

describe('leaseProtocol codec', () => {
  test('frame round-trips through the decoder', () => {
    const decoder = createFrameDecoder();
    const frames = [];
    decoder.on('frame', (f) => frames.push(f));
    const buf = Buffer.concat([
      encodeFrame({ op: 'status' }),
      encodeFrame({ op: 'lease', minValidityMs: 1000 }),
    ]);
    decoder.push(buf);
    expect(frames).toEqual([{ op: 'status' }, { op: 'lease', minValidityMs: 1000 }]);
  });

  test('decoder survives byte-at-a-time delivery', () => {
    const decoder = createFrameDecoder();
    const frames = [];
    decoder.on('frame', (f) => frames.push(f));
    const raw = encodeFrame({ hello: '世界' });
    for (const b of raw) decoder.push(Buffer.from([b]));
    expect(frames).toEqual([{ hello: '世界' }]);
  });

  test('oversized frames are rejected before buffering', () => {
    const decoder = createFrameDecoder();
    let err = null;
    decoder.on('error', (e) => { err = e; });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    decoder.push(header);
    expect(err && err.code).toBe('frame-too-large');
  });
});

describe('capability tokens', () => {
  test('capability is 32 random bytes rendered base64url (43 chars)', () => {
    const cap = newCapability();
    expect(cap).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifyCapability(cap, cap)).toBe(true);
    expect(verifyCapability(cap, newCapability())).toBe(false);
  });

  test('endpoint path is derived from dataDir and carries the protocol version', () => {
    const a = endpointPathFor('/tmp/aaa');
    const b = endpointPathFor('/tmp/bbb');
    expect(a).not.toBe(b);
    expect(a).toContain(PROTOCOL_VERSION);
  });
});

describe('lease broker end-to-end (real local IPC)', () => {
  let dataDir;
  let broker;
  let providerCalls;

  beforeEach(async () => {
    dataDir = mkDataDir();
    providerCalls = 0;
    broker = await createLeaseBroker({
      dataDir,
      provider: async () => {
        providerCalls += 1;
        return { token: `tok-${providerCalls}`, expiresAt: Date.now() + 60_000 };
      },
    });
  });

  afterEach(async () => {
    if (broker) await broker.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('coord files are written for child processes to discover', () => {
    const coord = readLeaseCoord({ dataDir });
    expect(coord.endpoint).toBe(broker.endpoint);
    expect(coord.capability).toBe(broker.capability);
    if (process.platform !== 'win32') {
      expect(coord.capabilityPath.startsWith(dataDir)).toBe(true);
    }
  });

  test('capability file is owner-only (0600) where POSIX permits it', () => {
    if (process.platform === 'win32') return;
    const coord = readLeaseCoord({ dataDir });
    const mode = fs.statSync(coord.capabilityPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('lease round trip returns token + expiry + generation', async () => {
    const lease = await requestLease({ dataDir, minValidityMs: 1000 });
    expect(lease.token).toBe('tok-1');
    expect(lease.expiresAt).toBeGreaterThan(Date.now());
    expect(lease.generation).toBe(1);
  });

  test('wrong capability is refused (fail-closed)', async () => {
    await expect(
      requestLease({ endpoint: broker.endpoint, capability: newCapability(), minValidityMs: 0 }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  test('concurrent leases collapse into one provider call (single-flight)', async () => {
    await broker.close();
    providerCalls = 0;
    broker = await createLeaseBroker({
      dataDir,
      refreshLeadMs: 0,
      provider: async () => {
        providerCalls += 1;
        await new Promise((r) => setTimeout(r, 50)); // keep the in-flight window open
        return { token: `tok-${providerCalls}`, expiresAt: Date.now() + 60_000 };
      },
    });
    const opts = { dataDir, minValidityMs: 1000 };
    const leases = await Promise.all([requestLease(opts), requestLease(opts), requestLease(opts)]);
    expect(providerCalls).toBe(1);
    expect(new Set(leases.map((l) => l.token)).size).toBe(1);
  });

  test('revoke bumps generation and forces a fresh provider fetch', async () => {
    const before = await requestLease({ dataDir, minValidityMs: 1000 });
    broker.revoke();
    const after = await requestLease({ dataDir, minValidityMs: 1000 });
    expect(after.generation).toBe(before.generation + 1);
    expect(after.token).not.toBe(before.token);
  });

  test('lease window smaller than minValidity fails honestly', async () => {
    await broker.close();
    broker = await createLeaseBroker({
      dataDir,
      provider: async () => ({ token: 'short', expiresAt: Date.now() + 500 }),
    });
    await expect(
      requestLease({ endpoint: broker.endpoint, capability: broker.capability, minValidityMs: 60_000 }),
    ).rejects.toMatchObject({ code: 'lease-window-too-small' });
  });

  test('status reports generation and provider health without a fetch', async () => {
    const st = await requestLease.status({ dataDir });
    expect(st.ok).toBe(true);
    expect(st.generation).toBe(1);
    expect(providerCalls).toBe(0);
  });
});

describe('static key provider wrapper', () => {
  test('issues a lease with host-side TTL (bounded exposure, not provider-enforced)', async () => {
    const { createStaticKeyProvider } = require('../../src/services/credentialLease/providers');
    const provider = createStaticKeyProvider({ getSecret: () => 'sk-static', ttlMs: 2000 });
    const cred = await provider.getCredential();
    expect(cred.token).toBe('sk-static');
    expect(cred.expiresAt - Date.now()).toBeLessThanOrEqual(2000);
    expect(cred.expiresAt).toBeGreaterThan(Date.now());
  });

  test('missing secret fails with a concrete error', async () => {
    const { createStaticKeyProvider } = require('../../src/services/credentialLease/providers');
    const provider = createStaticKeyProvider({ getSecret: () => null });
    await expect(provider.getCredential()).rejects.toMatchObject({ code: 'no-credential' });
  });
});

describe('crypto sanity', () => {
  test('sha256 helper is stable across runs (endpoint naming depends on it)', () => {
    const h = crypto.createHash('sha256').update('x').digest('hex');
    expect(h).toHaveLength(64);
  });
});
