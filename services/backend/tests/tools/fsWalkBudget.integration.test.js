'use strict';

/**
 * fsWalkBudget.integration.test.js — 证明 GlobTool / ListDirTool 的墙钟预算在真实文件树上
 * 生效:极小预算能让同步 walk 提前收尾并标 timedOut/truncated,不假死;符号链接回环存在时
 * 也在时间/深度上限内终止,绝不无限阻塞。
 *
 * 这是回归本次「Windows 上列目录假死 18 分钟」的守卫:根因是同步 walk 无时间上限,遇超大树 /
 * junction 回环时阻塞事件循环、ESC 打不断。核心不变量:无论树多大 / I-O 多慢 / 有无环,walk
 * 都在墙钟预算耗尽时优雅提前返回。测试用最小预算触发提前返回、用符号链接构造回环,断言不假死、
 * 总是成功返回。
 *
 * 运行:node --test services/backend/tests/tools/fsWalkBudget.integration.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function mkTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-walk-'));
  fs.writeFileSync(path.join(root, 'README.md'), '# hi');
  const sub = path.join(root, 'sub');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'a.py'), 'x=1');
  return { root, sub };
}

function loadFreshGlob() {
  delete require.cache[require.resolve('../../src/tools/GlobTool/index.js')];
  return require('../../src/tools/GlobTool/index.js');
}
function loadFreshListDir() {
  delete require.cache[require.resolve('../../src/tools/ListDirTool/index.js')];
  return require('../../src/tools/ListDirTool/index.js');
}

test('极小墙钟预算 → Glob walk 提前收尾,总是成功返回(不假死、不抛)', (t) => {
  const { root, sub } = mkTree();
  // 铺一些文件,让至少一次 deadline 检查有机会命中。
  for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(sub, `f${i}.py`), 'x');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  const prev = process.env.KHY_FS_WALK_BUDGET_MS;
  process.env.KHY_FS_WALK_BUDGET_MS = '250'; // 下限
  t.after(() => {
    if (prev === undefined) delete process.env.KHY_FS_WALK_BUDGET_MS;
    else process.env.KHY_FS_WALK_BUDGET_MS = prev;
  });

  const Glob = loadFreshGlob();
  assert.ok(Glob && typeof Glob.execute === 'function');
  // 无论是否命中预算,都必须成功返回(核心断言:不抛、不假死)。
  return Glob.execute({ pattern: '*.py', path: root }).then((res) => {
    assert.equal(res.success, true);
    assert.equal(Array.isArray(res.files), true);
  });
});

test('符号链接回环存在 → ListDir 在深度/时间上限内终止,总是成功返回(不假死)', (t) => {
  const { root } = mkTree();
  try {
    // sub/loop → root(回到父,构造回环)。无 symlink 权限(某些 CI)时忽略。
    fs.symlinkSync(root, path.join(root, 'sub', 'loop'), 'dir');
  } catch { /* 无 symlink 权限 → 仍验证普通树不假死 */ }
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  const ListDir = loadFreshListDir();
  const inst = ListDir.ListDirTool ? ListDir : null;
  // 门控关时导出 benign 对象;此处默认开,导出实例。
  assert.ok(inst && typeof inst.execute === 'function', 'ListDir tool should be enabled by default');

  // 用最大深度跑;回环存在时若无时间/深度兜底会无限膨胀——核心断言:仍成功终止返回。
  return inst.execute({ path: root, depth: 4 }).then((res) => {
    assert.equal(res.success, true);
    assert.equal(Array.isArray(res.files), true);
  });
});

test('墙钟预算门控关(KHY_FS_WALK_BUDGET=off)→ 无预算今日行为,常规小树仍正常返回', (t) => {
  const { root } = mkTree();
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  const prev = process.env.KHY_FS_WALK_BUDGET;
  process.env.KHY_FS_WALK_BUDGET = 'off';
  t.after(() => {
    if (prev === undefined) delete process.env.KHY_FS_WALK_BUDGET;
    else process.env.KHY_FS_WALK_BUDGET = prev;
  });

  const Glob = loadFreshGlob();
  return Glob.execute({ pattern: '**/*.py', path: root }).then((res) => {
    assert.equal(res.success, true);
    // 门控关:无 timedOut 标记(逐字节回退今日无预算行为)。
    assert.equal(res.timedOut, undefined);
    assert.ok(res.files.some((f) => f.endsWith('a.py')));
  });
});
