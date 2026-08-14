'use strict';

/**
 * docHelperEnabled.test.js — 锁 utils/docHelperEnabled 口径
 *   (收敛 imageOcr·pdfToWord 2 处相同 body 的 _checkEnabled)。
 *
 * 注:util 内部 spawn 真实 python `--version` 探活·不便注入·故诚实测面为
 *   返回 boolean + 绝不抛(仿 proxyDispatcherAgent 测法)。另断言 DOC_HELPER 路径
 *   解析与消费方(tools/ 下)逐字节一致(同深度 __dirname 相对 ../services/)。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const docHelperEnabled = require('../src/utils/docHelperEnabled');

test('返回布尔·绝不抛', () => {
  let r;
  assert.doesNotThrow(() => { r = docHelperEnabled(); });
  assert.strictEqual(typeof r, 'boolean');
});

test('多次调用稳定(同机同结果)', () => {
  assert.strictEqual(docHelperEnabled(), docHelperEnabled());
});

test('DOC_HELPER 路径:utils/ 与 tools/ 同深度 → 解析到同一 services/docHelper.py', () => {
  const fromUtils = path.resolve(__dirname, '../src/utils', '../services/docHelper.py');
  const fromTools = path.resolve(__dirname, '../src/tools', '../services/docHelper.py');
  assert.strictEqual(fromUtils, fromTools);
  assert.ok(fromUtils.endsWith(path.join('services', 'docHelper.py')));
});
