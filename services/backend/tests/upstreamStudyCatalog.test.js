'use strict';

/**
 * upstreamStudyCatalog 测试 —— 纯叶子:精华/糟粕分类、打分、参考项目识别、阈值。
 * 门控 KHY_UPSTREAM_STUDY_CATALOG。零 IO、确定性、绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert');

const cat = require('../src/services/upstreamStudyCatalog');

const ON = { KHY_UPSTREAM_STUDY_CATALOG: '1' };

test('classifyEntry:精华桶(changelog/source/test/doc/config)', () => {
  assert.strictEqual(cat.classifyEntry({ path: 'proj/CHANGELOG.md', size: 100 }, ON).bucket, 'changelog');
  assert.strictEqual(cat.classifyEntry({ path: 'proj/HISTORY', size: 100 }, ON).bucket, 'changelog');
  assert.strictEqual(cat.classifyEntry({ path: 'proj/src/app.rs', size: 100 }, ON).bucket, 'source');
  assert.strictEqual(cat.classifyEntry({ path: 'proj/src/main.py', size: 100 }, ON).bucket, 'source');
  assert.strictEqual(cat.classifyEntry({ path: 'proj/tests/foo_test.go', size: 100 }, ON).bucket, 'test');
  assert.strictEqual(cat.classifyEntry({ path: 'proj/foo.spec.ts', size: 100 }, ON).bucket, 'test');
  assert.strictEqual(cat.classifyEntry({ path: 'proj/README.md', size: 100 }, ON).bucket, 'doc');
  assert.strictEqual(cat.classifyEntry({ path: 'proj/package.json', size: 100 }, ON).bucket, 'config');
  for (const p of ['proj/CHANGELOG.md', 'proj/src/app.rs', 'proj/README.md']) {
    assert.strictEqual(cat.classifyEntry({ path: p, size: 100 }, ON).verdict, 'essence');
  }
});

test('classifyEntry:糟粕桶(vendored/lockfile/minified/binary/secret/os-junk/oversized)', () => {
  assert.strictEqual(cat.classifyEntry({ path: 'proj/node_modules/x/index.js', size: 100 }, ON).bucket, 'vendored');
  assert.strictEqual(cat.classifyEntry({ path: 'proj/dist/app.js', size: 100 }, ON).bucket, 'vendored');
  assert.strictEqual(cat.classifyEntry({ path: 'proj/target/debug/app', size: 100 }, ON).bucket, 'vendored');
  assert.strictEqual(cat.classifyEntry({ path: 'proj/yarn.lock', size: 100 }, ON).bucket, 'lockfile');
  assert.strictEqual(cat.classifyEntry({ path: 'proj/Cargo.lock', size: 100 }, ON).bucket, 'lockfile');
  assert.strictEqual(cat.classifyEntry({ path: 'proj/a.min.js', size: 100 }, ON).bucket, 'minified');
  assert.strictEqual(cat.classifyEntry({ path: 'proj/x.map', size: 100 }, ON).bucket, 'minified');
  assert.strictEqual(cat.classifyEntry({ path: 'proj/logo.png', size: 100 }, ON).bucket, 'binary');
  assert.strictEqual(cat.classifyEntry({ path: 'proj/app.wasm', size: 100 }, ON).bucket, 'binary');
  assert.strictEqual(cat.classifyEntry({ path: 'proj/.env', size: 100 }, ON).bucket, 'secret');
  assert.strictEqual(cat.classifyEntry({ path: 'proj/server.pem', size: 100 }, ON).bucket, 'secret');
  assert.strictEqual(cat.classifyEntry({ path: 'proj/.DS_Store', size: 100 }, ON).bucket, 'os-junk');
  // oversized:超 BLOB 阈值(默认 5MB)的源码扩展名也归糟粕
  assert.strictEqual(cat.classifyEntry({ path: 'proj/src/gen.js', size: 10 * 1024 * 1024 }, ON).bucket, 'oversized');
  for (const p of ['proj/node_modules/x.js', 'proj/.env', 'proj/logo.png']) {
    assert.strictEqual(cat.classifyEntry({ path: p, size: 100 }, ON).verdict, 'dross');
  }
});

test('classifyEntry:糟粕优先于精华(node_modules 内的 .js 仍是 vendored)', () => {
  const c = cat.classifyEntry({ path: 'proj/node_modules/lodash/index.js', size: 100 }, ON);
  assert.strictEqual(c.verdict, 'dross');
  assert.strictEqual(c.bucket, 'vendored');
});

test('classifyEntry:tooLarge 标记(精华但超可读上限, 默认 256KB)', () => {
  const c = cat.classifyEntry({ path: 'proj/src/big.js', size: 300 * 1024 }, ON);
  assert.strictEqual(c.verdict, 'essence');
  assert.strictEqual(c.tooLarge, true);
  const small = cat.classifyEntry({ path: 'proj/src/small.js', size: 1000 }, ON);
  assert.strictEqual(small.tooLarge, false);
});

test('classifyEntry:门关 ⇒ 恒 neutral(逐字节回退)', () => {
  for (const v of ['0', 'false', 'off', 'no']) {
    const c = cat.classifyEntry({ path: 'proj/src/app.rs', size: 100 }, { KHY_UPSTREAM_STUDY_CATALOG: v });
    assert.strictEqual(c.verdict, 'neutral');
    assert.strictEqual(c.bucket, '');
  }
});

test('classifyEntry:坏输入不抛,返回 neutral', () => {
  for (const bad of [null, undefined, {}, { path: '' }, { path: 123 }, 'str']) {
    assert.doesNotThrow(() => cat.classifyEntry(bad, ON));
    assert.strictEqual(cat.classifyEntry(bad, ON).verdict, 'neutral');
  }
});

test('scoreEssence:changelog>source>test>doc>config;改动>新增;过大扣分', () => {
  const mk = (bucket, tooLarge) => ({ path: 'proj/x', bucket, tooLarge });
  const s = (bucket, diff, tooLarge) => cat.scoreEssence(mk(bucket, tooLarge), diff || {}, ON);
  assert.ok(s('changelog') > s('source'));
  assert.ok(s('source') > s('test'));
  assert.ok(s('test') > s('doc'));
  assert.ok(s('doc') > s('config'));
  // 改动 > 新增 > 无
  assert.ok(s('source', { isChanged: true }) > s('source', { isNew: true }));
  assert.ok(s('source', { isNew: true }) > s('source', {}));
  // 过大扣分
  assert.ok(s('source', {}, true) < s('source', {}, false));
  // 门关 ⇒ 0
  assert.strictEqual(cat.scoreEssence(mk('source'), {}, { KHY_UPSTREAM_STUDY_CATALOG: '0' }), 0);
});

test('recognizeProject:命中已知参考项目 marker → 点名 + 指向档', () => {
  const entries = [{ path: 'DeepSeek-TUI-main/src/app.rs' }];
  const r = cat.recognizeProject(entries, 'DeepSeek-TUI-main.zip', ON);
  assert.ok(r);
  assert.strictEqual(r.id, 'deepseek-tui');
  assert.ok(r.doc.includes('OPS-MAN-016'));
  // 未命中 → null
  assert.strictEqual(cat.recognizeProject([{ path: 'unknown-lib/x.js' }], 'unknown.zip', ON), null);
  // 门关 → null
  assert.strictEqual(cat.recognizeProject(entries, 'DeepSeek-TUI-main.zip', { KHY_UPSTREAM_STUDY_CATALOG: '0' }), null);
});

test('resolveTop / resolveMaxReadableBytes / resolveBlobBytes:默认与 env 覆盖', () => {
  assert.strictEqual(cat.resolveTop(ON), 25);
  assert.strictEqual(cat.resolveTop({ ...ON, KHY_UPSTREAM_STUDY_TOP: '10' }), 10);
  assert.strictEqual(cat.resolveMaxReadableBytes(ON), 256 * 1024);
  assert.strictEqual(cat.resolveBlobBytes(ON), 5 * 1024 * 1024);
  assert.strictEqual(cat.resolveBlobBytes({ ...ON, KHY_UPSTREAM_STUDY_BLOB_MB: '2' }), 2 * 1024 * 1024);
});

test('常量冻结(纯叶子不可变)', () => {
  assert.ok(Object.isFrozen(cat.KNOWN_REFERENCES));
  for (const ref of cat.KNOWN_REFERENCES) assert.ok(Object.isFrozen(ref));
  assert.ok(Object.isFrozen(cat.BUCKET_BASE));
});
