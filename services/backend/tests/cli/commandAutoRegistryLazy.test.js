'use strict';

// commandAutoRegistry 两阶段惰性加载 —— 回归测试。
//
// 守的不变量（[启动性能] 两阶段惰性加载）：
//   1. init() 之后**不得**有任何 handlers/ 模块被 require（惰性生效）。
//   2. 静态预筛的登记结果必须与「全量 require」等价 —— 命令集/别名集/元数据齐全。
//   3. 阶段二能真正物化：dispatch 一个自注册命令会加载它、并给出 handled=true。
//   4. 别名可被 dispatch 解析到规范名（别名在阶段一就登记，不该依赖模块加载）。
//
// 为什么需要这组测试：惰性化把「注册」和「加载」拆开了，一旦拆错，
// 表现是**静默的** —— 命令从帮助/补全里悄悄消失，或 dispatch 永远返回 handled:false。
// 这类回归不会报错，只会让用户发现某个命令突然不可用了 —— 所以必须用测试钉住。

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const REGISTRY = require.resolve('../../src/cli/commandAutoRegistry');

/** 重新加载 registry 模块，拿到干净状态（模块内是模块级 Map 单例）。 */
function freshRegistry() {
  delete require.cache[REGISTRY];
  return require(REGISTRY);
}

/** handlers/ 下已进入 require cache 的模块数。 */
function loadedHandlerCount() {
  return Object.keys(require.cache).filter((k) => /[\\/]cli[\\/]handlers[\\/]/.test(k)).length;
}

/** 造一个最小 dispatch ctx：只够让 handler 拿到结构，不真正执行业务。 */
function mkCtx(command) {
  const noop = () => {};
  return {
    subCommand: '',
    args: [],
    options: {},
    rawCommandToken: command,
    parsed: { command, subCommand: '', args: [], options: {} },
    context: {},
    printError: noop,
    printHelp: noop,
    printInfo: noop,
    printTable: noop,
    printSuccess: noop,
    printWarn: noop,
    withSpinner: async (fn) => fn(),
    chalk: (s) => s,
  };
}

test('惰性：init() 不 require 任何 handler 模块', () => {
  const reg = freshRegistry();
  const before = loadedHandlerCount();
  reg.init();
  const after = loadedHandlerCount();
  assert.equal(
    after - before,
    0,
    `init() 不应加载 handler，实际加载了 ${after - before} 个 —— 两阶段惰性加载已失效`
  );
});

test('等价性：登记的命令集与别名集达到预期规模', () => {
  const reg = freshRegistry();
  reg.init();

  const names = reg.getCommandNames();
  const aliases = Object.keys(reg.getAliases());

  // 基线（handler 全量 require 时实测）：71 命令 / 69 别名。
  assert.equal(names.length, 71, `命令数应为 71，实际 ${names.length}`);
  assert.equal(aliases.length, 69, `别名数应为 69，实际 ${aliases.length}`);
  assert.equal(reg.size(), 71, `size() 应为 71，实际 ${reg.size()}`);
});

test('等价性：getCompletions 与 getCommandNames 同集且元数据齐全', () => {
  const reg = freshRegistry();
  reg.init();

  const names = reg.getCommandNames();
  const comps = reg.getCompletions();

  assert.equal(comps.length, names.length, 'getCompletions 条目数应与命令数一致');
  assert.deepEqual(
    comps.map((c) => c.name).sort(),
    names.slice().sort(),
    'getCompletions 的名字集合应与 getCommandNames 完全一致'
  );

  // 每个条目都必须有 name / usage（usage 缺省回退为 name），供帮助与补全消费。
  for (const c of comps) {
    assert.ok(c.name, '条目缺少 name');
    assert.ok(c.usage, `命令 ${c.name} 缺少 usage`);
    assert.ok(Array.isArray(c.subCommands), `命令 ${c.name} 的 subCommands 应为数组`);
  }
});

test('阶段二：dispatch 自注册命令会加载它并返回 handled=true', async () => {
  const reg = freshRegistry();
  reg.init();

  const before = loadedHandlerCount();

  // `where` 是自注册命令（handlers/where.js），副作用轻微、可安全执行。
  const res = await reg.dispatch('where', mkCtx('where'));

  assert.equal(res.handled, true, 'dispatch 应返回 handled=true（阶段二物化失败会退化为 false）');

  const after = loadedHandlerCount();
  assert.ok(after > before, 'dispatch 应触发该 handler 的加载（阶段二未被触发）');
  // 不应退化成「全量加载」——只加载命中的那一个（允许它有少量子依赖，但远小于 152）。
  assert.ok(
    after - before < 10,
    `dispatch 只应加载命中命令的模块，实际新增 ${after - before} 个`
  );
});

test('阶段二：重复 dispatch 同一命令不重复加载（缓存生效）', async () => {
  const reg = freshRegistry();
  reg.init();

  await reg.dispatch('where', mkCtx('where'));
  const mid = loadedHandlerCount();
  await reg.dispatch('where', mkCtx('where'));
  const end = loadedHandlerCount();

  assert.equal(end, mid, '第二次 dispatch 不应再新增模块加载');
});

test('别名可在阶段一解析（不依赖模块加载）', async () => {
  const reg = freshRegistry();
  reg.init();

  const aliases = reg.getAliases();
  // 用 `capability`（别名 `cap`）做验证：该 handler 在最小 ctx 下即可正常执行
  // （不像某些 handler 需要完整的 registry/context 装配，那种会让本测试变成
  //  在测被测命令的实现，而不是在测注册表的别名解析）。
  const alias = 'cap';
  assert.equal(aliases[alias], 'capability', '别名 cap 应映射到 capability');

  const before = loadedHandlerCount();
  const res = await reg.dispatch(alias, mkCtx(alias));
  const after = loadedHandlerCount();

  assert.equal(res.handled, true, `别名 ${alias} 应能解析到规范命令并执行`);
  assert.ok(after > before, '别名 dispatch 也应触发一次模块加载');
});

test('别名映射指向已登记的命令（全部别名逐条校验）', () => {
  const reg = freshRegistry();
  reg.init();

  const names = new Set(reg.getCommandNames());
  const aliases = reg.getAliases();

  for (const [alias, canonical] of Object.entries(aliases)) {
    assert.ok(
      names.has(canonical),
      `别名 "${alias}" 指向未登记的命令 "${canonical}" —— 该别名永远无法 dispatch`
    );
  }
});

test('未知命令返回 handled=false，且不加载任何模块', async () => {
  const reg = freshRegistry();
  reg.init();
  const before = loadedHandlerCount();

  const res = await reg.dispatch('__no_such_command__', mkCtx('__no_such_command__'));

  assert.equal(res.handled, false, '未知命令应返回 handled=false');
  assert.equal(loadedHandlerCount(), before, '未知命令不应引发任何模块加载');
});

test('设计锁：init() 源码不得再出现对 handler 文件的 require', async () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/cli/commandAutoRegistry.js'), 'utf8');

  // 阶段一必须只读源码。若有人把 `_registerFromFile` 改回 require，这条会红。
  assert.ok(
    !/_registerFromFile[\s\S]{0,600}?require\(filePath\)/.test(src),
    '_registerFromFile 不得 require handler 文件（会退化回全量加载）'
  );
  assert.ok(
    /readFileSync\(filePath/.test(src),
    '_registerFromFile 应通过 readFileSync 静态读取源码'
  );
  assert.ok(
    /_mayDeclareManifest/.test(src),
    '应保留静态预筛 _mayDeclareManifest'
  );
});
