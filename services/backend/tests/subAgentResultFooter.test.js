'use strict';

/**
 * subAgentResultFooter.test.js — 锁子代理结果「尾部告警块 + 保尾截断 + partial 打捞」的口径。
 *
 * 借鉴自 xingyao-y-code d88bbf4（v1.3.0，MIT，method=idea，见
 * khy-Trajectory/ycode-borrowing/2026-09-23-子代理结果尾块与部分打捞-计划.md）的两点：
 *   ① 部分工具失败不整任务否决 → 降级为结果尾部告警清单；
 *   ② 超时/取消/熔断打捞 partial_result，截断只吃正文、尾部告警块保留。
 * 本测是纯叶子 src/services/subAgentResultFooter.js 的逐字节口径锁；
 * 谁改动该模块谁先红。门控关（KHY_SUBAGENT_RESULT_FOOTER=off）须逐字节回退，见 isEnabled。
 */

const test = require('node:test');
const assert = require('node:assert');

// 模块尚不存在时，require 抛错 → 本套件全红（实现前的红态留证）。
const footer = require('../src/services/subAgentResultFooter');

const {
  SUBAGENT_WARNING_MARKER,
  withToolErrorFooter,
  truncateHeadPreserveTail,
  salvagePartial,
  isEnabled,
  toolErrorsFromLog,
} = footer;

// ── 点①：工具报错降级为尾部告警块 ─────────────────────────────────

test('无工具错且无 turnError → withToolErrorFooter 逐字节原样（不误伤）', () => {
  const text = '子代理结论：一切正常';
  assert.strictEqual(withToolErrorFooter(text, []), text);
  assert.strictEqual(withToolErrorFooter(text, null), text);
  assert.strictEqual(withToolErrorFooter(text, undefined), text);
  // 空串正文 + 无错 → 仍原样（空串）
  assert.strictEqual(withToolErrorFooter('', []), '');
});

test('有工具错 → 追加尾部告警块，含 marker 与「N 个」', () => {
  const out = withToolErrorFooter('结论正文', [
    { name: 'Bash', detail: 'exit 1' },
    { name: 'Read', detail: 'ENOENT' },
  ]);
  assert.ok(out.includes(SUBAGENT_WARNING_MARKER), '须含尾部告警 marker');
  assert.ok(out.startsWith('结论正文'), '正文在前，尾块在后');
  assert.ok(/2 个/.test(out), '须标注 2 个');
  assert.ok(out.includes('Bash') && out.includes('Read'), '逐项列出工具名');
  assert.ok(out.includes('exit 1') && out.includes('ENOENT'), '逐项列出错误明细');
});

test('turnError 在 → 追加「回合级中止原因」行', () => {
  const out = withToolErrorFooter('正文', [{ name: 'Bash', detail: 'x' }], '无进展熔断（第 40 轮）');
  assert.ok(out.includes('回合级中止原因'), '须含回合级中止原因行');
  assert.ok(out.includes('无进展熔断（第 40 轮）'), '透出真实中止原因');
});

test('>5 项 → 只列前 5，余项标「另有 N 个未展开」', () => {
  const errs = [];
  for (let i = 1; i <= 8; i++) errs.push({ name: `tool${i}`, detail: `d${i}` });
  const out = withToolErrorFooter('正文', errs);
  assert.ok(out.includes('tool1') && out.includes('tool5'), '前 5 项在');
  assert.ok(!out.includes('tool6') && !out.includes('tool8'), '第 6 项起不逐项展开');
  assert.ok(/另有 3 个未展开/.test(out), '标注剩余 3 项');
});

test('单项 detail 超 200 字 → 截断并以 … 收尾', () => {
  const long = 'x'.repeat(300);
  const out = withToolErrorFooter('正文', [{ name: 'Bash', detail: long }]);
  assert.ok(out.includes('…'), '单项截断须带省略号');
  const line = out.split('\n').find((l) => l.includes('Bash'));
  assert.ok(line.length < 300, '单项 detail 被封顶，不整段进尾块');
});

// ── 点②：保尾截断 + partial 打捞 ─────────────────────────────────

test('truncateHeadPreserveTail：≤maxLen → 原样', () => {
  const text = 'short';
  assert.strictEqual(truncateHeadPreserveTail(text, 100, '[… {omitted} 省略]'), text);
});

test('truncateHeadPreserveTail：>maxLen 且尾块存在 → 保尾、{omitted} 实数', () => {
  const head = 'A'.repeat(700);
  const body = head + '正文';
  const withMarker = body + SUBAGENT_WARNING_MARKER + '\n- Bash: exit 1';
  const maxLen = 600;
  const out = truncateHeadPreserveTail(withMarker, maxLen, '… [结果已截断，省略 {omitted} 字符]');
  assert.ok(out.includes(SUBAGENT_WARNING_MARKER), '尾部告警块保留');
  assert.ok(out.includes('Bash: exit 1'), '尾块内容保留');
  assert.ok(out.length <= maxLen, `截断后 ≤ maxLen（实际 ${out.length}）`);
  assert.ok(out.includes('… [结果已截断，省略 '), 'trailer 已插入');
  assert.ok(!out.includes('{omitted}'), '{omitted} 占位被替换为实数');
});

test('truncateHeadPreserveTail：尾块过大（预算 < maxLen//2）→ 退化普通头截断', () => {
  const tail = SUBAGENT_WARNING_MARKER + '\n' + 'X'.repeat(1000);
  const text = 'B'.repeat(50) + tail;
  const maxLen = 200;
  const out = truncateHeadPreserveTail(text, maxLen, '… [省略 {omitted}]');
  // 尾块 1000 远超预算 → 不保留尾块，退化为普通头截断
  assert.ok(out.length <= maxLen + 1, '退化后长度受控');
  assert.ok(out.includes('… [省略 '), '走普通头截断 trailer');
});

test('truncateHeadPreserveTail：无尾块 → 普通头截断', () => {
  const text = 'C'.repeat(100);
  const out = truncateHeadPreserveTail(text, 30, '… [省略 {omitted}]');
  assert.ok(out.length <= 30, '截断到 maxLen 以内');
  assert.ok(out.includes('… [省略 '), 'trailer 在尾');
});

test('salvagePartial：空→""、未超限→原样、超限→截断+…', () => {
  assert.strictEqual(salvagePartial('', 100), '');
  assert.strictEqual(salvagePartial(null, 100), '');
  assert.strictEqual(salvagePartial('abc', 100), 'abc');
  const long = 'D'.repeat(3000);
  const out = salvagePartial(long, 1500);
  assert.ok(out.length <= 1500 + 3, '打捞正文被封顶（含省略号）');
  assert.ok(out.endsWith('...'), '超限时以 … 收尾');
});

// ── 门控：关 → 逐字节回退 ─────────────────────────────────────────

test('isEnabled：默认开；0/false/off/no → 关；其余 → 开', () => {
  assert.strictEqual(isEnabled({}), true);
  assert.strictEqual(isEnabled({ KHY_SUBAGENT_RESULT_FOOTER: '' }), true);
  assert.strictEqual(isEnabled({ KHY_SUBAGENT_RESULT_FOOTER: '1' }), true);
  assert.strictEqual(isEnabled({ KHY_SUBAGENT_RESULT_FOOTER: 'on' }), true);
  assert.strictEqual(isEnabled({ KHY_SUBAGENT_RESULT_FOOTER: '0' }), false);
  assert.strictEqual(isEnabled({ KHY_SUBAGENT_RESULT_FOOTER: 'off' }), false);
  assert.strictEqual(isEnabled({ KHY_SUBAGENT_RESULT_FOOTER: 'false' }), false);
  assert.strictEqual(isEnabled({ KHY_SUBAGENT_RESULT_FOOTER: 'no' }), false);
});

// ── toolLog → 工具错清单（喂尾块） ───────────────────────────────

test('toolErrorsFromLog：只取 error 条目，映射 {name,detail}，缺 detail→""', () => {
  const log = [
    { tool: 'Read', status: 'success' },
    { tool: 'Bash', status: 'error', error: 'exit 1' },
    { tool: 'Grep', status: 'error' },
  ];
  const out = toolErrorsFromLog(log);
  assert.strictEqual(out.length, 2, '只保留两个 error 条目');
  assert.deepStrictEqual(out[0], { name: 'Bash', detail: 'exit 1' });
  assert.deepStrictEqual(out[1], { name: 'Grep', detail: '' });
  assert.strictEqual(toolErrorsFromLog([]).length, 0);
  assert.strictEqual(toolErrorsFromLog(null).length, 0);
});
