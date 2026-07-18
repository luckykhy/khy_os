'use strict';

/**
 * localBrainFileOpGlued — file_op 粘连连接符自然中文形单测(node:test,确定性)。
 *
 * 缺口:「把 X 移到 Y」「把 X 复制到 Y」「将 X 拷贝到 Y」此前在所有层(file_op
 * 是 cooperative:false)都返回 NULL → 只出兜底菜单,连 KHY 自家 describeApis 广告示例
 * 「把 a.txt 移到 backup/」都不命中。根因:_FILE_OP_RE 要求连接符「到/去/至」前有空格,
 * 而自然中文里「移到/移动到/复制到/拷贝到」连接符与动词粘连。
 *
 * 本测试锁定:
 *   - 粘连形被识别为 file_op,且 copy/move 判定正确;
 *   - 既有「移动 X 到 Y」(空格分隔连接符)路径行为不变;
 *   - 门控 KHY_FILE_OP_GLUED=off → 粘连形字节回退为 NULL(与历史一致);
 *   - 经 localBrainService Tier-1 注册表分派(file_op 是 cooperative:false,有无模型都拦截)。
 */

const test = require('node:test');
const assert = require('node:assert');

const lb = require('../../src/services/localBrainService');

function detect(text, opts) {
  return lb.detectDeterministic(text, opts || {});
}

test('粘连连接符:把/将 X 移到/移动到/复制到/拷贝到 Y → file_op,copy/move 判定正确', () => {
  const cwd = '/tmp/fo-test';
  const move = detect('把 a.txt 移到 backup/', { cwd });
  assert.ok(move && move.type === 'file_op', '「把 a.txt 移到 backup/」应命中 file_op');
  assert.strictEqual(move.op, 'move');

  const move2 = detect('把 a.txt 移动到 backup/', { cwd });
  assert.ok(move2 && move2.type === 'file_op');
  assert.strictEqual(move2.op, 'move');

  const copy = detect('把 a.txt 复制到 backup/', { cwd });
  assert.ok(copy && copy.type === 'file_op');
  assert.strictEqual(copy.op, 'copy');

  const copy2 = detect('将 x.log 拷贝到 logs/', { cwd });
  assert.ok(copy2 && copy2.type === 'file_op');
  assert.strictEqual(copy2.op, 'copy');
});

test('既有空格分隔连接符形为不变(回归保护)', () => {
  const cwd = '/tmp/fo-test';
  const m = detect('移动 a.txt 到 backup/', { cwd });
  assert.ok(m && m.type === 'file_op');
  assert.strictEqual(m.op, 'move');

  const c = detect('复制 a.txt 到 b.txt', { cwd });
  assert.ok(c && c.type === 'file_op');
  assert.strictEqual(c.op, 'copy');

  const r = detect('重命名 a.txt 为 b.txt', { cwd });
  assert.ok(r && r.type === 'file_op');
  assert.strictEqual(r.op, 'rename');
});

test('门控 KHY_FILE_OP_GLUED=off → 粘连形字节回退为 NULL', () => {
  const prev = process.env.KHY_FILE_OP_GLUED;
  try {
    process.env.KHY_FILE_OP_GLUED = 'off';
    assert.strictEqual(detect('把 a.txt 移到 backup/', { cwd: '/tmp/fo-test' }), null);
    // 但既有空格分隔形不受门控影响,仍命中
    const m = detect('移动 a.txt 到 backup/', { cwd: '/tmp/fo-test' });
    assert.ok(m && m.type === 'file_op');
    // 默认(未设置)→ 开
    delete process.env.KHY_FILE_OP_GLUED;
    const g = detect('把 a.txt 移到 backup/', { cwd: '/tmp/fo-test' });
    assert.ok(g && g.type === 'file_op');
  } finally {
    if (prev === undefined) delete process.env.KHY_FILE_OP_GLUED;
    else process.env.KHY_FILE_OP_GLUED = prev;
  }
});

test('src/dest 解析:dest 以 / 结尾保留原文件名', () => {
  const plan = detect('把 a.txt 移到 backup/', { cwd: '/tmp/fo-test' });
  assert.ok(plan.dest.endsWith('/backup/a.txt') || plan.dest.endsWith('\\backup\\a.txt'), `dest=${plan.dest}`);
  assert.ok(plan.src.endsWith('/a.txt') || plan.src.endsWith('\\a.txt'), `src=${plan.src}`);
});
