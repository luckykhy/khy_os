'use strict';
/**
 * guardedReadFileSync 单元测�?
 *
 * 覆盖:
 *  - 常规文件:返回�?fs.readFileSync 完全一致的内容(Buffer �?encoding 两种签名)�?
 *  - 不存在的文件:透传 ENOENT(快速失�?非卡�?——统计前检不吞、不改错语义�?
 *  - FIFO(会卡死的向量):�?EREADHANG + hangKind='special:fifo',不真去读字节(否则冻结事件循环)�?
 *  - 族门�?KHY_READFILE_SPECIAL_GUARD=0):FIFO 前检�?null �?逐字节回退到裸 readFileSync
 *    (这里不实际读 FIFO 以免测试自身卡死,只断言「不�?EREADHANG」的前检判定)�?
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { guardedReadFileSync } = require('../../src/tools/guardedReadFileSync');
const REGULAR = path.join(__dirname, '..', '..', 'package.json');
test('FIFO �?throws EREADHANG (special:fifo), never reads bytes', { skip: process.platform === 'win32' }, () => {
  const fifo = path.join(os.tmpdir(), `khy_guarded_fifo_${process.pid}_f`);
  cp.execSync(`mkfifo ${fifo}`);
  try {
    assert.throws(
      () => guardedReadFileSync(fifo, 'utf-8'),
      (err) => {
        expect(err.code).toBe('EREADHANG');
        expect(err.hangKind).toBe('special:fifo');
        return true;
      },
    );
  } finally {
    fs.unlinkSync(fifo);
  }
});
test('special guard off �?FIFO not pre-blocked (byte-revert path)', { skip: process.platform === 'win32' }, () => {
  // 直接复核前检判定:关族门后 classifyPreReadHang �?null �?guarded 会落到裸 readFileSync�?
  // 不在此实际读 FIFO(会真卡死),只断言 EREADHANG 不再由前检抛出�?
  const fifo = path.join(os.tmpdir(), `khy_guarded_fifo_off_${process.pid}_f`);
  cp.execSync(`mkfifo ${fifo}`);
  try {
    const { classifyPreReadHang } = require('../../src/tools/filePreReadHangGuard');
    const verdict = classifyPreReadHang({
      absPath: fifo,
      stat: fs.statSync(fifo),
      env: { KHY_READFILE_SPECIAL_GUARD: '0' },
    });
    expect(verdict).toBe(null);
  } finally {
    fs.unlinkSync(fifo);
  }
});

describe('Guarded Read File Sync', () => {
  test('regular file (buffer) === fs.readFileSync', () => {
      const a = guardedReadFileSync(REGULAR);
      const b = fs.readFileSync(REGULAR);
      expect(Buffer.isBuffer(a)).toBeTruthy();
      expect(a.equals(b)).toBeTruthy();
  });

  test('regular file (utf-8) === fs.readFileSync', () => {
      const a = guardedReadFileSync(REGULAR, 'utf-8');
      const b = fs.readFileSync(REGULAR, 'utf-8');
      expect(typeof a).toBe('string');
      expect(a).toBe(b);
  });

  test('nonexistent file �?ENOENT passthrough (fast-fail, not hang)', () => {
      const missing = path.join(os.tmpdir(), 'khy_guarded_missing_does_not_exist_xyz');
      assert.throws(
        () => guardedReadFileSync(missing, 'utf-8'),
        (err) => err && err.code === 'ENOENT' && err.code !== 'EREADHANG',
      );
  });

});

