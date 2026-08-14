'use strict';

/**
 * Unit tests for readBinaryGuard.js — the pure leaf that lets tools/readFile.js
 * refuse reading binary/compressed files as text (run via `node --test`).
 *
 * 覆盖：
 *   - binaryReadGuardEnabled 门控：默认开；env ∈ {0,false,off,no} 归一后关；其它开。
 *   - isBinaryForRead 保守判定：仅 fmt.isBinary === true 才拦；缺失/非对象/非严格 true
 *     一律放行（绝不误伤文本）。
 *   - buildBinaryReadRefusal 消息：含类型 + 大小 + 重定向工具 + 强读逃生门；对畸形输入
 *     绝不抛。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const G = require('../../src/tools/readBinaryGuard');

test('门控默认开（未设 env）', () => {
  assert.strictEqual(G.binaryReadGuardEnabled({}), true);
  assert.strictEqual(G.binaryReadGuardEnabled({ KHY_READFILE_BINARY_GUARD: undefined }), true);
});

test('门控 env ∈ {0,false,off,no}（含大小写/空白）→ 关', () => {
  for (const v of ['0', 'false', 'off', 'no', ' OFF ', 'False', 'No']) {
    assert.strictEqual(G.binaryReadGuardEnabled({ KHY_READFILE_BINARY_GUARD: v }), false, `env='${v}' 应关`);
  }
});

test('门控其它值 → 开', () => {
  for (const v of ['1', 'true', 'on', 'yes', 'anything']) {
    assert.strictEqual(G.binaryReadGuardEnabled({ KHY_READFILE_BINARY_GUARD: v }), true, `env='${v}' 应开`);
  }
});

test('isBinaryForRead：仅 isBinary===true 才拦', () => {
  assert.strictEqual(G.isBinaryForRead({ isBinary: true }), true);
  assert.strictEqual(G.isBinaryForRead({ isBinary: true, format: 'gzip', category: 'archive' }), true);
});

test('isBinaryForRead：文本 / 缺失 / 畸形 → 放行（绝不误伤）', () => {
  assert.strictEqual(G.isBinaryForRead({ isBinary: false, format: 'text' }), false);
  assert.strictEqual(G.isBinaryForRead({}), false);
  assert.strictEqual(G.isBinaryForRead(null), false);
  assert.strictEqual(G.isBinaryForRead(undefined), false);
  assert.strictEqual(G.isBinaryForRead('binary'), false);
  assert.strictEqual(G.isBinaryForRead(42), false);
  // 非严格 true 的 truthy 值也不拦（保守）。
  assert.strictEqual(G.isBinaryForRead({ isBinary: 1 }), false);
  assert.strictEqual(G.isBinaryForRead({ isBinary: 'yes' }), false);
});

test('buildBinaryReadRefusal：含类型 + 大小 + 重定向 + 逃生门', () => {
  const msg = G.buildBinaryReadRefusal({ magicFormat: 'gzip', category: 'archive', size: 1500 * 1024 });
  assert.match(msg, /gzip/);
  assert.match(msg, /archive/);
  assert.match(msg, /1\.5 MB/);
  assert.match(msg, /analyzeBinary/);
  assert.match(msg, /UpstreamStudy/);
  assert.match(msg, /KHY_READFILE_BINARY_GUARD=0/);
  assert.match(msg, /拒绝按文本读取/);
});

test('buildBinaryReadRefusal：字节数分档（B / KB / MB）', () => {
  assert.match(G.buildBinaryReadRefusal({ size: 512 }), /512 B/);
  assert.match(G.buildBinaryReadRefusal({ size: 2048 }), /2\.0 KB/);
  assert.match(G.buildBinaryReadRefusal({ size: 3 * 1024 * 1024 }), /3\.0 MB/);
  assert.match(G.buildBinaryReadRefusal({ size: null }), /未知大小/);
  assert.match(G.buildBinaryReadRefusal({ size: -1 }), /未知大小/);
});

test('buildBinaryReadRefusal：无 magic 时退化为「二进制文件」，仍带大小', () => {
  const msg = G.buildBinaryReadRefusal({ format: 'unknown', category: 'unknown', size: 1024 });
  assert.match(msg, /二进制文件/);
  assert.match(msg, /1\.0 KB/);
});

test('buildBinaryReadRefusal：对畸形/缺失输入绝不抛', () => {
  for (const bad of [null, undefined, {}, 'x', 42, [], { size: NaN }]) {
    let msg;
    assert.doesNotThrow(() => { msg = G.buildBinaryReadRefusal(bad); });
    assert.strictEqual(typeof msg, 'string');
    assert.ok(msg.length > 0);
  }
});
