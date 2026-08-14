'use strict';

// 验证本地模式（无模型 · 网络搜索）结果整理：
//  1. 结果按要点逐条列出（不再揉成大段），来源链接独占整行可整段复制。
//  2. 渲染层不对纯 URL 行做硬换行（保留单行，终端软换行可整段选中）。

const assert = require('assert');
const {
  _organizeSearchResults,
  _strictSearchAnswer,
} = require('../../src/services/localBrainService');
const { renderAiResponse } = require('../../src/cli/aiRenderer');

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

const LONG_URL =
  'https://docs.example.com/java/tutorial/getting-started?section=variables&lang=zh-CN&utm_source=khy&ref=local-mode-search-result-very-long-tail';

const SAMPLE = [
  {
    title: 'Java 变量入门',
    snippet:
      'Java 是一种面向对象的编程语言。变量是存储数据的容器。声明变量需要指定类型。整数用 int 类型表示。',
    url: LONG_URL,
  },
  {
    title: 'Java 数据类型',
    snippet: 'Java 有八种基本数据类型。包括 int、long、double、boolean 等。',
    url: 'https://example.org/java/types',
  },
];

// 1) _organizeSearchResults：结构化（## 标题 + - 要点）+ 来源整行
{
  const out = _organizeSearchResults('java知识点', SAMPLE);
  assert.ok(out, 'should produce organized output');
  const lines = out.split('\n');
  // 结构化：含 Markdown 区块标题
  assert.ok(out.includes('## '), 'has a markdown heading');
  // 至少有一条 Markdown 要点（渲染时 → •）
  assert.ok(lines.some(l => l.startsWith('- ')), 'has bullet point items');
  // 来源标题存在
  assert.ok(out.includes('来源'), 'has source section');
  // 长 URL 单独成行（编号 + 空格 + 完整 URL），未被插入换行切断
  assert.ok(
    lines.some(l => l.includes(LONG_URL)),
    'full long URL appears intact on a single line',
  );
  // 渲染后要点显示为 •
  const rendered = stripAnsi(renderAiResponse(out));
  assert.ok(rendered.includes('•'), 'bullets render as • in terminal');
}

// 2) _strictSearchAnswer 未知型回退也应包含完整 URL
{
  const ans = _strictSearchAnswer('讲讲 java', SAMPLE);
  assert.ok(ans, 'strict answer produced');
  assert.ok(ans.includes(LONG_URL), 'strict answer keeps full URL');
}

// 3) 渲染层不硬换行纯 URL 行
{
  // 构造一个远超终端宽度的 URL 行
  const urlLine = '1. ' + LONG_URL;
  const rendered = stripAnsi(renderAiResponse(urlLine));
  // URL 不应被插入换行切断：整条 URL 仍出现在某一行里
  const found = rendered.split('\n').some(l => l.includes(LONG_URL));
  assert.ok(found, 'renderer must not hard-wrap a bare URL line');
}

// 4) 渲染层对长纯拉丁行仍硬折行（回归保护）；中文散文行交给终端软折行
{
  const longLatin = 'long english words flow here and wrap on spaces '.repeat(10);
  const renderedLatin = stripAnsi(renderAiResponse(longLatin));
  assert.ok(
    renderedLatin.split('\n').length > 1,
    'long pure-Latin prose should still hard-wrap',
  );
  // 中文散文不硬断句（aiRenderer CJK typography 契约）：整行保留为单一逻辑行，
  // 由终端软折行，避免在中文↔拉丁边界吃空格 / 把收尾标点甩到行首。
  const longCjk = '这是一段很长的中文文本'.repeat(20);
  const renderedCjk = stripAnsi(renderAiResponse(longCjk));
  assert.ok(
    renderedCjk.split('\n').length === 1,
    'CJK prose stays one logical line (terminal soft-wraps)',
  );
}

console.log('localSearchFormatting: all assertions passed');
