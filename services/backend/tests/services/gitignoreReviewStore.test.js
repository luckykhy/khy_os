'use strict';
/**
 * gitignoreReviewStore.test.js �?.gitignore 写入「待审核队列」的确定性测试�?
 *
 * 锁定:�?enqueue �?list �?approve(真写 .gitignore 且移�?pending)�?discard 全链;
 * �?非法 pattern 拒绝入队;�?去重(同一�?pattern �?pending �?skip);�?门控�?enqueue no-op;
 * �?IO fail-soft(�?id / 空输入不�?�?
 *
 * 隔离:临时 data home(队列�?pending.json)+ 临时 cwd(approve �?.gitignore �?cwd)�?
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-gi-review-'));
process.env.KHY_DATA_HOME = path.join(TMP, 'data');
process.env.KHY_GITIGNORE_REVIEW = 'true';
process.env.KHY_GITIGNORE_ADVISOR = 'true';
const dataHome = require('../../src/utils/dataHome');
dataHome._resetStorageCaches();
const store = require('../../src/services/gitignoreReviewStore');
const origCwd = process.cwd();
const workCwd = path.join(TMP, 'work');
fs.mkdirSync(workCwd, { recursive: true });
test.before(() => { process.chdir(workCwd); });
test.after(() => {
  process.chdir(origCwd);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});
function fresh() { store.clear(); }

describe('Gitignore Review Store', () => {
  test('enqueue �?list:候选进队列', () => {
      fresh();
      const r = store.enqueue({ patterns: ['secret.env', 'big.bin'], reason: 'precommit', source: 'auto' });
      expect(r.success).toBe(true, r.error || '');
      expect(r.id).toBeTruthy();
      const list = store.list();
      expect(list.length).toBe(1);
      expect(list[0].patterns).toEqual(['secret.env', 'big.bin']);
      expect(store.count()).toBe(1);
  });

  test('去重:同一�?pattern �?pending �?skip', () => {
      fresh();
      store.enqueue({ patterns: ['a', 'b'] });
      const r2 = store.enqueue({ patterns: ['b', 'a'] }); // 顺序无关
      expect(r2.success).toBe(true);
      expect(r2.skipped).toBe(true);
      expect(store.list().length).toBe(1);
  });

  test('approve:真写 .gitignore 且从 pending 移除', () => {
      fresh();
      const r = store.enqueue({ patterns: ['secret.env'], reason: 'precommit' });
      const ap = store.approve(r.id, { cwd: workCwd });
      expect(ap.success).toBe(true, ap.error || '');
      expect(ap.file && ap.file.endsWith('.gitignore')).toBeTruthy();
      const content = fs.readFileSync(ap.file, 'utf-8');
      expect(content).toContain('secret.env');
      expect(store.list().length).toBe(0); // pending 已移�?
  });

  test('discard:丢弃不写文件', () => {
      fresh();
      const r = store.enqueue({ patterns: ['x.log'] });
      const d = store.discard(r.id);
      expect(d.success).toBe(true);
      expect(store.list().length).toBe(0);
  });

  test('非法 pattern 拒绝入队', () => {
      fresh();
      expect(store.enqueue({ patterns: ['/'] }).success).toBe(false);
      expect(store.enqueue({ patterns: ['a\nb'] }).success).toBe(false);
      expect(store.enqueue({ patterns: [] }).success).toBe(false);
      expect(store.list().length).toBe(0);
  });

  test('门控�?�?enqueue no-op(disabled)', () => {
      fresh();
      const saved = process.env.KHY_GITIGNORE_REVIEW;
      process.env.KHY_GITIGNORE_REVIEW = 'off';
      try {
        const r = store.enqueue({ patterns: ['y.tmp'] });
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/disabled/);
      } finally {
        process.env.KHY_GITIGNORE_REVIEW = saved;
      }
  });

  test('fail-soft:�?id / 空输入绝不抛', () => {
      fresh();
      expect(store.approve('').success).toBe(false);
      expect(store.approve('nonexistent').success).toBe(false);
      expect(store.discard('nope').success).toBe(false);
      expect(store.enqueue({}).success).toBe(false);
  });

});

