'use strict';

/**
 * ilinkDispatcher._stripToolBlocks — object-shaped JSON payload defense.
 *
 * _stripToolBlocks is internal; it is exercised through normalizeReply, which
 * only routes into it when the extracted text still carries tool-block markers.
 *
 * Regression: a single JSON OBJECT (not a content-block array) used to reach
 * contentToText → String(content) → "[object Object]", which was then sent to
 * the WeChat user as a "cleaned" reply. The fix trusts contentToText only for a
 * real content-block array (isStructuredContent); otherwise it falls back to
 * the per-line filter / original text (fail-soft), never "[object Object]".
 *
 * Fully offline: pure function assertions, no channel / model / network.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Some module init reads KHYOS_HOME; keep it isolated like the sibling suite.
process.env.KHYOS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-strip-'));

const { normalizeReply } = require('../../../src/services/channels/ilinkDispatcher');

test('single-object tool_use JSON no longer yields "[object Object]"', () => {
  // Old behavior: JSON.parse → object → String(object) === "[object Object]".
  const objPayload = '{"type":"tool_use","id":"t1","name":"Read"}';
  const r = normalizeReply({ finalResponse: objPayload });
  assert.notStrictEqual(r, '[object Object]', '对象型载荷绝不能被 String 化为 [object Object]');
  assert.ok(!String(r || '').includes('[object Object]'), `清洗结果不得含 [object Object]:${r}`);
});

test('single-object tool_result JSON no longer yields "[object Object]"', () => {
  const objPayload = '{"type":"tool_result","tool_use_id":"t3","content":"命令输出"}';
  const r = normalizeReply({ finalResponse: objPayload });
  assert.ok(!String(r || '').includes('[object Object]'), `不得含 [object Object]:${r}`);
});

test('multi-line object JSON falls back to the per-line filter, keeps non-tool text', () => {
  const multiline = ['{', '"note": "重要结论",', '"type": "tool_use"', '}'].join('\n');
  const r = normalizeReply({ finalResponse: multiline });
  assert.ok(!String(r || '').includes('[object Object]'), `不得含 [object Object]:${r}`);
  assert.ok(String(r).includes('重要结论'), '行过滤须保留非 tool 内容');
  assert.ok(!/"type"\s*:\s*"tool_use"/.test(String(r)), '携带 tool 标记的行须被滤掉');
});

test('真正的 blocks 数组仍降级为纯文本(不受本次加固影响)', () => {
  const blocks = JSON.stringify([
    { type: 'text', text: '已读完文件。' },
    { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a.js' } },
  ]);
  const r = normalizeReply({ finalResponse: blocks });
  assert.strictEqual(r, '已读完文件。');
});

test('普通文本不含 tool 标记时不进清洗分支(零回归)', () => {
  const plain = '任务完成:结果 {a:1} 已保存。';
  assert.strictEqual(normalizeReply({ finalResponse: plain }), plain);
  assert.strictEqual(normalizeReply('你好，世界'), '你好，世界');
});
