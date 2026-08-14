'use strict';

/**
 * workspaceGitInit.test.js — 「启动目录视为 git 仓库」的确定性单测 (node:test)。
 *
 * 两层覆盖：
 *  - 纯叶子 workspaceGitInitPolicy：安全判定（拒绝 HOME / 文件系统根 / 系统目录 /
 *    HOME 祖先 / 已是仓库 / 相对路径），放行普通项目目录；门控；fail-soft。
 *    这是本特性的安全核心——绝不在错误目录 git init。
 *  - IO 服务 workspaceGitInit.ensureWorkspaceRepo：经注入 git runner（不碰真实 git）
 *    验证 disabled / skip / initialized / error 各分支与通知打印。
 *
 * jest 自动忽略 node:test 文件（jest.config.js 扫 require('node:test')），故本套只由
 * `npm run test:node` 跑。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const policy = require('../../src/services/workspaceGitInitPolicy');
const svc = require('../../src/services/workspaceGitInit');

const HOME = '/home/alice';

describe('workspaceGitInitPolicy.assessGitInitTarget — refuses dangerous targets', () => {
  test('refuses the HOME directory itself', () => {
    const v = policy.assessGitInitTarget({ cwd: HOME, home: HOME, isGitRepo: false });
    assert.equal(v.shouldInit, false);
    assert.equal(v.reason, 'home-dir');
  });

  test('refuses HOME even with a trailing slash', () => {
    const v = policy.assessGitInitTarget({ cwd: '/home/alice/', home: HOME, isGitRepo: false });
    assert.equal(v.shouldInit, false);
  });

  test('refuses the filesystem root', () => {
    assert.equal(policy.assessGitInitTarget({ cwd: '/', home: HOME }).shouldInit, false);
  });

  test('refuses a Windows drive root', () => {
    const v = policy.assessGitInitTarget({ cwd: 'C:\\', home: 'C:\\Users\\alice' });
    assert.equal(v.shouldInit, false);
  });

  test('refuses an ancestor of HOME (e.g. /home when home=/home/alice)', () => {
    const v = policy.assessGitInitTarget({ cwd: '/home', home: HOME, isGitRepo: false });
    assert.equal(v.shouldInit, false);
    // /home is both a system-dir and an ancestor-of-home; either reason is correct.
    assert.ok(['ancestor-of-home', 'system-dir'].includes(v.reason));
  });

  test('refuses known system directories', () => {
    for (const d of ['/etc', '/usr', '/var', '/opt', '/bin', '/tmp', '/root']) {
      assert.equal(policy.assessGitInitTarget({ cwd: d, home: HOME }).shouldInit, false, `${d} should be refused`);
    }
  });

  test('refuses a directory already inside a git repo (idempotent)', () => {
    const v = policy.assessGitInitTarget({ cwd: '/home/alice/proj', home: HOME, isGitRepo: true });
    assert.equal(v.shouldInit, false);
    assert.equal(v.reason, 'already-repo');
  });

  test('refuses a relative / empty / non-string cwd (fail-soft)', () => {
    assert.equal(policy.assessGitInitTarget({ cwd: 'relative/path', home: HOME }).shouldInit, false);
    assert.equal(policy.assessGitInitTarget({ cwd: '', home: HOME }).shouldInit, false);
    assert.equal(policy.assessGitInitTarget({ cwd: null, home: HOME }).shouldInit, false);
    assert.equal(policy.assessGitInitTarget({}).shouldInit, false);
    assert.equal(policy.assessGitInitTarget().shouldInit, false);
  });
});

describe('workspaceGitInitPolicy.assessGitInitTarget — allows real project dirs', () => {
  test('allows HOME direct subdirectories (Desktop, Documents, projects, etc.)', () => {
    const cases = [
      '/home/alice/Desktop',
      '/home/alice/Documents',
      '/home/alice/projects',
      '/home/alice/work',
      'C:\\Users\\alice\\Desktop',
    ];
    for (const cwd of cases) {
      const home = cwd.includes('C:') ? 'C:\\Users\\alice' : HOME;
      const v = policy.assessGitInitTarget({ cwd, home, isGitRepo: false });
      assert.equal(v.shouldInit, true, `${cwd} should be allowed`);
      assert.equal(v.reason, 'home-direct-subdir', `${cwd} should have reason 'home-direct-subdir'`);
    }
  });

  test('allows a normal project directory under HOME', () => {
    const v = policy.assessGitInitTarget({ cwd: '/home/alice/work/myproj', home: HOME, isGitRepo: false });
    assert.equal(v.shouldInit, true);
    assert.equal(v.reason, 'eligible');
  });

  test('allows a SUBDIRECTORY of a system dir (only exact system roots are blocked)', () => {
    // /tmp is blocked, but /tmp/scratch is a legitimate workspace.
    const v = policy.assessGitInitTarget({ cwd: '/tmp/scratch', home: HOME, isGitRepo: false });
    assert.equal(v.shouldInit, true);
  });

  test('allows when isGitRepo is null (git probe failed) — repo detection is not a hard block', () => {
    const v = policy.assessGitInitTarget({ cwd: '/srv/app', home: HOME, isGitRepo: null });
    assert.equal(v.shouldInit, true);
  });
});

describe('workspaceGitInitPolicy.isEnabled (gate)', () => {
  test('default on', () => {
    assert.equal(policy.isEnabled({}), true);
    assert.equal(policy.isEnabled({ KHY_AUTO_GIT_INIT: '' }), true);
    assert.equal(policy.isEnabled({ KHY_AUTO_GIT_INIT: '1' }), true);
  });

  test('off via {0,false,off,no} (case-insensitive)', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
      assert.equal(policy.isEnabled({ KHY_AUTO_GIT_INIT: v }), false, `${JSON.stringify(v)} should disable`);
    }
  });
});

describe('workspaceGitInitPolicy.noticeLine', () => {
  test('mentions the path and the opt-out env', () => {
    const line = policy.noticeLine('/home/alice/proj');
    assert.match(line, /\/home\/alice\/proj/);
    assert.match(line, /KHY_AUTO_GIT_INIT/);
  });
});

describe('workspaceGitInit.ensureWorkspaceRepo (injected git runner)', () => {
  const makeRunner = (calls, { revParse } = {}) => (cmd, cwd) => {
    calls.push([cmd, cwd]);
    if (cmd.includes('rev-parse')) {
      if (revParse === 'throw') throw new Error('not a repo');
      return revParse || ''; // '' → not a repo; a path → already a repo
    }
    if (cmd.includes('init')) return 'Initialized empty Git repository';
    return '';
  };

  test('eligible dir → git init + notice printed', () => {
    const calls = [];
    // 引擎可能打印多行(init 通知 + 向导 gitignore/无身份提示);累加而非覆盖,
    // 才能断言「Git 仓库」init 通知确实出现(它是首行,后续向导行会覆盖单变量)。
    let logged = '';
    const r = svc.ensureWorkspaceRepo({
      cwd: '/home/alice/proj', home: HOME,
      log: (l) => { logged += `${l}\n`; },
      runner: makeRunner(calls, { revParse: 'throw' }),
    });
    assert.equal(r.status, 'initialized');
    assert.match(logged, /Git 仓库/);
    assert.ok(calls.some(([c]) => c.includes('init')), 'should call git init');
  });

  test('already a repo → skip, never calls git init', () => {
    const calls = [];
    const r = svc.ensureWorkspaceRepo({
      cwd: '/home/alice/proj', home: HOME,
      runner: makeRunner(calls, { revParse: '/home/alice/proj' }), // rev-parse returns toplevel
    });
    assert.equal(r.status, 'skip');
    assert.equal(r.reason, 'already-repo');
    assert.ok(!calls.some(([c]) => c.includes('init')), 'must not call git init');
  });

  test('HOME dir → skip even if probe says not-a-repo (never calls init)', () => {
    const calls = [];
    const r = svc.ensureWorkspaceRepo({
      cwd: HOME, home: HOME,
      runner: makeRunner(calls, { revParse: 'throw' }),
    });
    assert.equal(r.status, 'skip');
    assert.equal(r.reason, 'home-dir');
    assert.ok(!calls.some(([c]) => c.includes('init')), 'must not init HOME');
  });

  test('gate off → disabled, no git calls at all', () => {
    const calls = [];
    const r = svc.ensureWorkspaceRepo({
      cwd: '/home/alice/proj', home: HOME,
      env: { KHY_AUTO_GIT_INIT: 'off' },
      runner: makeRunner(calls),
    });
    assert.equal(r.status, 'disabled');
    assert.equal(calls.length, 0);
  });

  test('git init failure → error status (fail-soft, never throws)', () => {
    const runner = (cmd) => {
      if (cmd.includes('rev-parse')) throw new Error('not a repo');
      if (cmd.includes('init')) throw new Error('permission denied');
      return '';
    };
    const r = svc.ensureWorkspaceRepo({ cwd: '/home/alice/proj', home: HOME, runner });
    assert.equal(r.status, 'error');
    assert.equal(r.reason, 'git-init-failed');
  });

  test('a throwing log callback does not break a successful init', () => {
    const r = svc.ensureWorkspaceRepo({
      cwd: '/home/alice/proj', home: HOME,
      log: () => { throw new Error('tty gone'); },
      runner: (cmd) => {
        if (cmd.includes('rev-parse')) throw new Error('not a repo');
        return 'Initialized empty Git repository';
      },
    });
    assert.equal(r.status, 'initialized');
  });

  // ── goal 2026-07-07:无 git 身份也把全部文件纳入 git 管理 + 落 main 主线 ──────────
  // runner:rev-parse 抛(非仓库);config user.name/email 返 '' (无身份);其余返 ''.
  const makeNoIdentityRunner = (calls) => (cmd, cwd) => {
    calls.push([cmd, cwd]);
    if (cmd.includes('rev-parse')) throw new Error('not a repo');
    if (cmd.includes('config user.name') || cmd.includes('config user.email')) return ''; // 无身份
    if (cmd.includes('init')) return 'Initialized empty Git repository';
    return '';
  };

  test('无身份 + fallback 门开(默认)→ 设仓库级身份 + add -A + commit + branch -M main', () => {
    const calls = [];
    let logged = '';
    const r = svc.ensureWorkspaceRepo({
      cwd: '/home/alice/proj', home: HOME,
      log: (l) => { logged += `${l}\n`; },
      runner: makeNoIdentityRunner(calls),
    });
    assert.equal(r.status, 'initialized');
    const cmds = calls.map(([c]) => c);
    // 设仓库级 fallback 身份(不带 --global)。
    assert.ok(cmds.some((c) => /config user\.name /.test(c) && !c.includes('--global')), '应设 repo-local user.name');
    assert.ok(cmds.some((c) => /config user\.email /.test(c) && !c.includes('--global')), '应设 repo-local user.email');
    // 全量纳入 + 首次 commit + 规范主线。
    assert.ok(cmds.some((c) => c.includes('add -A')), '应 git add -A');
    assert.ok(cmds.some((c) => /commit -m /.test(c)), '应首次 commit');
    assert.ok(cmds.some((c) => /branch -M main\b/.test(c)), '应把主线规范为 main');
    assert.match(logged, /纳入 git 管理|main/);
  });

  test('无身份 + fallback 门关(KHY_GIT_INIT_FALLBACK_IDENTITY=off)→ 旧行为:不设身份、不 commit', () => {
    const calls = [];
    let logged = '';
    const r = svc.ensureWorkspaceRepo({
      cwd: '/home/alice/proj', home: HOME,
      env: { KHY_GIT_INIT_FALLBACK_IDENTITY: 'off' },
      log: (l) => { logged += `${l}\n`; },
      runner: makeNoIdentityRunner(calls),
    });
    assert.equal(r.status, 'initialized');
    const cmds = calls.map(([c]) => c);
    assert.ok(!cmds.some((c) => /config user\.(name|email) [^-]/.test(c) && /'/.test(c)), '不得写入 fallback 身份');
    assert.ok(!cmds.some((c) => /commit -m /.test(c)), '门关时不得 commit');
    assert.ok(!cmds.some((c) => /branch -M/.test(c)), '门关时不得改分支');
    assert.match(logged, /跳过首次提交/);
  });

  test('已有 git 身份 → commit + main,但不覆盖用户身份(不写 config user.name)', () => {
    const calls = [];
    const runner = (cmd, cwd) => {
      calls.push([cmd, cwd]);
      if (cmd.includes('rev-parse')) throw new Error('not a repo');
      if (cmd.includes('config user.name')) return 'Alice';
      if (cmd.includes('config user.email')) return 'alice@example.com';
      if (cmd.includes('init')) return 'Initialized empty Git repository';
      return '';
    };
    const r = svc.ensureWorkspaceRepo({ cwd: '/home/alice/proj', home: HOME, runner });
    assert.equal(r.status, 'initialized');
    const cmds = calls.map(([c]) => c);
    // 有身份 → 只 READ config(无引号赋值),绝不写入 fallback 身份。
    assert.ok(!cmds.some((c) => /config user\.name '/.test(c)), '有身份时不得覆盖 user.name');
    assert.ok(cmds.some((c) => c.includes('add -A')), '仍应 add -A');
    assert.ok(cmds.some((c) => /commit -m /.test(c)), '仍应 commit');
    assert.ok(cmds.some((c) => /branch -M main\b/.test(c)), '仍应规范主线为 main');
  });

  test('commit 失败(git 拒绝)→ fail-soft:不改分支,init 仍 initialized', () => {
    const calls = [];
    const runner = (cmd, cwd) => {
      calls.push([cmd, cwd]);
      if (cmd.includes('rev-parse')) throw new Error('not a repo');
      if (cmd.includes('config user.name') || cmd.includes('config user.email')) return '';
      // 注意:先判 commit 再判 init——"chore: initial commit" 含子串 "init",
      // 顺序反了会被 init 分支吞掉、commit 永不抛。
      if (/\bcommit\b/.test(cmd)) throw new Error('nothing to commit / refused');
      if (cmd.includes('init')) return 'Initialized empty Git repository';
      return '';
    };
    const r = svc.ensureWorkspaceRepo({ cwd: '/home/alice/proj', home: HOME, runner });
    assert.equal(r.status, 'initialized');
    assert.ok(!calls.map(([c]) => c).some((c) => /branch -M/.test(c)), 'commit 失败后不得改分支');
  });
});

describe('workspaceGitInit._resolveFallbackIdentity / _shellQuote', () => {
  test('派生身份消毒到 git 安全字符,email 为 user@host', () => {
    const id = svc._resolveFallbackIdentity(
      { USER: 'bob smith!', HOSTNAME: 'my host' },
      { name: 'Khy OS', email: 'khy@localhost' },
    );
    assert.match(id.email, /@/);
    assert.ok(!/[^A-Za-z0-9._@-]/.test(id.email), 'email 不含非法字符');
    assert.ok(!/[^A-Za-z0-9._-]/.test(id.name), 'name 不含非法字符');
  });
  test('全不可用 → 回退静态兜底(name 非空、email 含 @)', () => {
    const id = svc._resolveFallbackIdentity({}, { name: 'Khy OS', email: 'khy@localhost' });
    assert.ok(id.name && id.name.length > 0);
    assert.match(id.email, /@/);
  });
  test('_shellQuote 单引号包裹并转义内嵌单引号', () => {
    assert.equal(svc._shellQuote('abc'), `'abc'`);
    assert.equal(svc._shellQuote("a'b"), `'a'\\''b'`);
    assert.equal(svc._shellQuote(null), `''`);
  });
});

describe('workspaceGitInit.detectIsGitRepo', () => {
  test('returns true when rev-parse yields a toplevel', () => {
    assert.equal(svc.detectIsGitRepo('/x', () => '/x'), true);
  });
  test('returns false when rev-parse yields empty', () => {
    assert.equal(svc.detectIsGitRepo('/x', () => ''), false);
  });
  test('returns null when git probe throws (git unavailable)', () => {
    assert.equal(svc.detectIsGitRepo('/x', () => { throw new Error('no git'); }), null);
  });
});
