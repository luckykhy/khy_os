'use strict';

/**
 * orphanSweep.test.js — 纯叶子:递归清除 pip 升级残留的 `~` 前缀损坏孤儿目录。
 *
 * 锁定:
 *   ① isCorruptOrphanName 谓词:`~` 起(非 `.`/`..`)才算损坏标记;
 *   ② isEnabled 门控默认开、仅 {0,false,off,no} 关;
 *   ③ resolveMaxSweep 默认 + KHY_ORPHAN_SWEEP_MAX 覆盖 + 坏值回落;
 *   ④ sweepBundledOrphans 递归:删嵌套 `~` 目录、保留干净、剪枝 node_modules/.git;
 *   ⑤ 只删目录不删 `~` 文件;⑥ 不跟随符号链接;⑦ dry-run(apply:false)只统计不删;
 *   ⑧ 门控关 → skipped no-op;⑨ 上限 limit 生效;⑩ 遇 `~` 目录不下降(整棵一次)。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const leaf = require('../../src/services/orphanSweep/orphanSweep');

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-sweep-'));
}

test('isCorruptOrphanName: 仅 `~` 起(非 . / ..)', () => {
  assert.equal(leaf.isCorruptOrphanName('~rc'), true);
  assert.equal(leaf.isCorruptOrphanName('~'), true);
  assert.equal(leaf.isCorruptOrphanName('~~st'), true);
  assert.equal(leaf.isCorruptOrphanName('src'), false);
  assert.equal(leaf.isCorruptOrphanName('.'), false);
  assert.equal(leaf.isCorruptOrphanName('..'), false);
  assert.equal(leaf.isCorruptOrphanName(''), false);
  assert.equal(leaf.isCorruptOrphanName(null), false);
});

test('isEnabled: 默认开,仅 {0,false,off,no} 关', () => {
  assert.equal(leaf.isEnabled({}), true);
  assert.equal(leaf.isEnabled({ KHY_ORPHAN_SWEEP: 'on' }), true);
  assert.equal(leaf.isEnabled({ KHY_ORPHAN_SWEEP: '1' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(leaf.isEnabled({ KHY_ORPHAN_SWEEP: v }), false, v);
  }
});

test('resolveMaxSweep: 默认 + 覆盖 + 坏值回落', () => {
  assert.equal(leaf.resolveMaxSweep({}), leaf.DEFAULT_MAX_SWEEP);
  assert.equal(leaf.resolveMaxSweep({ KHY_ORPHAN_SWEEP_MAX: '10' }), 10);
  assert.equal(leaf.resolveMaxSweep({ KHY_ORPHAN_SWEEP_MAX: 'abc' }), leaf.DEFAULT_MAX_SWEEP);
  assert.equal(leaf.resolveMaxSweep({ KHY_ORPHAN_SWEEP_MAX: '-5' }), leaf.DEFAULT_MAX_SWEEP);
  assert.equal(leaf.resolveMaxSweep({ KHY_ORPHAN_SWEEP_MAX: '1.5' }), leaf.DEFAULT_MAX_SWEEP);
});

test('sweepBundledOrphans: 递归删嵌套 `~` 目录、保留干净、剪枝 node_modules', () => {
  const root = mktmp();
  try {
    fs.mkdirSync(path.join(root, 'services', 'backend', 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'services', 'backend', '~rc'));
    fs.mkdirSync(path.join(root, '~ata'));
    // node_modules 内的 `~` 目录必须被剪枝、保留。
    fs.mkdirSync(path.join(root, 'node_modules', '~evil'), { recursive: true });

    const res = leaf.sweepBundledOrphans({ root, env: {} });

    assert.equal(res.ok, true);
    assert.equal(res.skipped, false);
    assert.equal(res.removed.length, 2);
    assert.equal(fs.existsSync(path.join(root, 'services', 'backend', 'src')), true);
    assert.equal(fs.existsSync(path.join(root, 'services', 'backend', '~rc')), false);
    assert.equal(fs.existsSync(path.join(root, '~ata')), false);
    assert.equal(fs.existsSync(path.join(root, 'node_modules', '~evil')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sweepBundledOrphans: 只删目录,`~` 文件不动', () => {
  const root = mktmp();
  try {
    fs.writeFileSync(path.join(root, '~scratch'), 'x');
    fs.mkdirSync(path.join(root, '~dir'));
    const res = leaf.sweepBundledOrphans({ root, env: {} });
    assert.equal(res.removed.length, 1);
    assert.equal(fs.existsSync(path.join(root, '~scratch')), true); // 文件保留
    assert.equal(fs.existsSync(path.join(root, '~dir')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sweepBundledOrphans: 不跟随符号链接', () => {
  const root = mktmp();
  const outside = mktmp();
  try {
    fs.mkdirSync(path.join(outside, 'precious'));
    // 一个名字以 `~` 起的**符号链接**指向树外目录 → 绝不 rm 穿出。
    try {
      fs.symlinkSync(outside, path.join(root, '~link'), 'dir');
    } catch {
      return; // 平台不支持 symlink(如无权限 Windows)→ 跳过此断言
    }
    const res = leaf.sweepBundledOrphans({ root, env: {} });
    // 符号链接被跳过(不计入 removed),树外目录完好。
    assert.equal(res.removed.length, 0);
    assert.equal(fs.existsSync(path.join(outside, 'precious')), true);
    assert.equal(fs.existsSync(path.join(root, '~link')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('sweepBundledOrphans: dry-run(apply:false)只统计不删', () => {
  const root = mktmp();
  try {
    fs.mkdirSync(path.join(root, '~rc'));
    const res = leaf.sweepBundledOrphans({ root, apply: false, env: {} });
    assert.equal(res.removed.length, 1);
    assert.equal(fs.existsSync(path.join(root, '~rc')), true); // 未删
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sweepBundledOrphans: 门控关 → skipped no-op', () => {
  const root = mktmp();
  try {
    fs.mkdirSync(path.join(root, '~rc'));
    const res = leaf.sweepBundledOrphans({ root, env: { KHY_ORPHAN_SWEEP: 'off' } });
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'gate-off');
    assert.equal(res.removed.length, 0);
    assert.equal(fs.existsSync(path.join(root, '~rc')), true); // 字节回退不清理
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sweepBundledOrphans: 上限 limit 生效', () => {
  const root = mktmp();
  try {
    for (let i = 0; i < 5; i++) fs.mkdirSync(path.join(root, `~orphan${i}`));
    const res = leaf.sweepBundledOrphans({ root, limit: 2, env: {} });
    assert.equal(res.removed.length, 2);
    assert.equal(res.reason, 'limit');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sweepBundledOrphans: 遇 `~` 目录不下降(整棵一次计数)', () => {
  const root = mktmp();
  try {
    fs.mkdirSync(path.join(root, '~rc', '~nested'), { recursive: true });
    const res = leaf.sweepBundledOrphans({ root, env: {} });
    assert.equal(res.removed.length, 1); // 整棵一次,不重复计内层
    assert.equal(fs.existsSync(path.join(root, '~rc')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sweepBundledOrphans: 无 root / 坏输入 fail-soft', () => {
  assert.equal(leaf.sweepBundledOrphans({ env: {} }).skipped, true);
  assert.equal(leaf.sweepBundledOrphans({ root: 123, env: {} }).skipped, true);
  const missing = leaf.sweepBundledOrphans({ root: '/nonexistent/khy/xyz', env: {} });
  assert.equal(missing.skipped, true); // 不存在 → no-root,不抛
});
