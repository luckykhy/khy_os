'use strict';

/**
 * OPS-MAN-157 接线验证:gitTrackWhitelist 叶 → workspaceGitInit.ensureWorkspaceRepo。
 *
 * gitTrackWhitelist.js(loadWhitelist/saveWhitelist/isWhitelisted/addToWhitelist/
 * removeFromWhitelist)是全实现的「用户显式 git-init 白名单」叶——让用户对自动判定会拒绝
 * 的目录(精确系统/共享根,如 /opt、/srv、/mnt)显式声明「我确实要 git 化」。但此前**零
 * 生产消费者**:workspaceGitInit 从不消费它,能力完全休眠。
 *
 * 本接线把 `isWhitelisted(cwd)` 接进 IO 层 workspaceGitInit.ensureWorkspaceRepo:当纯策略叶
 * workspaceGitInitPolicy 判 shouldInit:false 且 reason==='system-dir'(可覆盖的软拒绝)时,
 * 查白名单 → 命中则覆盖为允许 init。硬安全约束(filesystem-root / home-dir / ancestor-of-home /
 * already-repo)**永不**覆盖(见 gitTrackWhitelist 契约「文件系统根 / 盘符根永远拒绝」)。
 *
 * ★为什么接在 IO 层而非纯策略叶:workspaceGitInitPolicy 契约是「零 IO」,而白名单是 fs 读;
 * 把 fs 读放进 IO 服务(它本就做 git 探测/init),保住纯叶的纯度。
 *
 * 测试用 require.cache 桩替换惰性 require 的 gitTrackWhitelist,确定性覆盖各分支,零真实 fs 写。
 * node:test 风格,已登记进 test:maintainer:safety 聚合套件。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const svc = require('../../src/services/workspaceGitInit');

const WL_PATH = require.resolve('../../src/services/gitTrackWhitelist');

/** 用桩替换惰性 require 的 gitTrackWhitelist;fn 收到 isWhitelisted 的调用参数记录。 */
function withWhitelistStub(impl, fn) {
  const orig = require.cache[WL_PATH];
  const calls = [];
  require.cache[WL_PATH] = {
    id: WL_PATH, filename: WL_PATH, loaded: true, exports: {
      isWhitelisted: (p) => { calls.push(p); return impl(p); },
    },
  };
  try { return fn(calls); } finally {
    if (orig) require.cache[WL_PATH] = orig; else delete require.cache[WL_PATH];
  }
}

/** 注入 git runner:rev-parse → ''(非仓库);init → 成功;其余 → ''。记录调用。 */
function makeRunner() {
  const calls = [];
  const runner = (cmd) => {
    calls.push(cmd);
    if (/rev-parse/.test(cmd)) return '';
    if (/\binit\b/.test(cmd)) return 'Initialized empty Git repository';
    return '';
  };
  runner.calls = calls;
  return runner;
}

const OPTS = (cwd, home, runner) => ({ cwd, home, runner, env: {}, log: () => {} });

// ── 接线守卫:system-dir + 白名单覆盖 ──────────────────────────

test('WIRING: system-dir 被白名单命中 → 覆盖为 init(isWhitelisted 以 cwd 调用)', () => {
  withWhitelistStub(() => true, (wlCalls) => {
    const runner = makeRunner();
    const r = svc.ensureWorkspaceRepo(OPTS('/opt', '/home/alice', runner));
    assert.strictEqual(r.status, 'initialized', 'whitelisted system-dir should init');
    assert.ok(runner.calls.some((c) => /\binit\b/.test(c)), 'git init must be invoked');
    assert.deepStrictEqual(wlCalls, ['/opt'], 'isWhitelisted must be consulted with cwd');
  });
});

test('WIRING: system-dir 未命中白名单 → 字节回退(skip system-dir,不 init)', () => {
  withWhitelistStub(() => false, (wlCalls) => {
    const runner = makeRunner();
    const r = svc.ensureWorkspaceRepo(OPTS('/opt', '/home/alice', runner));
    assert.strictEqual(r.status, 'skip');
    assert.strictEqual(r.reason, 'system-dir');
    assert.ok(!runner.calls.some((c) => /\binit\b/.test(c)), 'git init must NOT run');
    assert.deepStrictEqual(wlCalls, ['/opt']);
  });
});

// ── 硬安全约束:白名单永不覆盖 ─────────────────────────────────

test('HARD FLOOR: filesystem-root 即使白名单返 true 也拒绝(白名单从不被查)', () => {
  withWhitelistStub(() => true, (wlCalls) => {
    const runner = makeRunner();
    const r = svc.ensureWorkspaceRepo(OPTS('/', '/home/alice', runner));
    assert.strictEqual(r.status, 'skip');
    assert.strictEqual(r.reason, 'filesystem-root');
    assert.ok(!runner.calls.some((c) => /\binit\b/.test(c)));
    assert.deepStrictEqual(wlCalls, [], 'whitelist must NOT be consulted for hard-floor reasons');
  });
});

test('HARD FLOOR: HOME 目录即使白名单返 true 也拒绝(白名单从不被查)', () => {
  withWhitelistStub(() => true, (wlCalls) => {
    const runner = makeRunner();
    const r = svc.ensureWorkspaceRepo(OPTS('/home/alice', '/home/alice', runner));
    assert.strictEqual(r.status, 'skip');
    assert.strictEqual(r.reason, 'home-dir');
    assert.deepStrictEqual(wlCalls, []);
  });
});

// ── 既有行为不回归:eligible 目录不查白名单 ───────────────────

test('NO-REGRESSION: eligible(HOME 直接子目录)照常 init,白名单从不被查', () => {
  withWhitelistStub(() => { throw new Error('should not be called'); }, (wlCalls) => {
    const runner = makeRunner();
    const r = svc.ensureWorkspaceRepo(OPTS('/nonexistent-khytest-xyz/proj', '/nonexistent-khytest-xyz', runner));
    assert.strictEqual(r.status, 'initialized');
    assert.ok(runner.calls.some((c) => /\binit\b/.test(c)));
    assert.deepStrictEqual(wlCalls, [], 'eligible path must not consult whitelist');
  });
});

// ── 源级接线断言 ──────────────────────────────────────────────

test('SOURCE: workspaceGitInit 惰性 require gitTrackWhitelist 且以 system-dir 为门', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../src/services/workspaceGitInit.js'), 'utf-8');
  assert.ok(/require\(['"]\.\/gitTrackWhitelist['"]\)/.test(src), 'must require ./gitTrackWhitelist');
  assert.ok(src.includes('isWhitelisted'), 'must call isWhitelisted');
  assert.ok(/reason\s*===\s*'system-dir'/.test(src), 'override must be gated on system-dir reason');
});

test('LEAF: gitTrackWhitelist 导出面完整且 loadWhitelist fail-soft 返数组', () => {
  const wl = require('../../src/services/gitTrackWhitelist');
  for (const fn of ['loadWhitelist', 'isWhitelisted', 'addToWhitelist', 'removeFromWhitelist', 'saveWhitelist']) {
    assert.strictEqual(typeof wl[fn], 'function', `missing export: ${fn}`);
  }
  assert.ok(Array.isArray(wl.loadWhitelist()), 'loadWhitelist must return an array');
});
