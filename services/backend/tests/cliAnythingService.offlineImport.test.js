'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const svc = require('../src/services/cliAnythingService');

// importFromArchive writes into the fixed ~/.khy/cli-anything cache. Snapshot
// the affected files so the test does not clobber a real imported registry.
const CACHE_FILES = [
  path.join(svc.CLI_ANYTHING_DIR, 'registry.json'),
  path.join(svc.CLI_ANYTHING_DIR, 'public_registry.json'),
  path.join(svc.CLI_ANYTHING_DIR, 'bundle.json'),
];

describe('cliAnythingService.importFromArchive (offline)', () => {
  let backups;
  let fixtureDir;

  beforeAll(() => {
    backups = CACHE_FILES.map(f => {
      try { return { f, data: fs.readFileSync(f) }; } catch { return { f, data: null }; }
    });

    // Build a minimal extracted-snapshot fixture.
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-anything-fix-'));
    fs.writeFileSync(path.join(fixtureDir, 'registry.json'), JSON.stringify({
      meta: { repo: 'test' },
      clis: [
        { name: 'foo', display_name: 'Foo', description: 'a foo tool', category: 'testing' },
      ],
    }));
    fs.writeFileSync(path.join(fixtureDir, 'public_registry.json'), JSON.stringify({
      clis: [{ name: 'bar', display_name: 'Bar', description: 'a bar tool', category: 'web' }],
    }));
    const harness = path.join(fixtureDir, 'foo', 'agent-harness');
    fs.mkdirSync(harness, { recursive: true });
    fs.writeFileSync(path.join(harness, 'setup.py'), '# fixture setup.py\n');
  });

  afterAll(() => {
    for (const b of backups) {
      if (b.data !== null) fs.writeFileSync(b.f, b.data);
      else { try { fs.unlinkSync(b.f); } catch { /* ok */ } }
    }
    try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  test('rejects missing path', () => {
    const r = svc.importFromArchive('/no/such/path-xyz.zip');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/不存在/);
  });

  test('rejects empty argument', () => {
    const r = svc.importFromArchive('');
    expect(r.success).toBe(false);
  });

  test('imports an extracted directory and populates the registry cache', () => {
    const expectedRoot = path.resolve(fixtureDir);
    const r = svc.importFromArchive(fixtureDir);
    expect(r.success).toBe(true);
    expect(r.bundleRoot).toBe(expectedRoot);
    expect(r.harness).toBe(1);
    expect(r.public).toBe(1);
    expect(r.total).toBe(2);

    // Registry cache + bundle metadata were written.
    expect(fs.existsSync(path.join(svc.CLI_ANYTHING_DIR, 'registry.json'))).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(svc.CLI_ANYTHING_DIR, 'bundle.json'), 'utf8'));
    expect(meta.bundleRoot).toBe(expectedRoot);
    expect(meta.cliCount).toBe(2);
  });

  test('search resolves against the imported offline registry', () => {
    svc.importFromArchive(fixtureDir);
    const results = svc.searchRegistry('foo');
    expect(results.some(c => c.name === 'foo')).toBe(true);
  });

  test('directory without registry.json is rejected', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-anything-empty-'));
    try {
      const r = svc.importFromArchive(empty);
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/registry\.json/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('cliAnythingService vendored fallback (out-of-box)', () => {
  let backups;

  beforeAll(() => {
    // Wipe the user cache so resolution must fall through to the vendored copy.
    backups = CACHE_FILES.map(f => {
      try { return { f, data: fs.readFileSync(f) }; } catch { return { f, data: null }; }
    });
    for (const f of CACHE_FILES) { try { fs.unlinkSync(f); } catch { /* ok */ } }
  });

  afterAll(() => {
    for (const b of backups) {
      if (b.data !== null) fs.writeFileSync(b.f, b.data);
      else { try { fs.unlinkSync(b.f); } catch { /* ok */ } }
    }
  });

  test('search works with no cache and no import (built-in registry)', () => {
    const results = svc.searchRegistry('godot');
    expect(results.some(c => c.name === 'godot')).toBe(true);
  });

  test('registry stats are populated from the vendored copy', () => {
    const stats = svc.getRegistryStats();
    expect(stats.total).toBeGreaterThan(50);
    expect(stats.harness).toBeGreaterThan(0);
  });
});
