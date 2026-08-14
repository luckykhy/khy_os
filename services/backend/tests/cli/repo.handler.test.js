'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Capture formatter output instead of printing.
const calls = { success: [], error: [], warn: [], info: [] };
jest.mock('../../src/cli/formatters', () => ({
  printSuccess: (m) => calls.success.push(String(m)),
  printError: (m) => calls.error.push(String(m)),
  printWarn: (m) => calls.warn.push(String(m)),
  printInfo: (m) => calls.info.push(String(m)),
}));

jest.mock('chalk', () => {
  const fn = (v) => v;
  ['green', 'yellow', 'red', 'dim', 'bold', 'cyan'].forEach((k) => { fn[k] = fn; });
  fn.default = fn;
  return fn;
});

const { handleRepo, _isGitRepo } = require('../../src/cli/handlers/repo');

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('repo handler (beginner-safe version management)', () => {
  let tmp;
  let origCwd;

  beforeEach(() => {
    calls.success = []; calls.error = []; calls.warn = []; calls.info = [];
    origCwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-repo-test-'));
    process.chdir(tmp);
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    console.log.mockRestore();
    process.chdir(origCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function initRepo() {
    git(tmp, ['init', '-q']);
    git(tmp, ['config', 'user.email', 't@t.co']);
    git(tmp, ['config', 'user.name', 'tester']);
  }

  test('status outside a git repo shows a friendly guard, not a crash', async () => {
    const ok = await handleRepo('status', [], {});
    expect(ok).toBe(true);
    expect(calls.error.join('\n')).toContain('还不是一个版本库');
  });

  test('save refuses without a message', async () => {
    initRepo();
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'hello');
    await handleRepo('save', [], {});
    expect(calls.error.join('\n')).toContain('请为这个版本写一句说明');
  });

  test('save commits all changes as a snapshot', async () => {
    initRepo();
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'hello');
    await handleRepo('save', ['first', 'version'], {});
    expect(calls.success.join('\n')).toContain('已保存一个版本快照');
    // Working tree should now be clean.
    const porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: tmp, encoding: 'utf-8' });
    expect(porcelain.trim()).toBe('');
    // The commit message is what we passed.
    const subject = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: tmp, encoding: 'utf-8' });
    expect(subject.trim()).toBe('first version');
  });

  test('save with nothing to commit reports already up to date', async () => {
    initRepo();
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'hello');
    await handleRepo('save', ['v1'], {});
    calls.info = [];
    await handleRepo('save', ['again'], {});
    expect(calls.info.join('\n')).toContain('没有需要保存的改动');
  });

  test('history lists saved versions', async () => {
    initRepo();
    fs.writeFileSync(path.join(tmp, 'a.txt'), '1');
    await handleRepo('save', ['v1'], {});
    fs.writeFileSync(path.join(tmp, 'a.txt'), '2');
    await handleRepo('save', ['v2'], {});
    const logged = [];
    console.log.mockImplementation((...a) => logged.push(a.join(' ')));
    await handleRepo('history', [], {});
    const text = logged.join('\n');
    expect(text).toContain('v1');
    expect(text).toContain('v2');
  });

  test('branch switch without a name is rejected safely', async () => {
    initRepo();
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'hello');
    await handleRepo('save', ['v1'], {});
    await handleRepo('branch', ['switch'], {});
    expect(calls.error.join('\n')).toContain('要切换到哪个分支');
  });

  test('branch switch moves to an existing branch', async () => {
    initRepo();
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'hello');
    await handleRepo('save', ['v1'], {});
    git(tmp, ['branch', 'feature-x']);
    await handleRepo('branch', ['switch', 'feature-x'], {});
    expect(calls.success.join('\n')).toContain('已切换到分支: feature-x');
    const cur = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmp, encoding: 'utf-8' });
    expect(cur.trim()).toBe('feature-x');
  });

  test('unknown subcommand prints usage', async () => {
    initRepo();
    await handleRepo('frobnicate', [], {});
    expect(calls.error.join('\n')).toContain('未知子命令');
    expect(calls.info.join('\n')).toContain('小白安全版版本管理');
  });

  test('_isGitRepo reflects repo presence', async () => {
    expect(_isGitRepo()).toBe(false);
    initRepo();
    expect(_isGitRepo()).toBe(true);
  });
});
