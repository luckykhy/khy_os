'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  decodeAndExtract,
  normalizeCharset,
  detectCharset,
  htmlToText,
  decodeEntities,
  looksLikeHtml,
} = require('../src/services/webFetchDecode');

// '新闻' in GBK/GB2312 = bytes D0 C2 CE C5
const GBK_XINWEN = Buffer.from([0xd0, 0xc2, 0xce, 0xc5]);

test('GB2312 body declared in Content-Type decodes to correct Chinese (not mojibake)', () => {
  const html = Buffer.concat([
    Buffer.from('<html><body><p>', 'latin1'),
    GBK_XINWEN,
    Buffer.from('</p></body></html>', 'latin1'),
  ]);
  const r = decodeAndExtract(html, 'text/html; charset=gb2312', 20000);
  assert.strictEqual(r.charset, 'gbk');
  assert.ok(r.isHtml);
  assert.strictEqual(r.content, '新闻');
  assert.ok(!r.content.includes('<'), 'tags stripped');
});

test('charset sniffed from <meta> when header is absent', () => {
  const html = Buffer.concat([
    Buffer.from('<html><head><meta charset="gbk"></head><body>', 'latin1'),
    GBK_XINWEN,
    Buffer.from('</body></html>', 'latin1'),
  ]);
  const r = decodeAndExtract(html, '', 20000);
  assert.strictEqual(r.charset, 'gbk');
  assert.strictEqual(r.content, '新闻');
});

test('charset sniffed from <meta http-equiv content=...charset=...>', () => {
  const head = '<html><head><meta http-equiv="Content-Type" content="text/html; charset=gb2312"></head><body>';
  const html = Buffer.concat([
    Buffer.from(head, 'latin1'),
    GBK_XINWEN,
    Buffer.from('</body></html>', 'latin1'),
  ]);
  const cs = detectCharset(html, '');
  assert.strictEqual(cs, 'gbk');
});

test('utf-8 default + HTML→text strips scripts and styles', () => {
  const html = Buffer.from(
    '<html><head><style>.x{color:red}</style></head>'
    + '<body><script>var a=1;</script><h1>标题</h1><p>正文内容</p></body></html>',
    'utf8',
  );
  const r = decodeAndExtract(html, 'text/html; charset=utf-8', 20000);
  assert.strictEqual(r.charset, 'utf-8');
  assert.ok(r.content.includes('标题'));
  assert.ok(r.content.includes('正文内容'));
  assert.ok(!r.content.includes('color:red'), 'style content removed');
  assert.ok(!r.content.includes('var a=1'), 'script content removed');
});

test('non-HTML content (JSON) is returned verbatim, not tag-stripped', () => {
  const json = Buffer.from('{"title":"新闻","ok":true}', 'utf8');
  const r = decodeAndExtract(json, 'application/json; charset=utf-8', 20000);
  assert.strictEqual(r.isHtml, false);
  assert.strictEqual(r.content, '{"title":"新闻","ok":true}');
});

test('truncation caps content and flags truncated', () => {
  const big = Buffer.from('a'.repeat(5000), 'utf8');
  const r = decodeAndExtract(big, 'text/plain; charset=utf-8', 1000);
  assert.ok(r.truncated);
  assert.ok(r.content.length <= 1100);
  assert.ok(r.content.includes('truncated'));
});

test('empty body → empty content (genuine empty-but-success, no fake text)', () => {
  const r = decodeAndExtract(Buffer.from('', 'utf8'), 'text/html; charset=utf-8', 20000);
  assert.strictEqual(r.content, '');
});

test('HTML with no extractable prose yields a non-silent note', () => {
  const html = Buffer.from('<html><body><script>render()</script></body></html>', 'utf8');
  const r = decodeAndExtract(html, 'text/html', 20000);
  assert.ok(r.content.includes('未提取到可读正文'), 'non-silent honesty');
});

test('normalizeCharset aliases gb2312/gbk/gb18030/big5', () => {
  assert.strictEqual(normalizeCharset('GB2312'), 'gbk');
  assert.strictEqual(normalizeCharset('gbk'), 'gbk');
  assert.strictEqual(normalizeCharset('gb18030'), 'gb18030');
  assert.strictEqual(normalizeCharset('Big5'), 'big5');
  assert.strictEqual(normalizeCharset('utf-8'), 'utf-8');
  assert.strictEqual(normalizeCharset(''), 'utf-8');
});

test('decodeEntities resolves named + numeric entities', () => {
  assert.strictEqual(decodeEntities('a&nbsp;b'), 'a b');
  assert.strictEqual(decodeEntities('&lt;tag&gt;'), '<tag>');
  assert.strictEqual(decodeEntities('&#65;&#x42;'), 'AB');
  assert.strictEqual(decodeEntities('Tom&amp;Jerry'), 'Tom&Jerry');
});

test('looksLikeHtml detects by content-type and by body sniff', () => {
  assert.ok(looksLikeHtml('anything', 'text/html'));
  assert.ok(looksLikeHtml('<!DOCTYPE html><html>', 'application/octet-stream'));
  assert.ok(!looksLikeHtml('plain text', 'text/plain'));
});

test('htmlToText maps block boundaries to newlines', () => {
  const out = htmlToText('<p>一</p><p>二</p>');
  assert.ok(/一\n+二/.test(out), 'paragraphs separated by newline');
});
