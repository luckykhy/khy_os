'use strict';

// CcTable 截断契约测试 — BUG-100。
// 文件头注释承诺「超长内容截断用 …」，且 truncate 助手早已存在，但表头/数据单元格
// 此前只调 pad*（内容 ≥ 列宽时原样返回），flex 列被 calculateColumnWidths 压到小于
// 内容时，超宽 cell 会把 1 个逻辑行撑成多个视觉行并挤断列栅格。inkRuntime 可廉价
// 实例化，故直接渲染对拍帧高与省略号。
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

test('BUG-100 行为: flex 列压缩后超宽 cell 截断为一视觉行（ink 真渲染）', async () => {
  const TUI_PATH = path.resolve(__dirname, '../../../../src/cli/tui');
  process.env.FORCE_COLOR = process.env.FORCE_COLOR || '3';
  const R = require(require.resolve('react', { paths: [TUI_PATH] }));
  const inkRuntime = require(path.join(TUI_PATH, 'inkRuntime'));
  await inkRuntime.loadInk();
  const ink = inkRuntime.get();
  const stripAnsi = require(path.resolve(__dirname, '../../../../src/utils/stripAnsi'));
  const { CcTable } = require(path.join(TUI_PATH, 'ink-components/CcTable'));

  const columns = [
    { key: 'name', header: '名称', minWidth: 6, priority: 'high' },
    { key: 'desc', header: '功能', flex: true, minWidth: 4, priority: 'high' },
  ];
  const rows = [
    ['serve', '这是一个相当长的中文功能说明文字需要截断'],
    ['x', 'short'],
  ];

  const frame = stripAnsi(
    ink.renderToString(R.createElement(CcTable, { columns, rows, cols: 24, minCols: 1 }),
      { columns: 24 }),
  ).replace(/\n$/, '').split('\n');

  // 帧 = 上边框 + 表头 + 分隔线 + 2 数据行 + 下边框 = 6 视觉行。
  // 修复前：长 desc 撑破 → 8+ 视觉行且 name 列被挤断。
  assert.strictEqual(frame.length, 6, '每个逻辑数据行须占且仅占 1 视觉行，实测帧:\n' + frame.join('\n'));
  const longRow = frame.find((ln) => ln.includes('serve'));
  assert.ok(longRow.includes('…'), '超长 cell 须以省略号截断，实测: ' + JSON.stringify(longRow));
  assert.ok(!longRow.includes('需要截断'), '超宽内容不得原样上屏');
});

// ── BUG-101：CcMcpTable 状态色此前是死代码 ──────────────────────────────────
// CcMcpTable 建了 statusColor 映射并把 row.color 挂到行数组上（注释「为每行的
// 状态列添加颜色」），但通用 CcTable 数据行只读 col.color（列级，无人设置）→
// connected/failed 全渲染成默认灰，整套状态色形同虚设。修复 = 渲染读取 row.color。
test('BUG-101 行为: MCP 表格按连接状态着色（ink 真渲染，状态色不再丢失）', async () => {
  const TUI_PATH = path.resolve(__dirname, '../../../../src/cli/tui');
  process.env.FORCE_COLOR = process.env.FORCE_COLOR || '3';
  const R = require(require.resolve('react', { paths: [TUI_PATH] }));
  const inkRuntime = require(path.join(TUI_PATH, 'inkRuntime'));
  await inkRuntime.loadInk();
  const ink = inkRuntime.get();
  const { CcMcpTable } = require(path.join(TUI_PATH, 'ink-components/CcTable'));

  const servers = [
    { name: 'ok-server', state: 'connected', type: 'stdio', tools: 3 },
    { name: 'bad-server', state: 'failed', type: 'http', tools: 0 },
  ];
  const out = ink.renderToString(R.createElement(CcMcpTable, { servers, cols: 60 }), { columns: 60 });
  // #4ADE80 = rgb(74,222,128) connected；#F87171 = rgb(248,113,113) failed。
  assert.ok(out.includes('74;222;128'), 'connected 行须着绿色，实测无此色码');
  assert.ok(out.includes('248;113;113'), 'failed 行须着红色，实测无此色码');
});

// ── BUG-102：相邻列须有 1 空格分隔 ─────────────────────────────────────────
// 各列 Text 此前直接相邻，且满格 cell（内容宽==列宽）无补白 → 与下一列挤连
// （"• connectedstdio"）。修复：非末列 cell 追加 1 空格并按分隔数收缩宽度预算。
test('BUG-102 行为: 满格 cell 与下一列之间保留 1 空格分隔（ink 真渲染）', async () => {
  const TUI_PATH = path.resolve(__dirname, '../../../../src/cli/tui');
  process.env.FORCE_COLOR = process.env.FORCE_COLOR || '3';
  const R = require(require.resolve('react', { paths: [TUI_PATH] }));
  const inkRuntime = require(path.join(TUI_PATH, 'inkRuntime'));
  await inkRuntime.loadInk();
  const ink = inkRuntime.get();
  const stripAnsi = require(path.resolve(__dirname, '../../../../src/utils/stripAnsi'));
  const { CcMcpTable } = require(path.join(TUI_PATH, 'ink-components/CcTable'));

  const servers = [{ name: 'ok-server', state: 'connected', type: 'stdio', tools: 3 }];
  const frame = stripAnsi(
    ink.renderToString(R.createElement(CcMcpTable, { servers, cols: 60 }), { columns: 60 }),
  ).split('\n');
  const dataLine = frame.find((ln) => ln.includes('ok-server'));
  // 修复前 = "connectedstdio"（挤连）；修复后须有空格。
  assert.ok(/connected stdio/.test(dataLine), '状态列与类型列之间须有分隔，实测: ' + JSON.stringify(dataLine));
  assert.ok(!/connectedstdio/.test(dataLine), '不得再挤连');
});
