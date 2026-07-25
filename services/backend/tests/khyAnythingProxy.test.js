'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const proxy = require('../src/services/khyAnythingProxy');

// addProxy persists to the fixed ~/.khy/khyanything/proxies.json. Snapshot it so
// the test never clobbers a real user manifest.
describe('khyAnythingProxy — instant proxy onboarding', () => {
  let backup;
  let fixtureDir;
  const NAME = 'fixture-tool';

  beforeAll(() => {
    try { backup = fs.readFileSync(proxy.PROXIES_FILE); } catch { backup = null; }

    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-proxy-fix-'));
    fs.writeFileSync(path.join(fixtureDir, 'package.json'), JSON.stringify({
      name: 'fixture-tool',
      version: '1.0.0',
      bin: { greet: 'greet.js' },
      scripts: { hello: 'echo hi', build: 'echo built' },
    }));
    fs.writeFileSync(path.join(fixtureDir, 'greet.js'), "console.log('hi-from-bin');\n");
    fs.writeFileSync(path.join(fixtureDir, 'Makefile'), 'all:\n\techo making\n\nclean:\n\trm -f out\n');
  });

  afterAll(() => {
    try { proxy.removeProxy(NAME); } catch { /* ok */ }
    if (backup !== null) fs.writeFileSync(proxy.PROXIES_FILE, backup);
    else { try { fs.unlinkSync(proxy.PROXIES_FILE); } catch { /* ok */ } }
    try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  test('rejects missing path', () => {
    const r = proxy.addProxy('/no/such/khy-proxy-path-xyz');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/不存在/);
  });

  test('rejects empty argument', () => {
    const r = proxy.addProxy('');
    expect(r.success).toBe(false);
  });

  test('onboards a local project and detects commands', () => {
    const r = proxy.addProxy(fixtureDir, { name: NAME });
    expect(r.success).toBe(true);
    expect(r.name).toBe(NAME);
    expect(r.path).toBe(path.resolve(fixtureDir));
    expect(r.language).toBe('javascript');
    // Makefile is present and detected before package.json by the shared detector.
    expect(r.buildSystem).toBe('make');

    // npm scripts + bin + make targets + raw fallback are all whitelisted.
    expect(r.commands).toEqual(expect.arrayContaining(['hello', 'build', 'greet', 'all', 'clean', 'run']));
  });

  test('persists the proxy to proxies.json', () => {
    const list = JSON.parse(fs.readFileSync(proxy.PROXIES_FILE, 'utf8'));
    const entry = list.find(p => p.name === NAME);
    expect(entry).toBeTruthy();
    expect(entry.path).toBe(path.resolve(fixtureDir));
    expect(entry.runSpec.commands.some(c => c.kind === 'node-bin' && c.command === 'greet')).toBe(true);
  });

  test('listProxies returns the onboarded proxy', () => {
    expect(proxy.listProxies().some(p => p.name === NAME)).toBe(true);
  });

  test('invokeProxy runs a node-bin command inside the project', () => {
    const r = proxy.invokeProxy(NAME, 'greet');
    expect(r.success).toBe(true);
    expect(r.data).toMatch(/hi-from-bin/);
  });

  test('invokeProxy rejects a non-whitelisted command', () => {
    const r = proxy.invokeProxy(NAME, 'definitely-not-a-command');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/白名单/);
  });

  test('removeProxy clears the proxy', () => {
    const r = proxy.removeProxy(NAME);
    expect(r.success).toBe(true);
    expect(proxy.listProxies().some(p => p.name === NAME)).toBe(false);
  });
});
