'use strict';

/**
 * gitDiffCollect 叶子单测(node:test)。
 *
 * 注入假 runGit(按 args 返回预置 stdout),覆盖:
 *   - 门控梯(默认开 / 0·false·off·no(含大小写)关 / 其它值开)
 *   - 门控开:tracked + 两个未跟踪 → 同时含 tracked 段与两份 --no-index 段(+ 行齐全)
 *   - 门控关:逐字节等于裸 git diff 的 trim(证回退)
 *   - 仅未跟踪无 tracked → 仍输出新文件 diff(关键回归点:历史此场景为空)
 *   - 无任何改动 → 空串
 *   - maxUntracked 封顶 → 追加诚实「+N 未显示」标记(非静默)
 *   - 防呆:runGit 非函数 / stdout 缺失 → 不抛、返回空或仅 tracked
 */

const test = require('node:test');
const assert = require('node:assert');

const { includeUntrackedEnabled, collectWorkingTreeDiff } = require('./gitDiffCollect');

// ── 假 runGit 工厂:按首参数与具体路径返回预置 stdout ────────────────────────────────
function makeRunGit({ tracked = '', untracked = [], synth = {} } = {}) {
  // untracked: string[]；synth: { [path]: diffText }
  return (args) => {
    if (args[0] === 'diff' && args[1] === '--no-index') {
      const f = args[args.length - 1];
      return { stdout: synth[f] || '' };
    }
    if (args[0] === 'diff') return { stdout: tracked };
    if (args[0] === 'ls-files') return { stdout: untracked.map((f) => f + '\0').join('') };
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
  'diff --git a/新文件.txt b/新文件.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/新文件.txt',
  '@@ -0,0 +1,1 @@',
  '+你好',
].join('\n');

// ── 门控梯 ────────────────────────────────────────────────────────────────────────
test('includeUntrackedEnabled:默认开(未设)', () => {
  assert.equal(includeUntrackedEnabled({}), true);
});

test('includeUntrackedEnabled:0/false/off/no(含大小写)关', () => {
  for (const v of ['0', 'false', 'off', 'no', 'FALSE', 'Off', 'NO', ' no ']) {
    assert.equal(includeUntrackedEnabled({ KHY_DIFF_INCLUDE_UNTRACKED: v }), false, `值 ${JSON.stringify(v)} 应关`);
  }
});

test('includeUntrackedEnabled:其它值开', () => {
  for (const v of ['1', 'true', 'on', 'yes', 'anything']) {
    assert.equal(includeUntrackedEnabled({ KHY_DIFF_INCLUDE_UNTRACKED: v }), true, `值 ${JSON.stringify(v)} 应开`);
  }
});

// ── 门控开:合并 tracked + 未跟踪 ──────────────────────────────────────────────────
test('门控开:tracked + 两个未跟踪 → 含 tracked 段且两份 --no-index 段(+ 行齐全)', () => {
  const runGit = makeRunGit({
    tracked: TRACKED_DIFF,
    untracked: ['new-a.js', '新文件.txt'],
    synth: { 'new-a.js': NEW_FILE_A, '新文件.txt': NEW_FILE_B },
  });
  const out = collectWorkingTreeDiff(runGit, {});
  assert.ok(out.includes('+++ b/existing.js'), '应含 tracked 段');
  assert.ok(out.includes('+++ b/new-a.js'), '应含新文件 A 段');
  assert.ok(out.includes('+++ b/新文件.txt'), '应含新文件 B 段(含中文路径)');
  assert.ok(out.includes("+console.log('a');"), '新文件 A 的 + 行齐全');
  assert.ok(out.includes('+你好'), '新文件 B 的 + 行齐全');
});

test('仅未跟踪无 tracked → 仍输出新文件 diff(历史此场景为空)', () => {
  const runGit = makeRunGit({
    tracked: '',
    untracked: ['new-a.js'],
    synth: { 'new-a.js': NEW_FILE_A },
  });
  const out = collectWorkingTreeDiff(runGit, {});
  assert.ok(out.includes('+++ b/new-a.js'), '仅有新文件时也应显示');
  assert.ok(!out.startsWith('\n'), '无 tracked 时不应以空行开头(无空 tracked 段)');
});

// ── 门控关:逐字节回退 ────────────────────────────────────────────────────────────
test('门控关:逐字节等于裸 git diff 的 trim(无视未跟踪)', () => {
  const runGit = makeRunGit({
    tracked: '\n' + TRACKED_DIFF + '\n',
    untracked: ['new-a.js'],
    synth: { 'new-a.js': NEW_FILE_A },
  });
  const out = collectWorkingTreeDiff(runGit, { KHY_DIFF_INCLUDE_UNTRACKED: '0' });
  assert.equal(out, TRACKED_DIFF, '门控关应只返回裸 git diff 的 trim');
  assert.ok(!out.includes('new-a.js'), '门控关绝不含未跟踪文件');
});

// ── 边界 ──────────────────────────────────────────────────────────────────────────
test('无任何改动 → 空串', () => {
  const runGit = makeRunGit({ tracked: '', untracked: [] });
  assert.equal(collectWorkingTreeDiff(runGit, {}), '');
});

test('maxUntracked 封顶 → 追加诚实「+N 未显示」标记(非静默)', () => {
  const untracked = ['f1', 'f2', 'f3', 'f4', 'f5'];
  const synth = {};
  for (const f of untracked) synth[f] = `--- /dev/null\n+++ b/${f}\n@@ -0,0 +1 @@\n+x`;
  const runGit = makeRunGit({ tracked: '', untracked, synth });
  const out = collectWorkingTreeDiff(runGit, {}, { maxUntracked: 2 });
  assert.ok(out.includes('+++ b/f1'), '前 2 个应显示');
  assert.ok(out.includes('+++ b/f2'), '前 2 个应显示');
  assert.ok(!out.includes('+++ b/f3'), '第 3 个起不显示');
  assert.ok(/\+3 个新文件未显示/.test(out), '应追加诚实未显示标记');
});

test('maxUntracked 非法值 → 退默认 50(不抛)', () => {
  const runGit = makeRunGit({ tracked: '', untracked: ['f1'], synth: { f1: '+++ b/f1\n+x' } });
  for (const bad of [NaN, -1, 'abc', undefined]) {
    const out = collectWorkingTreeDiff(runGit, {}, { maxUntracked: bad });
    assert.ok(out.includes('+++ b/f1'), `maxUntracked=${String(bad)} 仍应显示`);
  }
});

// ── 防呆 ──────────────────────────────────────────────────────────────────────────
test('防呆:runGit 非函数 → 返回空串不抛', () => {
  assert.equal(collectWorkingTreeDiff(null, {}), '');
  assert.equal(collectWorkingTreeDiff(undefined, {}), '');
  assert.equal(collectWorkingTreeDiff(42, {}), '');
});

test('防呆:runGit 返回非对象 / stdout 缺失 → 当作空 stdout 不抛', () => {
  assert.equal(collectWorkingTreeDiff(() => null, {}), '');
  assert.equal(collectWorkingTreeDiff(() => ({}), {}), '');
  assert.equal(collectWorkingTreeDiff(() => 'not-an-object', {}), '');
});

test('防呆:runGit 抛 → 被吞,该段当作空(不冒泡)', () => {
  // tracked 调用抛 → tracked 空;ls-files 正常 → 但 --no-index 抛 → 该新文件段空
  const runGit = (args) => {
    if (args[0] === 'diff' && args[1] === '--no-index') throw new Error('exit 1 no stdout captured');
    if (args[0] === 'ls-files') return { stdout: 'f1\0' };
    if (args[0] === 'diff') throw new Error('boom');
    return { stdout: '' };
  };
  assert.doesNotThrow(() => collectWorkingTreeDiff(runGit, {}));
  assert.equal(collectWorkingTreeDiff(runGit, {}), '');
});
