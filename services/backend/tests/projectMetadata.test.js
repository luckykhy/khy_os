'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const svc = require('../src/services/projectMetadataService');

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

describe('projectMetadataService — deterministic seed docs', () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-meta-'));
  });
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  test('generates .ai/ for a Node project with stack, entry point and symbols', async () => {
    write(tmp, 'package.json', JSON.stringify({
      name: 'demo-app',
      main: 'src/index.js',
      scripts: { build: 'tsc', start: 'node src/index.js', test: 'jest' },
      dependencies: { express: '^4', lodash: '^4' },
    }));
    write(tmp, 'src/index.js', [
      'function startServer() {}',
      'class Router {}',
      'const handleRequest = async () => {};',
      'module.exports = { startServer };',
    ].join('\n'));

    const res = await svc.generateProjectMetadata(tmp);
    assert.equal(res.generated, true, res.reason);
    // The .ai/ seed docs come first; generate also links AI entry-point pointers
    // (AGENTS.md, CLAUDE.md, …) so other tools discover .ai/ automatically.
    assert.deepEqual(res.files.slice(0, 4), ['.ai/MAP.md', '.ai/CONTEXT.yaml', '.ai/GUARDS.md', '.ai/.metahash.json']);
    assert.ok(res.files.includes('AGENTS.md'), 'should link AGENTS.md pointer');
    assert.ok(res.files.includes('CLAUDE.md'), 'should link CLAUDE.md pointer');

    const map = fs.readFileSync(path.join(tmp, '.ai/MAP.md'), 'utf8');
    assert.match(map, /node/);
    assert.match(map, /src\/index\.js/);
    assert.match(map, /npm start/);
    assert.match(map, /startServer/);

    const ctx = fs.readFileSync(path.join(tmp, '.ai/CONTEXT.yaml'), 'utf8');
    assert.match(ctx, /stack: \[/);
    assert.match(ctx, /express/);
    assert.match(ctx, /startServer/);
    assert.match(ctx, /Router/);

    const guards = fs.readFileSync(path.join(tmp, '.ai/GUARDS.md'), 'utf8');
    assert.match(guards, /没有 AI/);
    assert.match(guards, /npm test/);
    assert.match(guards, /TODO\(人工\)/);
  });

  test('is idempotent: second run skips unless force', async () => {
    write(tmp, 'package.json', JSON.stringify({ name: 'x' }));
    write(tmp, 'index.js', 'function a(){}');

    const first = await svc.generateProjectMetadata(tmp);
    assert.equal(first.generated, true);

    // Tamper with the generated file to prove a no-op skip leaves it intact.
    const mapPath = path.join(tmp, '.ai/MAP.md');
    fs.writeFileSync(mapPath, 'HAND EDITED', 'utf8');

    const second = await svc.generateProjectMetadata(tmp);
    assert.equal(second.generated, false);
    assert.equal(second.reason, 'already_exists');
    assert.equal(fs.readFileSync(mapPath, 'utf8'), 'HAND EDITED');

    const forced = await svc.generateProjectMetadata(tmp, { force: true });
    assert.equal(forced.generated, true);
    assert.notEqual(fs.readFileSync(mapPath, 'utf8'), 'HAND EDITED');
  });

  test('detects a Python project', async () => {
    write(tmp, 'pyproject.toml', '[project]\nname = "pyapp"\n');
    write(tmp, 'main.py', 'def run():\n    pass\nclass App:\n    pass\n');

    const res = await svc.generateProjectMetadata(tmp);
    assert.equal(res.generated, true, res.reason);
    const ctx = fs.readFileSync(path.join(tmp, '.ai/CONTEXT.yaml'), 'utf8');
    assert.match(ctx, /python/);
    assert.match(ctx, /main\.py/);
    assert.match(ctx, /run/);
    assert.match(ctx, /App/);
  });

  test('empty project does not generate', async () => {
    const res = await svc.generateProjectMetadata(tmp);
    assert.equal(res.generated, false);
    assert.equal(res.reason, 'empty_project');
  });

  test('invalid root is reported, not thrown', async () => {
    const res = await svc.generateProjectMetadata(path.join(tmp, 'nope'));
    assert.equal(res.generated, false);
    assert.equal(res.reason, 'invalid_root');
  });
});

describe('projectMetadataService — maybeGenerateAfterRun trigger logic', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-meta-run-')); });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  test('triggers on scaffold tool usage', async () => {
    write(tmp, 'package.json', JSON.stringify({ name: 'scaf' }));
    write(tmp, 'src/a.js', 'function a(){}');
    const log = [
      { tool: 'scaffoldFiles', params: {}, result: { success: true, root: tmp, createdFiles: ['src/a.js'] } },
    ];
    const res = await svc.maybeGenerateAfterRun(tmp, log, {});
    assert.equal(res.generated, true, res.reason);
    assert.ok(fs.existsSync(path.join(tmp, '.ai/MAP.md')));
  });

  test('triggers when >= KHY_META_MIN_FILES files written', async () => {
    write(tmp, 'package.json', JSON.stringify({ name: 'multi' }));
    const log = [];
    for (const f of ['a.js', 'b.js', 'c.js']) {
      write(tmp, f, 'function x(){}');
      log.push({ tool: 'Write', params: { file_path: path.join(tmp, f) }, result: { success: true } });
    }
    const res = await svc.maybeGenerateAfterRun(tmp, log, {});
    assert.equal(res.generated, true, res.reason);
  });

  test('does not trigger below threshold without scaffold', async () => {
    write(tmp, 'a.js', 'function x(){}');
    const log = [
      { tool: 'Write', params: { file_path: path.join(tmp, 'a.js') }, result: { success: true } },
    ];
    const res = await svc.maybeGenerateAfterRun(tmp, log, {});
    assert.equal(res.generated, false);
    assert.equal(res.reason, 'no_project_generated');
  });

  test('honors KHY_META_ENABLED=0', async () => {
    const prev = process.env.KHY_META_ENABLED;
    process.env.KHY_META_ENABLED = '0';
    try {
      const log = [{ tool: 'scaffoldFiles', params: {}, result: { success: true, root: tmp } }];
      const res = await svc.maybeGenerateAfterRun(tmp, log, {});
      assert.equal(res.generated, false);
      assert.equal(res.reason, 'disabled');
    } finally {
      if (prev === undefined) delete process.env.KHY_META_ENABLED;
      else process.env.KHY_META_ENABLED = prev;
    }
  });

  test('_commonProjectRoot descends into a single shared subdir', () => {
    const sub = path.join(tmp, 'my-app');
    fs.mkdirSync(sub, { recursive: true });
    const files = [path.join(sub, 'index.js'), path.join(sub, 'pkg.json')];
    const root = svc._internal._commonProjectRoot(tmp, files);
    assert.equal(root, sub);
  });

  test('_commonProjectRoot stays at cwd for root-level files', () => {
    write(tmp, 'index.js', '');
    const files = [path.join(tmp, 'index.js')];
    const root = svc._internal._commonProjectRoot(tmp, files);
    assert.equal(root, path.resolve(tmp));
  });
});

describe('projectMetadataService — fingerprint + non-destructive refresh', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-meta-refresh-')); });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  test('refresh generates when absent, then is a no-op while structure is unchanged', async () => {
    write(tmp, 'package.json', JSON.stringify({ name: 'rf', main: 'index.js' }));
    write(tmp, 'index.js', 'function a(){}');

    const first = await svc.refreshProjectMetadata(tmp);
    assert.equal(first.generated, true);
    assert.equal(first.reason, 'generated');
    assert.equal(first.mode, 'auto');
    assert.ok(first.fingerprint);
    assert.ok(fs.existsSync(path.join(tmp, '.ai/.metahash.json')));

    const meta = JSON.parse(fs.readFileSync(path.join(tmp, '.ai/.metahash.json'), 'utf8'));
    assert.equal(meta.fingerprint, first.fingerprint);
    assert.equal(meta.kind, 'auto');

    const second = await svc.refreshProjectMetadata(tmp);
    assert.equal(second.generated, false);
    assert.equal(second.reason, 'unchanged');
    assert.equal(second.fingerprint, first.fingerprint);
  });

  test('refresh overwrites auto-owned docs when structure changes', async () => {
    write(tmp, 'package.json', JSON.stringify({ name: 'rf', main: 'index.js' }));
    write(tmp, 'index.js', 'function a(){}');
    const first = await svc.refreshProjectMetadata(tmp);

    // Add a new source file with new symbols → fingerprint must change.
    write(tmp, 'extra.js', 'function brandNewSymbol(){}\nclass FreshClass {}');
    const second = await svc.refreshProjectMetadata(tmp);
    assert.equal(second.generated, true);
    assert.equal(second.reason, 'refreshed');
    assert.notEqual(second.fingerprint, first.fingerprint);

    const ctxDoc = fs.readFileSync(path.join(tmp, '.ai/CONTEXT.yaml'), 'utf8');
    assert.match(ctxDoc, /brandNewSymbol/);
    // metahash advanced to the new fingerprint.
    const meta = JSON.parse(fs.readFileSync(path.join(tmp, '.ai/.metahash.json'), 'utf8'));
    assert.equal(meta.fingerprint, second.fingerprint);
  });

  test('refresh never overwrites a hand-authored .ai/, writes SKELETON.auto instead', async () => {
    write(tmp, 'package.json', JSON.stringify({ name: 'curated', main: 'index.js' }));
    write(tmp, 'index.js', 'function a(){}');
    // Hand-authored MAP.md WITHOUT the auto marker.
    const curated = '# Curated MAP\n\nHand-written by a human. Do not touch.\n';
    write(tmp, '.ai/MAP.md', curated);

    const res = await svc.refreshProjectMetadata(tmp);
    assert.equal(res.generated, true);
    assert.equal(res.reason, 'skeleton_refreshed');
    assert.equal(res.mode, 'skeleton');

    // Curated MAP untouched.
    assert.equal(fs.readFileSync(path.join(tmp, '.ai/MAP.md'), 'utf8'), curated);
    // Machine-derived skeleton written and marked.
    const skel = fs.readFileSync(path.join(tmp, '.ai/SKELETON.auto.md'), 'utf8');
    assert.match(skel, /khy-metadata:auto/);
    assert.match(skel, /index\.js/);

    const meta = JSON.parse(fs.readFileSync(path.join(tmp, '.ai/.metahash.json'), 'utf8'));
    assert.equal(meta.kind, 'skeleton');

    // Second pass with no structural change → skeleton no-op.
    const again = await svc.refreshProjectMetadata(tmp);
    assert.equal(again.generated, false);
    assert.equal(again.reason, 'skeleton_unchanged');
  });

  test('generated docs carry the auto marker so refresh recognizes them as owned', async () => {
    write(tmp, 'package.json', JSON.stringify({ name: 'owned' }));
    write(tmp, 'index.js', 'function a(){}');
    await svc.generateProjectMetadata(tmp);
    const map = fs.readFileSync(path.join(tmp, '.ai/MAP.md'), 'utf8');
    assert.ok(svc._internal._isAutoOwned(map));
  });

  test('fingerprint is deterministic and ignores timestamps', async () => {
    write(tmp, 'package.json', JSON.stringify({ name: 'det', main: 'index.js' }));
    write(tmp, 'index.js', 'function a(){}');
    const limits = svc._internal.LIMITS();
    const c1 = svc._internal._collectContext(tmp, limits);
    const c2 = svc._internal._collectContext(tmp, limits);
    assert.equal(
      svc._internal._computeFingerprint(c1.ctx),
      svc._internal._computeFingerprint(c2.ctx),
    );
  });
});

describe('projectMetadataService — large-monorepo coverage & sensitivity', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-meta-mono-')); });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  // Build a monorepo where many shallow, alphabetically-early files would, under the
  // old global (depth,path) sort, starve a deep module out of the symbol budget entirely.
  function seedMonorepo() {
    write(tmp, 'package.json', JSON.stringify({ name: 'mono' }));
    // 60 shallow files in an alphabetically-early bucket — enough to crowd out a small cap.
    for (let i = 0; i < 60; i++) {
      write(tmp, `aaa/file${String(i).padStart(2, '0')}.js`, `function shallow${i}(){}`);
    }
    // The deep module we care about (mirrors platform/khy_platform/app_protocol.py).
    write(tmp, 'platform/khy_platform/app_protocol.py',
      'def discover_apps():\n    pass\n');
  }

  test('a deep module is represented in symbols despite many shallow files (bucket fairness)', () => {
    seedMonorepo();
    // Tight symbol budget: old logic would spend it all on aaa/*; bucketing must still reach platform/.
    const prev = process.env.KHY_META_MAX_SYMBOL_FILES;
    process.env.KHY_META_MAX_SYMBOL_FILES = '12';
    try {
      const limits = svc._internal.LIMITS();
      const collected = svc._internal._collectContext(tmp, limits);
      const rels = collected.ctx.symbolFiles.map(sf => sf.rel);
      assert.ok(
        rels.includes('platform/khy_platform/app_protocol.py'),
        `deep module starved; picked: ${rels.join(', ')}`,
      );
    } finally {
      if (prev === undefined) delete process.env.KHY_META_MAX_SYMBOL_FILES;
      else process.env.KHY_META_MAX_SYMBOL_FILES = prev;
    }
  });

  test('editing a deep, non-sampled source file still flips the fingerprint', () => {
    seedMonorepo();
    // Force the symbol budget so small the deep file is NOT sampled, proving the
    // full-source-tree (path|size) signal — not symbol sampling — drives sensitivity.
    const prev = process.env.KHY_META_MAX_SYMBOL_FILES;
    process.env.KHY_META_MAX_SYMBOL_FILES = '1';
    try {
      const limits = svc._internal.LIMITS();
      const before = svc._internal._computeFingerprint(svc._internal._collectContext(tmp, limits).ctx);
      // Add a function → file size grows → srcTree entry changes.
      write(tmp, 'platform/khy_platform/app_protocol.py',
        'def discover_apps():\n    pass\n\ndef load_app(name):\n    return None\n');
      const after = svc._internal._computeFingerprint(svc._internal._collectContext(tmp, limits).ctx);
      assert.notEqual(after, before, 'deep-file edit must change fingerprint');
    } finally {
      if (prev === undefined) delete process.env.KHY_META_MAX_SYMBOL_FILES;
      else process.env.KHY_META_MAX_SYMBOL_FILES = prev;
    }
  });
});

// 详略得当：MAP/SKELETON 是给人看的导航速览（teaser，宜简），CONTEXT.yaml 是给机器读的
// 完整契约（宜全）。下面验证：①MAP 逐文件/整体裁剪并引导到 CONTEXT；②CONTEXT 始终完整、
// 不受档位影响；③KHY_META_DETAIL 档位接线 + 单项 env 覆盖优先；④档位纯渲染、不动指纹。
describe('projectMetadataService — 详略得当 detail calibration', () => {
  let tmp;
  const SAVED = {};
  const ENV_KEYS = [
    'KHY_META_DETAIL', 'KHY_META_MAP_SYMBOL_FILES', 'KHY_META_MAP_SYMBOLS_PER_FILE',
    'KHY_META_TREE_SUBDIRS', 'KHY_META_TREE_ROOT_FILES',
  ];
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-meta-detail-'));
    for (const k of ENV_KEYS) { SAVED[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    for (const k of ENV_KEYS) {
      if (SAVED[k] === undefined) delete process.env[k];
      else process.env[k] = SAVED[k];
    }
  });

  test('KHY_META_DETAIL selects a profile; garbage falls back to standard', () => {
    process.env.KHY_META_DETAIL = 'brief';
    let L = svc._internal.LIMITS();
    assert.equal(L.mapSymbolFiles, 24);
    assert.equal(L.mapSymbolsPerFile, 6);
    assert.equal(L.treeSubDirs, 8);
    assert.equal(L.treeRootFiles, 12);

    process.env.KHY_META_DETAIL = 'full';
    L = svc._internal.LIMITS();
    assert.equal(L.mapSymbolFiles, 800);
    assert.equal(L.mapSymbolsPerFile, 200);

    process.env.KHY_META_DETAIL = 'not-a-level';
    L = svc._internal.LIMITS();
    assert.equal(L.mapSymbolFiles, 48); // standard
    assert.equal(L.mapSymbolsPerFile, 10);
  });

  test('an explicit single-knob env overrides the profile (zero hardcode)', () => {
    process.env.KHY_META_DETAIL = 'brief';
    process.env.KHY_META_MAP_SYMBOLS_PER_FILE = '99';
    const L = svc._internal.LIMITS();
    assert.equal(L.mapSymbolsPerFile, 99); // override wins
    assert.equal(L.mapSymbolFiles, 24);    // profile still applies to the rest
  });

  test('MAP truncates per-file symbols with …(+N) while CONTEXT keeps the full list', async () => {
    process.env.KHY_META_MAP_SYMBOLS_PER_FILE = '3';
    write(tmp, 'package.json', JSON.stringify({ name: 'teaser', main: 'index.js' }));
    const fns = Array.from({ length: 10 }, (_, i) => `function fn${i}(){}`).join('\n');
    write(tmp, 'index.js', fns);

    const res = await svc.generateProjectMetadata(tmp);
    assert.equal(res.generated, true, res.reason);

    const map = fs.readFileSync(path.join(tmp, '.ai/MAP.md'), 'utf8');
    assert.match(map, /…\(\+7\)/, 'MAP should show a +N overflow marker');
    assert.ok(!map.includes('fn9'), 'MAP teaser must not list the truncated tail symbol');
    assert.match(map, /CONTEXT\.yaml/, 'MAP should point to CONTEXT.yaml for the full list');

    const ctx = fs.readFileSync(path.join(tmp, '.ai/CONTEXT.yaml'), 'utf8');
    assert.match(ctx, /fn0/);
    assert.match(ctx, /fn9/, 'CONTEXT must carry the complete symbol list');
    assert.ok(!ctx.includes('…(+'), 'CONTEXT must never truncate symbols');
  });

  test('MAP caps the number of files shown and defers the rest to CONTEXT.yaml', async () => {
    process.env.KHY_META_MAP_SYMBOL_FILES = '2';
    write(tmp, 'package.json', JSON.stringify({ name: 'manyfiles' }));
    for (const n of ['alpha', 'bravo', 'charlie', 'delta']) {
      write(tmp, `${n}.js`, `function ${n}Sym(){}`);
    }

    const res = await svc.generateProjectMetadata(tmp);
    assert.equal(res.generated, true, res.reason);

    const map = fs.readFileSync(path.join(tmp, '.ai/MAP.md'), 'utf8');
    assert.match(map, /其余 2 个文件的符号见 `CONTEXT\.yaml`/);

    const ctx = fs.readFileSync(path.join(tmp, '.ai/CONTEXT.yaml'), 'utf8');
    for (const n of ['alpha', 'bravo', 'charlie', 'delta']) {
      assert.match(ctx, new RegExp(`${n}\\.js`), `CONTEXT must list every file (${n})`);
    }
  });

  test('detail level is render-only: it never changes the fingerprint', () => {
    write(tmp, 'package.json', JSON.stringify({ name: 'fp', main: 'index.js' }));
    write(tmp, 'index.js', Array.from({ length: 12 }, (_, i) => `function g${i}(){}`).join('\n'));

    process.env.KHY_META_DETAIL = 'brief';
    const brief = svc._internal._collectContext(tmp, svc._internal.LIMITS());
    const fpBrief = svc._internal._computeFingerprint(brief.ctx);

    process.env.KHY_META_DETAIL = 'full';
    const full = svc._internal._collectContext(tmp, svc._internal.LIMITS());
    const fpFull = svc._internal._computeFingerprint(full.ctx);

    assert.equal(fpBrief, fpFull, 'detail profile must not perturb the structural fingerprint');
  });
});
