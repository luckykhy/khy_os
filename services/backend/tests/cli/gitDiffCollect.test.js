'use strict';
/**
 * gitDiffCollect 叶子单测(node:test)�? *
 * 注入�?runGit(�?args 返回预置 stdout),覆盖:
 *   - 门控�?默认开 / 0·false·off·no(含大小写)�?/ 其它值开)
 *   - 门控开:tracked + 两个未跟�?�?同时�?tracked 段与两份 --no-index �?+ 行齐�?
 *   - 门控�?逐字节等于裸 git diff �?trim(证回退)
 *   - 仅未跟踪�?tracked �?仍输出新文件 diff(关键回归�?历史此场景为�?
 *   - 无任何改�?�?空串
 *   - maxUntracked 封顶 �?追加诚实�?N 未显示」标�?非静�?
 *   - 防呆:runGit 非函�?/ stdout 缺失 �?不抛、返回空或仅 tracked
 */
const { includeUntrackedEnabled, collectWorkingTreeDiff } = require('./gitDiffCollect');
// ── �?runGit 工厂:按首参数与具体路径返回预�?stdout ────────────────────────────────
function makeRunGit({ tracked = '', untracked = [], synth = {} } = {}) {
  // untracked: string[]；synth: { [path]: diffText }
  return (args) => {
    if (args[0] === 'diff' && args[1] === '--no-index') {
      const f = args[args.length - 1];
      return { stdout: synth[f] || '' };
    }
    if (args[0] === 'diff') {
      return { stdout: tracked };
    }
    if (args[0] === 'ls-files') {
      return { stdout: untracked.map((f) => f + '\0').join('') };
    }
    return { stdout: '' };
  };
}
const TRACKED_DIFF = [
  'diff --git a/existing.js b/existing.js',
  'index 1111111..2222222 100644',
  '--- a/existing.js',
  '+++ b/existing.js',
  '@@ -1,2 +1,3 @@',
  ' const a = 1;',
  '+const b = 2;',
  ' module.exports = { a };',
].join('\n');
const NEW_FILE_A = [
  'diff --git a/new-a.js b/new-a.js',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/new-a.js',
  '@@ -0,0 +1,2 @@',
  "+console.log('a');",
  '+module.exports = 1;',
].join('\n');
const NEW_FILE_B = [
  'diff --git a/新文�?txt b/新文�?txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/新文�?txt',
  '@@ -0,0 +1,1 @@',
  '+你好',
].join('\n');
// ── 门控�?────────────────────────────────────────────────────────────────────────
// ── 门控开:合并 tracked + 未跟�?──────────────────────────────────────────────────
// ── 门控�?逐字节回退 ────────────────────────────────────────────────────────────
// ── 边界 ──────────────────────────────────────────────────────────────────────────
// ── 防呆 ──────────────────────────────────────────────────────────────────────────

describe('Git Diff Collect', () => {
  test('includeUntrackedEnabled:默认开(未设)', () => {
      expect(includeUntrackedEnabled({})).toBe(true);
  });

  test('includeUntrackedEnabled:0/false/off/no(含大小写)�?, () => {
      for (const v of ['0', 'false', 'off', 'no', 'FALSE', 'Off', 'NO', ' no ']) {
        assert.equal(
          includeUntrackedEnabled({ KHY_DIFF_INCLUDE_UNTRACKED: v }),
          false,
          `�?${JSON.stringify(v)} 应关`
        );
      }
  });

  test('includeUntrackedEnabled:其它值开', () => {
      for (const v of ['1', 'true', 'on', 'yes', 'anything']) {
        assert.equal(
          includeUntrackedEnabled({ KHY_DIFF_INCLUDE_UNTRACKED: v }),
          true,
          `�?${JSON.stringify(v)} 应开`
        );
      }
  });

  test('门控开:tracked + 两个未跟�?�?�?tracked 段且两份 --no-index �?+ 行齐�?', () => {
      const runGit = makeRunGit({
        tracked: TRACKED_DIFF,
        untracked: ['new-a.js', '新文�?txt'],
        synth: { 'new-a.js': NEW_FILE_A, '新文�?txt': NEW_FILE_B },
      });
      const out = collectWorkingTreeDiff(runGit, {});
      expect(out.includes('+++ b/existing.js')).toBeTruthy();
      expect(out.includes('+++ b/new-a.js')).toBeTruthy();
      expect(out.includes('+++ b/新文�?txt')).toBeTruthy();
      expect(out.includes("+console.log('a');")).toBe();
      expect(out.includes('+你好')).toBeTruthy();
  });

  test('仅未跟踪�?tracked �?仍输出新文件 diff(历史此场景为�?', () => {
      const runGit = makeRunGit({
        tracked: '',
        untracked: ['new-a.js'],
        synth: { 'new-a.js': NEW_FILE_A },
      });
      const out = collectWorkingTreeDiff(runGit, {});
      expect(out.includes('+++ b/new-a.js')).toBeTruthy();
      expect(!out.startsWith('\n')).toBeTruthy();
  });

  test('门控�?逐字节等于裸 git diff �?trim(无视未跟�?', () => {
      const runGit = makeRunGit({
        tracked: '\n' + TRACKED_DIFF + '\n',
        untracked: ['new-a.js'],
        synth: { 'new-a.js': NEW_FILE_A },
      });
      const out = collectWorkingTreeDiff(runGit, { KHY_DIFF_INCLUDE_UNTRACKED: '0' });
      expect(out).toBe(TRACKED_DIFF);
      expect(!out.includes('new-a.js')).toBeTruthy();
  });

  test('无任何改�?�?空串', () => {
      const runGit = makeRunGit({ tracked: '', untracked: [] });
      expect(collectWorkingTreeDiff(runGit)).toBe({});
  });

  test('maxUntracked 封顶 �?追加诚实�?N 未显示」标�?非静�?', () => {
      const untracked = ['f1', 'f2', 'f3', 'f4', 'f5'];
      const synth = {};
      for (const f of untracked) {
        synth[f] = `--- /dev/null\n+++ b/${f}\n@@ -0,0 +1 @@\n+x`;
      }
      const runGit = makeRunGit({ tracked: '', untracked, synth });
      const out = collectWorkingTreeDiff(runGit, {}, { maxUntracked: 2 });
      expect(out.includes('+++ b/f1')).toBeTruthy();
      expect(out.includes('+++ b/f2')).toBeTruthy();
      expect(!out.includes('+++ b/f3')).toBeTruthy();
      expect(/\+3 个新文件未显�?.test(out)).toBe();
  });

  test('maxUntracked 非法�?�?退默认 50(不抛)', () => {
      const runGit = makeRunGit({ tracked: '', untracked: ['f1'], synth: { f1: '+++ b/f1\n+x' } });
      for (const bad of [NaN, -1, 'abc', undefined]) {
        const out = collectWorkingTreeDiff(runGit, {}, { maxUntracked: bad });
        expect(out.includes('+++ b/f1')).toBeTruthy();
      }
  });

  test('防呆:runGit 非函�?�?返回空串不抛', () => {
      expect(collectWorkingTreeDiff(null)).toBe({});
      expect(collectWorkingTreeDiff(undefined)).toBe({});
      expect(collectWorkingTreeDiff(42)).toBe({});
  });

  test('防呆:runGit 返回非对�?/ stdout 缺失 �?当作�?stdout 不抛', () => {
      assert.equal(
        collectWorkingTreeDiff(() => null, {}),
        ''
      );
      assert.equal(
        collectWorkingTreeDiff(() => ({}), {}),
        ''
      );
      assert.equal(
        collectWorkingTreeDiff(() => 'not-an-object', {}),
        ''
      );
  });

  test('防呆:runGit �?�?被吞,该段当作�?不冒�?', () => {
      // tracked 调用�?�?tracked �?ls-files 正常 �?�?--no-index �?�?该新文件段空
      const runGit = (args) => {
        if (args[0] === 'diff' && args[1] === '--no-index') {
          throw new Error('exit 1 no stdout captured');
        }
        if (args[0] === 'ls-files') {
          return { stdout: 'f1\0' };
        }
        if (args[0] === 'diff') {
          throw new Error('boom');
        }
        return { stdout: '' };
      };
      expect(() => collectWorkingTreeDiff(runGit, {}).not.toThrow());
      expect(collectWorkingTreeDiff(runGit)).toBe({});
  });

});

