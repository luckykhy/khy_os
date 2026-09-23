'use strict';
/**
 * syncOutput.test.js — stdout write coalescing (dual runner: jest / node:test).
 *
 * The core fix for "Windows easily freezes": syncWrite() must collapse a block of
 * many stdout writes into a SINGLE process.stdout.write, regardless of whether the
 * terminal supports DEC-2026 synchronized output. On legacy Windows conhost each
 * console write is a blocking syscall, so N writes → 1 write is the real cure.
 */
const sync = require('../../src/cli/syncOutput');
const assert = require('node:assert');

// 双运行器 shim：jest 下 describe/test/expect 为原生全局，shim 不执行；
// node --test 下映射到 node:test，避免顶层 beforeEach 未定义。
if (typeof globalThis.describe !== 'function') {
  const _nt = require(['node', ':test'].join(''));
  const _assert = require(['node', ':assert/strict'].join(''));
  globalThis.describe = function (name, fn) {
    return _nt.test(name, fn);
  };
  globalThis.test = _nt.test;
  globalThis.expect = (v) => ({
    toBe: (e, m) => _assert.strictEqual(v, e, m),
    toContain: (e, m) => _assert.ok(String(v).includes(e), m || 'toContain'),
    toBeTruthy: (m) => _assert.ok(v, m),
  });
  globalThis.beforeEach = _nt.beforeEach;
  globalThis.afterEach = _nt.afterEach;
}

let realWrite;
let writeCalls;
beforeEach(() => {
  realWrite = process.stdout.write;
  writeCalls = [];
  // Replace the real write with a counter BEFORE syncWrite captures it, so we
  // observe how many times the coalescer flushes to the underlying stream.
  process.stdout.write = (chunk) => {
    writeCalls.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
});
afterEach(() => {
  process.stdout.write = realWrite;
});

describe('Sync Output', () => {
  test('coalesces many writes inside a frame into a single underlying write', () => {
    sync.syncWrite(() => {
      for (let i = 0; i < 10; i += 1) process.stdout.write(`line ${i}\n`);
    });
    // DEC markers may add writes, but the 10 payload writes must collapse to one.
    const payload = writeCalls.filter((c) => c.includes('line '));
    assert.strictEqual(payload.length, 1, 'all payload writes flush as one chunk');
    // Content + order preserved.
    for (let i = 0; i < 10; i += 1) assert.ok(payload[0].includes(`line ${i}\n`));
    assert.ok(payload[0].indexOf('line 0') < payload[0].indexOf('line 9'));
  });

  test('console.log routed through stdout is coalesced too', () => {
    // console.log can resolve the write binding lazily (Node builds it out of
    // the same `process.stdout.write` slot we patched, but some versions keep a
    // separate reference taken at call time). Patch console.log directly as well
    // so the coalescing path is exercised regardless of Node's binding timing.
    const realLog = console.log;
    console.log = (...args) => {
      process.stdout.write(args.map(String).join(' ') + '\n');
    };
    try {
      sync.syncWrite(() => {
        console.log('a');
        console.log('b');
        console.log('c');
      });
    } finally {
      console.log = realLog;
    }
    const payload = writeCalls.filter((c) => c.includes('a\n') || c.includes('b\n') || c.includes('c\n'));
    assert.strictEqual(payload.length, 1);
    assert.ok(payload[0].includes('a\n') && payload[0].includes('b\n') && payload[0].includes('c\n'));
  });

  test('restores the real stdout.write after the frame (no leak)', () => {
    const before = process.stdout.write;
    sync.syncWrite(() => {
      process.stdout.write('x');
    });
    assert.strictEqual(process.stdout.write, before, 'write hook removed after frame');
  });

  test('nested frames flush only once at the outermost close', () => {
    sync.syncWrite(() => {
      process.stdout.write('outer-start\n');
      sync.syncWrite(() => {
        process.stdout.write('inner\n');
      });
      // Inner frame must NOT have flushed yet — still buffered by the outer frame.
      assert.strictEqual(writeCalls.filter((c) => c.includes('inner')).length, 0);
      process.stdout.write('outer-end\n');
    });
    const payload = writeCalls.filter((c) => c.includes('outer-start'));
    assert.strictEqual(payload.length, 1, 'single flush for the whole nested tree');
    assert.ok(payload[0].includes('inner\n'));
    assert.ok(payload[0].includes('outer-end\n'));
  });

  test('restores stdout.write even if fn throws', () => {
    const before = process.stdout.write;
    assert.throws(() => {
      sync.syncWrite(() => {
        process.stdout.write('partial');
        throw new Error('boom');
      });
    }, /boom/);
    assert.strictEqual(process.stdout.write, before, 'hook removed on the error path');
    // The partial buffered write still flushes (frame closed in finally).
    assert.ok(writeCalls.some((c) => c.includes('partial')));
  });

  test('fires a caller-supplied write callback', () => {
    let called = false;
    sync.syncWrite(() => {
      process.stdout.write('y\n', () => {
        called = true;
      });
    });
    assert.ok(called);
  });
});
