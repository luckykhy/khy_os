'use strict';

/**
 * server.js 对量化应用缺席的容忍度 —— [DESIGN-ARCH-069] §4.1 的机器化。
 *
 * 断边之前，`server.js` 在**加载期**直接 require 19 个指向 `software/khyquant` 的路由壳。
 * 删掉那个目录，19 个 require 一起抛 MODULE_NOT_FOUND，服务器连启动都失败。那不是
 * 「删目录即卸载」，那是删目录即整机不可用——§4.1 要禁的正是这个。
 *
 * 怎么在测试里造出「应用缺席」：不去动真实的 software/khyquant（那会让用例互相干扰，
 * 也会在中途失败时留下一个搬走的目录）。改用 fixture **抢下** quant-app 这个服务名，
 * 但目录里一个路由模块都不放。对挂载逻辑而言这与目录整个消失完全等价：每一处
 * loadModule 都解析成 null。fixture 胜过迁移期 L4 兜底这一点由 quantAppSeam 用例保证。
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const BACKEND = path.resolve(__dirname, '..', '..');
const REPO = path.resolve(BACKEND, '..', '..');
const SERVER = path.join(BACKEND, 'server.js');
const tempDirs = [];

after(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** 一个抢下 quant-app 却什么模块都不提供的拓展根 —— 等价于「应用缺席」。 */
function emptyProviderRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-quant-empty-'));
  tempDirs.push(root);
  const dir = path.join(root, 'software', 'khy-quant-stub');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'khy.extension.json'),
    JSON.stringify({
      id: 'khy-quant-stub', name: 'khy-quant-stub', version: '1.0.0',
      kind: 'runtime', main: 'index.js', capabilities: [], provides: ['quant-app'],
    }, null, 2),
    'utf8'
  );
  fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = {};\n', 'utf8');
  return root;
}

/**
 * 在子进程里加载 server.js，1.5 秒后退出。
 * 必须起子进程：server.js 会装中间件、连数据库、开监听，同进程加载两次会互相污染。
 */
function loadServer(env = {}) {
  const script =
    "try{require('./server.js');console.log('SERVER_LOADED_OK');}" +
    "catch(e){console.log('SERVER_LOAD_FAILED: '+e.message);process.exitCode=1;}" +
    'setTimeout(()=>process.exit(process.exitCode||0),1500);';
  const res = cp.spawnSync(process.execPath, ['-e', script], {
    cwd: BACKEND,
    encoding: 'utf8',
    timeout: 90000,
    env: { ...process.env, NODE_ENV: 'test', KHY_APP_ROOT: REPO, ...env },
  });
  return { out: (res.stdout || '') + (res.stderr || ''), status: res.status };
}

describe('server.js：量化应用缺席时仍能启动', () => {
  test('应用在位 → 21 条路由全部挂上，不打跳过日志', () => {
    const { out } = loadServer();
    assert.match(out, /SERVER_LOADED_OK/, '基线：应用在位时服务器本来就该起得来');
    assert.doesNotMatch(out, /已跳过/, '一条都不该跳过——跳过说明解析坏了，不是说明容错好');
  });

  test('应用缺席 → 服务器照样起来，不再是加载期 MODULE_NOT_FOUND', () => {
    // 本文件的全部意义在这一条。它红了就意味着有人在 server.js 里又加了一处
    // 对量化应用的加载期硬 require，§4.1 的承诺随之作废。
    const { out } = loadServer({ KHY_EXTENSION_PATH: emptyProviderRoot() });
    assert.match(out, /SERVER_LOADED_OK/, '删掉量化应用只该少掉它的路由，不该让整机起不来');
    assert.doesNotMatch(out, /MODULE_NOT_FOUND/);
  });

  test('跳过时汇报一行汇总，点服务名而非拓展 id，且说「未安装」', () => {
    const { out } = loadServer({ KHY_EXTENSION_PATH: emptyProviderRoot() });
    const line = out.split('\n').find((l) => l.includes('已跳过')) || '';
    assert.ok(line, '跳过了却不汇报，等于让运维在一个静默 404 上查半天');

    // 红线②状态透明：动作 + 目标 + 进度，三者都得在。
    assert.match(line, /已跳过/, '动作');
    assert.match(line, /quant-app/, '目标要点服务名（§3.4：不点拓展 id）');
    assert.match(line, /21\/21/, '进度要给分数，不能只说「部分路由不可用」');
    assert.match(line, /未安装/, '§3.4：「没装这个能力」和「装了但坏了」是两个诊断，别报成一个');
    assert.doesNotMatch(line, /探测失败|加载失败/, '缺席不是失败');
  });

  test('汇总里逐条列出被跳过的挂载路径 —— 运维要知道哪些接口没了', () => {
    const { out } = loadServer({ KHY_EXTENSION_PATH: emptyProviderRoot() });
    const line = out.split('\n').find((l) => l.includes('已跳过')) || '';
    for (const p of ['/api/market', '/api/backtest', '/api/trading-agents', '/api/instrument-sync']) {
      assert.ok(line.includes(p), '汇总里少了 ' + p);
    }
  });
});

describe('server.js：量化路由不许绕过 mountOptional', () => {
  // 上面那组是行为验证，这一组是静态防复发：行为用例只能证明「现在是好的」，
  // 挡不住下一个人顺手写一行 app.use('/api/xxx', require('./src/routes/<量化路由>'))。
  // 那一行会在应用缺席时抛回加载期错误，把 §4.1 的承诺重新打破。
  const QUANT_ROUTES = [
    'strategy', 'backtest', 'watchlist', 'stockProxy', 'dashboard', 'trade', 'trades',
    'tradingAgents', 'comprehensiveData', 'market', 'replay', 'tickBacktest',
    'futuresTickData', 'bankTransfer', 'instruments', 'favorites', 'klineData',
    'instrumentSync', 'marketData', 'news',
  ];

  test('server.js 里没有任何一条量化路由是用裸 app.use 挂的', () => {
    const src = fs.readFileSync(SERVER, 'utf8');
    const offenders = [];

    for (const line of src.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('app.use(')) continue;
      for (const r of QUANT_ROUTES) {
        // 只看**路由器实参**，不看挂载路径：/api/news 挂的是 createAiProxy()，与量化应用
        // 的 routes/news 壳毫无关系，按路径匹配会把它误报成违规。两种实参形态都要盖到：
        // 具名常量 marketRoutes、内联 require('./src/routes/market')。
        const named = new RegExp(',\\s*' + r + 'Routes\\b');
        const inline = new RegExp("require\\('\\./src/routes/" + r + "'\\)");
        if (named.test(t) || inline.test(t)) {
          offenders.push(t);
          break;
        }
      }
    }
    assert.deepEqual(offenders, [], '这些挂载要改走 mountOptional，否则应用缺席时服务器起不来');
  });

  test('mountOptional 与汇报点都还在 —— 别把挂载器本身删了', () => {
    const src = fs.readFileSync(SERVER, 'utf8');
    assert.match(src, /function mountOptional\(/);
    assert.match(src, /reportSkippedMounts\(\d+\)/, '汇报点要带上总数，否则分子分母对不上');
  });
});
