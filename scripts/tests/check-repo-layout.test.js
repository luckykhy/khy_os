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
  for (const cross of ['scripts', 'packaging', 'alpine', '_source']) {
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
