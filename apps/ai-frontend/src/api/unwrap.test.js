/**
 * unwrap SSOT 单测(node:test·ESM)。
 *   node --test src/api/unwrap.test.js
 *
 * 证:信封 {success,data} 解包、无信封透传、null-ish 分支、payload??res 兜底、
 * 不改入参。这是全站响应信封解包的唯一真源(取代 13 处内联副本)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { unwrap } from './unwrap.js';

test('信封 {success,data} → 返回 data', () => {
  const res = { data: { success: true, data: { id: 1, name: 'x' } } };
  assert.deepEqual(unwrap(res), { id: 1, name: 'x' });
});

test('信封 data 为数组 → 原样返回数组', () => {
  const res = { data: { success: true, data: [1, 2, 3] } };
  assert.deepEqual(unwrap(res), [1, 2, 3]);
});

test('success:false 仍解包 data(判定只看键存在,不看真假)', () => {
  const res = { data: { success: false, data: null } };
  assert.equal(unwrap(res), null);
});

test('payload 有 data 无 success → 不当信封,透传整个 payload', () => {
  const res = { data: { data: 42 } };
  assert.deepEqual(unwrap(res), { data: 42 });
});

test('payload 有 success 无 data → 不当信封,透传整个 payload', () => {
  const res = { data: { success: true } };
  assert.deepEqual(unwrap(res), { success: true });
});

test('无信封普通对象 → 透传 payload', () => {
  const res = { data: { items: [1] } };
  assert.deepEqual(unwrap(res), { items: [1] });
});

test('res.data 为 null → 落 payload ?? res,返回整个 res', () => {
  const res = { data: null, status: 204 };
  assert.deepEqual(unwrap(res), { data: null, status: 204 });
});

test('res 为 undefined → 可选链兜底,返回 undefined,绝不抛', () => {
  assert.equal(unwrap(undefined), undefined);
});

test('res.data 为 0(falsy 非 null)→ payload ?? res 保留 0', () => {
  const res = { data: 0 };
  assert.equal(unwrap(res), 0);
});

test('不 mutate 入参', () => {
  const inner = { success: true, data: { k: 'v' } };
  const res = { data: inner };
  unwrap(res);
  assert.deepEqual(res, { data: { success: true, data: { k: 'v' } } });
});
