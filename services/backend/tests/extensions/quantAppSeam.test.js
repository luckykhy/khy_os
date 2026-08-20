'use strict';

/**
 * quantApp seam 契约测试 —— [DESIGN-ARCH-069] §2.2/§3.4 的机器化。
 *
 * 这个 seam 存在的唯一理由是把「核点名 software/khyquant 这个磁盘位置」换成
 * 「核点名 quant-app 这个服务」。所以要测的不是「能 require 到东西」，而是三件
 * 会在 Phase 1 搬目录时真正决定成败的事：
 *   1. 有人用 provides 声明了这个服务 → 走契约，**不看** L4 现址；
 *   2. 没人声明 → 落到迁移期兜底，行为与迁移前一致（Phase 0 是纯重构）；
 *   3. 「未安装」与「装了但坏了」是两档，不能都被吞成 null。
 *
 * 第 3 条是本文件的重点。通用解析点 providerModule.requireFromProvider 把两者都
 * 吞成 null，那会让一个路由模块里的真 bug 从启动期大声崩退化成静默 404。下面
 * 「模块存在但加载抛错 → 照抛」那一例就是钉住这个区别的。
 *
 * **每个用例起一个子进程**：seam 有目录解析缓存、require 有模块缓存，而
 * KHY_EXTENSION_PATH 只在模块加载时读一次。同进程内连着测两种根，测到的是缓存
 * 行为不是契约行为。
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const BACKEND = path.resolve(__dirname, '..', '..');
const REPO = path.resolve(BACKEND, '..', '..');
const L4_DIR = path.join(REPO, 'software', 'khyquant');
const SEAM = path.join(BACKEND, 'src', 'services', 'extensions', 'quantApp.js');
const tempDirs = [];

/** 子进程里加载 seam 的前缀，各用例的脚本都拼在它后面。 */
const Q = "const q=require('./src/services/extensions/quantApp');";

after(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** 一个空的拓展根：用来证明「没人声明 quant-app」时的兜底行为。 */
function emptyRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-quant-none-'));
  tempDirs.push(root);
  return root;
}

/**
 * 造一个声明了 `provides: ['quant-app']` 的假量化应用。
 * 里面放三种模块，正好对应三档结果：能加载 / 不存在 / 加载即抛。
 */
function makeQuantRoot({ id = 'khy-quant-fixture', provides = ['quant-app'], category = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-quant-'));
  tempDirs.push(root);
  const dir = category ? path.join(root, ...category.split('/'), id) : path.join(root, id);
  fs.mkdirSync(path.join(dir, 'routes'), { recursive: true });

  fs.writeFileSync(
    path.join(dir, 'khy.extension.json'),
    JSON.stringify({
      id, name: id, version: '1.0.0', kind: 'runtime', main: 'index.js',
      capabilities: [], provides,
    }, null, 2),
    'utf8'
  );
  fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = {};\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'routes', 'ok.js'), "module.exports = { tag: 'fixture-ok' };\n", 'utf8');
  fs.writeFileSync(
    path.join(dir, 'routes', 'boom.js'),
    "throw new Error('fixture module body exploded');\n",
    'utf8'
  );
  return { root, dir };
}

/** 在子进程里对 seam 提问，返回它最后一行打印的 JSON。 */
function ask(root, script, extraEnv = {}) {
  const res = cp.spawnSync(process.execPath, ['-e', Q + script], {
    cwd: BACKEND,
    encoding: 'utf8',
    env: { ...process.env, KHY_EXTENSION_PATH: root, KHY_APP_ROOT: REPO, ...extraEnv },
  });
  if (res.status !== 0) {
    throw new Error('子进程退出 ' + res.status + ':\n' + res.stdout + '\n' + res.stderr);
  }
  return JSON.parse(res.stdout.trim().split('\n').pop());
}

/** 同上，但**期待**子进程失败，返回 stderr 给调用方断言错误内容。 */
function askExpectThrow(root, script, extraEnv = {}) {
  const res = cp.spawnSync(process.execPath, ['-e', Q + script], {
    cwd: BACKEND,
    encoding: 'utf8',
    env: { ...process.env, KHY_EXTENSION_PATH: root, KHY_APP_ROOT: REPO, ...extraEnv },
  });
  assert.notEqual(res.status, 0, '本例的全部意义在于它必须抛出来，而不是被吞成 null');
  return res.stderr;
}

describe('quantApp seam：核点名服务，不点名位置', () => {
  test('有人 provides 了 quant-app → 解析到那个拓展，而不是 L4 现址', () => {
    const { root, dir } = makeQuantRoot();
    const out = ask(root, 'console.log(JSON.stringify({dir:q.resolveDir()}))');
    assert.equal(out.dir, dir, 'provides 声明必须胜过迁移期兜底，否则 Phase 1 搬完目录仍会读旧址');
    assert.notEqual(out.dir, L4_DIR);
  });

  test('声明的是别的服务名 → 不认领；服务名不是模糊匹配', () => {
    const { root } = makeQuantRoot({ provides: ['quant-something-else'] });
    const out = ask(root, 'console.log(JSON.stringify({dir:q.resolveDir()}))');
    assert.equal(out.dir, L4_DIR, '没人声明 quant-app，就该落到兜底而不是抓一个名字像的');
  });

  test('躺在分类目录里也能被发现（§2.3 两层深度）', () => {
    const { root, dir } = makeQuantRoot({ category: 'software' });
    const out = ask(root, 'console.log(JSON.stringify({dir:q.resolveDir()}))');
    assert.equal(out.dir, dir, 'Phase 1 的落点正是 extensions/software/<id>，这一层必须能被下探到');
  });

  test('SERVICE 常量就是核唯一该知道的字符串', () => {
    const out = ask(emptyRoot(), 'console.log(JSON.stringify({s:q.SERVICE}))');
    assert.equal(out.s, 'quant-app');
  });
});

describe('quantApp seam：迁移期兜底（Phase 1 搬完目录后删掉这一支）', () => {
  test('没人声明 → 兜底到 L4 software/khyquant，行为与迁移前一致', () => {
    const out = ask(emptyRoot(), 'console.log(JSON.stringify({dir:q.resolveDir()}))');
    assert.equal(out.dir, L4_DIR, 'Phase 0 必须是纯重构：没有拓展提供者时，读到的仍是原来那个目录');
  });

  test('兜底路径里不含拓展 id —— 不触 §1.3「核不点名拓展 id」', () => {
    // 这条不是风格洁癖：check-repo-layout 的 extension-id-hardcode 基线是 0，
    // 兜底一旦写成 khy-quant 就会把这个门禁染红，Phase 0 反而卡死。
    const src = fs.readFileSync(SEAM, 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join('\n');
    assert.ok(!code.includes('khy-quant'), '兜底应写 L4 目录名 khyquant，不是拓展 id khy-quant');
  });
});

describe('quantApp seam：「未安装」与「装了但坏了」是两档', () => {
  test('模块存在 → 正常加载', () => {
    const { root } = makeQuantRoot();
    const out = ask(root, "console.log(JSON.stringify({m:q.loadModule('routes/ok')}))");
    assert.deepEqual(out.m, { tag: 'fixture-ok' });
  });

  test('省略 .js 后缀与写全后缀等价', () => {
    const { root } = makeQuantRoot();
    const out = ask(
      root,
      "console.log(JSON.stringify({a:q.loadModule('routes/ok'),b:q.loadModule('routes/ok.js')}))"
    );
    assert.deepEqual(out.a, out.b);
  });

  test('模块不存在 → null，且不抛（这一档才是「未安装」）', () => {
    const { root } = makeQuantRoot();
    const out = ask(root, "console.log(JSON.stringify({m:q.loadModule('routes/nope')}))");
    assert.equal(out.m, null);
  });

  test('模块存在但加载抛错 → 照抛，不吞成 null', () => {
    // 本文件最重要的一条。吞掉它意味着 khyquant 路由里的真 bug 会表现为静默 404，
    // 而不是启动期一声脆响 —— 那种 bug 要查一整天。
    const { root } = makeQuantRoot();
    const err = askExpectThrow(root, "q.loadModule('routes/boom');console.log('{}')");
    assert.match(err, /fixture module body exploded/, '原始错误必须原样冒出来，不能被 seam 抹掉');
  });

  test('垃圾入参不抛，只是解析不到', () => {
    const { root } = makeQuantRoot();
    const out = ask(
      root,
      'console.log(JSON.stringify({a:q.loadModule(null),b:q.loadModule(""),c:q.loadModule(42)}))'
    );
    assert.deepEqual(out, { a: null, b: null, c: null });
  });

  // 注：「应用整体缺席 → loadModule 全线返回 null」这一档在 Phase 0 期间**不可断言**
  // ——迁移期兜底总会命中真实的 software/khyquant。它是 Phase 1 删掉兜底之后才成立的
  // 契约，那时再补用例。这里刻意不造一个假绿灯来占位。
});

describe('quantApp seam：对真实 khyquant 的核验', () => {
  test('真实应用的路由模块能通过 seam 取到，且是个 express router', () => {
    const out = ask(
      emptyRoot(),
      "const m=q.loadModule('routes/market');" +
        "console.log(JSON.stringify({t:typeof m,router:!!(m&&m.stack&&typeof m.use==='function')}))"
    );
    assert.equal(out.t, 'function');
    assert.equal(out.router, true, 'server.js 要能把它直接 app.use 上去，形状不能变');
  });

  test('真实应用的 model 也能取到 —— 57 个壳里不止路由', () => {
    const out = ask(emptyRoot(), "console.log(JSON.stringify({ok:!!q.loadModule('models/Trade')}))");
    assert.equal(out.ok, true);
  });
});
