'use strict';

/**
 * scripts/ci/check-pattern-coverage.js 的规则测试。
 *
 * 刻意**不**对着真实仓库跑：真仓库的未覆盖数（当前 2705）会随补标注进度变化，
 * 那样的测试「基线一改就绿」，测不出规则逻辑。这里每个用例建一个临时 git 仓库
 * 当 fixture，通过 KHY_PATTERN_COVERAGE_ROOT 把守卫指过去。
 *
 * 上一轮的教训正是这条：`git ls-files 'dir/**\/*.js'` 的 pathspec 用法在真仓库上
 * 「看起来能跑」，直到有人查了数才发现它一个文件都没匹配。一条没有 fixture 测试
 * 的守卫规则，会在无人察觉的情况下静默变成空转。
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'check-pattern-coverage.js');
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
 * 建一个最小可通过的 fixture 仓库：两个源文件、两条对应的注册表条目、
 * 一份三项全 0 的基线。各用例在此基础上**只加一处**问题，好让断言指向单一原因。
 *
 * 注意 `git add -A`：守卫的真源是 git 索引而不是磁盘，未 add 的文件它看不见——
 * fixture 必须走一遍 add，否则每个用例都会「全绿」而测不出任何东西。
 */
function makeFixture(mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-pattern-'));
  tempDirs.push(root);

  writeFile(root, 'services/backend/src/a.js', '// a\n');
  writeFile(root, 'services/backend/src/b.js', '// b\n');
  writeRegistry(root, {
    'services/backend/src/a.js': ['Facade'],
    'services/backend/src/b.js': ['Strategy', 'Observer'],
  });
  writeBaseline(root, { 'pattern-uncovered': 0, 'pattern-ghost': 0, 'pattern-invalid': 0 });

  if (mutate) mutate(root);

  cp.execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  cp.execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
  return root;
}

function writeRegistry(root, obj) {
  writeFile(root, 'docs/_设计模式/模式注册表.json', JSON.stringify(obj, null, 2) + '\n');
}

function writeBaseline(root, counts) {
  writeFile(root, 'scripts/ci/pattern-coverage-baseline.json',
    JSON.stringify({ _note: 'fixture', updated: '2026-08-19', counts }, null, 2) + '\n');
}

function runGuard(root, extraArgs = []) {
  const result = cp.spawnSync(process.execPath, [SCRIPT, ...extraArgs], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, KHY_PATTERN_COVERAGE_ROOT: root },
  });
  return {
    status: result.status,
    stdout: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

describe('check-pattern-coverage: 规则命中', () => {
  test('干净 fixture 全绿，退出码 0', () => {
    const root = makeFixture();
    const { status, stdout } = runGuard(root);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /全绿/);
    assert.match(stdout, /"pattern-uncovered":0/);
  });

  test('pattern-uncovered: 跟踪的源文件没有条目即计数', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, 'services/backend/src/c.js', '// 没有注册表条目\n');
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /"pattern-uncovered":1/);
    assert.match(stdout, /\[error\]/);
    assert.match(stdout, /超出基线（基线 0，实测 1）/);
  });

  test('pattern-ghost: 条目指向磁盘上不存在的文件即计数', () => {
    const root = makeFixture((dir) => {
      writeRegistry(dir, {
        'services/backend/src/a.js': ['Facade'],
        'services/backend/src/b.js': ['Strategy', 'Observer'],
        'frontend/deleted.js': ['Proxy'],
      });
    });
    const { status, stdout } = runGuard(root, ['--list=pattern-ghost']);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /"pattern-ghost":1/);
    assert.match(stdout, /frontend\/deleted\.js/);
  });

  test('pattern-invalid: 非 GoF 23 的模式名与空列表都计数', () => {
    const root = makeFixture((dir) => {
      writeRegistry(dir, {
        'services/backend/src/a.js': ['Service Locator'],
        'services/backend/src/b.js': [],
      });
    });
    const { status, stdout } = runGuard(root, ['--list=pattern-invalid']);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /"pattern-invalid":2/);
    assert.match(stdout, /Service Locator/);
    assert.match(stdout, /空模式列表/);
  });
});

describe('check-pattern-coverage: 扫描范围', () => {
  test('未被 git 跟踪的文件不计入 —— 真源是 git 而不是文件系统', () => {
    // 这是本守卫改写的核心：旧版用 find 扫盘，把 .venv 下 3232 个第三方包
    // 算成「本仓待标注的源文件」。fixture 里放一个 .venv 且不 add，计数须不变。
    const root = makeFixture();
    writeFile(root, 'tools/eyes/.venv/lib/site-packages/requests/api.py', '# 第三方\n');
    const { status, stdout } = runGuard(root);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /"pattern-uncovered":0/);
  });

  test('测试文件与 vendor/ 产物不参与标注', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, 'services/backend/tests/foo.js', '// 测试\n');
      writeFile(dir, 'services/backend/src/bar.test.js', '// 测试\n');
      writeFile(dir, 'apps/web/vendor/lib.js', '// 第三方\n');
      writeFile(dir, 'apps/web/dist/app.min.js', '// 压缩产物\n');
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /"pattern-uncovered":0/);
  });

  test('非源码扩展名不参与标注', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, 'services/backend/src/data.json', '{}\n');
      writeFile(dir, 'services/backend/src/notes.md', '# 说明\n');
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /"pattern-uncovered":0/);
  });
});

describe('check-pattern-coverage: 棘轮', () => {
  test('基线内的存量只是 warning，不阻断', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, 'services/backend/src/c.js', '// 存量未标注\n');
      writeBaseline(dir, { 'pattern-uncovered': 1, 'pattern-ghost': 0, 'pattern-invalid': 0 });
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /\[warning\]/);
    assert.doesNotMatch(stdout, /\[error\]/);
  });

  test('超基线一处即升 error —— 这才是棘轮', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, 'services/backend/src/c.js', '// 存量\n');
      writeFile(dir, 'services/backend/src/d.js', '// 新增，超基线\n');
      writeBaseline(dir, { 'pattern-uncovered': 1, 'pattern-ghost': 0, 'pattern-invalid': 0 });
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /promoted from warning/);
    assert.match(stdout, /超出基线（基线 1，实测 2）/);
  });

  test('低于基线不报错，也不自动下调 —— 下调必须显式', () => {
    const root = makeFixture((dir) => {
      writeBaseline(dir, { 'pattern-uncovered': 5, 'pattern-ghost': 0, 'pattern-invalid': 0 });
    });
    const { status, stdout } = runGuard(root);
    assert.equal(status, 0, stdout);
    const baseline = JSON.parse(
      fs.readFileSync(path.join(root, 'scripts/ci/pattern-coverage-baseline.json'), 'utf8'));
    assert.equal(baseline.counts['pattern-uncovered'], 5, '未传 --update-baseline 时不得改基线文件');
  });

  test('--update-baseline 写回实测值，且保留 _ 前缀的说明字段', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, 'services/backend/src/c.js', '// 未标注\n');
    });
    const { status } = runGuard(root, ['--update-baseline']);
    assert.equal(status, 0);
    const baseline = JSON.parse(
      fs.readFileSync(path.join(root, 'scripts/ci/pattern-coverage-baseline.json'), 'utf8'));
    assert.equal(baseline.counts['pattern-uncovered'], 1);
    assert.equal(baseline._note, 'fixture', '_ 前缀字段是「只降不升」这条约定的解释，不得被写基线顺手删掉');
  });
});

describe('check-pattern-coverage: 用法错误', () => {
  test('未知的 --list id 退 2 并列出可用 id', () => {
    const root = makeFixture();
    const { status, stdout } = runGuard(root, ['--list=pattern-nonexistent']);
    assert.equal(status, 2, stdout);
    assert.match(stdout, /未知的 --list id/);
    assert.match(stdout, /pattern-ghost/);
  });

  test('注册表解析不了退 2，而不是当成「零条目」全库报未覆盖', () => {
    const root = makeFixture((dir) => {
      writeFile(dir, 'docs/_设计模式/模式注册表.json', '{ 坏掉的 json\n');
    });
    const { status, stdout } = runGuard(root, []);
    assert.equal(status, 2, stdout);
    assert.match(stdout, /读不到或解析不了注册表/);
  });
});
