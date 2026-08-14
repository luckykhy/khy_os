'use strict';

/**
 * webFetchToolCharset.test.js — 接线契约:WebFetchTool._decodeBody 按服务器声明的 charset 解码
 * 响应体(修「主工具恒 .toString('utf-8') → GB2312/GBK 中文站乱码」)。门控 KHY_WEBFETCH_CHARSET
 * 默认开;关 → 逐字节回退 .toString('utf-8')。UTF-8 站点两路等价。
 *
 * 手法:直接调私有 _decodeBody(Buffer, contentType)(零网络)。GBK 字节 [0xd0,0xc2,0xce,0xc5]=「新闻」。
 */

const test = require('node:test');
const assert = require('node:assert');

const tool = require('../src/tools/WebFetchTool/index');

const GBK_XINWEN = Buffer.from([0xd0, 0xc2, 0xce, 0xc5]); // 「新闻」in GBK
const UTF8_HELLO = Buffer.from('你好 hello', 'utf8');

function withEnv(key, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try { return fn(); } finally {
    if (had) process.env[key] = prev; else delete process.env[key];
  }
}

test('_decodeBody: gate ON + gbk header → decodes to 新闻 (no mojibake)', () => {
  withEnv('KHY_WEBFETCH_CHARSET', undefined, () => {
    const out = tool._decodeBody(GBK_XINWEN, 'text/html; charset=gb2312');
    assert.strictEqual(out, '新闻');
  });
});

test('_decodeBody: gate ON + utf-8 body → unchanged (equivalent to .toString utf-8)', () => {
  withEnv('KHY_WEBFETCH_CHARSET', undefined, () => {
    const out = tool._decodeBody(UTF8_HELLO, 'text/html; charset=utf-8');
    assert.strictEqual(out, '你好 hello');
    assert.strictEqual(out, UTF8_HELLO.toString('utf-8'));
  });
});

test('_decodeBody: gate OFF (KHY_WEBFETCH_CHARSET=0) → byte-revert to .toString utf-8 (gbk mojibake)', () => {
  withEnv('KHY_WEBFETCH_CHARSET', '0', () => {
    const out = tool._decodeBody(GBK_XINWEN, 'text/html; charset=gb2312');
    assert.strictEqual(out, GBK_XINWEN.toString('utf-8')); // 逐字节回退旧行为
    assert.notStrictEqual(out, '新闻');
  });
});

test('_decodeBody: <meta charset> sniff when header lacks charset', () => {
  withEnv('KHY_WEBFETCH_CHARSET', undefined, () => {
    const buf = Buffer.concat([
      Buffer.from('<html><head><meta charset="gbk"></head><body>', 'latin1'),
      GBK_XINWEN,
      Buffer.from('</body></html>', 'latin1'),
    ]);
    const out = tool._decodeBody(buf, 'text/html'); // header 无 charset → 靠 <meta> 嗅探
    assert.ok(out.includes('新闻'), `expected decoded 新闻, got: ${JSON.stringify(out)}`);
  });
});

test('_decodeBody: non-buffer / empty input is fail-soft', () => {
  withEnv('KHY_WEBFETCH_CHARSET', undefined, () => {
    assert.strictEqual(tool._decodeBody(Buffer.from(''), 'text/html; charset=utf-8'), '');
    assert.strictEqual(typeof tool._decodeBody(null, ''), 'string');
  });
});
