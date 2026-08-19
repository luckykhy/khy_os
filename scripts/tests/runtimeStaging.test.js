'use strict';

/**
 * runtimeStaging.test.js — 分发 runtime 组装的验收。
 *
 * 这条路径挂在 npm 的 prepack 和 pip 的构建脚本上，所以它失败的时候，失败的是
 * **发布**。因此这里盯的不是「成功时对不对」，而是**每一种失败方式下旧产物还在不在**：
 * 原实现是 `rmSync(bundled)` 然后 `copyFileSync`，拷贝一旦失败就同时没有新的和旧的。
 */

const assert = require('assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { assembleRuntime } = require('../release/lib/runtimeStaging');

const NL = String.fromCharCode(10);

/** 每个用例一个临时根，互不干扰。 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-runtime-staging-'));
  const srcDir = path.join(root, 'dist');
  const bundledDir = path.join(root, 'pkg', 'bundled');
  fs.mkdirSync(srcDir, { recursive: true });
  const src = path.join(srcDir, 'bundle.mjs');
  fs.writeFileSync(src, `export const x = 1;${NL}`, 'utf-8');
  return { root, src, bundledDir };
}

/** 放一份「上一次成功组装」的产物，用来验证失败路径没碰它。 */
function seedPrevious(bundledDir) {
  const previous = path.join(bundledDir, 'runtime', 'khy', 'bundle.mjs');
  fs.mkdirSync(path.dirname(previous), { recursive: true });
  fs.writeFileSync(previous, `PREVIOUS GOOD BUILD${NL}`, 'utf-8');
  return previous;
}

function spec(fx, extra = {}) {
  return {
    label: 'test:assemble',
    bundledDir: fx.bundledDir,
    root: fx.root,
    entries: [{ from: fx.src, to: 'runtime/khy/bundle.mjs' }],
    ...extra,
  };
}

/** 组装留下的临时目录数量。成功或失败后都必须是 0。 */
function leftovers(bundledDir) {
  const parent = path.dirname(bundledDir);
  const base = path.basename(bundledDir);
  let names;
  try {
    names = fs.readdirSync(parent);
  } catch {
    return [];
  }
  return names.filter((n) => n.startsWith(base + '.'));
}

test('组装成功：文件落位、旧产物被替换、不留临时目录', () => {
  const fx = fixture();
  seedPrevious(fx.bundledDir);

  const result = assembleRuntime(spec(fx));

  const landed = path.join(fx.bundledDir, 'runtime', 'khy', 'bundle.mjs');
  assert.equal(fs.readFileSync(landed, 'utf-8'), fs.readFileSync(fx.src, 'utf-8'));
  assert.deepEqual(result.files, ['runtime/khy/bundle.mjs']);
  assert.equal(result.checked, 1);
  assert.deepEqual(leftovers(fx.bundledDir), [], '.staging-/.old- 都必须清掉');
});

test('目标目录原本不存在也能组装 —— clean checkout 上的第一次构建', () => {
  const fx = fixture();
  assert.equal(fs.existsSync(fx.bundledDir), false);

  assembleRuntime(spec(fx));

  assert.ok(fs.existsSync(path.join(fx.bundledDir, 'runtime', 'khy', 'bundle.mjs')));
  assert.deepEqual(leftovers(fx.bundledDir), []);
});

test('源文件不存在：抛错，且上一份产物一个字节都没动', () => {
  const fx = fixture();
  const previous = seedPrevious(fx.bundledDir);
  const before = fs.readFileSync(previous, 'utf-8');
  fs.rmSync(fx.src);

  assert.throws(() => assembleRuntime(spec(fx)), /源文件不存在/);

  // 这正是原实现的缺陷:它先 rmSync(bundled) 再拷,源没了就两头空。
  assert.equal(fs.readFileSync(previous, 'utf-8'), before, '旧产物必须原样留着');
  assert.deepEqual(leftovers(fx.bundledDir), []);
});

test('源文件为空:抛错而不是发一个 0 字节的 runtime', () => {
  const fx = fixture();
  const previous = seedPrevious(fx.bundledDir);
  fs.writeFileSync(fx.src, '', 'utf-8');

  assert.throws(() => assembleRuntime(spec(fx)), /为空或不是普通文件/);
  assert.ok(fs.existsSync(previous));
});

test('组装出的 runtime 里有 .map:拒绝换入,旧产物保留', () => {
  const fx = fixture();
  const previous = seedPrevious(fx.bundledDir);
  const before = fs.readFileSync(previous, 'utf-8');
  const map = path.join(path.dirname(fx.src), 'bundle.mjs.map');
  fs.writeFileSync(map, '{"version":3}', 'utf-8');

  // 「有人把 copyFileSync 改成了 copyTree」的等价形态 —— khy 那份 map 有 66.9 MB,
  // 而且带着全部源码。audit-purity.js 的禁品清单里没有 *.map,拦不住它。
  assert.throws(
    () => assembleRuntime(spec(fx, {
      entries: [
        { from: fx.src, to: 'runtime/khy/bundle.mjs' },
        { from: map, to: 'runtime/khy/bundle.mjs.map' },
      ],
    })),
    /拒绝换入/
  );

  assert.equal(fs.readFileSync(previous, 'utf-8'), before);
  assert.deepEqual(leftovers(fx.bundledDir), [], '被拒绝的 staging 必须清干净');
});

test('bundle 末尾指向不存在的 .map:同样拒绝换入', () => {
  const fx = fixture();
  fs.writeFileSync(fx.src, `export const x = 1;${NL}//# sourceMappingURL=bundle.mjs.map${NL}`, 'utf-8');

  assert.throws(() => assembleRuntime(spec(fx)), /拒绝换入|末尾仍指向/);
  assert.deepEqual(leftovers(fx.bundledDir), []);
});

test('上次崩溃留下的同名 staging 残渣被清掉,不被当成本次内容', () => {
  const fx = fixture();
  const stale = `${fx.bundledDir}.staging-${process.pid}`;
  fs.mkdirSync(path.join(stale, 'runtime', 'khy'), { recursive: true });
  fs.writeFileSync(path.join(stale, 'runtime', 'khy', 'ghost.mjs'), 'stale', 'utf-8');

  assembleRuntime(spec(fx));

  assert.equal(
    fs.existsSync(path.join(fx.bundledDir, 'runtime', 'khy', 'ghost.mjs')),
    false,
    '残渣文件绝不能被换进产物'
  );
  assert.ok(fs.existsSync(path.join(fx.bundledDir, 'runtime', 'khy', 'bundle.mjs')));
});

test('参数不全时立刻拒绝,不去碰任何目录', () => {
  const fx = fixture();
  const previous = seedPrevious(fx.bundledDir);

  assert.throws(() => assembleRuntime({ label: 't', bundledDir: '', entries: [{ from: fx.src, to: 'a' }] }), /bundledDir/);
  assert.throws(() => assembleRuntime({ label: 't', bundledDir: fx.bundledDir, entries: [] }), /没有要组装的条目/);
  assert.ok(fs.existsSync(previous));
});
