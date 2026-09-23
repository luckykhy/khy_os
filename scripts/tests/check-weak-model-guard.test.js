'use strict';

/**
 * scripts/ci/check-weak-model-guard.js 的规则测试。
 *
 * 刻意不**只**对着真实仓库跑：真仓库上的绿色只会说明「今天的载体正好没问题」，
 * 测不出规则逻辑。这里每个负例都建一个临时 fixture，把载体改成一处**已知的坏形态**，
 * 好让断言指向单一原因；最后再补一条真仓库冒烟，防止检查器自己变成永久红灯。
 *
 * 上一轮的教训正是这条：check-permission-invariants 的第一版把「yolo 别名分支」
 * 误当成「未知档兜底」，在真仓库上一片绿却报错了别的东西——只有 fixture 负例
 * 能把这种「测了个寂寞」挡下来。
 *
 * 变异一律用字符串替换，不重写一份平行实现：fixture 载体直接抄真仓载体再定点改坏，
 * 这样测的是守卫，而不是抄错的那份平行实现。
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'check-weak-model-guard.js');
const CARRIER_REL = 'services/backend/src/services/weakModelChangeGuard.js';
const CALLER_REL = 'services/backend/src/services/toolLoop.js';
const tempDirs = [];

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function writeFile(root, relPath, content) {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

// 删掉包含 needle 的整行。正则字面量在 JS 里转义地狱，按行删是最稳的变异方式。
function dropLine(text, needle) {
  return text.split('\n').filter((l) => !l.includes(needle)).join('\n');
}

const REAL_CARRIER = fs.readFileSync(path.join(ROOT, CARRIER_REL), 'utf8');

// 调用点抄 toolUseLoopCore.js 的真实用法：只投递提醒文案，从不读 allow。
const CALLER = `
const _wmg = require('./weakModelChangeGuard');
const adv = _wmg.buildWeakModelAdvisory({ modelId: 'x', filePath: f });
if (adv) { console.log(adv.humanLine); }
`;

function makeFixture(mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-wmg-'));
  tempDirs.push(root);

  let carrier = REAL_CARRIER;
  if (mutate) carrier = mutate(carrier);

  writeFile(root, CARRIER_REL, carrier);
  writeFile(root, CALLER_REL, CALLER);
  return root;
}

function runGuard(root, extraArgs = []) {
  const result = cp.spawnSync(process.execPath, [SCRIPT, ...extraArgs], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, KHY_PERMISSION_MODE: '', KHY_SYSCALL_GATEWAY: '' },
  });
  return {
    status: result.status,
    stdout: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

describe('check-weak-model-guard: 干净基线', () => {
  test('未改动的载体 + 有调用点 → 0 error（exit 0）', () => {
    const { status, stdout } = runGuard(makeFixture());
    assert.equal(status, 0, stdout);
    assert.match(stdout, /Summary: 0 error\(s\)/);
  });

  test('warning 不阻断，只有 --strict-warnings 才红', () => {
    const root = makeFixture();
    assert.equal(runGuard(root).status, 0);
    const { status, stdout } = runGuard(root, ['--strict-warnings']);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /warning\(s\)/);
  });
});

describe('check-weak-model-guard: 分类覆盖', () => {
  test('删掉一类红线正则 → guard-category-uncovered 且 exit 1', () => {
    const root = makeFixture((t) => dropLine(t, 'flagRegistry'));
    const { status, stdout } = runGuard(root);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /\[ERROR\] guard-category-uncovered/);
    assert.match(stdout, /flagRegistry SSOT/);
  });

  test('红线列表整体清空 → 6 类全报未覆盖', () => {
    const root = makeFixture((t) => t.replace(
      /const RED_LINE_PATTERNS = \[[\s\S]*?\];/,
      'const RED_LINE_PATTERNS = [];'));
    const { status, stdout } = runGuard(root);
    assert.equal(status, 1, stdout);
    const hits = (stdout.match(/guard-category-uncovered/g) || []).length;
    assert.ok(hits >= 6, `期望 6 类全部命中，实测 ${hits}：\n${stdout}`);
  });

  test('红线正则被改宽到匹配一切 → 普通文件被误拦，精度回归以 warning 报出', () => {
    // 精度回归按设计是 warning 而非 error：改宽红线不会让红线本体失效，
    // 只是让弱模型每次日常编辑都被拦。断言它确实被看见，而不是静默放行。
    const root = makeFixture((t) => t.replace(
      'const RED_LINE_PATTERNS = [',
      'const RED_LINE_PATTERNS = [/.*/, '));
    const { status, stdout } = runGuard(root);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /\[WARN \] guard-normal-nagged/);
    assert.match(stdout, /\[WARN \] guard-sensitive-misclassified/);
  });
});

describe('check-weak-model-guard: 裁决矩阵', () => {
  test('弱档+红线被放成 allow:true → guard-weak-redline-allowed', () => {
    const root = makeFixture((t) => t.replace('allow: false,', 'allow: true,'));
    const { status, stdout } = runGuard(root);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /\[ERROR\] guard-weak-redline-allowed/);
    assert.match(stdout, /allow=true/);
  });

  test('require-strong-review 动作串被改掉 → 同一负例被捕获', () => {
    const root = makeFixture((t) => t.replace(
      "action: 'require-strong-review',",
      "action: 'just-review',"));
    const { status, stdout } = runGuard(root);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /\[ERROR\] guard-weak-redline-allowed/);
    assert.match(stdout, /just-review/);
  });

  test('敏感核心漏了 requireConfirm → guard-sensitive-not-confirmed', () => {
    const root = makeFixture((t) => t.replace(
      /requireConfirm: true,/g, 'requireConfirm: false,'));
    const { status, stdout } = runGuard(root);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /\[ERROR\] guard-sensitive-not-confirmed/);
    assert.match(stdout, /requireConfirm=false/);
  });
});

describe('check-weak-model-guard: 旁路与接线', () => {
  test('权限旁路能关掉护栏 → guard-env-dependent', () => {
    const root = makeFixture((t) => t.replace(
      "const raw = e.KHY_WEAK_MODEL_EDIT_GUARD;",
      "if (e.KHY_PERMISSION_MODE === 'yolo') return false;\n    const raw = e.KHY_WEAK_MODEL_EDIT_GUARD;"));
    const { status, stdout } = runGuard(root);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /\[ERROR\] guard-env-dependent/);
    assert.match(stdout, /yolo/);
  });

  test('护栏没人调用（死代码）→ guard-not-wired', () => {
    const root = makeFixture();
    fs.rmSync(path.join(root, CALLER_REL));
    const { status, stdout } = runGuard(root);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /\[ERROR\] guard-not-wired/);
    assert.match(stdout, /死代码/);
  });

  test('调用点真的读 allow 做硬拦截 → 不再报契约漂移 warning', () => {
    const root = makeFixture();
    writeFile(root, CALLER_REL, `
const _wmg = require('./weakModelChangeGuard');
const v = _wmg.assessWeakModelChange({ modelId: 'x', filePath: f });
if (v && v.allow === false) { throw new Error('blocked'); }
`);
    const { status, stdout } = runGuard(root);
    assert.equal(status, 0, stdout);
    assert.doesNotMatch(stdout, /guard-declared-deny-unconsumed/);
  });

  test('只在注释里提到护栏名字 ≠ 接线', () => {
    const root = makeFixture();
    fs.rmSync(path.join(root, CALLER_REL));
    writeFile(root, 'services/backend/src/notes.js',
      '// weakModelChangeGuard: 我们以后再接\n');
    const { status, stdout } = runGuard(root);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /\[ERROR\] guard-not-wired/);
  });
});

describe('check-weak-model-guard: 契约', () => {
  test('载体不存在 → guard-module-missing，不抛栈', () => {
    const root = makeFixture();
    fs.rmSync(path.join(root, CARRIER_REL));
    const { status, stdout } = runGuard(root);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /\[ERROR\] guard-module-missing/);
    assert.doesNotMatch(stdout, /TypeError|ReferenceError|UnhandledPromise/);
  });

  test('入参不全必须 fail-soft 返 null', () => {
    const root = makeFixture((t) => t.replace(
      "if (!filePath || typeof filePath !== 'string') {\n      return null;\n    }",
      "if (!filePath || typeof filePath !== 'string') {\n      return { allow: true };\n    }"));
    const { status, stdout } = runGuard(root);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /\[ERROR\] guard-no-failsoft/);
  });
});

describe('check-weak-model-guard: 真仓库冒烟', () => {
  // 这条不是规则测试，是防退化护栏：检查器输出格式一旦坏了，ruleguard 会把整个
  // SECURITY-003 降级成一条不透明的 checker-failure。
  test('真仓库 0 error（exit 0），且契约漂移 warning 计数不变静地绿', () => {
    const { status, stdout } = runGuard(ROOT);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /Summary: 0 error\(s\), 1 warning\(s\)\./);
    assert.match(stdout, /guard-declared-deny-unconsumed/);
    assert.match(stdout, /toolUseLoopCore\.js/);
  });
});
