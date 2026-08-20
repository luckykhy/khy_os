'use strict';

/**
 * scripts/ci/check-repo-layout.js 的规则测试。
 *
 * 刻意**不**对着真实仓库跑：真仓库的违规数会随治理进度变化，那样的测试
 * 「基线一改就绿」，测不出规则逻辑。这里每个用例建一个临时 git 仓库当
 * fixture，通过 KHY_REPO_LAYOUT_ROOT 把守卫指过去。
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'check-repo-layout.js');
const tempDirs = [];

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function writeFile(root, relPath, content) {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

/**
 * 建一个最小可通过的 fixture 仓库：七个层级目录 + 横切目录都存在，
 * docs/ 每个分类目录都有排序首位的索引，根目录只有白名单文件。
 * 各用例在此基础上**只加一处**违规，好让断言指向单一原因。
 */
function makeFixture(mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-layout-'));
  tempDirs.push(root);

  for (const layer of ['kernel', 'platform', 'services', 'apps', 'software', 'extensions', 'tools']) {
    writeFile(root, `${layer}/.keep`, '');
  }
  for (const cross of ['scripts', 'packaging', '_source']) {
    writeFile(root, `${cross}/.keep`, '');
  }

  writeFile(root, 'README.md', '# fixture\n');
  writeFile(root, 'package.json', JSON.stringify({ name: 'fixture', scripts: { 'check:layout': 'node x.js' } }, null, 2));
  writeFile(root, 'docs/03_DESIGN_设计/00_INDEX_设计-分类索引.md', '# 索引\n');
  writeFile(root, 'docs/03_DESIGN_设计/[DESIGN-ARCH-001] 示例.md', '# 示例\n');
  // 纯资产目录不含 .md，规则应自然跳过它而不需要特例名单。
  writeFile(root, 'docs/_assets/nav-data.js', '// asset\n');

  if (mutate) mutate(root);

  cp.execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  cp.execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
  return root;
}

function runGuard(root, extraArgs = []) {
  const result = cp.spawnSync(process.execPath, [SCRIPT, ...extraArgs], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, KHY_REPO_LAYOUT_ROOT: root },
  });
  return {
    status: result.status,
    stdout: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

describe('check-repo-layout: 规则命中', () => {
  test('干净 fixture 全绿，退出码 0', () => {
    const root = makeFixture();
    const { status, stdout } = runGuard(root);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /无结构发现/);
  });

  test('root-whitelist: 根目录白名单外的 .md / .txt 一律 error', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, 'FIX_SUMMARY.md', '# 一次性报告\n');
      writeFile(dir, '使用说明.txt', '说明\n');
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /root-whitelist/);
    assert.match(stdout, /FIX_SUMMARY\.md/);
    assert.match(stdout, /使用说明\.txt/);
  });

  test('root-whitelist: 白名单文件与 README 语言变体不报', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, 'CHANGELOG.md', '# 变更\n');
      writeFile(dir, 'CONTRIBUTING.md', '# 贡献\n');
      writeFile(dir, 'SECURITY.md', '# 安全\n');
      writeFile(dir, 'AGENTS.md', '# agents\n');
      writeFile(dir, 'README.zh-CN.md', '# 中文\n');
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 0, stdout);
    assert.doesNotMatch(stdout, /root-whitelist/);
  });

  test('root-whitelist: 非说明性扩展名（.json/.toml）不在本规则范围内', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, 'pyproject.toml', '[project]\n');
      writeFile(dir, 'fly.staging.toml', '# fly\n');
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 0, stdout);
    assert.doesNotMatch(stdout, /root-whitelist/);
  });

  test('docs-index-first: 分类目录缺 00_INDEX_* 是 error', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, 'docs/_传承/KHY-OS-传承书.md', '# 传承\n');
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /docs-index-first/);
    assert.match(stdout, /docs\/_传承\//);
  });

  test('docs-index-first: 索引存在但排序不在首位也是 error', () => {
    const root = makeFixture((dir) => {
      // "00_INDEX_..." 的字典序高于 "!急件.md"，故索引不再是首位。
      writeFile(dir, 'docs/07_OPS_运维/00_INDEX_运维-分类索引.md', '# 索引\n');
      writeFile(dir, 'docs/07_OPS_运维/!急件.md', '# 插队\n');
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /未居字典序首位/);
  });

  test('docs-index-first: 不含 .md 的资产目录不被误判', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, 'docs/_ref/sample.html', '<p>x</p>\n');
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 0, stdout);
    assert.doesNotMatch(stdout, /docs-index-first/);
  });

  test('layer-registry: 未登记的新顶层目录是 error', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, 'frontend/index.js', '// 该并入 apps/ 或 software/\n');
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /layer-registry/);
    assert.match(stdout, /frontend/);
  });

  test('layer-registry: 点目录不参与层级体系', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, '.github/workflows/pr-gate.yml', 'name: x\n');
      writeFile(dir, '.khy/state.json', '{}\n');
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 0, stdout);
    assert.doesNotMatch(stdout, /layer-registry/);
  });
});

describe('check-repo-layout: 任务入口与跨层引用', () => {
  test('dangling-task: 引用了未定义的 npm run 目标 → warning，不阻断', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, 'docs/03_DESIGN_设计/[DESIGN-ARCH-002] 验收.md', '跑 `npm run gate:release` 与 `npm run check:layout`。\n');
    });
    const { status, stdout } = runGuard(root, ['--list=dangling-task']);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /"dangling-task":1/);
    // check:layout 在 fixture 的 package.json 里有定义，不该被算作悬空。
    assert.match(stdout, /· gate:release/);
    assert.doesNotMatch(stdout, /· check:layout/);
  });

  test('dangling-task: --promote 把它升为 error', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, 'docs/03_DESIGN_设计/[DESIGN-ARCH-002] 验收.md', '跑 `npm run gate:release`。\n');
    });
    const { status, stdout } = runGuard(root, ['--promote=dangling-task']);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /promoted from warning/);
  });

  test('cross-layer-require: 跨 workspace 深层相对 require → warning', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, 'services/backend/package.json', '{"name":"backend"}\n');
      writeFile(dir, 'services/backend/src/utils/parseBoolean.js', 'module.exports = () => true;\n');
      writeFile(dir, 'services/ai-backend/package.json', '{"name":"ai-backend"}\n');
      writeFile(dir, 'services/ai-backend/src/routes/admin.js',
        "const parseBoolean = require('../../../backend/src/utils/parseBoolean');\nmodule.exports = { parseBoolean };\n");
    });
    const { status, stdout } = runGuard(root, ['--list=cross-layer-require']);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /cross-layer-require/);
    assert.match(stdout, /services\/ai-backend\/src\/routes\/admin\.js/);
  });

  test('cross-layer-require: 测试 fixture 不进入运行时依赖计数', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, 'services/backend/package.json', '{"name":"backend"}\n');
      writeFile(dir, 'services/backend/src/utils/parseBoolean.js', 'module.exports = () => true;\n');
      writeFile(dir, 'services/ai-backend/package.json', '{"name":"ai-backend"}\n');
      writeFile(dir, 'services/ai-backend/tests/admin.test.js',
        "const parseBoolean = require('../../../backend/src/utils/parseBoolean');\nmodule.exports = { parseBoolean };\n");
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /"cross-layer-require":0/);
    assert.match(stdout, /"unresolved-require":0/);
  });

  test('cross-layer-require: 纯 re-export 壳文件按兼容别名豁免', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, 'services/backend/package.json', '{"name":"backend"}\n');
      writeFile(dir, 'software/khyquant/package.json', '{"name":"khyquant"}\n');
      writeFile(dir, 'software/khyquant/models/Instrument.js', 'module.exports = {};\n');
      writeFile(dir, 'services/backend/src/models/Instrument.js',
        "module.exports = require('../../../../software/khyquant/models/Instrument');\n");
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 0, stdout);
    // 断言计数为 0 而不是「输出里没有这个 id」—— counts 行永远会列出 id。
    assert.match(stdout, /"cross-layer-require":0/);
    assert.match(stdout, /"_reexport-shims":1/);
  });

  test('cross-layer-require: 注释里举例的路径不算违规', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, 'services/backend/package.json', '{"name":"backend"}\n');
      writeFile(dir, 'services/backend/src/utils/parseBoolean.js', 'module.exports = () => true;\n');
      writeFile(dir, 'services/ai-backend/package.json', '{"name":"ai-backend"}\n');
      writeFile(dir, 'services/ai-backend/src/notes.js',
        '/**\n * 反例：不要写 require(\'../../../backend/src/utils/parseBoolean\')。\n */\n'
        + "// 也不要 require('../../../backend/src/utils/parseBoolean')\nmodule.exports = {};\n");
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /"cross-layer-require":0/);
    assert.match(stdout, /"unresolved-require":0/);
  });

  test('unresolved-require: 指向不存在路径的深层 require 被单独报出', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, 'software/khyquant/package.json', '{"name":"khyquant"}\n');
      writeFile(dir, 'software/khyquant/services/marketDataService.js', 'module.exports = {};\n');
      // 少算一级 ../：从 handlers/ 出发解析到 software/services/…（不存在）。
      writeFile(dir, 'software/khyquant/handlers/data.js',
        "const svc = require('../../services/marketDataService');\nmodule.exports = { svc };\n");
    });
    const { status, stdout } = runGuard(root, ['--list=unresolved-require']);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /unresolved-require/);
    assert.match(stdout, /software\/services\/marketDataService/);
  });
});

describe('check-repo-layout: 拓展契约（[DESIGN-ARCH-069]）', () => {
  // 合规拓展的最小形状：canonical manifest + id 等于目录名 + main 在磁盘上。
  function writeExtension(dir, id, manifest, { withEntry = true } = {}) {
    writeFile(dir, `extensions/${id}/khy.extension.json`, `${JSON.stringify(manifest, null, 2)}\n`);
    if (withEntry && manifest.main) {
      writeFile(dir, `extensions/${id}/${manifest.main}`, 'module.exports = { activate() {} };\n');
    }
  }

  test('合规拓展不计违规', () => {
    const root = makeFixture((dir) => {
      writeExtension(dir, 'khy-demo', { id: 'khy-demo', name: 'Demo', version: '1.0.0', kind: 'runtime', main: 'index.js' });
      // kind: ide-bridge 不需要 main —— 核不激活它。
      writeExtension(dir, 'khy-bridge', { id: 'khy-bridge', name: 'Bridge', version: '1.0.0', kind: 'ide-bridge' });
      // kind 缺省即 runtime，合规拓展可以不写这一字段。
      writeExtension(dir, 'khy-plain', { id: 'khy-plain', name: 'Plain', version: '1.0.0', main: 'main.js' });
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /"extension-contract":0/);
  });

  test('缺 khy.extension.json 的目录被计入', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, 'extensions/khy-nomanifest/index.js', 'module.exports = {};\n');
    });
    const { status, stdout } = runGuard(root, ['--list=extension-contract']);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /"extension-contract":1/);
    assert.match(stdout, /khy-nomanifest/);
  });

  test('id 与目录名不一致被计入', () => {
    const root = makeFixture((dir) => {
      writeExtension(dir, 'khy-dir', { id: 'khy-other', name: 'X', version: '1.0.0', kind: 'runtime', main: 'index.js' });
    });
    const { status, stdout } = runGuard(root, ['--list=extension-contract']);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /"extension-contract":1/);
    assert.match(stdout, /khy-other/);
  });

  test('kind 非法被计入', () => {
    const root = makeFixture((dir) => {
      writeExtension(dir, 'khy-weird', { id: 'khy-weird', name: 'X', version: '1.0.0', kind: 'plugin', main: 'index.js' });
    });
    const { status, stdout } = runGuard(root, ['--list=extension-contract']);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /"extension-contract":1/);
    assert.match(stdout, /khy-weird/);
  });

  test('runtime 拓展的 main 指向空气被计入', () => {
    const root = makeFixture((dir) => {
      writeExtension(dir, 'khy-ghostmain',
        { id: 'khy-ghostmain', name: 'X', version: '1.0.0', kind: 'runtime', main: 'index.js' },
        { withEntry: false });
    });
    const { status, stdout } = runGuard(root, ['--list=extension-contract']);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /"extension-contract":1/);
    assert.match(stdout, /khy-ghostmain/);
  });

  test('坏 JSON 与缺 manifest 区分得开（都计一处，但原因不同）', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, 'extensions/khy-badjson/khy.extension.json', '{ "id": "khy-badjson", \n');
    });
    const { status, stdout } = runGuard(root, ['--list=extension-contract']);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /"extension-contract":1/);
    assert.match(stdout, /khy-badjson/);
    // 「解析失败」必须与「缺失」措辞不同，否则修的人会去建一个已经存在的文件。
    assert.doesNotMatch(stdout, /khy-badjson[^\n]*缺/);
  });

  test('超基线 → extension-contract 升为 error', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, 'extensions/khy-nomanifest/index.js', 'module.exports = {};\n');
      writeFile(dir, 'scripts/ci/repo-layout-baseline.json',
        `${JSON.stringify({ updated: '2026-01-01', counts: { 'dangling-task': 0, 'cross-layer-require': 0, 'unresolved-require': 0, 'docs-index-complete': 0, 'extension-contract': 0 } }, null, 2)}\n`);
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /extension-contract/);
    assert.match(stdout, /promoted from warning/);
  });
});

describe('check-repo-layout: 基线棘轮与参数校验', () => {
  test('实测数超过基线 → 该 warning 升为 error', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, 'docs/03_DESIGN_设计/[DESIGN-ARCH-002] 验收.md', '`npm run gate:release` `npm run arch:god`\n');
      writeFile(dir, 'scripts/ci/repo-layout-baseline.json',
        `${JSON.stringify({ updated: '2026-01-01', counts: { 'dangling-task': 1, 'cross-layer-require': 0, 'unresolved-require': 0 } }, null, 2)}\n`);
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /超出基线/);
    assert.match(stdout, /promoted from warning/);
  });

  test('实测数等于基线 → 不阻断', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, 'docs/03_DESIGN_设计/[DESIGN-ARCH-002] 验收.md', '`npm run gate:release`\n');
      writeFile(dir, 'scripts/ci/repo-layout-baseline.json',
        `${JSON.stringify({ updated: '2026-01-01', counts: { 'dangling-task': 1, 'cross-layer-require': 0, 'unresolved-require': 0 } }, null, 2)}\n`);
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 0, stdout);
    assert.doesNotMatch(stdout, /超出基线/);
  });

  test('--update-baseline 写回实测数并保留 _ 前缀说明字段', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, 'docs/03_DESIGN_设计/[DESIGN-ARCH-002] 验收.md', '`npm run gate:release`\n');
      writeFile(dir, 'scripts/ci/repo-layout-baseline.json',
        `${JSON.stringify({ _note: '只降不升', updated: '2026-01-01', counts: { 'dangling-task': 999 } }, null, 2)}\n`);
    });
    const { status, stdout } = runGuard(root, ['--update-baseline']);
    assert.equal(status, 0, stdout);

    const written = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'ci', 'repo-layout-baseline.json'), 'utf8'));
    assert.equal(written._note, '只降不升');
    assert.equal(written.counts['dangling-task'], 1);
    assert.equal(written.counts['cross-layer-require'], 0);
    assert.equal(written.counts['unresolved-require'], 0);
  });

  test('--strict-warnings 把全部 warning 升为 error', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, 'docs/03_DESIGN_设计/[DESIGN-ARCH-002] 验收.md', '`npm run gate:release`\n');
    });
    const { status } = runGuard(root, ['--strict-warnings']);
    assert.equal(status, 1);
  });

  test('未知的 --promote id 以退出码 2 失败（不静默放过拼写错误）', () => {
    const root = makeFixture();
    const { status, stdout } = runGuard(root, ['--promote=root-whitelis']);
    assert.equal(status, 2, stdout);
    assert.match(stdout, /未知的 --promote \/ --list id/);
    assert.match(stdout, /root-whitelist/);
  });

  test('未知的 --list id 同样以退出码 2 失败', () => {
    const root = makeFixture();
    const { status } = runGuard(root, ['--list=danglingtask']);
    assert.equal(status, 2);
  });
});

describe('check-repo-layout: 拓展分类目录（[DESIGN-ARCH-069] §2.3）', () => {
  // 分类是为「二十几个拓展平铺在 extensions/ 下没法管」加的一层布局。守卫在这里管两件
  // 加载器**故意不管**的事：分类名不许随手新造，分类目录下不许再套一层。
  // 加载器只认「有没有 manifest」，任何空壳目录都能当分类 —— 收敛分类名属仓库卫生。
  function writeNested(dir, category, id, extra = {}) {
    writeFile(dir, `extensions/${category}/${id}/khy.extension.json`,
      `${JSON.stringify({ id, name: id, version: '1.0.0', kind: 'runtime', main: 'index.js', ...extra }, null, 2)}\n`);
    writeFile(dir, `extensions/${category}/${id}/index.js`, 'module.exports = {};\n');
  }

  test('分类目录下的合规拓展不计违规', () => {
    const root = makeFixture((dir) => {
      writeNested(dir, 'tools', 'khy-demo');
      writeNested(dir, 'protocols', 'khy-proto');
      // 顶层与分类可以共存：分类是布局手段，不是强制层。
      writeFile(dir, 'extensions/khy-top/khy.extension.json',
        `${JSON.stringify({ id: 'khy-top', name: 'Top', version: '1.0.0', kind: 'ide-bridge' }, null, 2)}\n`);
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /"extension-contract":0/);
  });

  test('分类名不在白名单里被计入 —— 否则 extensions/ 会长出一棵没人说得清的树', () => {
    const root = makeFixture((dir) => {
      writeNested(dir, 'misc', 'khy-demo');
    });
    const { status, stdout } = runGuard(root, ['--list=extension-contract']);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /"extension-contract":1/);
    assert.match(stdout, /extensions\/misc —— 分类名不在/);
  });

  test('分类目录下再套一层被计入 —— 发现只下探两层，第三层等于不存在', () => {
    const root = makeFixture((dir) => {
      writeNested(dir, 'tools', 'khy-demo');
      writeFile(dir, 'extensions/tools/sub/khy-deep/khy.extension.json', '{}\n');
    });
    const { status, stdout } = runGuard(root, ['--list=extension-contract']);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /"extension-contract":1/);
    assert.match(stdout, /extensions\/tools\/sub —— 缺 khy\.extension\.json/);
  });

  test('既不是拓展也不是分类的目录被计入', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, 'extensions/khy-mystery/README.md', '# 说不清是什么\n');
    });
    const { status, stdout } = runGuard(root, ['--list=extension-contract']);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /"extension-contract":1/);
    assert.match(stdout, /既不是拓展.*也不是分类目录/);
  });

  test('分类下的 id 必须等于叶子目录名，不含分类前缀', () => {
    // 反过来写（id: 'tools/khy-demo'）是迁移时最容易犯的错：看着「更完整」，
    // 实际把 state 键、冲突键与孤儿检测键一起改掉了。
    const root = makeFixture((dir) => {
      writeFile(dir, 'extensions/tools/khy-demo/khy.extension.json',
        `${JSON.stringify({ id: 'tools/khy-demo', name: 'D', version: '1.0.0', kind: 'runtime', main: 'index.js' }, null, 2)}\n`);
      writeFile(dir, 'extensions/tools/khy-demo/index.js', 'module.exports = {};\n');
    });
    const { status, stdout } = runGuard(root, ['--list=extension-contract']);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /"extension-contract":1/);
    assert.match(stdout, /id \("tools\/khy-demo"\) 与目录名不一致/);
  });

  test('核里硬编码分类目录下的拓展 id 同样被抓 —— 分类不是规则的盲区', () => {
    // 这条是分类改造最隐蔽的回归：id 枚举若还只看一层，一批拓展移进分类目录后
    // 「核里不许点名拓展 id」这条守卫就静默变成空转，而计数依然是 0。
    const root = makeFixture((dir) => {
      writeNested(dir, 'tools', 'khy-demo');
      writeFile(dir, 'services/backend/src/x.js', `const DIR = 'khy-demo';\n`);
    });
    const { status, stdout } = runGuard(root, ['--list=extension-id-hardcode']);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /"extension-id-hardcode":1/);
    assert.match(stdout, /src\/x\.js:1/);
  });
});

describe('check-repo-layout: 核不得硬编码拓展 id（[DESIGN-ARCH-069] §1.3 第四条）', () => {
  // 每个用例都要有一个「已存在的拓展」，规则才有 id 可查。
  function withDemoExtension(dir) {
    writeFile(dir, 'extensions/khy-demo/khy.extension.json',
      `${JSON.stringify({ id: 'khy-demo', name: 'Demo', version: '1.0.0', kind: 'runtime', main: 'index.js' }, null, 2)}\n`);
    writeFile(dir, 'extensions/khy-demo/index.js', 'module.exports = {};\n');
  }
  function core(dir, body) {
    writeFile(dir, 'services/backend/src/x.js', body);
  }

  test('核里没有 id 字面量 → 零违规', () => {
    const root = makeFixture((dir) => {
      withDemoExtension(dir);
      core(dir, `const d = require('./svc').findProvider('demo-service');\n`);
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /"extension-id-hardcode":0/);
  });

  test('代码里的 id 字面量被计入，且指出行号', () => {
    const root = makeFixture((dir) => {
      withDemoExtension(dir);
      core(dir, `const DIR = 'khy-demo';\n`);
    });
    const { status, stdout } = runGuard(root, ['--list=extension-id-hardcode']);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /"extension-id-hardcode":1/);
    assert.match(stdout, /src\/x\.js:1/);
  });

  // 这是本规则最容易做错的地方：第一版逐行剥离注释，而 JSDoc 续行（`  * 复用 khy-demo`）
  // 本身没有任何注释标记，于是真实仓库 6 个命中里 5 个是误报。块注释状态必须跨行保持。
  test('注释里的 id 不计（含跨行 JSDoc 续行）', () => {
    const root = makeFixture((dir) => {
      withDemoExtension(dir);
      core(dir, [
        '/**',
        ' * 底层复用 khy-demo 拓展（extensions/khy-demo/）。',
        ' * Pattern mirrors extensions/khy-demo/index.js',
        ' */',
        '// 行注释里也提一次 khy-demo',
        'const ok = 1; /* 块注释 khy-demo */',
        '',
      ].join(String.fromCharCode(10)));
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /"extension-id-hardcode":0/);
  });

  test('含中文的提示文案不计（禁掉它只会让报错变模糊）', () => {
    const root = makeFixture((dir) => {
      withDemoExtension(dir);
      core(dir, `printError('未找到 khy-demo 拓展，请先安装。');\n`);
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /"extension-id-hardcode":0/);
  });

  test('kind: ide-bridge 的 id 不计（其路径由外部 IDE 决定，改服务名也影响不了）', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, 'extensions/khy-ide/khy.extension.json',
        `${JSON.stringify({ id: 'khy-ide', name: 'IDE', version: '1.0.0', kind: 'ide-bridge' }, null, 2)}\n`);
      core(dir, `const p = path.join(globalStorage, 'khy-ide', 'auth.json');\n`);
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /"extension-id-hardcode":0/);
  });

  test('超基线（基线 0）→ 升为 error', () => {
    const root = makeFixture((dir) => {
      withDemoExtension(dir);
      core(dir, `const DIR = 'khy-demo';\n`);
      writeFile(dir, 'scripts/ci/repo-layout-baseline.json',
        `${JSON.stringify({ updated: '2026-01-01', counts: { 'extension-id-hardcode': 0 } }, null, 2)}\n`);
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /超出基线/);
  });
});

describe('check-repo-layout: 拓展路径漂移（搬目录搬坏了）', () => {
  // 这一组盯的是「文件被挪深一层，路径算术没跟着改」这一类。它在本仓库真实发生过：
  // scripts/<子目录>/x.js 迁到 extensions/scripts/<id>/x.js 之后，`../lib/y` 和
  // `path.resolve(__dirname,'..','..')` 全部指错，而后者**不抛任何错**。
  function ext(dir, id, files) {
    writeFile(dir, `extensions/scripts/${id}/khy.extension.json`,
      `${JSON.stringify({ id, name: id, version: '1.0.0', kind: 'toolchain', commands: [] }, null, 2)}\n`);
    for (const [rel, body] of Object.entries(files)) writeFile(dir, `extensions/scripts/${id}/${rel}`, body);
  }

  test('路径都对得上时不计违规', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, 'scripts/lib/thing.js', 'module.exports = {};\n');
      ext(dir, 'khy-ok', {
        'run.js': "const t = require('../../../scripts/lib/thing');\nconst ROOT = require('path').resolve(__dirname, '..', '..', '..');\n",
      });
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /"extension-path-drift":0/);
  });

  test('单层相对 require 指空 → 计入（unresolved-require 只看 ../../ 起步，够不着这里）', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, 'scripts/lib/thing.js', 'module.exports = {};\n');
      ext(dir, 'khy-req', { 'run.js': "const t = require('../lib/thing');\n" });
    });
    const { status, stdout } = runGuard(root, ['--list=extension-path-drift']);
    assert.match(stdout, /"extension-path-drift":1/);
    assert.match(stdout, /khy-req\/run\.js/);
    assert.match(stdout, /"unresolved-require":0/, '正是 unresolved-require 的盲区，所以才要单列一条');
  });

  test('爬根少算一级（落在 extensions/）→ 计入，哪怕那个目录真实存在', () => {
    // 这条是整组的理由：extensions/ 是存在的，所以任何「路径存不存在」式的检查
    // 都看不见这处漂移 —— 它不报错，只是从此把仓库根认成了 extensions/。
    const root = makeFixture((dir) => {
      ext(dir, 'khy-short', { 'run.js': "const ROOT = require('path').resolve(__dirname, '..', '..');\n" });
    });
    const { status, stdout } = runGuard(root, ['--list=extension-path-drift']);
    assert.match(stdout, /"extension-path-drift":1/);
    assert.match(stdout, /既不是仓库根也不在本拓展内/);
  });

  test('爬根多算一级（爬出仓库）→ 计入', () => {
    const root = makeFixture((dir) => {
      ext(dir, 'khy-long', { 'run.js': "const ROOT = require('path').resolve(__dirname, '..', '..', '..', '..');\n" });
    });
    const { status, stdout } = runGuard(root, ['--list=extension-path-drift']);
    assert.match(stdout, /"extension-path-drift":1/);
  });

  test('爬到本拓展自己的根 → 不计违规', () => {
    // 拓展内部的 test/ 往上一层拿包目录当 root 是正当写法，不能误报。
    const root = makeFixture((dir) => {
      ext(dir, 'khy-self', { 'test/smoke.js': "const ROOT = require('path').join(__dirname, '..');\n" });
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /"extension-path-drift":0/);
  });

  test('脚本旁边的相对路径（不含 ..）与深度无关 → 不计违规', () => {
    // 运行时自建的输出目录属于这一类，误报它会逼着人给规则加豁免名单。
    const root = makeFixture((dir) => {
      ext(dir, 'khy-side', { 'run.js': "const OUT = require('path').join(__dirname, 'traces');\n" });
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /"extension-path-drift":0/);
  });

  test('注释里举例的路径不计违规', () => {
    const root = makeFixture((dir) => {
      ext(dir, 'khy-cmt', { 'run.js': "// 迁移前写的是 require('../lib/thing')\nmodule.exports = {};\n" });
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /"extension-path-drift":0/);
  });

  test('超基线（基线 0）→ 升为 error', () => {
    const root = makeFixture((dir) => {
      ext(dir, 'khy-reg', { 'run.js': "const ROOT = require('path').resolve(__dirname, '..', '..');\n" });
      writeFile(dir, 'scripts/ci/repo-layout-baseline.json',
        `${JSON.stringify({ updated: '2026-01-01', counts: { 'extension-path-drift': 0 } }, null, 2)}\n`);
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /超出基线/);
  });
});
