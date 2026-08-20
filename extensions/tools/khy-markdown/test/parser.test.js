'use strict';

/**
 * parser.test.js — 验证 khyosMarkdown.html 内联 Markdown 解析器（零依赖手写）。
 *
 * 解析器三函数（escapeHtml / renderInline / mdToHtml）是纯函数、不依赖 DOM。
 * 本测试从 HTML 中按区段标记切出这三函数，在沙箱中 eval 后对代表性 Markdown 断言渲染结果，
 * 守护这块「最易出错的手写代码」。绝不联网、绝不操作 DOM。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 从 HTML 切出解析器区段（区段 1：escapeHtml→mdToHtml，止于区段 2 注释）。
const html = fs.readFileSync(path.join(__dirname, '..', 'khyosMarkdown.html'), 'utf8');
const start = html.indexOf('function escapeHtml');
const end = html.indexOf('* 2) 应用状态');
assert.ok(start > 0 && end > start, '未能在 HTML 中定位解析器区段');
const code = html.slice(start, html.lastIndexOf('}', end) + 1);

const sandbox = {};
vm.runInNewContext(code + '\nthis.mdToHtml = mdToHtml; this.escapeHtml = escapeHtml;', sandbox);
const md = sandbox.mdToHtml;

test('标题渲染 + id', () => {
  assert.match(md('# Hello World'), /<h1 id="hello-world">Hello World<\/h1>/);
  assert.match(md('### 三级 标题'), /<h3 id="[^"]*">三级 标题<\/h3>/);
});

test('粗体/斜体/删除线/行内代码', () => {
  assert.match(md('**粗** 与 *斜* 与 ~~删~~'), /<strong>粗<\/strong>/);
  assert.match(md('**粗** 与 *斜*'), /<em>斜<\/em>/);
  assert.match(md('~~删~~'), /<del>删<\/del>/);
  assert.match(md('用 `code` 段'), /<code>code<\/code>/);
});

test('围栏代码块保留原文且转义', () => {
  const h = md('```js\nconst a = 1 < 2 && 3 > 1;\n```');
  assert.match(h, /<pre><code class="language-js">/);
  assert.match(h, /1 &lt; 2 &amp;&amp; 3 &gt; 1/);
});

test('无序/有序列表', () => {
  assert.match(md('- a\n- b'), /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(md('1. x\n2. y'), /<ol><li>x<\/li><li>y<\/li><\/ol>/);
});

test('任务列表复选框', () => {
  const h = md('- [x] done\n- [ ] todo');
  assert.match(h, /<input type="checkbox" disabled checked \/> done/);
  assert.match(h, /<input type="checkbox" disabled \/> todo/);
});

test('表格 + 对齐', () => {
  const h = md('| A | B |\n| :--- | ---: |\n| 1 | 2 |');
  assert.match(h, /<table>/);
  assert.match(h, /<th style="text-align:left">A<\/th>/);
  assert.match(h, /<th style="text-align:right">B<\/th>/);
  assert.match(h, /<td[^>]*>1<\/td>/);
});

test('引用块', () => {
  assert.match(md('> 引用一行\n> 第二行'), /<blockquote>[\s\S]*引用一行[\s\S]*<\/blockquote>/);
});

test('链接与图片与自动链接', () => {
  assert.match(md('[文字](https://x.cn/page)'), /<a href="https:\/\/x\.cn\/page">文字<\/a>/);
  assert.match(md('![图](pic.png)'), /<img src="pic\.png" alt="图" \/>/);
  assert.match(md('see https://a.cn/x here'), /<a href="https:\/\/a\.cn\/x">https:\/\/a\.cn\/x<\/a>/);
});

test('水平线', () => {
  assert.match(md('---'), /<hr \/>/);
});

test('HTML 注入被转义（安全）', () => {
  const h = md('正文 <script>alert(1)</script> 结束');
  assert.ok(!/<script>alert/.test(h), '原始 <script> 不应逃逸');
  assert.match(h, /&lt;script&gt;/);
});

test('段落聚合 + 软换行', () => {
  const h = md('第一行\n第二行\n\n新段落');
  assert.match(h, /<p>第一行<br \/>第二行<\/p>/);
  assert.match(h, /<p>新段落<\/p>/);
});

test('真实文档冒烟：不抛异常且产出非空', () => {
  const sample = '# 标题\n\n> 提示\n\n- 项目 A\n- 项目 B\n\n```bash\nls -la\n```\n\n| 列1 | 列2 |\n|---|---|\n| a | b |\n';
  const h = md(sample);
  assert.ok(h.length > 50);
  assert.match(h, /<h1/); assert.match(h, /<ul>/); assert.match(h, /<pre>/); assert.match(h, /<table>/);
});
