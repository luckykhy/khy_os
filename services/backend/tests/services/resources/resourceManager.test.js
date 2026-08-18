'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateManifest } = require('../../../src/services/resources/manifestLoader');
const { createResourceManager } = require('../../../src/services/resources/resourceManager');
const { createStore } = require('../../../src/services/resources/resourceStore');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'khy-resource-')); }
function manifestFor(hash, version = '1.0.0', sources = ['https://example.test/fixture.bin']) {
  return { schemaVersion: 1, resources: [{ id: 'fixture-tool', kind: 'tool', version, policy: 'manual', platforms: { 'win32-x64': { sources, sha256: hash, format: 'file', sentinel: 'fixture.bin' } } }] };
}

describe('resource manifest', () => {
  test('rejects non-HTTPS sources and unsafe paths', () => {
    const base = { schemaVersion: 1, resources: [{ id: 'x', kind: 'tool', version: '1', platforms: { 'win32-x64': { sources: ['https://example.test/x'], sha256: 'a'.repeat(64), format: 'zip', sentinel: 'bin/x' } } }] };
    const insecure = structuredClone(base);
    insecure.resources[0].platforms['win32-x64'].sources = ['http://example.test/x'];
    expect(() => validateManifest(insecure)).toThrow(/HTTPS/);
    const escaping = structuredClone(base);
    escaping.resources[0].platforms['win32-x64'].sentinel = '../x';
    expect(() => validateManifest(escaping)).toThrow(/unsafe path/);
  });
  test('accepts disabled resources without a platform payload', () => {
    expect(validateManifest({ schemaVersion: 1, resources: [{ id: 'x', kind: 'dataset', version: '1', policy: 'disabled', platforms: { 'win32-x64': null } }] }).resources[0].policy).toBe('disabled');
  });
});

describe('resource manager', () => {
  let root;
  let previousLedger;
  beforeEach(() => {
    root = tempDir();
    previousLedger = process.env.KHY_INSTALL_LEDGER;
    process.env.KHY_INSTALL_LEDGER = '0';
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    if (previousLedger === undefined) delete process.env.KHY_INSTALL_LEDGER;
    else process.env.KHY_INSTALL_LEDGER = previousLedger;
  });

  test('installs a content-addressed file and activates it', async () => {
    const payload = Buffer.from('fixture payload');
    const hash = crypto.createHash('sha256').update(payload).digest('hex');
    let calls = 0;
    const manager = createResourceManager({ root, platform: 'win32-x64', manifest: manifestFor(hash) });
    const result = await manager.ensure('fixture-tool', { downloader: async (url, dest) => { calls += 1; fs.writeFileSync(dest, payload); } });
    expect(result.status).toBe('provisioned');
    expect(fs.readFileSync(path.join(result.path, 'fixture.bin'))).toEqual(payload);
    expect(manager.resolve('fixture-tool').status).toBe('present');
    expect(fs.existsSync(createStore({ root }).blobPath(hash))).toBe(true);
    expect(calls).toBe(1);
    expect((await manager.ensure('fixture-tool')).status).toBe('present');
    expect(calls).toBe(1);
  });

  test('rejects a corrupt download without activating it', async () => {
    const manager = createResourceManager({ root, platform: 'win32-x64', manifest: manifestFor('a'.repeat(64)) });
    const result = await manager.ensure('fixture-tool', { downloader: async (url, dest) => fs.writeFileSync(dest, 'wrong') });
    expect(result.status).toBe('failed');
    expect(manager.resolve('fixture-tool').status).toBe('missing');
  });

  test('deduplicates concurrent ensures', async () => {
    const payload = Buffer.from('same');
    const hash = crypto.createHash('sha256').update(payload).digest('hex');
    const manager = createResourceManager({ root, platform: 'win32-x64', manifest: manifestFor(hash) });
    let calls = 0;
    const downloader = async (url, dest) => { calls += 1; await new Promise(resolve => setTimeout(resolve, 10)); fs.writeFileSync(dest, payload); };
    const results = await Promise.all([manager.ensure('fixture-tool', { downloader }), manager.ensure('fixture-tool', { downloader })]);
    expect(calls).toBe(1);
    expect(results[0].status).toBe('provisioned');
    expect(results[1].status).toBe('provisioned');
  });

  test('tries ordered sources and clears partial downloads between attempts', async () => {
    const payload = Buffer.from('complete payload');
    const hash = crypto.createHash('sha256').update(payload).digest('hex');
    const sources = ['https://one.example.test/file', 'https://two.example.test/file'];
    const manager = createResourceManager({ root, platform: 'win32-x64', manifest: manifestFor(hash, '1.0.0', sources) });
    const seen = [];
    const result = await manager.ensure('fixture-tool', { downloader: async (url, dest) => {
      seen.push(url);
      if (seen.length === 1) { fs.writeFileSync(dest, 'partial'); throw new Error('source down'); }
      fs.writeFileSync(dest, payload);
    } });
    expect(result.status).toBe('provisioned');
    expect(result.source).toBe(sources[1]);
    expect(seen).toEqual(sources);
    expect(fs.readFileSync(path.join(result.path, 'fixture.bin'))).toEqual(payload);
  });

  test('rolls back with the selected version record and protects retained blobs from gc', async () => {
    const v1 = Buffer.from('version one');
    const h1 = crypto.createHash('sha256').update(v1).digest('hex');
    const first = createResourceManager({ root, platform: 'win32-x64', manifest: manifestFor(h1, '1.0.0') });
    await first.ensure('fixture-tool', { downloader: async (url, dest) => fs.writeFileSync(dest, v1) });

    const v2 = Buffer.from('version two');
    const h2 = crypto.createHash('sha256').update(v2).digest('hex');
    const second = createResourceManager({ root, platform: 'win32-x64', manifest: manifestFor(h2, '2.0.0') });
    await second.ensure('fixture-tool', { downloader: async (url, dest) => fs.writeFileSync(dest, v2) });
    expect(second.resolve('fixture-tool').version).toBe('2.0.0');
    const rolledBack = second.rollback('fixture-tool', '1.0.0');
    expect(rolledBack.status).toBe('rolled-back');
    expect(rolledBack.sha256).toBe(h1);
    expect(second.resolve('fixture-tool').version).toBe('1.0.0');
    expect(second.gc().count).toBe(0);
  });

  test('gc previews and removes only expired unreferenced blobs', () => {
    const manager = createResourceManager({ root, platform: 'win32-x64', manifest: manifestFor('a'.repeat(64)) });
    const staleHash = 'b'.repeat(64);
    const freshHash = 'c'.repeat(64);
    const stale = manager.store.blobPath(staleHash);
    const fresh = manager.store.blobPath(freshHash);
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.mkdirSync(path.dirname(fresh), { recursive: true });
    fs.writeFileSync(stale, 'stale');
    fs.writeFileSync(fresh, 'fresh');
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);

    const preview = manager.gc();
    expect(preview.candidates).toEqual([stale]);
    expect(fs.existsSync(stale)).toBe(true);
    expect(fs.existsSync(fresh)).toBe(true);
    const cleaned = manager.gc({ apply: true });
    expect(cleaned.status).toBe('cleaned');
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});
