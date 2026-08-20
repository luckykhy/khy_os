'use strict';

/**
 * ext-run 派发器契约测试 —— [DESIGN-ARCH-069] §2.3 / §4.1 在**交付脚本**这条路径上的机器化。
 *
 * 为什么单独测它：`extensionRoots` 那套是给运行时用的，而 `npm run portable:build` 这类
 * 目标走的是另一条完全独立的代码路径（scripts/ 不许 import L2，见 [DESIGN-ARCH-068] 第二节，
 * 于是 ext-run 自带了一份两层扫描）。两份实现意味着两份会漂移的语义——这里钉的就是它们
 * 不许漂：同一套「删目录即消失 / 分类只是布局」的行为，在派发器这一侧也必须成立。
 *
 * 用 KHY_EXT_RUN_ROOT 指向临时夹具仓库，不碰真实 extensions/：否则任何人往仓库里加一个
 * 拓展都可能让用例飘绿或飘红。
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const RUNNER = path.resolve(__dirname, '..', 'lib', 'ext-run.js');
const tempDirs = [];

after(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** 造一个夹具仓库，返回它的根。`category` 为 null 时拓展直接放在 extensions/ 下。 */
function makeRepo({ id = 'khy-fix', category = 'scripts', commands, script = 'run.js', body } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-extrun-'));
  tempDirs.push(repo);
  const dir = category
    ? path.join(repo, 'extensions', category, id)
    : path.join(repo, 'extensions', id);
  fs.mkdirSync(dir, { recursive: true });

  const manifest = body || {
    id,
    name: id,
    version: '1.0.0',
    kind: 'toolchain',
    commands: commands || [{ name: 'go', description: 'fixture', script }],
  };
  fs.writeFileSync(
    path.join(dir, 'khy.extension.json'),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2),
    'utf8'
  );
  // 脚本把自己拿到的参数原样打回来 —— 好证明透传没被派发层吃掉。
  fs.writeFileSync(
    path.join(dir, script),
    "console.log(JSON.stringify({ran:true,argv:process.argv.slice(2)}));\n",
    'utf8'
  );
  return { repo, dir };
}

function run(repo, args) {
  const res = cp.spawnSync(process.execPath, [RUNNER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, KHY_EXT_RUN_ROOT: repo },
  });
  return { code: res.status, out: res.stdout || '', err: res.stderr || '' };
}

describe('ext-run：找得到就跑得动', () => {
  test('分类目录下的拓展能被找到，参数原样透传', () => {
    const { repo } = makeRepo({ id: 'khy-fix', category: 'scripts' });
    const r = run(repo, ['khy-fix', 'go', '--kind', 'portable-dev']);
    assert.equal(r.code, 0, r.err);
    const got = JSON.parse(r.out.trim().split('\n').pop());
    assert.equal(got.ran, true);
    assert.deepEqual(got.argv, ['--kind', 'portable-dev'], '派发层不得吞掉或重排脚本参数');
  });

  test('顶层直放（无分类）同样能找到 —— 分类是可选布局，不是必须的注册位', () => {
    const { repo } = makeRepo({ id: 'khy-flat', category: null });
    const r = run(repo, ['khy-flat', 'go']);
    assert.equal(r.code, 0, r.err);
  });

  test('不下探第三层 —— 与 extensionRoots.MAX_DEPTH 同深度', () => {
    // 两份扫描实现漂移的第一个症状就会出现在这里：一侧认第三层、另一侧不认，
    // 于是同一个拓展「运行时看得见但 npm 目标叫不动」。
    const { repo } = makeRepo({ id: 'khy-deep', category: 'a/b' });
    const r = run(repo, ['khy-deep', 'go']);
    assert.equal(r.code, 1);
    assert.match(r.err, /未安装/);
  });
});

describe('ext-run：删目录即消失（而不是即崩溃）', () => {
  test('拓展不存在 → 一条说得清的消息 + 非零退出，不是 Cannot find module', () => {
    const { repo, dir } = makeRepo({ id: 'khy-gone' });
    assert.equal(run(repo, ['khy-gone', 'go']).code, 0);

    fs.rmSync(dir, { recursive: true, force: true });
    const r = run(repo, ['khy-gone', 'go']);
    assert.equal(r.code, 1, '缺失必须是非零退出，否则 CI 会把「能力没装」当成跑成功了');
    assert.match(r.err, /khy-gone 未安装/, '消息要点名是哪个拓展');
    assert.match(r.err, /go/, '消息要点名是哪条命令不可用');
    assert.doesNotMatch(r.err, /Cannot find module/, '用户该看到「这个能力没装」，不是 node 的模块解析栈');
  });

  test('删掉整个分类目录 → 同样退化为「未安装」', () => {
    const { repo } = makeRepo({ id: 'khy-catgone', category: 'scripts' });
    fs.rmSync(path.join(repo, 'extensions', 'scripts'), { recursive: true, force: true });
    const r = run(repo, ['khy-catgone', 'go']);
    assert.equal(r.code, 1);
    assert.match(r.err, /未安装/);
  });
});

describe('ext-run：三种「装了但不对」各自可区分', () => {
  // 这三种情况若都退化成同一句话，排查时就得靠猜。它们的成因完全不同：
  // 拓展作者写错 manifest / 用户敲错命令名 / 文件被误删。

  test('manifest 是坏 JSON → 明确报 JSON 坏掉，不当作「没装」', () => {
    const { repo } = makeRepo({ id: 'khy-bad', body: '{ 坏 json' });
    const r = run(repo, ['khy-bad', 'go']);
    assert.equal(r.code, 1);
    assert.match(r.err, /不是合法 JSON/, '目录在场却被报成「没装」会把人引向完全错误的方向');
  });

  test('命令名未声明 → 报它到底声明了哪些', () => {
    const { repo } = makeRepo({ id: 'khy-cmd', commands: [{ name: 'build', script: 'run.js' }] });
    const r = run(repo, ['khy-cmd', 'nope']);
    assert.equal(r.code, 1);
    assert.match(r.err, /没有声明命令 "nope"/);
    assert.match(r.err, /build/, '报错要顺手给出可用命令，否则用户得自己去翻 manifest');
  });

  test('script 指向空气 → 报的是路径对不上，不是「未安装」', () => {
    const { repo, dir } = makeRepo({ id: 'khy-noscript' });
    fs.rmSync(path.join(dir, 'run.js'));
    const r = run(repo, ['khy-noscript', 'go']);
    assert.equal(r.code, 1);
    assert.match(r.err, /在磁盘上不存在/);
  });

  test('少给参数 → 打用法，不是栈', () => {
    const { repo } = makeRepo({});
    const r = run(repo, ['khy-fix']);
    assert.equal(r.code, 1);
    assert.match(r.err, /用法/);
  });
});

describe('ext-run：退出码是子脚本的退出码', () => {
  test('子脚本非零退出 → 派发层原样透出', () => {
    // 否则 `npm run portable:verify` 会在体检失败时报成功，CI 就白设了。
    const { repo, dir } = makeRepo({ id: 'khy-exit' });
    fs.writeFileSync(path.join(dir, 'run.js'), 'process.exit(3);\n', 'utf8');
    assert.equal(run(repo, ['khy-exit', 'go']).code, 3);
  });
});

describe('ext-run：真实仓库里的 5 个 scripts 拓展都叫得动', () => {
  // 这一组打真实仓库：上面全是夹具，夹具全绿也不能证明**本轮迁移的那 5 个拓展**
  // 的 manifest 与 package.json 里的命令名对得上。
  const REPO = path.resolve(__dirname, '..', '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));

  const targets = Object.entries(pkg.scripts || {})
    .map(([name, cmd]) => [name, /node scripts\/lib\/ext-run\.js (\S+) (\S+)/.exec(cmd)])
    .filter(([, m]) => m)
    .map(([name, m]) => ({ name, id: m[1], command: m[2] }));

  test('确实有 npm 目标走 ext-run —— 否则下面的用例是空转', () => {
    assert.ok(targets.length >= 14, `只找到 ${targets.length} 个 ext-run 目标`);
  });

  for (const t of targets) {
    test(`npm run ${t.name} → ${t.id} ${t.command} 的 script 在磁盘上存在`, () => {
      const found = require(path.join(REPO, 'scripts', 'lib', 'ext-run.js')).findExtension(t.id);
      assert.ok(found, `拓展 ${t.id} 找不到 —— npm 目标指向一个不存在的拓展`);
      const entry = (found.manifest.commands || []).find((c) => c && c.name === t.command);
      assert.ok(entry, `${t.id} 未声明命令 ${t.command}（npm 目标与 manifest 对不上）`);
      assert.ok(
        fs.existsSync(path.join(found.dir, entry.script)),
        `${t.id}/${entry.script} 不存在`
      );
    });
  }
});
