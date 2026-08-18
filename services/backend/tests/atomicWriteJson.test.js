'use strict';

/**
 * atomicWriteJson.test.js — F2 的原子写单点(utils/atomicWriteJson.js)。
 *
 * 关注点不是「能不能写文件」,而是**失败时目标文件的状态**:序列化失败、磁盘出错、
 * 进程中断,任何一种情况下原有内容都不能被截断成半个 JSON —— 那正是裸 writeFileSync
 * 在这个仓里造成的风险(422 个写点,142 个内联 JSON.stringify)。
 *
 * node:test:与 backup 一族测试保持一致(见 backupRestoreDrill.test.js 顶部说明)。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const atomicWriteJson = require('../src/utils/atomicWriteJson');

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-atomic-'));
});

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** 目录里残留的临时文件(原子写绝不能留下它们)。 */
function _tmpLeftovers(d) {
  return fs.readdirSync(d).filter((n) => /\.tmp-|^\.[^.]+\.tmp/.test(n));
}

describe('基本写入', () => {
  test('写出可解析的 JSON,默认两空格缩进,不留临时文件', () => {
    const p = path.join(dir, 'a.json');
    assert.equal(atomicWriteJson(p, { a: 1, b: [1, 2] }), true);
    const raw = fs.readFileSync(p, 'utf-8');
    assert.deepEqual(JSON.parse(raw), { a: 1, b: [1, 2] });
    assert.ok(raw.includes('\n  '), '默认应为 pretty=2');
    assert.deepEqual(_tmpLeftovers(dir), []);
  });

  test('pretty=0 写紧凑 JSON', () => {
    const p = path.join(dir, 'c.json');
    assert.equal(atomicWriteJson(p, { a: 1 }, { pretty: 0 }), true);
    assert.equal(fs.readFileSync(p, 'utf-8'), '{"a":1}');
  });

  test('父目录不存在时自动创建;ensureDir=false 则失败且不留残骸', () => {
    const nested = path.join(dir, 'x', 'y', 'z.json');
    assert.equal(atomicWriteJson(nested, { ok: true }), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(nested, 'utf-8')), { ok: true });

    const other = path.join(dir, 'no-such-dir', 'w.json');
    assert.equal(atomicWriteJson(other, { ok: true }, { ensureDir: false }), false);
    assert.equal(fs.existsSync(path.dirname(other)), false);
  });

  test('覆盖写:整体替换,不是追加', () => {
    const p = path.join(dir, 'over.json');
    atomicWriteJson(p, { v: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    atomicWriteJson(p, { v: 'b' });
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf-8')), { v: 'b' });
    assert.deepEqual(_tmpLeftovers(dir), []);
  });

  test('数组、字符串、数字、null 都能写', () => {
    for (const [name, value] of [
      ['arr.json', [1, 2, 3]],
      ['str.json', 'hello'],
      ['num.json', 42],
      ['null.json', null],
    ]) {
      const p = path.join(dir, name);
      assert.equal(atomicWriteJson(p, value), true, name);
      assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf-8')), value, name);
    }
  });
});

describe('失败时不破坏现有内容(原子性的实质)', () => {
  test('不可序列化的值 → 返回 false,原文件分毫未动', () => {
    const p = path.join(dir, 'keep.json');
    atomicWriteJson(p, { good: true });
    const before = fs.readFileSync(p, 'utf-8');

    const circular = { self: null };
    circular.self = circular;
    assert.equal(atomicWriteJson(p, circular), false, '循环引用应返回 false');
    assert.equal(fs.readFileSync(p, 'utf-8'), before, '失败不得改动原文件');
    assert.deepEqual(_tmpLeftovers(dir), []);
  });

  test('undefined(JSON.stringify 产出 undefined)→ 返回 false,不创建文件', () => {
    const p = path.join(dir, 'undef.json');
    assert.equal(atomicWriteJson(p, undefined), false);
    assert.equal(fs.existsSync(p), false, '不得留下一个空文件');

    // BigInt 同样无法序列化(stringify 会抛)
    const p2 = path.join(dir, 'bigint.json');
    assert.equal(atomicWriteJson(p2, { n: BigInt(1) }), false);
    assert.equal(fs.existsSync(p2), false);
  });

  test('目标是一个目录 → 返回 false 而不是抛异常', () => {
    const asDir = path.join(dir, 'iam-a-dir.json');
    fs.mkdirSync(asDir);
    assert.equal(atomicWriteJson(asDir, { a: 1 }), false);
    assert.equal(fs.statSync(asDir).isDirectory(), true);
  });

  test('读到的永远是完整 JSON:大对象反复覆盖后仍可解析', () => {
    const p = path.join(dir, 'big.json');
    const big = { rows: Array.from({ length: 5000 }, (_, i) => ({ i, s: `value-${i}` })) };
    for (let round = 0; round < 5; round++) {
      assert.equal(atomicWriteJson(p, { round, ...big }), true);
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
      assert.equal(parsed.round, round);
      assert.equal(parsed.rows.length, 5000);
    }
    assert.deepEqual(_tmpLeftovers(dir), []);
  });
});

describe('fsync 门控(KHY_ATOMIC_FSYNC)', () => {
  const saved = process.env.KHY_ATOMIC_FSYNC;
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.KHY_ATOMIC_FSYNC;
    } else {
      process.env.KHY_ATOMIC_FSYNC = saved;
    }
  });

  test('关掉 fsync 仍然正常写入(fsync 只影响掉电持久性,不影响原子性)', () => {
    process.env.KHY_ATOMIC_FSYNC = '0';
    const p = path.join(dir, 'nofsync.json');
    assert.equal(atomicWriteJson(p, { a: 1 }), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf-8')), { a: 1 });
  });

  test('opts.fsync 显式布尔覆盖环境变量', () => {
    process.env.KHY_ATOMIC_FSYNC = '0';
    const p = path.join(dir, 'forced.json');
    assert.equal(atomicWriteJson(p, { a: 1 }, { fsync: true }), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf-8')), { a: 1 });

    const p2 = path.join(dir, 'forced-off.json');
    assert.equal(atomicWriteJson(p2, { a: 1 }, { fsync: false, env: { KHY_ATOMIC_FSYNC: '1' } }), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(p2, 'utf-8')), { a: 1 });
  });

  test('注入 env 不读全局(纯函数式可测)', () => {
    delete process.env.KHY_ATOMIC_FSYNC;
    const p = path.join(dir, 'injected.json');
    assert.equal(atomicWriteJson(p, { a: 1 }, { env: { KHY_ATOMIC_FSYNC: 'off' } }), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf-8')), { a: 1 });
  });
});

describe('权限', () => {
  test('默认 0600(仅 POSIX 可断言;Windows 无此语义)', (t) => {
    if (process.platform === 'win32') {
      t.skip('Windows 不支持 POSIX 文件模式位');
      return;
    }
    const p = path.join(dir, 'secret.json');
    atomicWriteJson(p, { token: 'x' });
    assert.equal(fs.statSync(p).mode & 0o777, 0o600);

    const p2 = path.join(dir, 'public.json');
    atomicWriteJson(p2, { a: 1 }, { mode: 0o644 });
    assert.equal(fs.statSync(p2).mode & 0o777, 0o644);
  });
});
