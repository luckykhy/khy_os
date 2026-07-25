'use strict';

/**
 * todoStateStorePaths.test.js — 纯叶子:兼容 todoWrite 的 todo_state.json 候选路径 SSOT。
 *
 * 锁定:
 *   ① 门控 todoStateUnifyEnabled 默认开、仅 {0,false,off,no} 关;
 *   ② todoStateCandidateFiles:有序 home→cwd→tmp、source 标签、file_path 拼接;
 *   ③ 收敛不变量:写侧(getTmpDir)与读侧(注入同一 tmpdir)候选**完全一致**;
 *   ④ 门控关字节回退:读侧注入 os.tmpdir → 与今日内联清单逐字节一致;
 *   ⑤ 坏输入 fail-soft。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const leaf = require('../../src/services/todoStateStorePaths');

// ── ① 门控 ─────────────────────────────────────────────────────────────────
test('todoStateUnifyEnabled: 默认开 + falsy 值关', () => {
  assert.strictEqual(leaf.todoStateUnifyEnabled({}), true);
  assert.strictEqual(leaf.todoStateUnifyEnabled({ KHY_TODO_STATE_UNIFY: '1' }), true);
  assert.strictEqual(leaf.todoStateUnifyEnabled({ KHY_TODO_STATE_UNIFY: 'on' }), true);
  assert.strictEqual(leaf.todoStateUnifyEnabled({ KHY_TODO_STATE_UNIFY: '0' }), false);
  assert.strictEqual(leaf.todoStateUnifyEnabled({ KHY_TODO_STATE_UNIFY: 'false' }), false);
  assert.strictEqual(leaf.todoStateUnifyEnabled({ KHY_TODO_STATE_UNIFY: 'off' }), false);
  assert.strictEqual(leaf.todoStateUnifyEnabled({ KHY_TODO_STATE_UNIFY: 'no' }), false);
});

// ── ② 候选清单 ───────────────────────────────────────────────────────────────
test('todoStateCandidateFiles: 有序 home→cwd→tmp + source + file_path', () => {
  const files = leaf.todoStateCandidateFiles({ homedir: '/home/u', cwd: '/work/proj', tmpdir: '/tmp' });
  assert.deepStrictEqual(files, [
    { source: 'legacy_data_home', dir: path.join('/home/u', '.khyquant'), file_path: path.join('/home/u', '.khyquant', 'todo_state.json') },
    { source: 'workspace', dir: path.join('/work/proj', '.khyquant'), file_path: path.join('/work/proj', '.khyquant', 'todo_state.json') },
    { source: 'temp_runtime', dir: path.join('/tmp', 'khyquant'), file_path: path.join('/tmp', 'khyquant', 'todo_state.json') },
  ]);
});

test('todoStateCandidateDirs: 只出目录(写侧建目录用)', () => {
  const dirs = leaf.todoStateCandidateDirs({ homedir: '/h', cwd: '/c', tmpdir: '/t' });
  assert.deepStrictEqual(dirs.map((d) => d.dir), [
    path.join('/h', '.khyquant'),
    path.join('/c', '.khyquant'),
    path.join('/t', 'khyquant'),
  ]);
});

// ── ③ 收敛不变量:写侧 = 读侧(注入同一 tmpdir → 候选完全一致) ─────────────────
test('收敛不变量:写读两侧注入同一 tmpdir → file_path 完全一致(消除漂移)', () => {
  const tmp = '/custom/temp'; // 例:Windows getTmpDir()==%TEMP% != os.tmpdir()
  const writer = leaf.todoStateCandidateFiles({ homedir: '/h', cwd: '/c', tmpdir: tmp }).map((c) => c.file_path);
  const reader = leaf.todoStateCandidateFiles({ homedir: '/h', cwd: '/c', tmpdir: tmp }).map((c) => c.file_path);
  assert.deepStrictEqual(writer, reader);
  // 且 temp 候选确实落在注入的 tmp 下(而非硬编码 os.tmpdir)。
  assert.strictEqual(writer[2], path.join(tmp, 'khyquant', 'todo_state.json'));
});

// ── ④ 门控关字节回退:读侧 SSOT(os.tmpdir)== 今日内联清单 ──────────────────────
test('字节回退:注入 os.tmpdir 时 SSOT 清单 == 读侧今日内联清单(source+file_path)', () => {
  const os = require('os');
  const homedir = os.homedir();
  const cwd = process.cwd();
  const tmp = os.tmpdir();
  // 今日读侧内联(largeTasks.js 门控关分支)。getLegacyDataHome()===homedir/.khyquant。
  const today = [
    { source: 'legacy_data_home', file_path: path.join(homedir, '.khyquant', 'todo_state.json') },
    { source: 'workspace', file_path: path.join(cwd, '.khyquant', 'todo_state.json') },
    { source: 'temp_runtime', file_path: path.join(tmp, 'khyquant', 'todo_state.json') },
  ];
  const viaSsot = leaf.todoStateCandidateFiles({ homedir, cwd, tmpdir: tmp })
    .map((c) => ({ source: c.source, file_path: c.file_path }));
  assert.deepStrictEqual(viaSsot, today);
});

// ── ⑤ 坏输入 fail-soft ───────────────────────────────────────────────────────
test('坏输入:缺字段 → 仍返回三条(空段拼接,绝不抛)', () => {
  const files = leaf.todoStateCandidateFiles({});
  assert.strictEqual(files.length, 3);
  for (const f of files) {
    assert.ok(typeof f.file_path === 'string');
    assert.ok(f.file_path.endsWith(path.join('todo_state.json')) || f.file_path.endsWith('todo_state.json'));
  }
});

test('常量导出稳定(读写两侧文件名一致)', () => {
  assert.strictEqual(leaf.TODO_STATE_FILE_NAME, 'todo_state.json');
  assert.strictEqual(leaf.DOT_DIR, '.khyquant');
  assert.strictEqual(leaf.TMP_SUBDIR, 'khyquant');
});
