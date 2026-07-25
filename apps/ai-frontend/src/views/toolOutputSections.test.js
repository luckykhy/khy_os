/**
 * Unit tests for parseToolOutputSections — the `=== label ===` structured-output
 * parser that lets the frontend render CC-style titled sections instead of one
 * ellipsized line. Zero deps — run with the built-in Node test runner
 * (apps/ai-frontend is type:module):
 *   node --test src/views/toolOutputSections.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToolOutputSections } from './toolOutputSections.js';

test('无表头的普通输出 → null(逐字节回退到单行渲染)', () => {
  assert.equal(parseToolOutputSections('just some plain output\nwith two lines'), null);
  assert.equal(parseToolOutputSections('total 4\ndrwxr-xr-x  2 user user'), null);
});

test('空/非字符串输入 → null(绝不抛)', () => {
  assert.equal(parseToolOutputSections(''), null);
  assert.equal(parseToolOutputSections(null), null);
  assert.equal(parseToolOutputSections(undefined), null);
  assert.equal(parseToolOutputSections(42), null);
  assert.equal(parseToolOutputSections({}), null);
});

test('单个 `=== label ===` 表头 → 一个带标题的分节', () => {
  const out = parseToolOutputSections('=== git status ===\nOn branch main\nnothing to commit');
  assert.deepEqual(out, [{ title: 'git status', body: 'On branch main\nnothing to commit' }]);
});

test('多个表头 → 顺序切分,body 各归其段', () => {
  const text = [
    '=== step 1: lint ===',
    'no errors',
    '=== step 2: test ===',
    '10 passed',
    '0 failed',
  ].join('\n');
  assert.deepEqual(parseToolOutputSections(text), [
    { title: 'step 1: lint', body: 'no errors' },
    { title: 'step 2: test', body: '10 passed\n0 failed' },
  ]);
});

test('表头前的前置内容 → 无标题块(title=null)在前', () => {
  const text = 'preamble line\n=== check ===\nok';
  assert.deepEqual(parseToolOutputSections(text), [
    { title: null, body: 'preamble line' },
    { title: 'check', body: 'ok' },
  ]);
});

test('表头容差:两侧空白、`=` 数量≥3(如 ==== label ====)仍识别', () => {
  const text = '   ====  build  ====   \nartifact ready';
  assert.deepEqual(parseToolOutputSections(text), [
    { title: 'build', body: 'artifact ready' },
  ]);
});

test('表头后 body 为空 → 保留空 body 块(表头本身即信息)', () => {
  const text = '=== phase A ===\n=== phase B ===\ndone';
  assert.deepEqual(parseToolOutputSections(text), [
    { title: 'phase A', body: '' },
    { title: 'phase B', body: 'done' },
  ]);
});

test('假阳防护:shell 相等比较 / 非表头的 === 用法不误判为表头', () => {
  // 行内 == 比较、无 label 的裸 ===、`=== ` 后无闭合 === → 不构成表头 → 整体无表头 → null
  assert.equal(parseToolOutputSections('if [ "$x" == "y" ]; then echo hi; fi'), null);
  assert.equal(parseToolOutputSections('======'), null);
  assert.equal(parseToolOutputSections('=== unterminated header'), null);
});

test('body 内部空行保留,段首尾空行裁掉', () => {
  const text = '=== s ===\n\nline1\n\nline2\n\n';
  assert.deepEqual(parseToolOutputSections(text), [
    { title: 's', body: 'line1\n\nline2' },
  ]);
});

test('确定性:同一输入多次调用结果相同', () => {
  const text = '=== a ===\n1\n=== b ===\n2';
  assert.deepEqual(parseToolOutputSections(text), parseToolOutputSections(text));
});
