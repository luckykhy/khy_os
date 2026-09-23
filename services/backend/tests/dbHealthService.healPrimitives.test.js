'use strict';

/**
 * dbHealthService.healPrimitives.test.js — locks the lock-aware / fail-soft
 * primitives of the SQLite self-heal service, without corrupting real DBs:
 *   - _isBusyError: "file held by another process" detection from errno
 *     (EBUSY/EPERM/EACCES) AND human-readable text (sharing violation /
 *     resource busy), returning false for unrelated errors / falsy input
 *   - _retryFsOperation: retries ONLY busy errors on the backoff ladder,
 *     attaches `attempts` to the rethrown error, and propagates non-busy
 *     errors immediately (single call, no backoff)
 *   - checkIntegrity: missing-file short-circuit + injected DatabaseCtor
 *     (quick_check ok / not-ok mapping) so no real sqlite-adapter is needed
 *   - _tryResetSidecars: quarantines mismatched -wal/-shm/-journal sidecars
 *     (rename, never delete) and reports the no-sidecar / still-unhealthy cases
 *   - getAuditLog: returns a copy of the in-memory heal-audit records
 * 纯逻辑 node:test；临时文件用 os.tmpdir 隔离，绝不触碰真实数据库。
 * 谁改忙锁判定 / 重试阶梯 / 附属文件隔离语义先红。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  _isBusyError,
  _retryFsOperation,
  checkIntegrity,
  _tryResetSidecars,
  getAuditLog,
} = require('../src/services/dbHealthService');

describe('dbHealthService _isBusyError 忙锁判定', () => {
  test('falsy 输入 → false（不误判）', () => {
    assert.strictEqual(_isBusyError(null), false);
    assert.strictEqual(_isBusyError(undefined), false);
    assert.strictEqual(_isBusyError(''), false);
  });

  test('errno code 命中（EBUSY/EPERM/EACCES）→ true', () => {
    assert.strictEqual(_isBusyError({ code: 'EBUSY' }), true);
    assert.strictEqual(_isBusyError({ code: 'EPERM' }), true);
    assert.strictEqual(_isBusyError({ code: 'EACCES' }), true);
  });

  test('人类可读文本命中（sharing violation / resource busy）→ true', () => {
    assert.strictEqual(_isBusyError('The process cannot access the file: sharing violation'), true);
    assert.strictEqual(_isBusyError(new Error('resource busy')), true);
  });

  test('无关错误 / 无关 code → false', () => {
    assert.strictEqual(_isBusyError(new Error('ENOENT: no such file')), false);
    assert.strictEqual(_isBusyError({ code: 'ENOENT' }), false);
    assert.strictEqual(_isBusyError({ code: 'ECONNRESET', message: 'socket reset' }), false);
  });
});

describe('dbHealthService _retryFsOperation 重试阶梯', () => {
  test('非忙锁错误：立即传播（只调用一次，不打退避）', () => {
    let calls = 0;
    const err = new Error('ENOENT: no such file');
    try {
      _retryFsOperation(() => {
        calls++;
        throw err;
      }, 'op', {});
      assert.fail('should throw');
    } catch (e) {
      assert.strictEqual(e, err, '传播的是原错误对象');
      assert.strictEqual(calls, 1, '非忙锁错误不得重试');
    }
  });

  test('忙锁错误：按阶梯重试，成功后返回结果（不调用 6 次即成功）', () => {
    let calls = 0;
    const out = _retryFsOperation(
      () => {
        calls += 1;
        if (calls < 3) {
          const e = new Error('EBUSY: resource temporarily locked');
          e.code = 'EBUSY';
          throw e;
        }
        return 'done';
      },
      'retry-op',
      {},
    );
    assert.strictEqual(out, 'done');
    assert.strictEqual(calls, 3, '第 3 次成功');
  });

  test('阶梯耗尽语义：重抛的错误对象附 attempts=阶梯长度+1；非忙锁错误只调用一次', () => {
    // 用非忙锁错误走「立即传播」快路径（无退避，保持测试快），验证被重抛的错误
    // 一定被盖上 attempts 计数（= FS_RETRY_DELAYS_MS.length + 1 = 6）。
    let calls = 0;
    try {
      _retryFsOperation(
        () => {
          calls++;
          throw new Error('disk full');
        },
        'x',
        {},
      );
      assert.fail('should throw');
    } catch (e) {
      assert.strictEqual(e.attempts, 6, 'attempts 应记录为阶梯长度+1');
      assert.strictEqual(calls, 1, '非忙锁错误立即抛出，只调用一次');
    }
  });
});

describe('dbHealthService checkIntegrity 完整性检查', () => {
  test('数据库文件不存在 → ok:false + 明确 error（不触碰真实 sqlite）', () => {
    const missing = path.join(os.tmpdir(), `dbhealth-missing-${Date.now()}.db`);
    assert.ok(!fs.existsSync(missing));
    const fakeCtor = class {
      pragma() {
        throw new Error('should not be called for missing file');
      }
      close() {}
    };
    const r = checkIntegrity(missing, { DatabaseCtor: fakeCtor });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.result, 'not_checked');
    assert.match(r.error, /does not exist/i);
  });

  test('注入 DatabaseCtor：quick_check=ok → ok:true', () => {
    const dbPath = path.join(os.tmpdir(), `dbhealth-ok-${Date.now()}.db`);
    fs.writeFileSync(dbPath, 'x');
    const fakeCtor = class {
      pragma(q) {
        if (q === 'quick_check') return [{ quick_check: 'ok' }];
        return [];
      }
      close() {}
    };
    const r = checkIntegrity(dbPath, { DatabaseCtor: fakeCtor });
    assert.strictEqual(r.ok, true, `quick_check ok 应判定健康（error=${r.error}）`);
    assert.strictEqual(r.result, 'ok');
    fs.unlinkSync(dbPath);
  });

  test('注入 DatabaseCtor：quick_check 非 ok → ok:false + error', () => {
    const dbPath = path.join(os.tmpdir(), `dbhealth-bad-${Date.now()}.db`);
    fs.writeFileSync(dbPath, 'x');
    const fakeCtor = class {
      pragma(q) {
        return [{ quick_check: 'corrupt' }];
      }
      close() {}
    };
    const r = checkIntegrity(dbPath, { DatabaseCtor: fakeCtor });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.result, 'corrupt');
    assert.match(r.error, /Integrity check failed/i);
    fs.unlinkSync(dbPath);
  });
});

describe('dbHealthService _tryResetSidecars 附属文件隔离', () => {
  test('无附属文件 → {ok:false, reason:"no sidecar files present"}', () => {
    const dbPath = path.join(os.tmpdir(), `dbhealth-nosc-${Date.now()}.db`);
    fs.writeFileSync(dbPath, 'x');
    const r = _tryResetSidecars(dbPath, 'nosc');
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /no sidecar files present/);
    fs.unlinkSync(dbPath);
  });

  test('存在 -wal/-shm → 被隔离（改名 .orphan-*，绝不删除）', () => {
    const base = path.join(os.tmpdir(), `dbhealth-sc-${Date.now()}`);
    const dbPath = `${base}.db`;
    fs.writeFileSync(dbPath, 'x');
    fs.writeFileSync(`${dbPath}-wal`, 'wal');
    fs.writeFileSync(`${dbPath}-shm`, 'shm');

    const r = _tryResetSidecars(dbPath, 'sc');
    // 主文件不是真实 SQLite → 仍不健康
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /unhealthy|sidecar/i);
    assert.ok(!fs.existsSync(`${dbPath}-wal`), '原 -wal 应被移走');
    assert.ok(!fs.existsSync(`${dbPath}-shm`), '原 -shm 应被移走');
    const dir = path.dirname(dbPath);
    const orphans = fs.readdirSync(dir).filter((f) => /-wal\.orphan-\d+$|-shm\.orphan-\d+$/.test(f));
    assert.strictEqual(orphans.length, 2, '两个附属文件都应被隔离为 .orphan-*');
    // 清理
    for (const f of orphans) fs.unlinkSync(path.join(dir, f));
    fs.unlinkSync(dbPath);
  });
});

test('dbHealthService getAuditLog: 返回内存审计记录的浅拷贝（数组，可含历史记录）', () => {
  const log = getAuditLog();
  assert.ok(Array.isArray(log), '必须是数组');
  // 每次返回独立副本：改动返回值不影响内部状态
  log.push({ injected: true });
  assert.strictEqual(getAuditLog().length, log.length - 1, '两次调用不得共享同一数组实例');
});
