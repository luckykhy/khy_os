'use strict';

/**
 * gitCommit.precheck.test.js — 提交前自检的确定性测试(真实临时 git 仓库)。
 *
 * 锁定:① staged 含大文件 → 自检印警告 + 入 gitignore 队列,但**仍放行**(只提示不阻断);
 * ② KHY_COMMIT_PRECHECK_BLOCK=on + verdict block → shouldBlock:true;
 * ③ --no-verify → 不跑(ran:false);④ 门控关 → 不跑;⑤ 无暂存 → 不跑;⑥ clean → 不入队。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-precheck-'));
process.env.KHY_DATA_HOME = path.join(TMP, 'data');
process.env.KHY_COMMIT_PRECHECK = 'true';
process.env.KHY_GITIGNORE_REVIEW = 'true';
process.env.KHY_GITIGNORE_ADVISOR = 'true';
process.env.KHY_REPO_DISCIPLINE = 'true';
delete process.env.KHY_COMMIT_PRECHECK_BLOCK;

const dataHome = require('../../src/utils/dataHome');
dataHome._resetStorageCaches();

const precheck = require('../../src/services/precommitCheck');
const store = require('../../src/services/gitignoreReviewStore');

const repo = path.join(TMP, 'repo');

function git(args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test.before(() => {
  fs.mkdirSync(repo, { recursive: true });
  git(['init']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['checkout', '-b', 'feature-x']);
});
test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function stageLargeFile(name) {
  // 6 MB > LARGE_FILE_BYTES(5MB) → high 风险大文件。
  fs.writeFileSync(path.join(repo, name), Buffer.alloc(6 * 1024 * 1024, 0x61));
  git(['add', name]);
}

test('大文件 → 自检警告 + 入 gitignore 队列,但仍放行(shouldBlock:false)', () => {
  store.clear();
  stageLargeFile('big.bin');
  const lines = [];
  const chk = precheck.runPrecommitCheck({ cwd: repo, message: 'add big file', addAll: true, log: (l) => lines.push(l) });
  assert.strictEqual(chk.ran, true);
  assert.strictEqual(chk.shouldBlock, false, '只提示不阻断');
  assert.ok(chk.enqueued.includes('big.bin'), `应把 big.bin 入队,enqueued=${chk.enqueued}`);
  assert.ok(store.list().some((e) => e.patterns.includes('big.bin')), '队列应含 big.bin');
  assert.ok(lines.join('\n').includes('big.bin'), '警告应提到 big.bin');
});

test('KHY_COMMIT_PRECHECK_BLOCK=on + block → shouldBlock:true', () => {
  store.clear();
  // 隔离:清掉上个用例暂存的 big.bin,只留密钥文件,避免 6MB 文件污染 diff。
  try { git(['reset']); } catch { /* ignore */ }
  process.env.KHY_COMMIT_PRECHECK_BLOCK = 'on';
  try {
    // 密钥 → verdict block。敏感变量名 = 长字面量(命中通用赋值扫描)。
    fs.writeFileSync(path.join(repo, 'cfg.js'), 'const api_key = "abcdef0123456789ABCDEF";\n');
    git(['add', 'cfg.js']);
    const chk = precheck.runPrecommitCheck({ cwd: repo, message: 'add config file properly', log: () => {} });
    assert.strictEqual(chk.verdict, 'block');
    assert.strictEqual(chk.shouldBlock, true);
  } finally {
    delete process.env.KHY_COMMIT_PRECHECK_BLOCK;
    try { git(['rm', '--cached', 'cfg.js']); } catch { /* ignore */ }
  }
});

test('--no-verify → 不跑(ran:false)', () => {
  const chk = precheck.runPrecommitCheck({ cwd: repo, message: 'x', noVerify: true, log: () => {} });
  assert.strictEqual(chk.ran, false);
  assert.strictEqual(chk.shouldBlock, false);
});

test('门控关(KHY_COMMIT_PRECHECK=off) → 不跑', () => {
  const saved = process.env.KHY_COMMIT_PRECHECK;
  process.env.KHY_COMMIT_PRECHECK = 'off';
  try {
    const chk = precheck.runPrecommitCheck({ cwd: repo, message: 'x', log: () => {} });
    assert.strictEqual(chk.ran, false);
  } finally {
    process.env.KHY_COMMIT_PRECHECK = saved;
  }
});

test('无暂存改动 → 不跑', () => {
  const clean = path.join(TMP, 'clean');
  fs.mkdirSync(clean, { recursive: true });
  execFileSync('git', ['init'], { cwd: clean, stdio: ['ignore', 'pipe', 'pipe'] });
  const chk = precheck.runPrecommitCheck({ cwd: clean, message: 'x', log: () => {} });
  assert.strictEqual(chk.ran, false);
});

test('_offendingPaths 只挑大文件/产物(密钥无 path 不导出)', () => {
  const report = {
    findings: [
      { kind: 'secret', category: 'risk', severity: 'critical', line: 3 },       // 无 path
      { kind: 'large-file', category: 'risk', severity: 'high', path: 'a.bin' },
      { kind: 'binary-artifact', category: 'risk', severity: 'medium', path: 'b.o' },
      { kind: 'path-tier', category: 'discipline', severity: 'high', path: 'c.js' }, // 不导出
    ],
  };
  assert.deepStrictEqual(precheck._offendingPaths(report).sort(), ['a.bin', 'b.o']);
});
