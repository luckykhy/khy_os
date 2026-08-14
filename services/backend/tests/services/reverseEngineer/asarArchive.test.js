'use strict';

/**
 * asarArchive.test.js — 原生 asar 头解析纯函数测试。
 *
 * 用最小合成 asar 缓冲（对齐 @electron/asar 磁盘 pickle 布局）验证：
 *   size pickle → headerSize、header pickle → JSON 树、扁平化含 offset/size/unpacked/link，
 *   以及所有畸形输入 fail-closed（返回 null/空数组、绝不抛）。
 */

const assert = require('node:assert');
const test = require('node:test');
const {
  HEADER_BASE,
  parseHeaderSize,
  parseHeader,
  flattenEntries,
} = require('../../../src/services/reverseEngineer/asarArchive');

/** 4 字节对齐。 */
function align4(n) { return (n + 3) & ~3; }

/**
 * 构建最小合法 asar 缓冲。
 * @param {object} filesTree header.files 子树
 * @param {Buffer} dataRegion 拼接的文件数据区
 * @returns {{buf:Buffer, headerSize:number, dataOffset:number}}
 */
function buildAsar(filesTree, dataRegion) {
  const json = Buffer.from(JSON.stringify({ files: filesTree }), 'utf8');
  const jsonAligned = align4(json.length);
  // header pickle: [UInt32 payloadSize][UInt32 jsonLen][json + padding]
  const payloadSize = 4 + jsonAligned;
  const headerPickle = Buffer.alloc(4 + payloadSize);
  headerPickle.writeUInt32LE(payloadSize, 0);
  headerPickle.writeUInt32LE(json.length, 4);
  json.copy(headerPickle, 8);
  const headerSize = headerPickle.length;
  // size pickle: [UInt32 4][UInt32 headerSize]
  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(headerSize, 4);
  return {
    buf: Buffer.concat([sizePickle, headerPickle, dataRegion]),
    headerSize,
    dataOffset: HEADER_BASE + headerSize,
  };
}

test('parseHeaderSize 读出 8 字节 size pickle 的 headerSize', () => {
  const { buf, headerSize } = buildAsar({ 'a.txt': { size: 3, offset: '0' } }, Buffer.from('abc'));
  assert.strictEqual(parseHeaderSize(buf.subarray(0, 8)), headerSize);
});

test('parseHeaderSize 畸形输入 fail-closed', () => {
  assert.strictEqual(parseHeaderSize(null), null);
  assert.strictEqual(parseHeaderSize(Buffer.alloc(4)), null); // 太短
  const bad = Buffer.alloc(8); bad.writeUInt32LE(99, 0); // payloadLen != 4
  assert.strictEqual(parseHeaderSize(bad), null);
  const zero = Buffer.alloc(8); zero.writeUInt32LE(4, 0); zero.writeUInt32LE(0, 4);
  assert.strictEqual(parseHeaderSize(zero), null); // headerSize 0
});

test('parseHeader 解出 JSON 树并给出正确 dataOffset', () => {
  const data = Buffer.from('abc');
  const { buf, headerSize, dataOffset } = buildAsar({ 'a.txt': { size: 3, offset: '0' } }, data);
  const headerBuf = buf.subarray(HEADER_BASE, HEADER_BASE + headerSize);
  const parsed = parseHeader(headerBuf, headerSize);
  assert.ok(parsed);
  assert.strictEqual(parsed.dataOffset, dataOffset);
  assert.ok(parsed.header.files['a.txt']);
});

test('parseHeader 畸形/非 JSON fail-closed', () => {
  assert.strictEqual(parseHeader(null, 8), null);
  assert.strictEqual(parseHeader(Buffer.alloc(4), 8), null);
  // jsonLen 超过缓冲
  const b = Buffer.alloc(16); b.writeUInt32LE(8, 0); b.writeUInt32LE(999, 4);
  assert.strictEqual(parseHeader(b, 16), null);
});

test('flattenEntries 递归目录 + 提取 offset/size/unpacked/link', () => {
  const { buf, headerSize } = buildAsar({
    'a.txt': { size: 3, offset: '0' },
    'dir': { files: { 'b.js': { size: 5, offset: '3' }, 'big.bin': { size: 9, offset: '8', unpacked: true } } },
    'ln': { link: 'a.txt' },
  }, Buffer.from('abcworldbigbigbig'));
  const parsed = parseHeader(buf.subarray(HEADER_BASE, HEADER_BASE + headerSize), headerSize);
  const entries = flattenEntries(parsed.header);
  const byPath = Object.fromEntries(entries.map((e) => [e.path, e]));
  assert.deepStrictEqual(byPath['a.txt'], { path: 'a.txt', type: 'file', offset: 0, size: 3, unpacked: false });
  assert.deepStrictEqual(byPath['dir/b.js'], { path: 'dir/b.js', type: 'file', offset: 3, size: 5, unpacked: false });
  assert.strictEqual(byPath['dir/big.bin'].unpacked, true);
  assert.deepStrictEqual(byPath['ln'], { path: 'ln', type: 'link', link: 'a.txt' });
});

test('flattenEntries 畸形 header fail-closed 返回空/部分', () => {
  assert.deepStrictEqual(flattenEntries(null), []);
  assert.deepStrictEqual(flattenEntries({}), []);
  assert.deepStrictEqual(flattenEntries({ files: 'nope' }), []);
});
