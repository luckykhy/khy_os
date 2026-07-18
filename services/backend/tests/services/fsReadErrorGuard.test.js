'use strict';

/**
 * fsReadErrorGuard.test.js — 「读文件出现 illegal 提示」友好化纯叶子单测(node:test)。
 *
 * 覆盖:门控、目录读友好提示、errno 人话化(EISDIR/EACCES/ENOENT/...)、
 * 未知 errno 与门控关时逐字节回退 err.message、code 括号保留、绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert');

const g = require('../../src/services/fsReadErrorGuard');

test('isEnabled: 默认开,仅显式 falsy 关', () => {
  assert.equal(g.isEnabled({}), true);
  assert.equal(g.isEnabled({ KHY_FS_ERROR_HUMANIZE: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
    assert.equal(g.isEnabled({ KHY_FS_ERROR_HUMANIZE: off }), false, off);
  }
});

test('directoryReadMessage: 命中目录→友好中文含 ListDir 与 (EISDIR);门控关→null', () => {
  const msg = g.directoryReadMessage('/tmp/somedir', {});
  assert.match(msg, /目录/);
  assert.match(msg, /ListDir/);
  assert.match(msg, /\(EISDIR\)/);
  assert.match(msg, /\/tmp\/somedir/);
  assert.equal(g.directoryReadMessage('/tmp/somedir', { KHY_FS_ERROR_HUMANIZE: '0' }), null);
});

test('humanizeReadError: EISDIR→人话且保留 (EISDIR)', () => {
  const err = Object.assign(new Error('EISDIR: illegal operation on a directory, read'), { code: 'EISDIR' });
  const out = g.humanizeReadError(err, '/tmp/d', {});
  assert.match(out, /目录/);
  assert.doesNotMatch(out, /illegal operation/); // 不再泄露裸串
  assert.match(out, /\(EISDIR\)/);
  assert.match(out, /\/tmp\/d/);
});

test('humanizeReadError: ENOENT/EACCES/ENOTDIR 各有人话且保留 code', () => {
  for (const [code, re] of [['ENOENT', /不存在/], ['EACCES', /权限/], ['ENOTDIR', /不是目录/]]) {
    const err = Object.assign(new Error(`${code}: ...`), { code });
    const out = g.humanizeReadError(err, 'p', {});
    assert.match(out, re, code);
    assert.match(out, new RegExp(`\\(${code}\\)`), code);
  }
});

test('未知 errno → 逐字节回退 err.message', () => {
  const err = Object.assign(new Error('some weird message'), { code: 'EWEIRD' });
  assert.strictEqual(g.humanizeReadError(err, 'p', {}), 'some weird message');
  // 无 code 同样回退
  const err2 = new Error('no code here');
  assert.strictEqual(g.humanizeReadError(err2, 'p', {}), 'no code here');
});

test('门控关 → humanizeReadError 逐字节回退 err.message(revert oracle)', () => {
  const err = Object.assign(new Error('EISDIR: illegal operation on a directory, read'), { code: 'EISDIR' });
  const off = g.humanizeReadError(err, '/tmp/d', { KHY_FS_ERROR_HUMANIZE: 'off' });
  assert.strictEqual(off, 'EISDIR: illegal operation on a directory, read');
});

test('绝不抛:畸形输入 fail-soft', () => {
  assert.doesNotThrow(() => g.humanizeReadError(null, null, {}));
  assert.doesNotThrow(() => g.humanizeReadError(undefined, undefined, undefined));
  assert.doesNotThrow(() => g.directoryReadMessage(null, {}));
  assert.equal(typeof g.humanizeReadError('plain string', 'p', {}), 'string');
});
