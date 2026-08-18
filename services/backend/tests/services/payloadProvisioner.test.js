'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const provisioner = require('../../src/services/payloadProvisioner');

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function response(body, status = 200) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => String(name).toLowerCase() === 'content-length' ? String(data.length) : null },
    body: (async function* () { yield data; })(),
  };
}

function fixture() {
  const files = {
    'markdown-vendor-manifest.json': Buffer.from('{"engine":"fixture"}\n'),
    'markdown-vendor-muya.js': Buffer.from('window.MuyaFixture=true;\n'),
    'markdown-vendor-muya.css': Buffer.from('.muya-fixture{}\n'),
  };
  const manifest = {
    format: 'khy-release-payloads',
    formatVersion: 1,
    version: '1.2.3',
    payloads: {
      'markdown-vendor': {
        files: [
          { path: 'MANIFEST.json', asset: 'markdown-vendor-manifest.json', sha256: digest(files['markdown-vendor-manifest.json']), size: files['markdown-vendor-manifest.json'].length },
          { path: 'khyos-muya.js', asset: 'markdown-vendor-muya.js', sha256: digest(files['markdown-vendor-muya.js']), size: files['markdown-vendor-muya.js'].length },
          { path: 'khyos-muya.css', asset: 'markdown-vendor-muya.css', sha256: digest(files['markdown-vendor-muya.css']), size: files['markdown-vendor-muya.css'].length },
        ],
      },
    },
  };
  return { files, manifest };
}

function config(cacheRoot, overrides = {}) {
  return {
    RELEASE_DOWNLOAD_BASE_URL: 'https://release.test/download',
    TAG_PATTERN: 'v<version>',
    MANIFEST_ASSET: 'khy-payload-manifest.json',
    DOWNLOAD_IDLE_TIMEOUT_MS: 50,
    RETRY_COUNT: 1,
    CACHE_ROOT: cacheRoot,
    ...overrides,
  };
}

function assetName(url) {
  return decodeURIComponent(String(url).split('/').pop());
}

test('downloads, verifies, atomically installs, records, and reuses a payload', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-provision-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { files, manifest } = fixture();
  const calls = [];
  const ledger = [];
  const fetchImpl = async url => {
    calls.push(url);
    const name = assetName(url);
    return name === 'khy-payload-manifest.json'
      ? response(JSON.stringify(manifest))
      : response(files[name]);
  };

  const first = await provisioner.ensurePayload('markdown-vendor', {
    version: '1.2.3', config: config(root), fetchImpl, recordFile: entry => ledger.push(entry),
  });
  assert.equal(first.ok, true);
  assert.equal(first.reused, false);
  assert.equal(fs.readFileSync(path.join(first.targetDir, 'khyos-muya.js'), 'utf8'), files['markdown-vendor-muya.js'].toString());
  assert.equal(ledger.length, 4);
  assert.ok(ledger.every(entry => entry.action === 'unlink' && entry.meta.scope === 'payload'));
  assert.ok(ledger.every(entry => !JSON.stringify(entry).includes('release.test')));

  const before = calls.length;
  const second = await provisioner.ensurePayload('markdown-vendor', {
    version: '1.2.3', config: config(root), fetchImpl,
  });
  assert.equal(second.reused, true);
  assert.equal(calls.length, before);

  fs.writeFileSync(path.join(first.targetDir, 'khyos-muya.js'), 'tampered');
  const repaired = await provisioner.ensurePayload('markdown-vendor', {
    version: '1.2.3', config: config(root), fetchImpl, recordFile: entry => ledger.push(entry),
  });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.reused, false);
  assert.equal(fs.readFileSync(path.join(first.targetDir, 'khyos-muya.js'), 'utf8'), files['markdown-vendor-muya.js'].toString());
  assert.ok(calls.length > before);
});

test('memoizes concurrent first-use work as one promise', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-concurrent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { files, manifest } = fixture();
  let calls = 0;
  const fetchImpl = async url => {
    calls += 1;
    await new Promise(resolve => setTimeout(resolve, 5));
    const name = assetName(url);
    return response(name === 'khy-payload-manifest.json' ? JSON.stringify(manifest) : files[name]);
  };
  const options = { version: '1.2.3', targetDir: path.join(root, 'target'), config: config(root), fetchImpl, recordFile() {} };
  const a = provisioner.ensurePayload('markdown-vendor', options);
  const b = provisioner.ensurePayload('markdown-vendor', options);
  assert.equal(a, b);
  const [one, two] = await Promise.all([a, b]);
  assert.equal(one.ok, true);
  assert.deepEqual(one, two);
  assert.equal(calls, 4);
});

test('adopts manually copied Release assets after checksum verification', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-manual-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const targetDir = path.join(root, 'target');
  fs.mkdirSync(targetDir);
  const { files, manifest } = fixture();
  fs.writeFileSync(path.join(targetDir, 'khy-payload-manifest.json'), JSON.stringify(manifest));
  for (const [asset, body] of Object.entries(files)) fs.writeFileSync(path.join(targetDir, asset), body);
  const ledger = [];

  const result = await provisioner.ensurePayload('markdown-vendor', {
    version: '1.2.3', targetDir, config: config(root),
    fetchImpl: async () => { throw new Error('network must not be used'); },
    recordFile: entry => ledger.push(entry),
  });
  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.equal(result.adopted, true);
  assert.equal(fs.existsSync(path.join(targetDir, 'markdown-vendor-muya.js')), false);
  assert.equal(fs.readFileSync(path.join(targetDir, 'khyos-muya.js'), 'utf8'), files['markdown-vendor-muya.js'].toString());
  assert.equal(ledger.length, 4);
});

test('rejects traversal entries before downloading payload assets', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-traversal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { manifest } = fixture();
  manifest.payloads['markdown-vendor'].files[0].path = '../outside.json';
  let calls = 0;
  const result = await provisioner.ensurePayload('markdown-vendor', {
    version: '1.2.3', targetDir: path.join(root, 'target'), config: config(root),
    fetchImpl: async () => { calls += 1; return response(JSON.stringify(manifest)); },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /unsafe payload path/);
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(path.join(root, 'outside.json')), false);
});

test('retries a checksum mismatch and leaves no part files', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-retry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { files, manifest } = fixture();
  let jsAttempts = 0;
  const fetchImpl = async url => {
    const name = assetName(url);
    if (name === 'khy-payload-manifest.json') return response(JSON.stringify(manifest));
    if (name === 'markdown-vendor-muya.js' && jsAttempts++ === 0) return response('corrupt');
    return response(files[name]);
  };
  const result = await provisioner.ensurePayload('markdown-vendor', {
    version: '1.2.3', targetDir: path.join(root, 'target'), config: config(root), fetchImpl, recordFile() {},
  });
  assert.equal(result.ok, true);
  assert.equal(jsAttempts, 2);
  assert.equal(fs.readdirSync(result.targetDir).some(name => name.includes('.part-')), false);
});

test('idle timeout aborts and offline failures retain manual acquisition details', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-idle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stalledFetch = async (_url, options) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: (async function* () {
      await new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason));
      });
    })(),
  });
  const destination = path.join(root, 'stalled.part');
  await assert.rejects(
    provisioner._download('https://release.test/stalled', destination, { fetchImpl: stalledFetch, idleTimeoutMs: 15 }),
    /idle timeout/
  );
  assert.equal(fs.existsSync(destination), false);

  const targetDir = path.join(root, 'offline');
  const result = await provisioner.ensurePayload('markdown-vendor', {
    version: '1.2.3', targetDir, config: config(root), fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'offline');
  assert.equal(result.targetDir, targetDir);
  assert.equal(result.manualUrl, 'https://release.test/download/v1.2.3/khy-payload-manifest.json');
});

test('manifest validation enforces version and complete required file set', () => {
  const { manifest } = fixture();
  assert.throws(() => provisioner._validateManifest(manifest, 'markdown-vendor', '9.9.9'), /version mismatch/);
  manifest.payloads['markdown-vendor'].files.pop();
  assert.throws(() => provisioner._validateManifest(manifest, 'markdown-vendor', '1.2.3'), /incomplete/);
});
