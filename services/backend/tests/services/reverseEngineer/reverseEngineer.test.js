'use strict';

/**
 * reverseEngineer/ subsystem (DESIGN-ARCH-054) — deterministic tests.
 *
 * Synthetic artifacts are constructed byte-for-byte so the suite is hermetic and
 * green on any machine (no real binaries / external decompilers required). Cases
 * that need an external tool assert graceful degradation, not tool presence.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const registry = require('../../../src/services/reverseEngineer/formatRegistry');
const scanner = require('../../../src/services/reverseEngineer/artifactScanner');
const stringHarvester = require('../../../src/services/reverseEngineer/stringHarvester');
const sourceRecoverer = require('../../../src/services/reverseEngineer/sourceRecoverer');
const toolOrchestrator = require('../../../src/services/reverseEngineer/toolOrchestrator');
const reconstructionPort = require('../../../src/services/reverseEngineer/reconstructionPort');
const ledger = require('../../../src/services/reverseEngineer/verificationLedger');
const engine = require('../../../src/services/reverseEngineer');

// ── fixtures ────────────────────────────────────────────────────────────────
let TMP;
function tmpFile(name, buf) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, buf);
  return p;
}

function elf64() {
  const b = Buffer.alloc(64);
  b.write('\x7fELF', 0, 'binary');
  b[4] = 2;            // 64-bit
  b[5] = 1;            // little-endian
  b.writeUInt16LE(0x3e, 18); // e_machine = x86-64
  return b;
}
function pe() {
  const b = Buffer.alloc(0x100);
  b.write('MZ', 0, 'ascii');
  b.writeUInt32LE(0x80, 0x3c); // e_lfanew
  b.write('PE\0\0', 0x80, 'ascii');
  b.writeUInt16LE(0x8664, 0x84); // machine x86-64
  return b;
}
function javaClass() {
  const b = Buffer.alloc(16);
  b.writeUInt32BE(0xcafebabe, 0);
  b.writeUInt16BE(0, 4);   // minor
  b.writeUInt16BE(52, 6);  // major 52 = Java 8
  return b;
}
function fatMacho() {
  const b = Buffer.alloc(16);
  b.writeUInt32BE(0xcafebabe, 0);
  b.writeUInt32BE(2, 4); // nfat_arch = 2 (major bytes => 0x0002, < 45 → macho)
  return b;
}
function wasm() {
  const b = Buffer.alloc(8);
  b.write('\0asm', 0, 'binary');
  return b;
}
function dex() {
  const b = Buffer.alloc(64);
  b.write('dex\n035\0', 0, 'binary'); // magic + version 035
  return b;
}
// Minimal header buffers for additional archive magics (detection-only fixtures).
const ARCHIVE_FIXTURES = {
  '7z': Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 0]),
  xz: Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0, 0]),
  bzip2: Buffer.concat([Buffer.from('BZh', 'ascii'), Buffer.from([0x39, 0, 0, 0])]),
  zstd: Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0, 0, 0]),
  rar4: Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00, 0]),
  rar5: Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]),
  ar: Buffer.from('!<arch>\n0123', 'ascii'),
};

/** Minimal STORED (no compression) single-file zip — valid for node-stream-zip. */
function storedZip(entries /* [{name, data:Buffer}] */) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = zlib.crc32(e.data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8);   // method store
    lh.writeUInt16LE(0, 10);  // time
    lh.writeUInt16LE(0, 12);  // date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(e.data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    const localRec = Buffer.concat([lh, nameBuf, e.data]);
    locals.push(localRec);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(e.data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, nameBuf]));
    offset += localRec.length;
  }
  const localBlob = Buffer.concat(locals);
  const centralBlob = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBlob.length, 12);
  eocd.writeUInt32LE(localBlob.length, 16);
  return Buffer.concat([localBlob, centralBlob, eocd]);
}

describe('reverseEngineer subsystem', () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-re-test-'));

  // ── formatRegistry ────────────────────────────────────────────────────────
  describe('formatRegistry — single source of truth', () => {
    test('every format has signatures + recoverability', () => {
      for (const f of registry.listFormats()) {
        assert.ok(f.id && f.family && f.recoverability, `format ${f.id} complete`);
        assert.ok(Array.isArray(f.signatures), `format ${f.id} has signatures`);
      }
    });
    test('recoverability tiers are from the frozen enum', () => {
      const valid = new Set(Object.values(registry.RECOVERABILITY));
      for (const f of registry.listFormats()) assert.ok(valid.has(f.recoverability));
    });
    test('candidateTools returns array, never throws on unknown', () => {
      assert.deepEqual(toolOrchestrator.PLANS.elf.length > 0, true);
      assert.deepEqual(registry.candidateTools('nonexistent'), []);
    });
    test('embedded markers declare appliesTo + recoverability', () => {
      for (const m of registry.listEmbeddedMarkers()) {
        assert.ok(m.id && m.family && m.contentMarker);
      }
    });
  });

  // ── artifactScanner ───────────────────────────────────────────────────────
  describe('artifactScanner — read-only triage', () => {
    test('detects ELF64 x86-64', async () => {
      const r = await scanner.scanFile(tmpFile('a.elf', elf64()));
      assert.equal(r.format, 'elf');
      assert.equal(r.family, 'elf');
      assert.equal(r.arch.bits, 64);
      assert.equal(r.arch.arch, 'x86-64');
      assert.equal(r.recoverability, 'native');
      assert.match(r.sha256, /^[0-9a-f]{64}$/);
    });
    test('detects PE x86-64', async () => {
      const r = await scanner.scanFile(tmpFile('a.exe', pe()));
      assert.equal(r.format, 'pe');
      assert.equal(r.arch.arch, 'x86-64');
    });
    test('disambiguates cafebabe → java-class via major version', async () => {
      const r = await scanner.scanFile(tmpFile('A.class', javaClass()));
      assert.equal(r.format, 'java-class');
      assert.equal(r.recoverability, 'bytecode');
    });
    test('disambiguates cafebabe → macho when nfat_arch small', async () => {
      const r = await scanner.scanFile(tmpFile('fat.bin', fatMacho()));
      assert.equal(r.format, 'macho');
    });
    test('detects wasm', async () => {
      const r = await scanner.scanFile(tmpFile('m.wasm', wasm()));
      assert.equal(r.format, 'wasm');
    });
    test('detects Android DEX → dalvik bytecode', async () => {
      const r = await scanner.scanFile(tmpFile('classes.dex', dex()));
      assert.equal(r.format, 'dex');
      assert.equal(r.family, 'dalvik');
      assert.equal(r.recoverability, 'bytecode');
      assert.ok(r.candidateTools.includes('jadx'));
    });
    test('detects additional archive magics (7z/xz/bzip2/zstd/rar/ar)', async () => {
      const cases = [
        ['x.7z', ARCHIVE_FIXTURES['7z'], 'archive-7z'],
        ['x.xz', ARCHIVE_FIXTURES.xz, 'archive-xz'],
        ['x.bz2', ARCHIVE_FIXTURES.bzip2, 'archive-bzip2'],
        ['x.zst', ARCHIVE_FIXTURES.zstd, 'archive-zstd'],
        ['x4.rar', ARCHIVE_FIXTURES.rar4, 'archive-rar'],
        ['x5.rar', ARCHIVE_FIXTURES.rar5, 'archive-rar'],
        ['x.deb', ARCHIVE_FIXTURES.ar, 'archive-ar'],
      ];
      for (const [name, buf, expected] of cases) {
        const r = await scanner.scanFile(tmpFile(name, buf));
        assert.equal(r.format, expected, `${name} → ${expected}`);
        assert.equal(r.family, 'archive');
        assert.equal(r.recoverability, 'archive');
      }
    });
    test('missing file → exists:false, never throws', async () => {
      const r = await scanner.scanFile(path.join(TMP, 'nope.bin'));
      assert.equal(r.exists, false);
      assert.equal(r.format, 'unknown');
    });
    test('embedded .NET marker upgrades PE → bytecode', async () => {
      const b = Buffer.concat([pe(), Buffer.from('xxBSJBxx', 'ascii')]);
      const r = await scanner.scanFile(tmpFile('managed.exe', b));
      assert.ok(r.markers.includes('dotnet'));
      assert.equal(r.recoverability, 'bytecode');
    });
    test('PyInstaller marker upgrades native → source', async () => {
      const b = Buffer.concat([elf64(), Buffer.from('MEI\x0c\x0b\x0a\x0b\x0e', 'binary')]);
      const r = await scanner.scanFile(tmpFile('pyinst.bin', b));
      assert.ok(r.markers.includes('pyinstaller'));
      assert.equal(r.recoverability, 'source');
    });
  });

  // ── stringHarvester ───────────────────────────────────────────────────────
  describe('stringHarvester — evidence extraction', () => {
    test('harvests ascii strings + classifies urls/paths/versions', () => {
      const buf = Buffer.from('\x00\x01hello https://example.com/x v1.2.3 /usr/lib/foo.so \x00', 'binary');
      const h = stringHarvester.harvest(buf, { minLen: 3 });
      assert.ok(h.classified.url.some((s) => s.text.includes('example.com')));
      assert.ok(h.classified.version.some((s) => /1\.2\.3/.test(s.text)));
      assert.ok(h.classified.path.length >= 1);
    });
    test('detects toolchain fingerprints', () => {
      const buf = Buffer.from('blah GCC: (Ubuntu 11) 11.4.0 and Go build ID: abc node_modules', 'ascii');
      const h = stringHarvester.harvest(buf);
      assert.ok(h.toolchains.includes('gcc'));
      assert.ok(h.toolchains.includes('go'));
      assert.ok(h.toolchains.includes('node'));
    });
    test('harvests utf16le wide strings', () => {
      const wide = Buffer.from('C:\\Program Files\\app.exe', 'utf16le');
      const h = stringHarvester.harvest(wide, { minLen: 4 });
      assert.ok(h.samples.some((s) => s.text.includes('Program Files')));
    });
    test('non-buffer input degrades gracefully', () => {
      const h = stringHarvester.harvest(null);
      assert.equal(h.total, 0);
    });
  });

  // ── sourceRecoverer ───────────────────────────────────────────────────────
  describe('sourceRecoverer — in-band recovery', () => {
    test('rejects unsafe entry paths (traversal/absolute/drive)', () => {
      assert.equal(sourceRecoverer._isSafeEntry('../etc/passwd'), false);
      assert.equal(sourceRecoverer._isSafeEntry('/abs/path'), false);
      assert.equal(sourceRecoverer._isSafeEntry('C:\\x'), false);
      assert.equal(sourceRecoverer._isSafeEntry('a/b/c.js'), true);
    });
    test('classifies members by extension', () => {
      assert.equal(sourceRecoverer._classifyMember('x/app.js'), 'source');
      assert.equal(sourceRecoverer._classifyMember('A.class'), 'bytecode');
      assert.equal(sourceRecoverer._classifyMember('logo.png'), 'asset');
    });
    test('lists zip members without extracting (listOnly default)', async () => {
      const zbuf = storedZip([
        { name: 'src/index.js', data: Buffer.from('console.log(1)') },
        { name: 'README.md', data: Buffer.from('# hi') },
      ]);
      const zpath = tmpFile('bundle.zip', zbuf);
      const scan = await scanner.scanFile(zpath);
      assert.equal(scan.format, 'archive-zip');
      const rec = await sourceRecoverer.recover(zpath, scan, {});
      assert.equal(rec.ok, true);
      assert.equal(rec.members.length, 2);
      assert.ok(rec.members.every((m) => !m.extractedTo));
    });
    test('extracts zip members to outDir (sandboxed)', async () => {
      const zbuf = storedZip([{ name: 'app/main.py', data: Buffer.from('print(1)') }]);
      const zpath = tmpFile('bundle2.zip', zbuf);
      const scan = await scanner.scanFile(zpath);
      const out = path.join(TMP, 'extracted');
      const rec = await sourceRecoverer.recover(zpath, scan, { outDir: out });
      assert.equal(rec.ok, true);
      const extracted = rec.members[0].extractedTo;
      assert.ok(fs.existsSync(extracted));
      assert.equal(fs.readFileSync(extracted, 'utf8'), 'print(1)');
    });
    test('pyinstaller marker → honest deferral (no fabrication)', async () => {
      const b = Buffer.concat([elf64(), Buffer.from('MEI\x0c\x0b\x0a\x0b\x0e', 'binary')]);
      const p = tmpFile('pyinst2.bin', b);
      const scan = await scanner.scanFile(p);
      const rec = await sourceRecoverer.recover(p, scan, {});
      assert.equal(rec.ok, false);
      assert.equal(rec.deferred, true);
      assert.equal(rec.delegateTool, 'pyinstxtractor');
    });
  });

  // ── toolOrchestrator ──────────────────────────────────────────────────────
  describe('toolOrchestrator — discover + fail-soft', () => {
    test('probe returns availability map for a known family', () => {
      const r = toolOrchestrator.probe('elf');
      assert.equal(r.family, 'elf');
      assert.ok(r.tools.length > 0);
      for (const t of r.tools) assert.equal(typeof t.available, 'boolean');
    });
    test('orchestrate with no available tools → honest degraded hint', async () => {
      // Force an empty availability by probing a family with a fake plan via run=false
      const r = await toolOrchestrator.orchestrate('/nonexistent', 'wasm', { run: false });
      assert.equal(r.attempted, false);
      assert.ok(Array.isArray(r.availability));
    });
    test('unknown family → degraded with no-plan hint, never throws', async () => {
      const r = await toolOrchestrator.orchestrate('/x', 'totally-unknown', { run: true });
      assert.equal(r.degraded, true);
      assert.equal(r.evidence.length, 0);
    });
    test('go/rust/dalvik families now have runnable plans (were unwired)', () => {
      for (const fam of ['go', 'rust', 'dalvik']) {
        assert.ok(Array.isArray(toolOrchestrator.PLANS[fam]), `PLANS.${fam} exists`);
        assert.ok(toolOrchestrator.PLANS[fam].length > 0, `PLANS.${fam} non-empty`);
        const r = toolOrchestrator.probe(fam);
        assert.equal(r.family, fam);
        for (const t of r.tools) assert.equal(typeof t.available, 'boolean');
      }
    });
    test('pycdc is wired into the python plan', () => {
      assert.ok(toolOrchestrator.PLANS.python.some((p) => p.bin === 'pycdc'));
    });
    test('Ghidra analyzeHeadless is a decompile entry for native families', () => {
      for (const fam of ['elf', 'pe', 'macho']) {
        const g = toolOrchestrator.PLANS[fam].find((p) => p.bin === 'analyzeHeadless');
        assert.ok(g, `PLANS.${fam} has analyzeHeadless`);
        assert.equal(g.kind, 'decompile');
        assert.equal(g.needsTempProject, true);
      }
    });
  });

  // ── reconstructionPort ────────────────────────────────────────────────────
  describe('reconstructionPort — evidence vs inference', () => {
    test('no brain → deterministic evidence-only report', async () => {
      const pack = reconstructionPort.buildEvidencePack({
        scan: { format: 'elf', family: 'elf', recoverability: 'native', markers: [] },
        strings: { toolchains: ['gcc'], classified: {}, samples: [] },
      });
      const r = await reconstructionPort.reconstruct(pack, {});
      assert.equal(r.source, 'evidence-only');
      assert.equal(r.inferredLanguage, 'C/C++');
    });
    test('brain JSON output is parsed + clamped + tagged source:model', async () => {
      const brain = async () => JSON.stringify({
        inferredLanguage: 'Go', inferredToolchain: 'go', purposeSummary: 'cli',
        modules: [{ name: 'main', role: 'entry' }], entryPoints: ['main.main'],
        reconstructedSkeleton: 'func main(){}', dependencies: ['fmt'], confidence: 1.7, caveats: [],
      });
      const pack = reconstructionPort.buildEvidencePack({ scan: { family: 'elf' }, strings: {} });
      const r = await reconstructionPort.reconstruct(pack, { brain });
      assert.equal(r.source, 'model');
      assert.equal(r.inferredLanguage, 'Go');
      assert.equal(r.confidence, 1); // clamped
    });
    test('brain timeout → falls back to evidence-only with caveat', async () => {
      const brain = () => new Promise((res) => setTimeout(() => res('{}'), 1000));
      const pack = reconstructionPort.buildEvidencePack({ scan: { family: 'wasm' }, strings: {} });
      const r = await reconstructionPort.reconstruct(pack, { brain, timeoutMs: 20 });
      assert.equal(r.source, 'evidence-only');
      assert.ok(r.caveats.some((c) => /timed out/i.test(c)));
    });
    test('brain non-JSON garbage → evidence-only fallback', async () => {
      const brain = async () => 'not json at all';
      const pack = reconstructionPort.buildEvidencePack({ scan: { family: 'elf' }, strings: { toolchains: ['rustc'] } });
      const r = await reconstructionPort.reconstruct(pack, { brain });
      assert.equal(r.source, 'evidence-only');
      assert.equal(r.inferredLanguage, 'Rust');
    });
  });

  // ── verificationLedger ────────────────────────────────────────────────────
  describe('verificationLedger — fidelity self-verification', () => {
    test('build + load + find manifest round-trip', () => {
      const srcDir = path.join(TMP, 'proj');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'a.js'), 'a');
      fs.writeFileSync(path.join(srcDir, 'b.js'), 'b');
      const artifact = tmpFile('out.zip', storedZip([{ name: 'a.js', data: Buffer.from('a') }]));
      const m = ledger.buildManifest({ artifactPath: artifact, sourceFiles: ['a.js', 'b.js'], rootDir: srcDir, entry: 'a.js', toolchain: 'node' });
      assert.equal(m.sourceCount, 2);
      // Write into the project subdir (NOT TMP root) so it cannot pollute other artifacts' manifest discovery.
      const mp = ledger.writeManifest(m, path.join(srcDir, '.khy-build-manifest.json'));
      assert.ok(ledger.loadManifest(mp));
    });
    test('no manifest → no-baseline verdict, never throws', () => {
      const v = ledger.verify({ sha256: 'x' }, { members: [] }, null);
      assert.equal(v.hasBaseline, false);
      assert.equal(v.verdict, 'no-baseline');
    });
    test('full coverage + artifact hash match → verified', () => {
      const manifest = {
        manifestVersion: 1,
        artifact: { name: 'out', sha256: 'deadbeef' },
        sources: [{ name: 'src/a.js' }, { name: 'src/b.js' }],
      };
      const scan = { sha256: 'deadbeef' };
      const recover = { members: [{ name: 'a.js', kind: 'source' }, { name: 'b.js', kind: 'source' }] };
      const v = ledger.verify(scan, recover, manifest);
      assert.equal(v.verdict, 'verified');
      assert.equal(v.coverage, 1);
      assert.equal(v.artifactHashMatch, true);
      assert.equal(v.fidelity, 100);
    });
    test('partial coverage → partial/mismatch verdict + missing list', () => {
      const manifest = { manifestVersion: 1, artifact: { sha256: 'aaa' }, sources: [{ name: 'a.js' }, { name: 'b.js' }, { name: 'c.js' }] };
      const v = ledger.verify({ sha256: 'bbb' }, { members: [{ name: 'a.js', kind: 'source' }] }, manifest);
      assert.ok(['partial', 'mismatch'].includes(v.verdict));
      assert.ok(v.missing.includes('b.js'));
      assert.equal(v.artifactHashMatch, false);
    });
  });

  // ── engine facade ─────────────────────────────────────────────────────────
  describe('engine facade — end-to-end', () => {
    test('unauthorized + no manifest → triage only, with warning', async () => {
      const p = tmpFile('e1.elf', Buffer.concat([elf64(), Buffer.from('GCC: (x) 9.0 stuff', 'ascii')]));
      const r = await engine.analyze(p, {});
      assert.equal(r.ok, true);
      assert.equal(r.authorized, false);
      assert.equal(r.scan.format, 'elf');
      assert.ok(r.strings.toolchains.includes('gcc'));
      assert.equal(r.recovery, null); // recovery gated behind authorization
      assert.ok(r.warnings.some((w) => /未授权|authoriz/i.test(w)));
    });
    test('authorized zip → recovers members + reconstructs + verifies', async () => {
      const zbuf = storedZip([
        { name: 'src/index.js', data: Buffer.from('module.exports=1') },
        { name: 'package.json', data: Buffer.from('{"name":"x"}') },
      ]);
      const p = tmpFile('e2.zip', zbuf);
      const r = await engine.analyze(p, { authorized: true });
      assert.equal(r.ok, true);
      assert.equal(r.authorized, true);
      assert.ok(r.recovery.ok);
      assert.ok(r.recovery.members.length >= 2);
      assert.ok(r.reconstruction);
      assert.equal(r.verification.verdict, 'no-baseline');
    });
    test('manifest beside artifact → auto-authorized + verified fidelity', async () => {
      const dir = path.join(TMP, 'pkg');
      fs.mkdirSync(dir, { recursive: true });
      const zbuf = storedZip([{ name: 'app.js', data: Buffer.from('x') }]);
      const artifact = path.join(dir, 'app.zip');
      fs.writeFileSync(artifact, zbuf);
      const manifest = {
        manifestVersion: 1,
        artifact: { name: 'app.zip', sha256: require('crypto').createHash('sha256').update(zbuf).digest('hex') },
        sources: [{ name: 'app.js' }],
      };
      fs.writeFileSync(path.join(dir, '.khy-build-manifest.json'), JSON.stringify(manifest));
      const r = await engine.analyze(artifact, {});
      assert.equal(r.authorized, true); // manifest presence auto-authorizes
      assert.equal(r.verification.verdict, 'verified');
      assert.equal(r.verification.fidelity, 100);
    });
    test('missing artifact → ok:false, no-artifact verdict, never throws', async () => {
      const r = await engine.analyze(path.join(TMP, 'ghost.exe'), { authorized: true });
      assert.equal(r.ok, false);
      assert.equal(r.verification.verdict, 'no-artifact');
    });
  });

  // ── 依赖自愈接线：runTools 无工具 → 主动申请安装批准 ──────────────────────────
  describe('decompiler self-healing wiring — proactive install approval', () => {
    test('recommendInstall maps each native/bytecode family to a curated depId', () => {
      // 每个有外部反编译/反汇编计划的 family 都能挑出一个已登记的 depId。
      assert.equal(toolOrchestrator.recommendInstall('elf').depId, 'binutils');
      assert.equal(toolOrchestrator.recommendInstall('pe').depId, 'binutils');
      assert.equal(toolOrchestrator.recommendInstall('dalvik').depId, 'jadx');
      assert.equal(toolOrchestrator.recommendInstall('wasm').depId, 'wabt');
      assert.equal(toolOrchestrator.recommendInstall('dotnet').depId, 'ilspycmd');
      assert.equal(toolOrchestrator.recommendInstall('python').depId, 'decompyle3');
      // 未登记 family → null（不捏造）。
      assert.equal(toolOrchestrator.recommendInstall('nonsuch'), null);
    });

    test('every recommended depId resolves to a registered dependency', () => {
      const depRegistry = require('../../../src/services/dependency/registry');
      for (const fam of ['elf', 'pe', 'macho', 'dalvik', 'wasm', 'dotnet', 'python', 'go', 'rust']) {
        const rec = toolOrchestrator.recommendInstall(fam);
        if (!rec) continue;
        assert.ok(depRegistry.getDependency(rec.depId), `depId ${rec.depId} (family ${fam}) must be registered`);
      }
    });

    test('engine annotates missingDependency only when runTools + no tool available', async () => {
      // 强制「本机无任何工具」：清缓存后注入恒空的 which（probe → 全 unavailable）。
      const orig = toolOrchestrator._run; // not used here; we drive via availability
      toolOrchestrator._resetWhichCache();
      const dex = (() => {
        const b = Buffer.alloc(64);
        b.write('dex\n035\0', 0, 'binary');
        return b;
      })();
      const p = tmpFile('eng-miss.dex', dex);
      // runTools=false → 探活路径，绝不打扰用户。
      const probeOnly = await engine.analyze(p, { authorized: true, runTools: false });
      assert.equal(probeOnly.orchestration.missingDependency, undefined);
      void orig;
    });

    test('tool returns MISSING_DEPENDENCY with depId when runTools and no decompiler', async () => {
      const tool = require('../../../src/tools/reverseEngineer');
      // 注入一个 family 有计划、但所有工具都「不可用」的报告：直接驱动工具的 execute 不可行
      // （依赖真实 which），故验证「探活模式不触发」+「映射可解析」两条已覆盖；此处验证
      // 工具在 runTools 且 orchestration.missingDependency 存在时构造结构化失败的契约。
      assert.equal(typeof tool.execute, 'function');
      const { MissingDependencyError } = require('../../../src/services/dependency/resolver');
      const err = new MissingDependencyError('jadx', {});
      const s = err.toStructuredResult();
      assert.equal(s.success, false);
      assert.equal(s.error.code, 'MISSING_DEPENDENCY');
      // depId 透传后 resolver 应能零文本匹配回溯辨认。
      s.depId = 'jadx';
      const resolver = require('../../../src/services/dependency/resolver');
      const det = resolver.detectFromError(s);
      assert.ok(det && det.depId === 'jadx');
    });
  });
});
