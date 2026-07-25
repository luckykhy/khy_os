'use strict';

/**
 * fileSalience.test.js — 文件列举「抓重点」纯叶子(node:test)。
 *
 * 背景(goal 2026-07-03「分析压缩包/文件夹/盘符时文件太多抓不住重点」):三类列举路径按原始序 /
 * mtime 盲截 N 条,重要文件被淹没。fileSalience 在截断前插入 query-free 内在重要性重排 + 分组摘要。
 *
 * 本测证:① scoreFile 权重次序(入口/manifest/README > 普通文件 > node_modules/lock/min.js);
 * ② summarizeListing 在大列表上 pinned 抓住关键文件、byDir/byExt 计数正确、largest 按 size、hidden 精确;
 * ③ 门控 off → 逐字节复现旧原序 slice(load-bearing);④ 坏输入绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert');

const S = require('../src/services/fileSalience');

// ── 门控 ──────────────────────────────────────────────────────────────────────
test('isEnabled 默认开;仅 falsy 关', () => {
  assert.strictEqual(S.isEnabled({}), true);
  for (const v of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(S.isEnabled({ KHY_FILE_SALIENCE: v }), false, v);
  }
  for (const v of ['1', 'true', 'on', 'whatever']) {
    assert.strictEqual(S.isEnabled({ KHY_FILE_SALIENCE: v }), true, v);
  }
});

// ── scoreFile:内在重要性权重次序 ─────────────────────────────────────────────
test('scoreFile:入口 / manifest / README 高分,浅层加分', () => {
  const entry = S.scoreFile({ name: 'src/index.js', size: 100 });
  const manifest = S.scoreFile({ name: 'package.json', size: 100 });
  const readme = S.scoreFile({ name: 'README.md', size: 100 });
  const config = S.scoreFile({ name: 'app.config.yaml', size: 100 });
  const plain = S.scoreFile({ name: 'src/lib/deep/util/helper.js', size: 100 });

  assert.ok(entry.score > plain.score, 'index.js > 深层普通文件');
  assert.ok(manifest.score > plain.score, 'package.json > 普通');
  assert.ok(readme.score > plain.score, 'README > 普通');
  assert.ok(config.score > plain.score, 'config > 普通');
  assert.ok(entry.reasons.includes('entry-point'));
  assert.ok(manifest.reasons.includes('manifest'));
  assert.ok(readme.reasons.includes('readme/license'));
});

test('scoreFile:噪声(node_modules / lockfile / min.js / .map)负分,低于普通文件', () => {
  const plain = S.scoreFile({ name: 'src/foo.js', size: 100 });
  const nm = S.scoreFile({ name: 'node_modules/lodash/fp/curry.js', size: 100 });
  const lock = S.scoreFile({ name: 'package-lock.json', size: 100 });
  const min = S.scoreFile({ name: 'dist/bundle.min.js', size: 100 });
  const map = S.scoreFile({ name: 'dist/bundle.js.map', size: 100 });

  assert.ok(nm.score < plain.score, 'node_modules 降权');
  assert.ok(lock.score < plain.score, 'lockfile 降权');
  assert.ok(min.score < plain.score, 'minified 降权');
  assert.ok(map.score < plain.score, 'sourcemap 降权');
  // node_modules 里的 index.js 即便命中 entry-point,skip-dir 负权也应压过真正的根入口
  // (skip-dir −8 让它绝不能与根 index.js 争「关键文件」)。
  const nmEntry = S.scoreFile({ name: 'node_modules/foo/index.js', size: 100 });
  const rootEntry = S.scoreFile({ name: 'index.js', size: 100 });
  assert.ok(nmEntry.score < rootEntry.score, 'node_modules 内的 index.js 远低于根 index.js');
});

// ── summarizeListing ─────────────────────────────────────────────────────────
test('summarizeListing:大列表 → pinned 抓住关键文件 + 分组计数 + largest + hidden', () => {
  const entries = [
    { name: 'README.md', size: 1200 },
    { name: 'package.json', size: 800 },
    { name: 'src/index.js', size: 400 },
    { name: 'node_modules/x/i.js', size: 999999 },
    { name: 'dist/b.min.js', size: 500000 },
  ];
  for (let i = 0; i < 150; i += 1) entries.push({ name: `src/mod/f${i}.js`, size: 100 + i });
  for (let i = 0; i < 40; i += 1) entries.push({ name: `tests/t${i}.test.js`, size: 50 });

  const sum = S.summarizeListing(entries, { env: {}, total: entries.length });
  assert.strictEqual(sum.enabled, true);
  const pinnedPaths = sum.pinned.map(p => p.path);
  assert.ok(pinnedPaths.includes('package.json'), 'package.json 应 pinned');
  assert.ok(pinnedPaths.includes('README.md'), 'README 应 pinned');
  assert.ok(pinnedPaths.includes('src/index.js'), 'index.js 应 pinned');
  // 噪声不该进 pinned。
  assert.ok(!pinnedPaths.some(p => p.includes('node_modules')), 'node_modules 不进 pinned');
  assert.ok(!pinnedPaths.some(p => p.endsWith('.min.js')), 'min.js 不进 pinned');

  // 分组计数:.js 家族最多;src 目录最多。
  const jsGroup = sum.byExt.find(g => g.key === '.js');
  assert.ok(jsGroup && jsGroup.count >= 150);
  const srcGroup = sum.byDir.find(g => g.key === 'src');
  assert.ok(srcGroup && srcGroup.count >= 150);

  // largest 首位是最大的 node_modules 文件(诚实:largest 是「按大小」,与 pinned「按重要性」独立)。
  assert.strictEqual(sum.largest[0].path, 'node_modules/x/i.js');

  // total===list.length 时 hidden=0;total 更大时 hidden 精确。
  assert.strictEqual(sum.hidden, 0);
  const sum2 = S.summarizeListing(entries, { env: {}, total: entries.length + 500 });
  assert.strictEqual(sum2.hidden, 500);
});

test('summarizeListing:门控 off → 退化形(pinned 空、原序 slice)—— load-bearing', () => {
  const entries = Array.from({ length: 100 }, (_, i) => ({ name: `f${i}.js`, size: 1 }));
  const off = S.summarizeListing(entries, { env: { KHY_FILE_SALIENCE: 'off' }, total: 100, fallbackShown: 40 });
  assert.strictEqual(off.enabled, false);
  assert.strictEqual(off.pinned.length, 0);
  assert.strictEqual(off.fallbackList.length, 40, '原序取前 40(逐字节回退旧 slice)');
  assert.strictEqual(off.fallbackList[0].name, 'f0.js', '原序保持,不重排');
  assert.strictEqual(off.hidden, 60);
  // renderSalienceBlock 对退化形返 ''(调用方逐字节回退旧清单)。
  assert.strictEqual(S.renderSalienceBlock(off, { env: {} }), '');
});

test('renderSalienceBlock:含关键文件 / 目录分布 / 类型分布 / 最大文件段', () => {
  const entries = [
    { name: 'README.md', size: 1000 },
    { name: 'src/index.js', size: 500 },
    { name: 'src/a.js', size: 200 },
    { name: 'tests/b.test.js', size: 100 },
  ];
  const block = S.renderSalienceBlock(S.summarizeListing(entries, { env: {}, total: 4 }), { env: {} });
  assert.ok(block.includes('关键文件'));
  assert.ok(block.includes('README.md'));
  assert.ok(block.includes('目录分布'));
  assert.ok(block.includes('类型分布'));
  assert.ok(block.includes('最大文件'));
});

// ── 目录体积热点(接缝3:深树 rollup)─────────────────────────────────────────
test('dirHotspots:按目录聚合 count+totalSize,受 maxDirDepth rollup', () => {
  const entries = [];
  // 深树:C/Users/me/AppData/Local/big/ 下大量大文件;C/Users/me/docs/ 下少量小文件。
  for (let i = 0; i < 20; i += 1) entries.push({ path: `C/Users/me/AppData/Local/big/f${i}.dat`, size: 10 * 1024 * 1024 });
  for (let i = 0; i < 3; i += 1) entries.push({ path: `D/data/docs/deep/n${i}.txt`, size: 100 });
  const sum = S.summarizeListing(entries, { env: {}, maxDirDepth: 3 });
  assert.ok(Array.isArray(sum.dirHotspots) && sum.dirHotspots.length >= 2, 'dirHotspots 有多个桶');
  const top = sum.dirHotspots[0];
  // maxDirDepth=3 → 深路径 rollup 到前 3 段 C/Users/me。体积热点是该聚合桶。
  assert.ok(top.totalSize > 0, '热点有体积');
  assert.ok(top.count >= 20, `热点聚合了大量文件 (got ${top.count})`);
  const block = S.renderSalienceBlock(sum, { env: {} });
  assert.ok(block.includes('目录体积热点'), '渲染含目录体积热点段');
});

test('dirHotspots:门控 KHY_DIR_HOTSPOTS off → [](字节回退,不渲染新段)', () => {
  const entries = [];
  for (let i = 0; i < 20; i += 1) entries.push({ path: `a/b/c/d/f${i}.dat`, size: 1024 });
  const sum = S.summarizeListing(entries, { env: { KHY_DIR_HOTSPOTS: 'off' } });
  assert.deepStrictEqual(sum.dirHotspots, []);
  const block = S.renderSalienceBlock(sum, { env: { KHY_DIR_HOTSPOTS: 'off' } });
  assert.ok(!block.includes('目录体积热点'), 'off → 不渲染目录体积热点段');
});

// ── fail-soft:坏输入绝不抛 ────────────────────────────────────────────────────
test('坏输入绝不抛', () => {
  assert.doesNotThrow(() => S.summarizeListing(null, {}));
  assert.doesNotThrow(() => S.summarizeListing(undefined));
  assert.doesNotThrow(() => S.summarizeListing('not-an-array', {}));
  assert.doesNotThrow(() => S.summarizeListing([{ /* 无 name/size */ }, null, 42], {}));
  assert.doesNotThrow(() => S.scoreFile(null));
  assert.doesNotThrow(() => S.scoreFile({}));
  assert.doesNotThrow(() => S.renderSalienceBlock(null));
  assert.doesNotThrow(() => S.renderSalienceBlock({ enabled: true }));
});
