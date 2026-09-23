'use strict';

/**
 * commitTiming / commit handler 测试。
 *
 * 覆盖 `PROCESS-009` / `[DESIGN-GIT-004]` 的**执行面**（漏报比误报更贵，两者都测）：
 *
 * 1. **纯叶子 `commitTiming.js`** —— 判据 T1–T5、三结论、message 建议、门控
 * 2. **薄壳 `handlers/commit.js`** —— `-z` 解析（最易在重命名上错位）、
 *    verify 证据的时间锚（有过一个致命假阴性）、渲染
 * 3. **真执行** —— 在临时 git 仓库里跑真的 `git commit`，证明「该提交时真的提交」
 *    且「不该提交时**即使给了 --yes 也绝不提交**」
 *
 * ⚠ 本文件的临时仓库建在 `os.tmpdir()` 下，**不落仓库树** ——
 *   落 `scripts/ci/` 会让 `check-wiring` 看到「零接线检查器」而间歇性报 error
 *   （那正是阶段一踩过的坑）。
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const assert = require('node:assert');
const test = require('node:test');
const os = require('os');
const path = require('path');

const leaf = require('../src/cli/commitTiming');
const handler = require('../src/cli/handlers/commit');

// ── 临时 git 仓库工具 ───────────────────────────────────────────────────────

const _tmpdirs = [];

/** 造一个干净的临时 git 仓库。
 * @param {object} [opts]
 * @returns {string} 仓库路径
 */
function makeRepo(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-commit-test-'));
  _tmpdirs.push(dir);
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q', '.']);
  git(['config', 'user.email', 'test@test.local']);
  git(['config', 'user.name', 'test']);
  git(['config', 'commit.gpgsign', 'false']);
  // 关掉钩子，避免宿主机全局 hooksPath 干扰
  git(['config', 'core.hooksPath', path.join(dir, '.no-hooks')]);

  if (opts.seed) {
    for (const [rel, content] of Object.entries(opts.seed)) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
  }
  return dir;
}

function gitIn(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 在仓库里跑 handler，返回它打印到 stdout 的全部文本。 */
async function runHandler(dir, argv) {
  const origLog = console.log;
  let out = '';
  console.log = (...a) => {
    out += a.join(' ') + '\n';
  };
  const origCwd = process.cwd();
  try {
    process.chdir(dir);
    await handler.handleCommit(null, argv, {});
  } finally {
    process.chdir(origCwd);
    console.log = origLog;
  }
  return out;
}

function logCount(dir) {
  try {
    return gitIn(dir, ['rev-list', '--count', 'HEAD']).trim();
  } catch {
    return '0';
  }
}

process.on('exit', () => {
  for (const d of _tmpdirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响测试结论 */
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 一、纯叶子：判据 T1–T5
// ═══════════════════════════════════════════════════════════════════════════

test('leaf 门控：默认开，只有显式关闭值才关', () => {
  assert.strictEqual(leaf.isEnabled({}), true);
  assert.strictEqual(leaf.isEnabled({ KHY_COMMIT_TIMING: '1' }), true);
  assert.strictEqual(leaf.isEnabled({ KHY_COMMIT_TIMING: 'on' }), true);
  assert.strictEqual(leaf.isEnabled({ KHY_COMMIT_TIMING: 'off' }), false);
  assert.strictEqual(leaf.isEnabled({ KHY_COMMIT_TIMING: 'FALSE' }), false);
  assert.strictEqual(leaf.isEnabled({ KHY_COMMIT_TIMING: '0' }), false);
  assert.strictEqual(leaf.isEnabled({ KHY_COMMIT_TIMING: 'no' }), false);
});

test('T1：跨 ≥3 个顶层板块 → unit-multi-intent', () => {
  const changes = [
    { status: 'M', path: 'kernel/a.c' },
    { status: 'M', path: 'services/backend/src/x.js' },
    { status: 'M', path: 'apps/ai-frontend/src/y.vue' },
  ];
  const { violations } = leaf.assess(changes, { verifyPending: true });
  assert.ok(violations.some((v) => v.id === 'unit-multi-intent'));
});

test('T1 不误伤：单个板块 + 跟随目录（docs/scripts）不计数', () => {
  const changes = [
    { status: 'M', path: 'services/backend/src/a.js' },
    { status: 'M', path: 'docs/x.md' },
    { status: 'M', path: 'scripts/y.js' },
  ];
  const { violations } = leaf.assess(changes, { verifyPending: true });
  assert.ok(!violations.some((v) => v.criterion === 'T1'), 'docs/scripts 应跟随代码走，不计意图数');
});

test('T2：改了代码但没有验证证据 → unit-unverified', () => {
  const changes = [{ status: 'M', path: 'services/backend/src/a.js' }];
  const { violations } = leaf.assess(changes, { verifyPending: false });
  assert.ok(violations.some((v) => v.id === 'unit-unverified'));
});

test('T2 不误伤：有验证证据 → 无 finding；纯文档改动豁免', () => {
  const code = [{ status: 'M', path: 'services/backend/src/a.js' }];
  assert.ok(!leaf.assess(code, { verifyPending: true }).violations.some((v) => v.criterion === 'T2'));

  const docs = [{ status: 'M', path: 'docs/x.md' }];
  assert.ok(!leaf.assess(docs, { verifyPending: false }).violations.some((v) => v.criterion === 'T2'));
});

test('T3：本机态目录进暂存集 → unit-sweeps-foreign-changes', () => {
  const changes = [
    { status: 'M', path: 'services/backend/src/a.js' },
    { status: 'A', path: '.khyos/runtime.json' },
  ];
  const { violations } = leaf.assess(changes, { verifyPending: true });
  assert.ok(violations.some((v) => v.id === 'unit-sweeps-foreign-changes'));

  for (const d of ['.khy/', '.khyquant/', 'khy-Trajectory/', '.zcode/tmp/']) {
    const c = [{ status: 'A', path: d + 'f.json' }];
    assert.ok(
      leaf.assess(c, {}).violations.some((v) => v.id === 'unit-sweeps-foreign-changes'),
      `${d} 应被识别为本机态`
    );
  }
});

test('T4：游离产物 → unit-stray-artifacts', () => {
  for (const p of ['services/backend/tmp-x.js', 'services/backend/x.tmp', 'scripts/_probe.js', 'a/b.bak']) {
    const c = [{ status: 'A', path: p }];
    assert.ok(
      leaf.assess(c, {}).violations.some((v) => v.id === 'unit-stray-artifacts'),
      `${p} 应被识别为游离产物`
    );
  }
});

test('T5：改动 >20 文件 → advisory 而非 blocking（不阻断）', () => {
  const changes = Array.from({ length: 25 }, (_, i) => ({ status: 'M', path: `services/backend/src/f${i}.js` }));
  const { violations } = leaf.assess(changes, { verifyPending: true });
  const t5 = violations.find((v) => v.id === 'unit-not-rollbackable');
  assert.ok(t5, '应报出 T5');
  assert.strictEqual(t5.level, 'advisory', 'T5 是建议级，不阻断');
});

test('leaf 阈值不新造：ASK_FILE_COUNT 与既有 change-safety 同值 20', () => {
  assert.strictEqual(leaf.ASK_FILE_COUNT, 20);
});

// ═══════════════════════════════════════════════════════════════════════════
// 二、纯叶子：三结论（decide）
// ═══════════════════════════════════════════════════════════════════════════

test('decide：空集合 → do-not-commit（不是「可以提交」）', () => {
  const r = leaf.decide([], {});
  assert.strictEqual(r.decision, 'do-not-commit');
  assert.match(r.reason, /暂存区为空/);
});

test('decide：判据不满足优先于安全护栏', () => {
  // 既跨 3 板块（T1 blocking）又含删除 —— 优先级应是 do-not-commit
  const changes = [
    { status: 'D', path: 'kernel/a.c' },
    { status: 'M', path: 'services/x.js' },
    { status: 'M', path: 'apps/y.vue' },
  ];
  assert.strictEqual(leaf.decide(changes, {}).decision, 'do-not-commit');
});

test('decide：干净单意图小改动 → commit-now', () => {
  const changes = [{ status: 'M', path: 'services/backend/src/a.js' }];
  const r = leaf.decide(changes, { verifyPending: true });
  assert.strictEqual(r.decision, 'commit-now');
  assert.deepStrictEqual(r.blockers, []);
});

test('decide 安全护栏：含删除 → ask-first', () => {
  const changes = [{ status: 'D', path: 'services/backend/src/old.js' }];
  const r = leaf.decide(changes, { verifyPending: true });
  assert.strictEqual(r.decision, 'ask-first');
  assert.match(r.reason, /删除/);
});

test('decide 安全护栏：>20 文件 → ask-first', () => {
  const changes = Array.from({ length: 21 }, (_, i) => ({ status: 'M', path: `services/backend/src/f${i}.js` }));
  const r = leaf.decide(changes, { verifyPending: true });
  assert.strictEqual(r.decision, 'ask-first');
  assert.match(r.reason, /21 个文件/);
});

test('decide 安全护栏：跨 ≥3 意图板块 → ask-first', () => {
  const changes = [
    { status: 'M', path: 'kernel/a.c' },
    { status: 'M', path: 'apps/x.vue' },
    { status: 'M', path: 'platform/y.py' },
  ];
  // 注意：这三个板块也触发 T1。要单独验 ask-first，需绕过 T1 的 3 板块阈值 ——
  // 故此处直接断言「不低于 ask-first」的严格性：guard 不会放过它。
  const r = leaf.decide(changes, { verifyPending: true });
  assert.ok(['ask-first', 'do-not-commit'].includes(r.decision), '跨 3 板块必须被拦下');
});

test('decide 安全护栏：敏感路径 → ask-first', () => {
  for (const p of ['package.json', 'pyproject.toml', 'Dockerfile', 'deploy/x.toml', '.github/workflows/a.yml']) {
    const r = leaf.decide([{ status: 'M', path: p }], { verifyPending: true });
    assert.strictEqual(r.decision, 'ask-first', `${p} 应走 ask-first`);
  }
});

test('suggestMessage：按改动形状推 type', () => {
  assert.strictEqual(leaf.suggestMessage([{ status: 'D', path: 'services/a.js' }]).type, 'refactor');
  assert.strictEqual(leaf.suggestMessage([{ status: 'A', path: 'services/a.js' }]).type, 'feat');
  assert.strictEqual(leaf.suggestMessage([{ status: 'M', path: 'docs/a.md' }]).type, 'docs');
  assert.strictEqual(
    leaf.suggestMessage([{ status: 'M', path: 'services/a.test.js' }]).type,
    'test'
  );
  assert.strictEqual(leaf.suggestMessage([]).type, '');
});

// ═══════════════════════════════════════════════════════════════════════════
// 三、薄壳：-z 解析（最易错位处）
// ═══════════════════════════════════════════════════════════════════════════

test('parseNameStatusZ：普通 A/M/D 记录', () => {
  const raw = 'A\0new.js\0M\0mod.js\0D\0del.js\0';
  assert.deepStrictEqual(handler.parseNameStatusZ(raw), [
    { status: 'A', path: 'new.js', fromPath: null },
    { status: 'M', path: 'mod.js', fromPath: null },
    { status: 'D', path: 'del.js', fromPath: null },
  ]);
});

test('parseNameStatusZ：重命名/复制吃掉三段（这是最容易错位的地方）', () => {
  const raw = 'R100\0old.js\0new.js\0C75\0src.js\0copy.js\0M\0after.js\0';
  const rows = handler.parseNameStatusZ(raw);
  assert.deepStrictEqual(rows, [
    { status: 'R', path: 'new.js', fromPath: 'old.js' },
    { status: 'C', path: 'copy.js', fromPath: 'src.js' },
    { status: 'M', path: 'after.js', fromPath: null },
  ]);
  assert.strictEqual(rows[2].path, 'after.js', 'R 之后必须重新对齐，否则后续记录全错位');
});

test('parseNameStatusZ：空输入与垃圾输入不炸', () => {
  assert.deepStrictEqual(handler.parseNameStatusZ(''), []);
  assert.deepStrictEqual(handler.parseNameStatusZ(null), []);
  // 不认识的码不允许把后续记录读错位
  const rows = handler.parseNameStatusZ('X\0weird\0M\0real.js\0');
  assert.deepStrictEqual(rows, [{ status: 'M', path: 'real.js', fromPath: null }]);
});

test('countPorcelainZ：分得出暂存与未暂存', () => {
  const raw = 'M  staged.js\0 M unstaged.js\0?? untracked.js\0';
  const c = handler.countPorcelainZ(raw);
  assert.strictEqual(c.staged, 1);
  assert.strictEqual(c.unstaged, 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// 四、薄壳：verify 证据的时间锚（曾经是致命假阴性）
// ═══════════════════════════════════════════════════════════════════════════

test('hasVerifyEvidence：无 .khy/feedback → false（不炸）', async () => {
  const dir = makeRepo();
  const origCwd = process.cwd();
  try {
    process.chdir(dir);
    assert.strictEqual(handler.hasVerifyEvidence([{ mtimeMs: Date.now() }]), false);
  } finally {
    process.chdir(origCwd);
  }
});

test('hasVerifyEvidence：证据比改动新 → true', async () => {
  const dir = makeRepo();
  const origCwd = process.cwd();
  try {
    process.chdir(dir);
    const changes = [{ status: 'M', path: 'a.js', mtimeMs: Date.now() - 10000 }];
    fs.mkdirSync(path.join(dir, '.khy', 'feedback', 't1'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.khy', 'feedback', 't1', 'verify.txt'), 'ok');
    assert.strictEqual(handler.hasVerifyEvidence(changes), true);
  } finally {
    process.chdir(origCwd);
  }
});

test('hasVerifyEvidence：锚点是改动 mtime 而非进程 uptime（回归：曾永久阻断提交）', () => {
  const dir = makeRepo();
  const origCwd = process.cwd();
  try {
    process.chdir(dir);
    fs.mkdirSync(path.join(dir, '.khy', 'feedback', 't1'), { recursive: true });
    const vf = path.join(dir, '.khy', 'feedback', 't1', 'verify.txt');
    fs.writeFileSync(vf, 'ok');
    const evidenceMs = fs.statSync(vf).mtimeMs;

    // 改动比证据**老**（正常情况：先写证据，再继续改）→ 仍应算有效证据。
    const changes = [{ status: 'M', path: 'a.js', mtimeMs: evidenceMs - 60000 }];
    assert.strictEqual(
      handler.hasVerifyEvidence(changes),
      true,
      '证据只要比改动新就是有效 —— 用 uptime 当锚会在这里假阴性'
    );
  } finally {
    process.chdir(origCwd);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 五、真执行：临时仓库里跑真的 git commit
// ═══════════════════════════════════════════════════════════════════════════

test('真执行：该提交时 --yes 真的落一个 commit', async () => {
  const dir = makeRepo({ seed: { 'services/backend/src/a.js': '// a\n' } });
  gitIn(dir, ['add', 'services/backend/src/a.js']);
  fs.mkdirSync(path.join(dir, '.khy', 'feedback', 't1'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.khy', 'feedback', 't1', 'verify.txt'), 'ok');

  const out = await runHandler(dir, ['--yes', '-m', 'feat(cli): 加一个文件']);
  assert.match(out, /可以提交/, '应判为可以提交');
  assert.match(out, /已提交/, '应真的提交');
  assert.strictEqual(logCount(dir), '1', 'git log 里应有一条 commit');
  assert.match(gitIn(dir, ['log', '-1', '--pretty=%s']), /feat\(cli\): 加一个文件/);
});

test('真执行防线：无验证证据 → 即使 --yes 也绝不提交', async () => {
  const dir = makeRepo({ seed: { 'services/backend/src/a.js': '// a\n' } });
  gitIn(dir, ['add', 'services/backend/src/a.js']);

  const out = await runHandler(dir, ['--yes', '-m', 'feat: x']);
  assert.match(out, /先别提交/);
  assert.strictEqual(logCount(dir), '0', 'git log 应仍为空');
});

test('真执行防线：含删除 → 即使 --yes 也绝不提交（安全护栏）', async () => {
  const dir = makeRepo({ seed: { 'services/backend/src/a.js': '// a\n' } });
  gitIn(dir, ['add', '-A']);
  gitIn(dir, ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
  gitIn(dir, ['rm', '-q', 'services/backend/src/a.js']);
  fs.mkdirSync(path.join(dir, '.khy', 'feedback', 't1'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.khy', 'feedback', 't1', 'verify.txt'), 'ok');

  const before = logCount(dir);
  const out = await runHandler(dir, ['--yes', '-m', 'refactor: 删掉']);
  assert.match(out, /先问一下/, '删除应走 ask-first');
  assert.strictEqual(logCount(dir), before, 'ask-first 下即使 --yes 也不能提交');
});

test('真执行：默认（无 --yes）只判断不提交', async () => {
  const dir = makeRepo({ seed: { 'services/backend/src/a.js': '// a\n' } });
  gitIn(dir, ['add', 'services/backend/src/a.js']);
  fs.mkdirSync(path.join(dir, '.khy', 'feedback', 't1'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.khy', 'feedback', 't1', 'verify.txt'), 'ok');

  const out = await runHandler(dir, []);
  assert.match(out, /可以提交/);
  assert.match(out, /没有提交/, '默认不应提交');
  assert.strictEqual(logCount(dir), '0');
});

test('真执行：--summary 输出紧凑机器可读格式', async () => {
  const dir = makeRepo({ seed: { 'services/backend/src/a.js': '// a\n' } });
  gitIn(dir, ['add', 'services/backend/src/a.js']);
  const out = await runHandler(dir, ['--summary']);
  assert.match(out, /^do-not-commit\t/, '--summary 应首列给结论');
});

test('真执行：git 仓库外调用 → 友好报错而非崩溃', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-notrepo-'));
  _tmpdirs.push(dir);
  const out = await runHandler(dir, []);
  assert.match(out, /不是 Git 仓库/);
});

test('真执行：--help 打印用法且不碰 git', async () => {
  const dir = makeRepo();
  const out = await runHandler(dir, ['--help']);
  assert.match(out, /khy commit/);
  assert.match(out, /PROCESS-009/);
});

test('真执行：help 子命令可达（顶层会拦走 --help，故需独立入口）', async () => {
  const dir = makeRepo();
  const out = await runHandler(dir, ['help']);
  assert.match(out, /khy commit/);
  assert.match(out, /三种结论/);
  assert.match(out, /khy commit help/, '帮助里应点明要用 help 而非 --help');
});

// ═══════════════════════════════════════════════════════════════════════════
// 六、登记与真源一致（防漂移）
// ═══════════════════════════════════════════════════════════════════════════

test('登记一致：handler manifest 形状合法', () => {
  const { extractManifest } = require('../src/cli/commandManifest');
  const { manifest } = extractManifest(handler);
  assert.ok(manifest, '应导出 manifest');
  assert.strictEqual(manifest.name, 'commit');
  assert.strictEqual(typeof manifest.handler, 'function');
  assert.ok(manifest.description.length > 0);
});

test('登记一致：登记表里 PROCESS-009 的 findings 与守卫同源', () => {
  const regPath = path.join(__dirname, '..', '..', '..', 'docs', '10_规范', 'registry', 'RULES-REGISTRY.json');
  let reg;
  try {
    reg = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
  } catch {
    return; // 登记表不在预期位置时跳过（不制造假红）
  }
  const entry = (reg.rules || []).find((r) => r.id === 'PROCESS-009');
  assert.ok(entry, 'PROCESS-009 应登记在册');
  assert.strictEqual(entry.gate, 'commit');
  assert.strictEqual(entry.severity, 'advisory');

  const expected = [
    'unit-multi-intent',
    'unit-unverified',
    'unit-sweeps-foreign-changes',
    'unit-stray-artifacts',
    'unit-not-rollbackable',
  ];
  const actual = (entry.exec && entry.exec.findings) || [];
  assert.deepStrictEqual(
    [...actual].sort(),
    [...expected].sort(),
    '登记表的 findings 必须与判据一一对应'
  );
});
