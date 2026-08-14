'use strict';

// docsFreshnessRunner 薄壳测试(node:test)。
// 用注入的 gitSoft 避免真 git;验证:变更收集/来源过滤、warn-only 默认、门控关短路、fail-soft。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runner = require('../../src/services/docsFreshness/docsFreshnessRunner');

test('_isSourceRel:源码扩展命中,docs/.ai 排除', () => {
  assert.strictEqual(runner._isSourceRel('services/backend/src/x.js'), true);
  assert.strictEqual(runner._isSourceRel('kernel/src/sched.c'), true);
  assert.strictEqual(runner._isSourceRel('scripts/y.sh'), true);
  assert.strictEqual(runner._isSourceRel('docs/A.md'), false);       // docs 排除
  assert.strictEqual(runner._isSourceRel('.ai/CONTEXT.yaml'), false); // .ai 排除
  assert.strictEqual(runner._isSourceRel('README.md'), false);       // 非源码扩展
  assert.strictEqual(runner._isSourceRel(''), false);
});

test('collectChangedSources:注入 gitSoft,过滤非源码/去重', () => {
  const fakeGit = (args) => {
    // staged name-only
    if (args.includes('--cached')) {
      return { ok: true, out: 'services/backend/src/a.js\ndocs/skip.md\nservices/backend/src/a.js' };
    }
    return { ok: true, out: 'frontend/App.vue\nREADME.md' };
  };
  const staged = runner.collectChangedSources('/repo', { staged: true, gitSoft: fakeGit });
  assert.deepStrictEqual(staged, ['services/backend/src/a.js']); // 去重 + docs 过滤

  const working = runner.collectChangedSources('/repo', { staged: false, gitSoft: fakeGit });
  // working 跑两次(diff + diff --cached),合并去重。App.vue 是源码,README.md 非。
  assert.ok(working.includes('frontend/App.vue'));
  assert.ok(!working.includes('README.md'));
});

test('collectChangedSources:git 失败 → 空,不抛', () => {
  const failGit = () => ({ ok: false, out: '', err: 'boom' });
  assert.deepStrictEqual(runner.collectChangedSources('/repo', { gitSoft: failGit }), []);
});

test('runDocsFreshness:门控关 → ran:false(byte-fallback no-op)', () => {
  const r = runner.runDocsFreshness('/nonexistent', { env: { KHY_DOCS_FRESHNESS: '0' }, gitSoft: () => ({ ok: true, out: '' }) });
  assert.strictEqual(r.ran, false);
  assert.deepStrictEqual(r.suspects, []);
  assert.strictEqual(r.warnOnly, true);
});

test('runDocsFreshness:warn-only 默认(无 fix → 无产物/标记动作)', (t) => {
  // 造一个临时仓库树:docs/A.md 引用 services/backend/src/target.js。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-docsfresh-'));
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });
  fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'docs', 'A.md'),
    '# A\n真源 `services/backend/src/target.js`。\n',
    'utf-8',
  );
  const fakeGit = (args) => {
    if (args.includes('--name-only')) return { ok: true, out: 'services/backend/src/target.js' };
    return { ok: true, out: '' };
  };
  const r = runner.runDocsFreshness(tmp, { staged: true, gitSoft: fakeGit });
  assert.strictEqual(r.ran, true);
  assert.strictEqual(r.suspects.length, 1);
  assert.strictEqual(r.suspects[0].doc, 'docs/A.md');
  assert.strictEqual(r.suspects[0].confidence, 'exact');
  // warn-only:未 fix → 无写动作。
  assert.deepStrictEqual(r.productActions, []);
  assert.deepStrictEqual(r.markerActions, []);
  assert.deepStrictEqual(r.restaged, []);
});

test('loadDocRecords:读 docs/**.md,跳过非 md,不抛', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-docsload-'));
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });
  fs.mkdirSync(path.join(tmp, 'docs', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'docs', 'X.md'), 'x', 'utf-8');
  fs.writeFileSync(path.join(tmp, 'docs', 'sub', 'Y.md'), 'y', 'utf-8');
  fs.writeFileSync(path.join(tmp, 'docs', 'Z.txt'), 'z', 'utf-8');
  const recs = runner.loadDocRecords(tmp);
  const paths = recs.map((r) => r.path).sort();
  assert.deepStrictEqual(paths, ['docs/X.md', 'docs/sub/Y.md']);
  // 无 docs 目录 → 空,不抛。
  assert.deepStrictEqual(runner.loadDocRecords(path.join(tmp, 'nope')), []);
});
