'use strict';

// 模型无关「工具结果总结」器验证：
//  1. 解析 Windows `dir` 清单 → 目录/文件计数 + 可用空间 + 主要条目。
//  2. 解析 Unix `ls -l` 清单。
//  3. 散文走抽取式摘要、结构化文本走行数摘要。
//  4. 散文绝不被误判为目录清单（零误报闸门）。
//  5. salvage 兜底领头给总结，原文随后附上。

const assert = require('assert');
const tds = require('../../src/services/toolDataSummary');
const { _salvageToolResults } = require('../../src/services/toolUseLoop');

const WIN_DIR = ` 驱动器 C 中的卷是 Windows
 卷的序列号是 04C4-1C6A

 C:\\ 的目录

2026/03/31  22:39            12,288 DumpStack.log
2026/05/01  00:48    <DIR>          inetpub
2024/04/01  15:26    <DIR>          PerfLogs
2026/05/21  10:22    <DIR>          Program Files
2026/05/28  20:03    <DIR>          Program Files (x86)
2026/04/01  21:14    <DIR>          temp_ocr_images
2026/05/09  13:39    <DIR>          Users
2026/06/20  13:09    <DIR>          Windows
               1 个文件         12,288 字节
               7 个目录  19,401,101,312 可用字节`;

// 1) Windows dir 解析 + 总结
{
  const p = tds.parseDirectoryListing(WIN_DIR);
  assert.ok(p, 'parses windows dir listing');
  assert.strictEqual(p.path, 'C:\\', 'captures path');
  assert.strictEqual(p.dirs.length, 7, '7 directories');
  assert.strictEqual(p.files.length, 1, '1 file');
  assert.ok(p.dirs.includes('Program Files (x86)'), 'name with spaces+parens intact');
  assert.strictEqual(p.freeBytes, 19401101312, 'free bytes parsed');

  const s = tds.summarizeDirectoryListing(WIN_DIR);
  assert.ok(s.includes('7 个目录'), 'summary states dir count');
  assert.ok(s.includes('1 个文件'), 'summary states file count');
  assert.ok(/可用空间约 18 GB/.test(s), 'summary states free space');
  assert.ok(s.includes('Windows'), 'summary lists a directory');
  assert.ok(s.includes('DumpStack.log'), 'summary lists the file');
}

// 2) Unix ls -l 解析
{
  const LS = `total 20
drwxr-xr-x  2 user group 4096 Jun 23 10:00 src
drwxr-xr-x  3 user group 4096 Jun 23 10:01 tests
-rw-r--r--  1 user group  812 Jun 23 10:02 README.md
-rwxr-xr-x  1 user group 1024 Jun 23 10:03 run.sh`;
  const p = tds.parseDirectoryListing(LS);
  assert.ok(p, 'parses ls -l');
  assert.strictEqual(p.dirs.length, 2, 'ls: 2 dirs');
  assert.strictEqual(p.files.length, 2, 'ls: 2 files');
  assert.ok(p.dirs.includes('src') && p.files.some(f => f.name === 'README.md'), 'ls names captured');
}

// 3) 散文摘要 + 结构化行摘要
{
  const prose = '这是第一句关于本地模式的话。'.repeat(1) + '第二句讲数据清理。第三句讲多数据源搜索。第四句无关紧要的填充内容。第五句继续填充。第六句结尾。';
  const out = tds.summarizeToolOutput(prose + prose + prose);
  assert.ok(out.length <= prose.length * 3, 'prose summarized/truncated');

  const rows = Array.from({ length: 20 }, (_, i) => `row-${i}`).join('\n');
  const rowSum = tds.summarizeToolOutput(rows);
  assert.ok(/共 20 行/.test(rowSum), 'structured text → line-count digest');
}

// 4) 零误报：纯散文不是目录清单
{
  assert.strictEqual(tds.looksLikeDirectoryListing('我今天去公园散步，天气很好，遇到了一只猫。'), false,
    'prose must not be mistaken for a directory listing');
  assert.strictEqual(tds.parseDirectoryListing('Java 是一种面向对象的语言。变量用来存数据。'), null,
    'prose parse → null');
}

// 5) salvage 兜底领头给总结
{
  const salvaged = _salvageToolResults([
    { tool: 'Bash', result: { success: true, output: WIN_DIR } },
  ]);
  assert.ok(salvaged, 'salvage produced output');
  assert.ok(/7 个目录/.test(salvaged), 'salvage leads with deterministic summary');
  assert.ok(salvaged.includes('原始内容'), 'salvage still appends raw output');
  // 总结应出现在原文之前
  assert.ok(salvaged.indexOf('7 个目录') < salvaged.indexOf('卷的序列号'), 'summary precedes raw');
}

// 6) env 关闭则回退原始呈现
{
  const prev = process.env.KHY_TOOL_DATA_SUMMARY;
  process.env.KHY_TOOL_DATA_SUMMARY = '0';
  const salvaged = _salvageToolResults([{ tool: 'Bash', result: { success: true, output: WIN_DIR } }]);
  assert.ok(/已为你直接呈现工具返回的内容/.test(salvaged), 'env off → raw passthrough header');
  if (prev === undefined) delete process.env.KHY_TOOL_DATA_SUMMARY;
  else process.env.KHY_TOOL_DATA_SUMMARY = prev;
}

console.log('toolDataSummary: all assertions passed');
