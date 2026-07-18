'use strict';

/**
 * windsurfProtobuf — 抽出自 gateway/proxyServer.js 的纯 protobuf 编码原语特征化测试
 * （node:test，可在本环境直接运行）。
 *
 * proxyServer 的集成测试是 Jest（本环境无运行器），故以 golden 字节向量锁定抽出后的
 * **线编码逐字节不变**（[DESIGN-ARCH-051] 巨石预警驱动降巨石）。向量取自抽出前逐字节
 * 拷贝的实现，作为未来回归护栏并文档化 Windsurf 私有 protobuf 结构。
 */

const test = require('node:test');
const assert = require('node:assert');

const w = require('../../src/services/gateway/windsurfProtobuf');

test('appendVarint：单字节与多字节（base-128）', () => {
  const one = []; w.appendVarint(one, 5); assert.strictEqual(Buffer.from(one).toString('hex'), '05');
  const big = []; w.appendVarint(big, 300); assert.strictEqual(Buffer.from(big).toString('hex'), 'ac02');
  const zero = []; w.appendVarint(zero, 0); assert.strictEqual(Buffer.from(zero).toString('hex'), '00');
  // 防御：负数/非数 → 归零（Math.max(0, Number||0)）
  const neg = []; w.appendVarint(neg, -7); assert.strictEqual(Buffer.from(neg).toString('hex'), '00');
});

test('appendStringField / appendBoolField：tag + wireType 正确', () => {
  const s = []; w.appendStringField(s, 1, 'a');
  assert.strictEqual(Buffer.from(s).toString('hex'), '0a0161'); // (1<<3|2)=0x0a, len=1, 'a'=0x61
  const b = []; w.appendBoolField(b, 11, true);
  assert.strictEqual(Buffer.from(b).toString('hex'), '5801');   // (11<<3|0)=0x58, 1
  const f = []; w.appendBoolField(f, 11, false);
  assert.strictEqual(Buffer.from(f).toString('hex'), '5800');
});

test('encodeWindsurfClientModelConfig：golden（recommended 与否）', () => {
  assert.strictEqual(
    w.encodeWindsurfClientModelConfig('gpt-4', true).toString('hex'),
    '0a056770742d34b201056770742d345801');
  assert.strictEqual(
    w.encodeWindsurfClientModelConfig('gpt-4', false).toString('hex'),
    '0a056770742d34b201056770742d34'); // 无 is_recommended 字段
});

test('encodeWindsurfModelConfigResponse：golden，仅首个标记 recommended', () => {
  assert.strictEqual(
    w.encodeWindsurfModelConfigResponse(['a', 'b']).toString('hex'),
    '0a090a0161b201016158010a070a0162b2010162'); // 'a' 带 5801，'b' 不带
  assert.strictEqual(w.encodeWindsurfModelConfigResponse([]).toString('hex'), '');
  assert.strictEqual(w.encodeWindsurfModelConfigResponse().toString('hex'), ''); // 默认 []
});

test('编码器不做去重（去重是调用方职责，抽出契约）', () => {
  // 传入重复项 → 编码两条（证明 dedupe 已上提到 proxyServer 调用点，编码器纯粹）。
  const dup = w.encodeWindsurfModelConfigResponse(['a', 'a']);
  const single = w.encodeWindsurfModelConfigResponse(['a']);
  assert.ok(dup.length > single.length, '重复项应被编码两次，编码器不吞重复');
});

test('proxyServer 经 require 重新接线后仍可加载（抽出未破坏宿主）', () => {
  const proxy = require('../../src/services/gateway/proxyServer.js');
  assert.strictEqual(typeof proxy, 'object');
});
