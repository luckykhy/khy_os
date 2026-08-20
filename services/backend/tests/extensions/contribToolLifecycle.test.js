'use strict';

/**
 * 拓展贡献工具的生命周期契约测试 —— [DESIGN-ARCH-069] §4 的机器化。
 *
 * 用户对拓展机制的原话要求是三条：「删除目录拓展自动删除，拖入目录，启动并在需要时
 * 自动加载」。这三条各自对应下面一组断言，而不是被笼统地测成「拓展能跑」。
 *
 * **每个用例起一个子进程**：resolver 有目录扫描缓存与 require 缓存，同进程内先测
 * 「目录在」再测「目录不在」会读到上一次的缓存，测出来的是缓存行为而不是契约行为。
 * 子进程同时让 KHY_EXTENSION_PATH 这类只在模块加载时读一次的环境变量能被逐例设置。
 *
 * **不对着真实 extensions/ 目录测机制**：那样一来任何人往仓库里放一个拓展都可能
 * 让用例飘绿或飘红。机制部分一律用临时目录当 fixture；只有最后一组「试点核验」
 * 才断言真实的 khy-notebook —— 那是本轮实际迁移的东西，它坏了就该红。
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const BACKEND = path.resolve(__dirname, '..', '..');
const REPO = path.resolve(BACKEND, '..', '..');
const tempDirs = [];

after(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * 造一个只含一个拓展的临时拓展根。
 * `entryExtra` 用来在入口模块体里塞副作用，好证明「模块体到底跑没跑」。
 */
function makeRoot({ id = 'khy-fixture', toolName = 'FixtureTool', entryExtra = '', category = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ext-'));
  tempDirs.push(root);
  // category 是**相对根的目录前缀**而不是「一个分类名」：深度上限的用例需要造出
  // 'a/b' 这种两层前缀来证明第三层不被下探，写死成单段就测不了那条边界。
  const dir = category ? path.join(root, ...category.split('/'), id) : path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });

  const manifest = {
    id,
    name: id,
    version: '1.0.0',
    kind: 'runtime',
    main: 'index.js',
    capabilities: ['tools'],
    tools: [
      {
        name: toolName,
        description: 'fixture tool',
        category: 'custom',
        risk: 'safe',
        inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
      },
    ],
  };
  fs.writeFileSync(path.join(dir, 'khy.extension.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const entry =
    entryExtra +
    '\nmodule.exports = { tools: [{ name: ' +
    JSON.stringify(toolName) +
    ', execute: async (p) => ({ ok: true, echo: p && p.x }) }] };\n';
  fs.writeFileSync(path.join(dir, 'index.js'), entry, 'utf8');

  return { root, dir };
}

/** 往一个已存在的根里再塞一个拓展（冲突与「不下探」用例需要同一根里放两个）。 */
function addExt(baseDir, { id, toolName, category = null }) {
  const dir = category ? path.join(baseDir, ...category.split('/'), id) : path.join(baseDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'khy.extension.json'),
    JSON.stringify(
      {
        id, name: id, version: '1.0.0', kind: 'runtime', main: 'index.js', capabilities: ['tools'],
        tools: [{
          name: toolName, description: 'fixture', category: 'custom', risk: 'safe',
          inputSchema: { type: 'object', properties: {} },
        }],
      },
      null, 2
    ), 'utf8'
  );
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    'module.exports = { tools: [{ name: ' + JSON.stringify(toolName) +
      ', execute: async () => ({ ok: true }) }] };\n',
    'utf8'
  );
  return dir;
}

/** 在子进程里对 resolver 提问，返回它最后一行打印的 JSON。 */
function ask(root, script, extraEnv = {}) {
  const res = cp.spawnSync(process.execPath, ['-e', script], {
    cwd: BACKEND,
    encoding: 'utf8',
    env: { ...process.env, KHY_EXTENSION_PATH: root, KHY_APP_ROOT: REPO, ...extraEnv },
  });
  if (res.status !== 0) {
    throw new Error('子进程退出 ' + res.status + ':\n' + res.stdout + '\n' + res.stderr);
  }
  return JSON.parse(res.stdout.trim().split('\n').pop());
}

const R = "const r=require('./src/services/plugins/pluginContribResolver');";
const E = "const e=require('./src/services/extensions/extensionRoots');";
const MARK = "require('fs').writeFileSync(process.env.KHY_TEST_MARK,'ran');";
const RAN = "ran:require('fs').existsSync(process.env.KHY_TEST_MARK)";

describe('拓展贡献工具：拖入即被发现', () => {
  test('目录在位 + manifest 声明了工具 → 漏斗认得这个名字', () => {
    const { root } = makeRoot({ toolName: 'FixtureA' });
    const out = ask(root, R + "console.log(JSON.stringify({owns:r.ownsTool('FixtureA')}))");
    assert.equal(out.owns, true, '拖进目录就该被发现，不需要任何注册步骤');
  });

  test('manifest 里没声明的名字不会被认领 —— 发现看声明，不看目录里有什么', () => {
    const { root } = makeRoot({ toolName: 'FixtureA' });
    const out = ask(root, R + "console.log(JSON.stringify({owns:r.ownsTool('FixtureB')}))");
    assert.equal(out.owns, false);
  });

  test('manifest 坏掉 → 该拓展当作不存在，且不抛异常', () => {
    const { root, dir } = makeRoot({ toolName: 'FixtureA' });
    fs.writeFileSync(path.join(dir, 'khy.extension.json'), '{ 坏 json', 'utf8');
    const out = ask(root, R + "console.log(JSON.stringify({owns:r.ownsTool('FixtureA')}))");
    assert.equal(out.owns, false, 'fail-soft：坏 manifest 只让这一个拓展消失，不该炸掉解析');
  });
});

describe('拓展贡献工具：需要时才加载', () => {
  test('只发现不激活时，入口模块体一次都不执行', () => {
    // 入口模块体一跑就落一个标记文件；只调 ownsTool 不该产生这个文件。
    const { root } = makeRoot({ toolName: 'FixtureLazy', entryExtra: MARK });
    const mark = path.join(root, 'loaded.mark');
    const out = ask(
      root,
      R + "const owns=r.ownsTool('FixtureLazy');" +
        'console.log(JSON.stringify({owns,' + RAN + '}))',
      { KHY_TEST_MARK: mark }
    );
    assert.equal(out.owns, true);
    assert.equal(out.ran, false, '发现阶段只读 manifest —— 入口模块体执行了就不叫惰性');
  });

  test('首次激活才 require 入口，且拿到可执行的工具', () => {
    const { root } = makeRoot({ toolName: 'FixtureLazy', entryExtra: MARK });
    const mark = path.join(root, 'loaded.mark');
    const out = ask(
      root,
      R + "const t=r.activateContributedTool('FixtureLazy');" +
        't.execute({x:7}).then(v=>console.log(JSON.stringify({got:!!t,' + RAN + ',echo:v.echo})))',
      { KHY_TEST_MARK: mark }
    );
    assert.equal(out.got, true);
    assert.equal(out.ran, true, '激活就是 require 入口的那一刻');
    assert.equal(out.echo, 7, '激活出来的工具必须真能执行，不是个壳');
  });
});

describe('拓展贡献工具：删目录即消失', () => {
  test('目录被删 → ownsTool 与激活双双转否', () => {
    const { root, dir } = makeRoot({ toolName: 'FixtureGone' });
    const before = ask(root, R + "console.log(JSON.stringify({owns:r.ownsTool('FixtureGone')}))");
    assert.equal(before.owns, true);

    fs.rmSync(dir, { recursive: true, force: true });
    const gone = ask(
      root,
      R + "console.log(JSON.stringify({owns:r.ownsTool('FixtureGone')," +
        "act:!!r.activateContributedTool('FixtureGone')}))"
    );
    assert.equal(gone.owns, false, '文件系统就是注册表：目录没了，拓展就没了');
    assert.equal(gone.act, false, '激活路径必须与发现路径同步转否，否则会激活一个幽灵');
  });

  test('入口文件缺失 → 即便 manifest 还在也不认领', () => {
    const { root, dir } = makeRoot({ toolName: 'FixtureNoEntry' });
    fs.rmSync(path.join(dir, 'index.js'));
    const out = ask(root, R + "console.log(JSON.stringify({owns:r.ownsTool('FixtureNoEntry')}))");
    assert.equal(out.owns, false, '一个同名空目录不该骗过解析');
  });
});

describe('拓展贡献工具：门控 fail-closed', () => {
  test('中心门控关掉 → 当作没装，发现与广告一起消失', () => {
    const { root } = makeRoot({ toolName: 'FixtureGated' });
    const out = ask(
      root,
      R + "console.log(JSON.stringify({owns:r.ownsTool('FixtureGated')," +
        'declared:r.listDeclaredTools().length}))',
      { KHY_PLUGIN_LAZY_LOAD: '0' }
    );
    assert.equal(out.owns, false);
    assert.equal(out.declared, 0, '门关着还往模型清单里广告，等于广告一个叫不动的工具');
  });
});

describe('拓展贡献工具：模型看得见（本轮补的缺口）', () => {
  test('listDeclaredTools 只读 manifest，不执行入口', () => {
    // 断言**只针对 fixture 这一个名字**，不钉死整份清单。
    // 原因是实测出来的：KHY_EXTENSION_PATH 是「前插最高优先级」而不是「替换根集合」
    // （extensionRoots.listRoots 把 override 排在最前，随后照样 push 仓库根、用户根、
    // 两个遗留 plugins 根）。所以任何 fixture 进程都还看得见真实 extensions/ 与
    // ~/.khyquant/extensions —— 后者在本机不存在、在别人机器上可能存在。
    // 把整份清单写死等于把用例绑在「这台机器上装了什么」上，正是本文件头要避免的飘绿飘红。
    const { root } = makeRoot({ toolName: 'FixtureAd', entryExtra: MARK });
    const mark = path.join(root, 'loaded.mark');
    const out = ask(
      root,
      R + 'const d=r.listDeclaredTools();' +
        "const f=d.find(x=>x.name==='FixtureAd');" +
        'console.log(JSON.stringify({found:!!f,' +
        'hasSchema:!!(f&&f.inputSchema&&f.inputSchema.properties),' + RAN + '}))',
      { KHY_TEST_MARK: mark }
    );
    assert.equal(out.found, true, '拖进去的拓展必须出现在广告清单里');
    assert.equal(out.hasSchema, true, '广告要带 schema，否则模型知道名字也不会调用');
    assert.equal(out.ran, false, '广告必须来自 JSON —— 为了广告去 require 入口就废掉了惰性');
  });

  test('拓展目录被删 → 它也从广告清单里消失', () => {
    // 「删目录即消失」必须三条路径同步：发现、激活、**广告**。
    // 前两条上面已测；广告这条是本轮新增的，漏了它就会向模型广告一个叫不动的工具。
    const { root, dir } = makeRoot({ toolName: 'FixtureAdGone' });
    const script = R + 'console.log(JSON.stringify(' +
      "{has:r.listDeclaredTools().some(x=>x.name==='FixtureAdGone')}))";
    assert.equal(ask(root, script).has, true);
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(ask(root, script).has, false, '目录没了还在广告 = 向模型撒谎');
  });
});

describe('拓展分类目录：两层布局（[DESIGN-ARCH-069] §2.3）', () => {
  // 分类是本轮为「25 个拓展平铺在 extensions/ 下没法管」加的布局层。它必须是**纯布局**：
  // 一旦分类名渗进 id，把拓展移进分类目录就等于给它改身份，state 条目、冲突裁决与
  // 孤儿检测会同时错位 —— 那比不分类糟得多。下面每条都在钉这个「纯布局」性质。

  test('<分类>/<id> 被发现，且 id 是叶子目录名而不是路径', () => {
    const { root } = makeRoot({ id: 'khy-nested', toolName: 'FixtureNested', category: 'tools' });
    const out = ask(
      root,
      R + "const d=r.listDeclaredTools().find(x=>x.name==='FixtureNested');" +
        "console.log(JSON.stringify({owns:r.ownsTool('FixtureNested'),dir:d&&d.dir}))"
    );
    assert.equal(out.owns, true, '分类目录只是布局，不该让拓展从发现路径上消失');
    assert.equal(out.dir, 'khy-nested', 'id 必须是叶子名 —— 掺进分类名等于给拓展改身份');
  });

  test('分类目录自己不算一个拓展', () => {
    const { root } = makeRoot({ id: 'khy-nested', toolName: 'FixtureCat', category: 'tools' });
    const out = ask(
      root,
      E + 'const f=e.discover();console.log(JSON.stringify({' +
        "ids:f.map(x=>x.id).filter(x=>x==='khy-nested'||x==='tools')," +
        "cat:(f.find(x=>x.id==='khy-nested')||{}).category}))"
    );
    assert.deepEqual(out.ids, ['khy-nested'], '空壳分类目录不该被当成一个「说不清是什么」的拓展');
    assert.equal(out.cat, 'tools', 'category 字段是分类的唯一去处 —— 供 khy ext 分组显示');
  });

  test('删掉分类目录 → 它下面的拓展一并消失', () => {
    const { root } = makeRoot({ id: 'khy-nested', toolName: 'FixtureCatGone', category: 'tools' });
    const script = R + "console.log(JSON.stringify({owns:r.ownsTool('FixtureCatGone')}))";
    assert.equal(ask(root, script).owns, true);
    fs.rmSync(path.join(root, 'tools'), { recursive: true, force: true });
    assert.equal(ask(root, script).owns, false, '删一层分类目录 = 删掉它整块内容，语义必须一致');
  });

  test('自带 manifest 的目录不被当分类目录下探', () => {
    // 否则一个拓展在自己目录里放了子拓展（vendor 场景）就会被整块散开成分类。
    const { root, dir } = makeRoot({ id: 'khy-outer', toolName: 'FixtureOuter' });
    addExt(dir, { id: 'khy-inner', toolName: 'FixtureInner' });
    const out = ask(
      root,
      R + 'console.log(JSON.stringify({' +
        "outer:r.ownsTool('FixtureOuter'),inner:r.ownsTool('FixtureInner')}))"
    );
    assert.equal(out.outer, true);
    assert.equal(out.inner, false, '显式自我声明胜过按结构推断：它是拓展，就不是分类');
  });

  test('不下探第三层 —— 一层足够分类，两层就要开始裁决', () => {
    const { root } = makeRoot({ id: 'khy-deep', toolName: 'FixtureDeep', category: 'a/b' });
    const out = ask(root, R + "console.log(JSON.stringify({owns:r.ownsTool('FixtureDeep')}))");
    assert.equal(out.owns, false, '深度无上限时「目录名」不再唯一指代一个东西，id 就不成键了');
  });

  test('同一 id 顶层与分类下各有一份 → 只认一个，不重复广告', () => {
    // 这里刻意**不**断言谁赢：那取决于分类名与 id 的字典序，是实现的偶然。
    // 契约只有一条 —— 同一个 id 在同一根里不得产出两条记录。
    const { root } = makeRoot({ id: 'khy-dup', toolName: 'DupTop' });
    addExt(root, { id: 'khy-dup', toolName: 'DupNested', category: 'tools' });
    const out = ask(
      root,
      E + 'const f=e.discover();' +
        R + "const d=r.listDeclaredTools().filter(x=>x.name.indexOf('Dup')===0);" +
        "console.log(JSON.stringify({ids:f.filter(x=>x.id==='khy-dup').length,ads:d.length}))"
    );
    assert.equal(out.ids, 1, '同 id 两处在位时必须裁决出一个，不能两条都算在位');
    assert.equal(out.ads, 1, '两条都广告 = 同一个拓展被算两遍');
  });

  test('findOrphanState 与发现同深度 —— 移进分类目录的拓展不算残留', () => {
    // 这条是分类改造最危险的漏点：孤儿名单是**要被清理的**名单。孤儿检测若还只看
    // 一层，「把拓展移进分类目录」就会让在位的拓展被列为残留。
    const { root } = makeRoot({ id: 'khy-nested', toolName: 'FixtureOrphan', category: 'tools' });
    const appHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-home-'));
    tempDirs.push(appHome);
    fs.writeFileSync(
      path.join(appHome, 'extensions_state.json'),
      JSON.stringify({ 'khy-nested': { enabled: true }, 'khy-vanished': { enabled: true } }),
      'utf8'
    );
    const out = ask(root, E + 'console.log(JSON.stringify({orphans:e.findOrphanState()}))', {
      KHY_APP_HOME: appHome,
    });
    assert.deepEqual(out.orphans, ['khy-vanished'], '在位的（哪怕在分类目录里）不是残留，真没了的才是');
  });
});

describe('试点核验：khy-notebook（真实拓展，不是 fixture）', () => {
  // 这一组刻意打真实仓库：NotebookEdit 是本轮从 services/backend/src/tools/
  // 迁出去的第一个内置工具，它断了就该红。
  const runReal = (script) => {
    const res = cp.spawnSync(process.execPath, ['-e', script], {
      cwd: BACKEND,
      encoding: 'utf8',
      env: { ...process.env, KHY_APP_ROOT: REPO },
    });
    if (res.status !== 0) throw new Error(res.stdout + '\n' + res.stderr);
    return JSON.parse(res.stdout.trim().split('\n').pop());
  };

  test('内置副本确已删除 —— 迁移不是复制', () => {
    assert.equal(
      fs.existsSync(path.join(BACKEND, 'src', 'tools', 'NotebookEditTool')),
      false,
      '内置与拓展同时存在时内置永远赢，等于迁移没发生却看起来是绿的'
    );
  });

  test('NotebookEdit 经拓展路径可发现、可激活、可执行', () => {
    const out = runReal(
      R + "const t=r.activateContributedTool('NotebookEdit');" +
        "t.execute({notebook_path:'relative.ipynb',new_source:'x'}).then(v=>" +
        "console.log(JSON.stringify({owns:r.ownsTool('NotebookEdit'),name:t.name," +
        'risk:t.risk,category:t.category,err:v.error})))'
    );
    assert.equal(out.owns, true);
    assert.equal(out.name, 'NotebookEdit', '保持原名 —— 核里约 20 处策略表按这个名字点名');
    assert.equal(out.category, 'filesystem');
    assert.equal(out.risk, 'high');
    assert.equal(out.err, 'notebook_path must be an absolute path.', '行为与迁移前一致');
  });

  test('NotebookEdit 出现在给模型的工具清单里', () => {
    const out = runReal(
      "const d=require('./src/services/gateway/adapters/claudeAdapter')" +
        '.__test__.buildDirectToolDefs();' +
        "const n=d.filter(x=>x.name==='NotebookEdit');" +
        'console.log(JSON.stringify({count:n.length,schema:!!(n[0]&&n[0].input_schema)}))'
    );
    assert.equal(out.count, 1, '既不能缺席（模型看不见就调不动），也不能重复');
    assert.equal(out.schema, true);
  });
});
