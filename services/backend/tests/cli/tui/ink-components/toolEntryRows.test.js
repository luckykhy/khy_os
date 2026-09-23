'use strict';

// toolEntryRows 契约测试 — 纯叶子(estimateToolEntryRows:live 时间线尾切预算的
// 单工具条目真实渲染行数估算;estimateLiteralRows:ToolLines 完成态字面输出体行数)。
// 二者与渲染共用同一批 memo 缓存(估算=渲染同源),与 toolCostOf 回调接线后从根上
// 修正「tool 记 1 行」的系统性低估 [IMPL-RPT-044]。所有断言值均为探针对实现实测
// 的真实返回值,不是猜测。零 IO、零网络。
//
// (本文件曾因 CJK mojibake 损坏被隔离为空壳,债务记录于 tests/DEBT.md;P0-2 期间
// 随 toolCostOf 接线一并恢复,DEBT.md 同步除名。)
//
// 运行: node --test services/backend/tests/cli/tui/ink-components/toolEntryRows.test.js

const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../../../../src/cli/tui/ink-components/toolEntryRows');
const ToolLines = require('../../../../src/cli/tui/ink-components/ToolLines');
const { estimateToolEntryRows, isEnabled, OFF_VALUES } = leaf;

const ENV = {}; // clean env → all sub-gates on, deterministic

// ── isEnabled(门控梯,默认开) ─────────────────────────────────────────────────

test('isEnabled: 默认开(unset/undefined/空串),四 falsy 值大小写+trim 关', () => {
  assert.strictEqual(isEnabled({}), true);
  assert.strictEqual(isEnabled(undefined), true);
  assert.strictEqual(isEnabled({ KHY_TOOL_ROW_BUDGET: '' }), true);
  assert.strictEqual(isEnabled({ KHY_TOOL_ROW_BUDGET: '1' }), true);
  for (const v of OFF_VALUES) {
    assert.strictEqual(isEnabled({ KHY_TOOL_ROW_BUDGET: v }), false, v);
    assert.strictEqual(isEnabled({ KHY_TOOL_ROW_BUDGET: ' ' + v.toUpperCase() + ' ' }), false, v);
  }
});

// ── 退化输入 / 门控关(恒 1) ─────────────────────────────────────────────────

test('estimateToolEntryRows: 门控关 → 恒返 1(逐字节回退历史记法)', () => {
  const offEnv = { KHY_TOOL_ROW_BUDGET: 'off' };
  assert.strictEqual(estimateToolEntryRows({ name: 'Bash', result: { output: 'a\nb' } }, { env: offEnv }), 1);
  assert.strictEqual(estimateToolEntryRows({ name: 'Bash', result: { isError: true, error: 'x' } }, { env: offEnv }), 1);
});

test('estimateToolEntryRows: tool 缺失/非对象 → 1,绝不抛', () => {
  assert.strictEqual(estimateToolEntryRows(null, { env: ENV }), 1);
  assert.strictEqual(estimateToolEntryRows(undefined, { env: ENV }), 1);
  assert.strictEqual(estimateToolEntryRows('Bash', { env: ENV }), 1);
  assert.strictEqual(estimateToolEntryRows(0, { env: ENV }), 1);
});

test('estimateToolEntryRows: 不传 opts 也不抛(默认 process.env 路径)', () => {
  // no env injection → reads process.env; must not throw regardless of its content
  assert.ok(estimateToolEntryRows({ name: 'Read' }) >= 1);
});

// ── 分支镜像(与 ToolLines 渲染体一一对应) ───────────────────────────────────

test('estimateToolEntryRows: _agentTree 非空 → 1(AgentTree 整体单行替换)', () => {
  const t = { _agentTree: [{}], result: { output: 'x' } };
  assert.strictEqual(estimateToolEntryRows(t, { env: ENV }), 1);
});

test('estimateToolEntryRows: 未完成 — 头行 1,progress 再 +1', () => {
  assert.strictEqual(estimateToolEntryRows({ name: 'Read' }, { env: ENV }), 1);
  assert.strictEqual(estimateToolEntryRows({ name: 'Read', progress: 'half' }, { env: ENV }), 2);
});

test('estimateToolEntryRows: 失败 — 头行 + 折叠详情行 + (denied|无详情时)headline 行', () => {
  // 3 行 error 文本:头 1 + 3 详情 = 4(shown=3,无 headline)
  assert.strictEqual(
    estimateToolEntryRows({ name: 'Bash', result: { isError: true, error: 'l1\nl2\nl3' } }, { env: ENV }),
    4,
  );
  // denied:头 1 + headline 1 = 2
  assert.strictEqual(
    estimateToolEntryRows({ name: 'Bash', result: { isError: true, denied: true } }, { env: ENV }),
    2,
  );
  // 40 行 error 折叠:头 1 + shown 10 + 「+30 行」页脚 = 12
  const err40 = Array.from({ length: 40 }, (_, i) => 'err ' + i).join('\n');
  assert.strictEqual(
    estimateToolEntryRows({ name: 'Bash', result: { isError: true, error: err40 } }, { env: ENV }),
    12,
  );
  // 展开态:头 1 + 40 行 = 41
  assert.strictEqual(
    estimateToolEntryRows({ name: 'Bash', result: { isError: true, error: err40 } }, { env: ENV, expanded: true }),
    41,
  );
});

test('estimateToolEntryRows: 完成 shell — output 体按折叠/展开计,exitCode≠0 再 +1', () => {
  // 3 行 output:头 1 + 3 行体 = 4
  assert.strictEqual(
    estimateToolEntryRows({ name: 'Bash', result: { output: 'a\nb\nc' } }, { env: ENV }),
    4,
  );
  // 同上 + exitCode 1 注释行
  assert.strictEqual(
    estimateToolEntryRows({ name: 'Bash', result: { output: 'a\nb\nc', exitCode: 1 } }, { env: ENV }),
    5,
  );
  // 无 output 体 → 只剩头 1(渲染只显示 ✓ 摘要行,由头行承载)
  assert.strictEqual(estimateToolEntryRows({ name: 'Bash', result: {} }, { env: ENV }), 1);
});

test('estimateToolEntryRows: 完成 shell 60 行 — 折叠 21 vs 展开 61(反低估主场景)', () => {
  // 历史记法恒 1;真实:折叠 = 头 1 + 折叠体 20;展开 = 头 1 + 全量 60
  const out60 = Array.from({ length: 60 }, (_, i) => 'out ' + i).join('\n');
  assert.strictEqual(
    estimateToolEntryRows({ name: 'Bash', result: { output: out60 } }, { env: ENV }),
    21,
  );
  assert.strictEqual(
    estimateToolEntryRows({ name: 'Bash', result: { output: out60 } }, { env: ENV, expanded: true }),
    61,
  );
});

test('estimateToolEntryRows: 完成 Write±diff — 按 diff 行计,非空 before/after 走结构化 diff', () => {
  // 3↔3 行内容改 1 行:结构化 diff 头 1 + 5 diff 行(hunk 头 + 上下文×2 + -old +new)
  const wr = { _khyWriteDiff: { beforeContent: 'a\nb\nc', afterContent: 'a\nx\nc' } };
  const collapsed = estimateToolEntryRows({ name: 'Edit', result: wr }, { env: ENV });
  const expanded = estimateToolEntryRows({ name: 'Edit', result: wr }, { env: ENV, expanded: true });
  assert.strictEqual(collapsed, 6);
  assert.strictEqual(expanded, 6);
  // 纯新增 60 行:折叠 = 头 1 + 11;展开 = 头 1 + 60
  const add60 = { _khyWriteDiff: { beforeContent: '', afterContent: Array.from({ length: 60 }, (_, i) => 'L' + i).join('\n') } };
  assert.strictEqual(estimateToolEntryRows({ name: 'Write', result: add60 }, { env: ENV }), 12);
  assert.strictEqual(estimateToolEntryRows({ name: 'Write', result: add60 }, { env: ENV, expanded: true }), 61);
});

test('estimateToolEntryRows: 完成非 shell — 折叠恒头 1 + 摘要 1;展开透明体或 12 行预览帽', () => {
  assert.strictEqual(
    estimateToolEntryRows({ name: 'Read', result: { content: 'abc' } }, { env: ENV }),
    2,
  );
  const c20 = Array.from({ length: 20 }, (_, i) => 'L' + i).join('\n');
  // 折叠:头 1 + 摘要 1 = 2(与体量无关)
  assert.strictEqual(
    estimateToolEntryRows({ name: 'Read', result: { content: c20 } }, { env: ENV }),
    2,
  );
  // 展开透明(KHY_TOOL_RESULT_TRANSPARENT 默认开):头 1 + shell 路径全量 20 行 = 21
  assert.strictEqual(
    estimateToolEntryRows({ name: 'Read', result: { content: c20 } }, { env: ENV, expanded: true }),
    21,
  );
  // 展开但透明关:回退 12 行预览帽 — 头 1 + 12 预览 + 截断标记 1 = 14
  const offT = { KHY_TOOL_RESULT_TRANSPARENT: 'off' };
  assert.strictEqual(
    estimateToolEntryRows({ name: 'Read', result: { content: c20 } }, { env: offT, expanded: true }),
    14,
  );
  assert.strictEqual(
    estimateToolEntryRows({ name: 'Read', result: { content: c20 } }, { env: offT }),
    2,
  );
});

// ── estimateLiteralRows(ToolLines 导出,估算=渲染同源) ────────────────────────

test('estimateLiteralRows: null/非对象 → 0;折叠非 shell → 恒 1 摘要行', () => {
  assert.strictEqual(ToolLines.estimateLiteralRows(null, { env: ENV }), 0);
  assert.strictEqual(ToolLines.estimateLiteralRows('x', { env: ENV }), 0);
  assert.strictEqual(ToolLines.estimateLiteralRows({ content: 'x' }, { env: ENV }), 1);
});

test('estimateLiteralRows: shell 2 行 output → 2(裸体行数,不含头行)', () => {
  assert.strictEqual(ToolLines.estimateLiteralRows({ output: 'a\nb' }, { env: ENV, shell: true }), 2);
});

// ── 幂等(估算与渲染共用 memo,重复调用不漂移) ────────────────────────────────

test('estimateToolEntryRows: 同一 tool 对象重复估算幂等(memo 命中,值不漂移)', () => {
  const out60 = Array.from({ length: 60 }, (_, i) => 'out ' + i).join('\n');
  const tool = { name: 'Bash', result: { output: out60 } };
  const first = estimateToolEntryRows(tool, { env: ENV });
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(estimateToolEntryRows(tool, { env: ENV }), first);
  }
});
