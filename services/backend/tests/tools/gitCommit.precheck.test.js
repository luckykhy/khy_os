'use strict';
/**
 * gitCommit.precheck.test.js �?提交前自检的确定性测�?真实临时 git 仓库)�?
 *
 * 锁定:�?staged 含大文件 �?自检印警�?+ �?gitignore 队列,�?*仍放�?*(只提示不阻断);
 * �?KHY_COMMIT_PRECHECK_BLOCK=on + verdict block �?shouldBlock:true;
 * �?--no-verify �?不跑(ran:false);�?门控�?�?不跑;�?无暂�?�?不跑;�?clean �?不入队�?
 */
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
  // 6 MB > LARGE_FILE_BYTES(5MB) �?high 风险大文件�?
  fs.writeFileSync(path.join(repo, name), Buffer.alloc(6 * 1024 * 1024, 0x61));
  git(['add', name]);
}

describe('Git Commit precheck', () => {
  test('大文�?�?自检警告 + �?gitignore 队列,但仍放行(shouldBlock:false)', () => {
      store.clear();
      stageLargeFile('big.bin');
      const lines = [];
      const chk = precheck.runPrecommitCheck({ cwd: repo, message: 'add big file', addAll: true, log: (l) => lines.push(l) });
      expect(chk.ran).toBe(true);
      expect(chk.shouldBlock).toBe(false, '只提示不阻断');
      expect(chk.enqueued.includes('big.bin')).toBeTruthy();
      expect(store.list().some((e) => e.patterns).toContain('big.bin'), '队列应含 big.bin');
      expect(lines.join('\n').includes('big.bin')).toBeTruthy();
  });

  test('KHY_COMMIT_PRECHECK_BLOCK=on + block �?shouldBlock:true', () => {
      store.clear();
      // 隔离:清掉上个用例暂存�?big.bin,只留密钥文件,避免 6MB 文件污染 diff�?
      try { git(['reset']); } catch { /* ignore */ }
      process.env.KHY_COMMIT_PRECHECK_BLOCK = 'on';
      try {
        // 密钥 �?verdict block。敏感变量名 = 长字面量(命中通用赋值扫�?�?
        fs.writeFileSync(path.join(repo, 'cfg.js'), 'const api_key = "abcdef0123456789ABCDEF";\n');
        git(['add', 'cfg.js']);
        const chk = precheck.runPrecommitCheck({ cwd: repo, message: 'add config file properly', log: () => {} });
        expect(chk.verdict).toBe('block');
        expect(chk.shouldBlock).toBe(true);
      } finally {
        delete process.env.KHY_COMMIT_PRECHECK_BLOCK;
        try { git(['rm', '--cached', 'cfg.js']); } catch { /* ignore */ }
      }
  });

  test('--no-verify �?不跑(ran:false)', () => {
      const chk = precheck.runPrecommitCheck({ cwd: repo, message: 'x', noVerify: true, log: () => {} });
      expect(chk.ran).toBe(false);
      expect(chk.shouldBlock).toBe(false);
  });

  test('门控�?KHY_COMMIT_PRECHECK=off) �?不跑', () => {
      const saved = process.env.KHY_COMMIT_PRECHECK;
      process.env.KHY_COMMIT_PRECHECK = 'off';
      try {
        const chk = precheck.runPrecommitCheck({ cwd: repo, message: 'x', log: () => {} });
        expect(chk.ran).toBe(false);
      } finally {
        process.env.KHY_COMMIT_PRECHECK = saved;
      }
  });

  test('无暂存改�?�?不跑', () => {
      const clean = path.join(TMP, 'clean');
      fs.mkdirSync(clean, { recursive: true });
      execFileSync('git', ['init'], { cwd: clean, stdio: ['ignore', 'pipe', 'pipe'] });
      const chk = precheck.runPrecommitCheck({ cwd: clean, message: 'x', log: () => {} });
      expect(chk.ran).toBe(false);
  });

  test('_offendingPaths 只挑大文�?产物(密钥�?path 不导�?', () => {
      const report = {
        findings: [
          { kind: 'secret', category: 'risk', severity: 'critical', line: 3 },       // �?path
          { kind: 'large-file', category: 'risk', severity: 'high', path: 'a.bin' },
          { kind: 'binary-artifact', category: 'risk', severity: 'medium', path: 'b.o' },
          { kind: 'path-tier', category: 'discipline', severity: 'high', path: 'c.js' }, // 不导�?
        ],
      };
      expect(precheck._offendingPaths(report).sort()).toEqual(['a.bin', 'b.o']);
  });

});

