'use strict';

/**
 * unpackTool — generic-extractor fallback + gated auto-install (jest).
 *
 * Covers the "遇到未知格式时 khy 自己想办法解决" self-remediation path: formats the
 * built-in handlers don't cover (.7z/.rar/.bz2/...) fall back to a system extractor
 * (7z/bsdtar/unar); if none is installed, unpack returns the exact per-platform
 * install command instead of a flat "Unsupported archive format".
 *
 * Determinism: the leaf's platform + executable probes are injectable, so the pure
 * mapping/selection logic is tested without touching the real system. A real
 * round-trip through the public unpack API runs only when `7z` is actually present
 * (skipped, not faked, otherwise).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const unpack = require('../../src/tools/unpackTool');
const ge = require('../../src/services/reverseEngineer/genericExtractor');

function _has(bin) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin],
      { stdio: ['pipe', 'pipe', 'ignore'], timeout: 3000 });
    return true;
  } catch { return false; }
}
const HAS_7Z = _has('7z') || _has('7za') || _has('7zz');

let tmpDir;
let _prevCwd;
let _prevGate;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-unpack-generic-'));
  // Confine extraction base to tmpDir so a /tmp output_dir counts as "within base"
  // (mirrors unpackAsar.test.js), leaving the actual extraction under test.
  _prevCwd = process.env.KHYQUANT_CWD;
  process.env.KHYQUANT_CWD = tmpDir;
  _prevGate = process.env.KHY_UNPACK_GENERIC;
  delete process.env.KHY_UNPACK_GENERIC; // default-on
});

afterAll(() => {
  if (_prevCwd === undefined) delete process.env.KHYQUANT_CWD; else process.env.KHYQUANT_CWD = _prevCwd;
  if (_prevGate === undefined) delete process.env.KHY_UNPACK_GENERIC; else process.env.KHY_UNPACK_GENERIC = _prevGate;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('genericExtractor — pure detection & mapping (deterministic, injected probes)', () => {
  test('detectGenericFormat is case-insensitive and null on unknown', () => {
    expect(ge.detectGenericFormat('/a/b/app.7z')).toBe('.7z');
    expect(ge.detectGenericFormat('/a/b/APP.RAR')).toBe('.rar');
    expect(ge.detectGenericFormat('/a/b/data.deb')).toBe('.deb');
    expect(ge.detectGenericFormat('/a/b/note.bogus')).toBeNull();
    expect(ge.detectGenericFormat('')).toBeNull();
    expect(ge.detectGenericFormat(null)).toBeNull();
  });

  test('pickExtractor honors preference order under injected availability', () => {
    // Only bsdtar present: .bz2 (tools: 7z→bsdtar→7za) picks bsdtar; .7z picks nothing.
    const onlyBsdtar = { has: (b) => b === 'bsdtar' };
    expect(ge.pickExtractor('.bz2', onlyBsdtar)).toEqual({ bin: 'bsdtar', kind: 'bsdtar' });
    expect(ge.pickExtractor('.7z', onlyBsdtar)).toBeNull();
    // 7z present: preferred first.
    expect(ge.pickExtractor('.7z', { has: (b) => b === '7z' })).toEqual({ bin: '7z', kind: '7z' });
    // unknown format → null regardless.
    expect(ge.pickExtractor('.bogus', { has: () => true })).toBeNull();
  });

  test('detectPackageManager picks per-platform in preference order', () => {
    expect(ge.detectPackageManager({ platform: 'linux', has: (b) => b === 'dnf' })).toBe('dnf');
    expect(ge.detectPackageManager({ platform: 'macos', has: (b) => b === 'brew' })).toBe('brew');
    expect(ge.detectPackageManager({ platform: 'windows', has: (b) => b === 'winget' })).toBe('winget');
    expect(ge.detectPackageManager({ platform: 'linux', has: () => false })).toBeNull();
  });

  test('buildInstallCommand yields exact command for detected manager + full option list', () => {
    const apt = ge.buildInstallCommand('.7z', { platform: 'linux', has: (b) => b === 'apt-get' });
    expect(apt.manager).toBe('apt');
    expect(apt.command).toBe('sudo apt-get install -y p7zip-full');
    // Always lists cross-platform options for portable guidance.
    expect(apt.options).toEqual(expect.arrayContaining(['brew install p7zip']));

    // .rar recommends the `unar` package.
    const rar = ge.buildInstallCommand('.rar', { platform: 'linux', has: (b) => b === 'apt-get' });
    expect(rar.command).toBe('sudo apt-get install -y unar');

    // No manager detected → command null but options still offered.
    const none = ge.buildInstallCommand('.7z', { platform: 'linux', has: () => false });
    expect(none.command).toBeNull();
    expect(none.manager).toBeNull();
    expect(none.options.length).toBeGreaterThan(0);
  });
});

describe('unpack — validateInput accepts generic family (gate on) and reverts (gate off)', () => {
  test('.7z is a valid archive when the generic gate is on', async () => {
    const p = path.join(tmpDir, 'x.7z');
    fs.writeFileSync(p, 'stub');
    const res = await unpack.validateInput({ file_path: p });
    expect(res.valid).toBe(true);
  });

  test('unsupported-format help text advertises the generic family', async () => {
    const p = path.join(tmpDir, 'note.bogus');
    fs.writeFileSync(p, 'not an archive');
    const res = await unpack.validateInput({ file_path: p });
    expect(res.valid).toBe(false);
    expect(res.message).toMatch(/\.7z/);
    expect(res.message).toMatch(/\.rar/);
  });

  test('gate off → .7z reverts to "Unsupported" (byte-revert)', async () => {
    const p = path.join(tmpDir, 'y.7z');
    fs.writeFileSync(p, 'stub');
    process.env.KHY_UNPACK_GENERIC = '0';
    try {
      const res = await unpack.validateInput({ file_path: p });
      expect(res.valid).toBe(false);
      expect(res.message).toMatch(/Unsupported archive format/);
    } finally {
      delete process.env.KHY_UNPACK_GENERIC;
    }
  });
});

describe('unpack — real .7z round-trip via system 7z', () => {
  const runIf = HAS_7Z ? test : test.skip;

  runIf('extracts a real 7z archive end-to-end', async () => {
    const srcDir = fs.mkdtempSync(path.join(tmpDir, 'src-'));
    const mainSrc = 'console.log("hello 7z")\n';
    fs.writeFileSync(path.join(srcDir, 'main.js'), mainSrc);
    fs.mkdirSync(path.join(srcDir, 'sub'));
    fs.writeFileSync(path.join(srcDir, 'sub', 'app.js'), 'export const x = 42\n');

    const archive = path.join(tmpDir, 'bundle.7z');
    const sevenZip = _has('7z') ? '7z' : (_has('7za') ? '7za' : '7zz');
    execFileSync(sevenZip, ['a', '-bd', archive, '.'], { cwd: srcDir, stdio: 'ignore' });
    expect(fs.existsSync(archive)).toBe(true);

    // list_only enumerates entries.
    const listed = await unpack.execute({ file_path: archive, list_only: true });
    expect(listed.success).toBe(true);
    expect(listed.output).toMatch(/main\.js/);

    // extraction round-trips file bytes.
    const out = path.join(tmpDir, 'extracted');
    const res = await unpack.execute({ file_path: archive, output_dir: out });
    expect(res.success).toBe(true);
    expect(fs.readFileSync(path.join(out, 'main.js'), 'utf8')).toBe(mainSrc);
    expect(fs.readFileSync(path.join(out, 'sub', 'app.js'), 'utf8')).toBe('export const x = 42\n');
  });
});
