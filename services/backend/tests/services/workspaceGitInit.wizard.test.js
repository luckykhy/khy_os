'use strict';

/**
 * workspaceGitInit.wizard.test.js — 初始化向导「一条龙」端到端探针(真实 git)。
 *
 * 锁定(全部在临时**非 git** 目录里跑真实 ensureWorkspaceRepo):
 *   ① 有 git 身份 → git 仓库 + 按栈 .gitignore + 首次 commit + 主线 main;
 *   ② 无 git 身份 + fallback 门开(默认)→ git 仓库 + .gitignore + 用仓库级 fallback 身份 commit + 主线 main;
 *   ③ 无 git 身份 + KHY_GIT_INIT_FALLBACK_IDENTITY=off → 仓库 + .gitignore,但**无 commit**(旧 fail-soft 行为);
 *   ④ KHY_GIT_INIT_WIZARD=off → 仅 init(无 .gitignore、无 commit),逐字节回退今日行为;
 *   ⑤ KHY_AUTO_GIT_INIT=off → 整功能不跑(status:disabled)。
 *
 * 注意:向导 commit 需 git 身份。为不污染全局 git config,用注入 runner 在**局部**
 * 目录级 config(git init 后 `git -C <cwd> config user.email ...`)。这里改用真实 git
 * 但把身份写进仓库级 config,避免依赖机器全局身份。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// 每个用例一个隔离的临时工作目录(非 git·非黑名单精确匹配)。
function freshDir(tag) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `khy-wiz-${tag}-`));
  // 再套一层子目录:确保不是 /tmp 黑名单精确命中,且是干净空目录。
  const dir = path.join(base, 'project');
  fs.mkdirSync(dir, { recursive: true });
  return { base, dir };
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function isRepo(dir) {
  try {
    const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    }).toString().trim();
    return out === 'true';
  } catch { return false; }
}

function hasCommit(dir) {
  try {
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch { return false; }
}

function currentBranch(dir) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    }).toString().trim();
  } catch { return ''; }
}

// 保证门控默认开(不受宿主环境影响)。
process.env.KHY_AUTO_GIT_INIT = 'true';
process.env.KHY_GIT_INIT_WIZARD = 'true';
process.env.KHY_GITIGNORE_ADVISOR = 'true';

const wgi = require('../../src/services/workspaceGitInit');

const _cleanup = [];
test.after(() => {
  for (const d of _cleanup) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('有 git 身份 → 仓库 + .gitignore + 首次 commit', () => {
  const { base, dir } = freshDir('id');
  _cleanup.push(base);
  // 放一个 node 项目签名,让探栈命中 node → .gitignore 含 node_modules/。
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));

  // 注入 runner:把真实 git 命令定向到 dir,并在 init 后注入仓库级身份。
  // 简单做法:让 _git 用真实 execFileSync,但先在 dir 建立身份配置。
  // 由于 detectIsGitRepo 在 init 前跑(此时非仓库),身份需 init 之后才能写;
  // 因此用 runner 拦截:遇到 `git init` 先 init 再写身份。
  const runner = (cmd, cwd) => {
    const argv = cmd.replace(/^git\s+/, '');
    const out = execFileSync('bash', ['-c', `git ${argv}`], {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (argv.trim() === 'init') {
      // init 完成后立刻写仓库级身份,供后续 config user.* 探测命中。
      execFileSync('git', ['config', 'user.email', 'wiz@example.com'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      execFileSync('git', ['config', 'user.name', 'Wizard'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    }
    return out;
  };

  const res = wgi.ensureWorkspaceRepo({ cwd: dir, home: '/nonexistent-home', runner, log: () => {} });
  assert.strictEqual(res.status, 'initialized', `应初始化,得到 ${JSON.stringify(res)}`);
  assert.ok(isRepo(dir), '应成为 git 仓库');
  assert.ok(fs.existsSync(path.join(dir, '.gitignore')), '应建 .gitignore');
  const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
  assert.ok(gi.includes('node_modules/'), `node 栈 .gitignore 应含 node_modules/,实际:\n${gi}`);
  assert.ok(hasCommit(dir), '有身份应产生首次 commit');
  assert.strictEqual(currentBranch(dir), 'main', '主线应规范为 main');
});

test('无 git 身份 + fallback 门开(默认)→ 仓库 + .gitignore + fallback 身份 commit + 主线 main', () => {
  const { base, dir } = freshDir('noid');
  _cleanup.push(base);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'y', version: '1.0.0' }));

  // runner:用隔离 HOME + 屏蔽全局/系统 config,确保**探测**身份查不到;引擎随后写仓库级
  // fallback 身份到该 dir(同一隔离 config 上下文),故 commit 应成功。
  const runner = (cmd, cwd) => execFileSync('bash', ['-c', `git ${cmd.replace(/^git\s+/, '')}`], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });

  const res = wgi.ensureWorkspaceRepo({ cwd: dir, home: '/nonexistent-home', runner, log: () => {} });
  assert.strictEqual(res.status, 'initialized', `应初始化,得到 ${JSON.stringify(res)}`);
  assert.ok(isRepo(dir), '应成为 git 仓库');
  assert.ok(fs.existsSync(path.join(dir, '.gitignore')), '无身份也应建 .gitignore');
  assert.ok(hasCommit(dir), '无身份 + fallback 门开应产生 fallback 身份 commit');
  assert.strictEqual(currentBranch(dir), 'main', '主线应规范为 main');
});

test('无 git 身份 + KHY_GIT_INIT_FALLBACK_IDENTITY=off → 仓库 + .gitignore,但无 commit', () => {
  const { base, dir } = freshDir('nofb');
  _cleanup.push(base);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'y2', version: '1.0.0' }));

  const saved = process.env.KHY_GIT_INIT_FALLBACK_IDENTITY;
  process.env.KHY_GIT_INIT_FALLBACK_IDENTITY = 'off';
  try {
    const runner = (cmd, cwd) => execFileSync('bash', ['-c', `git ${cmd.replace(/^git\s+/, '')}`], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    const res = wgi.ensureWorkspaceRepo({ cwd: dir, home: '/nonexistent-home', runner, log: () => {} });
    assert.strictEqual(res.status, 'initialized', `应初始化,得到 ${JSON.stringify(res)}`);
    assert.ok(isRepo(dir), '应成为 git 仓库');
    assert.ok(fs.existsSync(path.join(dir, '.gitignore')), '无身份也应建 .gitignore');
    assert.strictEqual(hasCommit(dir), false, 'fallback 门关时无身份不应 commit');
  } finally {
    process.env.KHY_GIT_INIT_FALLBACK_IDENTITY = saved;
  }
});

test('KHY_GIT_INIT_WIZARD=off → 仅 init(无 .gitignore·无 commit)', () => {
  const { base, dir } = freshDir('wizoff');
  _cleanup.push(base);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'z', version: '1.0.0' }));

  const saved = process.env.KHY_GIT_INIT_WIZARD;
  process.env.KHY_GIT_INIT_WIZARD = 'off';
  try {
    const runner = (cmd, cwd) => {
      const argv = cmd.replace(/^git\s+/, '');
      execFileSync('bash', ['-c', `git ${argv}`], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (argv.trim() === 'init') {
        execFileSync('git', ['config', 'user.email', 'wiz@example.com'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        execFileSync('git', ['config', 'user.name', 'Wizard'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      }
      return '';
    };
    const res = wgi.ensureWorkspaceRepo({ cwd: dir, home: '/nonexistent-home', runner, log: () => {} });
    assert.strictEqual(res.status, 'initialized');
    assert.ok(isRepo(dir), '仍应 git init');
    assert.strictEqual(fs.existsSync(path.join(dir, '.gitignore')), false, '门控关不应建 .gitignore');
    assert.strictEqual(hasCommit(dir), false, '门控关不应 commit');
  } finally {
    process.env.KHY_GIT_INIT_WIZARD = saved;
  }
});

test('KHY_AUTO_GIT_INIT=off → 整功能不跑(disabled)', () => {
  const saved = process.env.KHY_AUTO_GIT_INIT;
  process.env.KHY_AUTO_GIT_INIT = 'off';
  try {
    const res = wgi.ensureWorkspaceRepo({ cwd: '/tmp', home: '/nonexistent-home', log: () => {} });
    assert.strictEqual(res.status, 'disabled');
  } finally {
    process.env.KHY_AUTO_GIT_INIT = saved;
  }
});
