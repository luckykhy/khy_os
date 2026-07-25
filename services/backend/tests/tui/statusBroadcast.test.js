'use strict';

/**
 * statusBroadcast — 聚合「状态播报」纯叶子单测。
 *
 * 验证对齐 Claude Code 那一行现在进行时聚合活动行:
 *   "正在搜索 1 个模式、读取 1 个文件…" / "正在列出 1 个目录…" / "正在读取 3 个文件…"
 * 关注:只算在跑工具(无 result)、确定性类别顺序、复用 classifyAgentTool、门控字节回退。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const sb = require('../../src/cli/statusBroadcast');

const ON = { env: { KHY_STATUS_BROADCAST: '1' } };
const running = (name, input) => ({ name, input });           // 无 result → 在跑
const done = (name, result = { text: 'ok' }) => ({ name, result }); // 有 result → 完成

describe('summarizeRunningTools — 只统计在跑工具', () => {
  test('忽略已完成(挂了 result)的行', () => {
    const counts = sb.summarizeRunningTools([
      running('Grep', { pattern: 'foo' }),
      done('Read'),
      running('Read', { file_path: '/a.js' }),
    ]);
    assert.equal(counts.search, 1);
    assert.equal(counts.read, 1);
    assert.equal(counts.edit, undefined);
  });
  test('非数组 / 空 → 无任何类别(null-proto 计数对象)', () => {
    assert.equal(Object.keys(sb.summarizeRunningTools(null)).length, 0);
    assert.equal(Object.keys(sb.summarizeRunningTools([])).length, 0);
  });
  test('toolName 别名也识别', () => {
    const counts = sb.summarizeRunningTools([{ toolName: 'bash', input: { command: 'ls' } }]);
    assert.equal(counts.command, 1);
  });
});

describe('buildLiveStatusBroadcast — CC 风格聚合行', () => {
  test('单工具:列目录 → 正在列出 1 个目录…', () => {
    const line = sb.buildLiveStatusBroadcast([running('LS', { path: '/tmp' })], ON);
    assert.equal(line, '正在列出 1 个目录…');
  });

  test('多个同类:读 3 文件 → 正在读取 3 个文件…', () => {
    const line = sb.buildLiveStatusBroadcast([
      running('Read', { file_path: '/a' }),
      running('Read', { file_path: '/b' }),
      running('Read', { file_path: '/c' }),
    ], ON);
    assert.equal(line, '正在读取 3 个文件…');
  });

  test('跨类:搜索 1 + 读取 1 → 搜索领先的确定性顺序', () => {
    // 故意把 read 放在 grep 前,验证输出顺序由 CATEGORY_ORDER 决定(搜索在前),
    // 不随到达顺序变化。
    const line = sb.buildLiveStatusBroadcast([
      running('Read', { file_path: '/a.js' }),
      running('Grep', { pattern: 'foo' }),
    ], ON);
    assert.equal(line, '正在搜索 1 个模式、读取 1 个文件…');
  });

  test('CC 权威顺序:read 在 list 之前(对齐 getSearchReadSummaryText)', () => {
    // CC 源 collapseReadSearch.ts getSearchReadSummaryText 依次 push search → read → list。
    // 故意把 LS(列目录)放在 Read 之前到达,验证输出仍是「读取…、列出…」(read 领先 list),
    // 不随到达顺序变化、也不是早先误把 list 排在 read 前的旧近似。
    const line = sb.buildLiveStatusBroadcast([
      running('LS', { path: '/tmp' }),
      running('Read', { file_path: '/a.js' }),
    ], ON);
    assert.equal(line, '正在读取 1 个文件、列出 1 个目录…');
  });

  test('CC 三档全到:搜索 → 读取 → 列出(完整权威次序)', () => {
    const line = sb.buildLiveStatusBroadcast([
      running('LS', { path: '/d' }),
      running('Read', { file_path: '/a.js' }),
      running('Grep', { pattern: 'foo' }),
    ], ON);
    assert.equal(line, '正在搜索 1 个模式、读取 1 个文件、列出 1 个目录…');
  });

  test('命令在跑 → 执行 N 条命令', () => {
    const line = sb.buildLiveStatusBroadcast([
      running('Bash', { command: 'npm test' }),
      running('Bash', { command: 'ls' }),
    ], ON);
    assert.equal(line, '正在执行 2 条命令…');
  });

  test('全部完成 → 空串(无在跑工具不出行)', () => {
    assert.equal(sb.buildLiveStatusBroadcast([done('Read'), done('Grep')], ON), '');
  });

  test('空 / null → 空串', () => {
    assert.equal(sb.buildLiveStatusBroadcast([], ON), '');
    assert.equal(sb.buildLiveStatusBroadcast(null, ON), '');
  });
});

describe('门控 KHY_STATUS_BROADCAST — 关即字节回退', () => {
  const tools = [running('LS', { path: '/tmp' })];
  for (const off of ['0', 'false', 'off', 'no']) {
    test(`=${off} → 空串`, () => {
      assert.equal(sb.buildLiveStatusBroadcast(tools, { env: { KHY_STATUS_BROADCAST: off } }), '');
    });
  }
  test('未设(默认)→ 开启出行', () => {
    assert.equal(sb.buildLiveStatusBroadcast(tools, { env: {} }), '正在列出 1 个目录…');
  });
});
