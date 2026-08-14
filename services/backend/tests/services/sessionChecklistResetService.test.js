'use strict';

/**
 * sessionChecklistResetService.test.js — 薄壳:新会话启动清空 legacy 会话清单文件。
 *
 * 注入 fake fs + paths(不碰真实文件系统)。锁定 resetSessionChecklist:
 *   ① 存在的目标文件被 unlink、removed/paths 正确、打一次 log;
 *   ② 不存在的文件跳过(existsSync=false),不计入 removed;
 *   ③ 门控关 → {ran:false},不 unlink;
 *   ④ resume 会话 → {ran:false},不 unlink(承接上一会话清单);
 *   ⑤ 单条 unlink 抛 → fail-soft,如实少清、不影响其它;
 *   ⑥ removed=0 → 不打 log。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const service = require('../../src/services/sessionChecklistResetService');

const PATHS = {
  tmpdir: '/tmp',
  compatTmpdir: '/tmp',
  homedir: '/home/u',
  cwd: '/work/proj',
};

// 期望被判定为目标的全集(与 policy 一致)。
const ALL_TARGETS = [
  path.join('/tmp', 'khy-todos.json'),
  path.join('/home/u', '.khyquant', 'todo_state.json'),
  path.join('/work/proj', '.khyquant', 'todo_state.json'),
  path.join('/tmp', 'khyquant', 'todo_state.json'),
];

function fakeFs(existing) {
  const present = new Set(existing);
  const unlinked = [];
  return {
    unlinked,
    existsSync: (p) => present.has(p),
    unlinkSync: (p) => { if (!present.has(p)) throw new Error('ENOENT'); present.delete(p); unlinked.push(p); },
  };
}

test('存在的目标被 unlink、removed/paths 正确、打一次 log', () => {
  const existing = [
    path.join('/tmp', 'khy-todos.json'),
    path.join('/home/u', '.khyquant', 'todo_state.json'),
  ];
  const fs = fakeFs(existing);
  const logs = [];
  const res = service.resetSessionChecklist({ resumed: false, env: {}, paths: PATHS, fs, log: (l) => logs.push(l) });

  assert.strictEqual(res.ran, true);
  assert.strictEqual(res.removed, 2);
  assert.deepStrictEqual(res.paths.sort(), existing.slice().sort());
  assert.deepStrictEqual(fs.unlinked.sort(), existing.slice().sort());
  assert.strictEqual(logs.length, 1);
  assert.ok(/2 个 legacy todo 文件/.test(logs[0]), 'log 含数量');
});

test('不存在的文件跳过,不计入 removed', () => {
  const fs = fakeFs([]); // 全不存在
  const res = service.resetSessionChecklist({ resumed: false, env: {}, paths: PATHS, fs });
  assert.deepStrictEqual(res, { ran: true, removed: 0, paths: [] });
  assert.strictEqual(fs.unlinked.length, 0);
});

test('门控关 → {ran:false},不 unlink', () => {
  let touched = false;
  const fs = { existsSync: () => { touched = true; return true; }, unlinkSync: () => { touched = true; } };
  const res = service.resetSessionChecklist({ resumed: false, env: { KHY_SESSION_TODO_RESET: 'off' }, paths: PATHS, fs });
  assert.deepStrictEqual(res, { ran: false, removed: 0, paths: [] });
  assert.strictEqual(touched, false, '门控关不应碰 fs');
});

test('resume 会话 → {ran:false},不 unlink(承接上一会话清单)', () => {
  let touched = false;
  const fs = { existsSync: () => { touched = true; return true; }, unlinkSync: () => { touched = true; } };
  const res = service.resetSessionChecklist({ resumed: true, env: {}, paths: PATHS, fs });
  assert.deepStrictEqual(res, { ran: false, removed: 0, paths: [] });
  assert.strictEqual(touched, false, 'resume 不应碰 fs');
});

test('单条 unlink 抛 → fail-soft,如实少清、其它照删', () => {
  const all = ALL_TARGETS.slice();
  const fs = fakeFs(all);
  // 让第一个目标 unlink 抛(权限/竞态),其余正常。
  const orig = fs.unlinkSync;
  const boomPath = path.join('/tmp', 'khy-todos.json');
  fs.unlinkSync = (p) => { if (p === boomPath) throw new Error('EPERM'); return orig(p); };

  const res = service.resetSessionChecklist({ resumed: false, env: {}, paths: PATHS, fs });
  assert.strictEqual(res.ran, true);
  assert.ok(!res.paths.includes(boomPath), '抛错的那条不计入 removed');
  assert.ok(res.removed >= 1, '其余仍被清');
});

test('removed=0 → 不打 log', () => {
  const fs = fakeFs([]);
  const logs = [];
  service.resetSessionChecklist({ resumed: false, env: {}, paths: PATHS, fs, log: (l) => logs.push(l) });
  assert.strictEqual(logs.length, 0);
});

test('_resolvePaths 返回四个基目录字段(真实环境探测)', () => {
  const p = service._resolvePaths();
  assert.ok(typeof p.tmpdir === 'string');
  assert.ok(typeof p.compatTmpdir === 'string');
  assert.ok(typeof p.homedir === 'string');
  assert.ok(typeof p.cwd === 'string');
});

// ── 会话作用域孤儿清理(_pruneStaleScopedTodos + resetSessionChecklist 集成) ──────
const DAY = 86400000;

/** fake fs 扩展:readdirSync/statSync 支持 mtime + existsSync/unlinkSync。 */
function fakeFsWithStat(files) {
  // files: { [absPath]: mtimeMs }
  const present = new Map(Object.entries(files));
  const unlinked = [];
  return {
    unlinked,
    existsSync: (p) => present.has(p),
    unlinkSync: (p) => { if (!present.has(p)) throw new Error('ENOENT'); present.delete(p); unlinked.push(p); },
    readdirSync: (dir) => {
      const out = [];
      for (const abs of present.keys()) {
        if (path.dirname(abs) === dir) out.push(path.basename(abs));
      }
      return out;
    },
    statSync: (p) => { if (!present.has(p)) throw new Error('ENOENT'); return { mtimeMs: present.get(p) }; },
  };
}

test('_pruneStaleScopedTodos: 陈旧会话分文件被清、近期保留、legacy 不误删', () => {
  const now = Date.now();
  const old = path.join('/tmp', 'khy-todos-dead.json');
  const fresh = path.join('/tmp', 'khy-todos-live.json');
  const legacy = path.join('/tmp', 'khy-todos.json'); // 全局:SCOPED_FILE_RE 不匹配 → 不经此清
  const fs = fakeFsWithStat({
    [old]: now - 30 * DAY,
    [fresh]: now - 1 * DAY,
    [legacy]: now - 30 * DAY,
  });
  const removed = service._pruneStaleScopedTodos({ tmpdir: '/tmp' }, fs, {});
  assert.deepStrictEqual(removed, [old]);
  assert.ok(!fs.unlinked.includes(fresh), '近期分文件保留');
  assert.ok(!fs.unlinked.includes(legacy), 'legacy 全局不经孤儿清理');
});

test('_pruneStaleScopedTodos: 门控关 → 不清理', () => {
  const now = Date.now();
  const old = path.join('/tmp', 'khy-todos-dead.json');
  const fs = fakeFsWithStat({ [old]: now - 99 * DAY });
  const removed = service._pruneStaleScopedTodos({ tmpdir: '/tmp' }, fs, { KHY_TODO_SESSION_SCOPED: '0' });
  assert.deepStrictEqual(removed, []);
  assert.strictEqual(fs.unlinked.length, 0);
});

test('resetSessionChecklist: 集成清孤儿——legacy 全局 + 陈旧分文件一并计入 removed', () => {
  const now = Date.now();
  const legacy = path.join('/tmp', 'khy-todos.json');
  const oldScoped = path.join('/tmp', 'khy-todos-dead.json');
  const freshScoped = path.join('/tmp', 'khy-todos-live.json');
  const fs = fakeFsWithStat({
    [legacy]: now,
    [oldScoped]: now - 30 * DAY,
    [freshScoped]: now - 1 * DAY,
  });
  const logs = [];
  const res = service.resetSessionChecklist({
    resumed: false, env: {}, paths: PATHS, fs, log: (l) => logs.push(l),
  });
  assert.strictEqual(res.ran, true);
  // legacy(policy target)+ oldScoped(孤儿)= 2;freshScoped 保留。
  assert.ok(res.paths.includes(legacy), 'legacy 全局被清');
  assert.ok(res.paths.includes(oldScoped), '陈旧分文件被清');
  assert.ok(!res.paths.includes(freshScoped), '近期分文件保留');
  assert.strictEqual(res.removed, 2);
  assert.strictEqual(logs.length, 1);
});

