'use strict';

/**
 * ilinkLogin.dataurl.test.js — renderQrToDataUrl 契约测试(Node 内置 test runner)。
 *
 * 运行:.khy/node/v22.12.0/node --test <本文件绝对路径>
 */

const test = require('node:test');
const assert = require('node:assert');

const { renderQrToDataUrl } = require('../../../src/services/messaging/ilinkLogin');

test('正常 url → 返回 PNG data URL', async () => {
  const out = await renderQrToDataUrl('https://liteapp.weixin.qq.com/qr/abc123');
  assert.strictEqual(typeof out, 'string');
  assert.ok(out.startsWith('data:image/png'), `应为 PNG data URL,实为:${out.slice(0, 32)}`);
  assert.ok(out.includes('base64,'), '应为 base64 编码的 data URL');
});

test('空 url → 返回 null(调用方降级给链接)', async () => {
  assert.strictEqual(await renderQrToDataUrl(''), null);
  assert.strictEqual(await renderQrToDataUrl(null), null);
  assert.strictEqual(await renderQrToDataUrl(undefined), null);
});

test('异常输入(qrcode 抛错)→ 返回 null,绝不抛', async () => {
  // 传入非字符串对象,qrcode.toDataURL 会抛,应被 fail-soft 捕获成 null。
  const out = await renderQrToDataUrl({ not: 'a string' });
  assert.strictEqual(out, null);
});

test('尊重 opts.errorCorrectionLevel(H 级仍产出有效 PNG data URL)', async () => {
  const out = await renderQrToDataUrl('https://example.com/x', { errorCorrectionLevel: 'H' });
  assert.ok(typeof out === 'string' && out.startsWith('data:image/png'));
});
