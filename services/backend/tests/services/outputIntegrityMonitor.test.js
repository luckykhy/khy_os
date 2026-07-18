'use strict';

/**
 * outputIntegrityMonitor.test.js — 输出层软 bug 监听纯模块单测。
 *
 * 守护(goal 2026-06-25「软 bug 主动监听:输出不全 / 乱码 / 缩放丢行 —— 能修就修,否则报错存日志」):
 *   1. 乱码检测:零星 U+FFFD 可 strip(已修);整段误解码/高占比 → 不可修。
 *   2. 输出不全:未闭合代码围栏 → 补 ``` 闭合(已修)。
 *   3. 缩放丢行:shrink 且 rows 有效 → full-repaint;rows 测不出 → 兜底 rows 仍 full-repaint + 记日志。
 *   4. 不可修复:落注入 sink(错误日志);strict 抛、observe 不抛、render 永不抛。
 *   5. 健康文本零误报 + snapshot 契约。用注入 sink 断言落盘、避免真写 winston。
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const mon = require('../../src/services/outputIntegrityMonitor');

const OBSERVE = { KHY_OUTPUT_MONITOR: 'observe' };
const STRICT = { KHY_OUTPUT_MONITOR: 'strict' };
const OFF = { KHY_OUTPUT_MONITOR: 'off' };

let _sink;
beforeEach(() => {
  mon.reset();
  _sink = [];
  mon.__setSink((e) => _sink.push(e));
});

describe('乱码 / mojibake', () => {
  test('零星 U+FFFD → strip 修复', () => {
    const r = mon.guardText('正常文本' + '�' + '继续', { source: 't' }, OBSERVE);
    assert.equal(r.text.includes('�'), false);
    assert.equal(r.report.ok, true);
    assert.equal(r.report.repaired.length, 1);
    assert.equal(_sink.length, 0, '可修复不应落错误日志');
  });

  test('整段高占比替换符 → 不可修复,落错误日志', () => {
    const garbled = '�'.repeat(20) + 'x';
    const r = mon.guardText(garbled, { source: 'render-x' }, OBSERVE);
    assert.equal(r.report.ok, false);
    assert.equal(r.report.unrepaired.length, 1);
    assert.equal(_sink.length, 1, '不可修复必落日志');
    assert.equal(_sink[0].type, 'mojibake');
    assert.equal(_sink[0].source, 'render-x');
  });

  test('UTF-8 被 Latin1 误解码的经典字节对(多处)→ 不可修复', () => {
    const r = mon.guardText('caféÃ© résuméâ€™ dataÃ¨ moreÃ¢', {}, OBSERVE);
    assert.equal(r.report.ok, false);
    assert.equal(_sink.length, 1);
  });

  test('健康中英文文本零误报', () => {
    const r = mon.guardText('这是正常的中文 with English and emoji 🎉 and code.', {}, OBSERVE);
    assert.equal(r.report.ok, true);
    assert.equal(r.report.repaired.length, 0);
    assert.equal(_sink.length, 0);
  });
});

describe('输出不全 / 未闭合围栏', () => {
  test('奇数 ``` → 补闭合(已修)', () => {
    const r = mon.guardText('看代码:\n```js\nconst a = 1;', {}, OBSERVE);
    assert.equal((r.text.match(/```/g) || []).length % 2, 0, '闭合后围栏成对');
    assert.equal(r.report.repaired.some(x => x.type === 'incomplete'), true);
  });

  test('成对围栏不动', () => {
    const src = '```js\nconst a = 1;\n```';
    const r = mon.guardText(src, {}, OBSERVE);
    assert.equal(r.report.ok, true);
    assert.equal(r.report.repaired.length, 0);
  });
});

describe('缩放丢行 assessResize', () => {
  test('shrink + 有效 rows → full-repaint,无丢行风险', () => {
    const d = mon.assessResize({ prevCols: 120, curCols: 80, rows: 40, isTTY: true }, OBSERVE);
    assert.equal(d.action, 'full-repaint');
    assert.equal(d.rows, 40);
    assert.equal(d.riskLineLoss, false);
    assert.equal(_sink.length, 0);
  });

  test('shrink + rows 测不出(0/NaN)→ 兜底 rows 仍 full-repaint + 记日志', () => {
    const d = mon.assessResize({ prevCols: 120, curCols: 80, rows: 0, isTTY: true, fallbackRows: 30 }, OBSERVE);
    assert.equal(d.action, 'full-repaint', '不可落到 incremental(否则 under-erase 丢行)');
    assert.equal(d.rows, 30);
    assert.equal(d.riskLineLoss, true);
    assert.equal(_sink.length, 1);
    assert.equal(_sink[0].type, 'line-loss');
  });

  test('grow(zoom-out)+ 有效 rows → full-repaint(回归修复:此前落 incremental 残线)', () => {
    // ink 仅在缩小方向 resync live 区,放大方向直接跳过 → log-update 行计数与 reflow 后
    // 的物理行错位 → 残线/重复输入框。列宽任一方向变化都强制全屏重绘。
    const d = mon.assessResize({ prevCols: 80, curCols: 120, rows: 40, isTTY: true }, OBSERVE);
    assert.equal(d.action, 'full-repaint');
    assert.equal(d.rows, 40);
    assert.equal(d.riskLineLoss, false);
  });

  test('列宽不变(仅行数变化,无 reflow)→ incremental,无风险', () => {
    const d = mon.assessResize({ prevCols: 100, curCols: 100, rows: 40, isTTY: true }, OBSERVE);
    assert.equal(d.action, 'incremental');
    assert.equal(d.riskLineLoss, false);
  });

  test('grow 在监听关时仍 legacy incremental(逐字节 legacy,不含放大修复)', () => {
    const d = mon.assessResize({ prevCols: 80, curCols: 120, rows: 40, isTTY: true }, OFF);
    assert.equal(d.action, 'incremental');
    assert.equal(_sink.length, 0);
  });

  test('off → 旧策略(rows 测不出时 incremental,不兜底不记日志)', () => {
    const d = mon.assessResize({ prevCols: 120, curCols: 80, rows: NaN, isTTY: true }, OFF);
    assert.equal(d.action, 'incremental');
    assert.equal(_sink.length, 0);
  });
});

describe('strict / observe / render 抛与不抛', () => {
  test('strict + 不可修复 → 抛 OutputIntegrityError(且仍落日志)', () => {
    assert.throws(
      () => mon.guardText('�'.repeat(30), { source: 's' }, STRICT),
      (e) => e instanceof mon.OutputIntegrityError && e.type === 'mojibake',
    );
    assert.equal(_sink.length, 1, 'strict 抛前已落日志');
  });

  test('observe + 不可修复 → 不抛,返回最佳努力', () => {
    let r;
    assert.doesNotThrow(() => { r = mon.guardText('�'.repeat(30), {}, OBSERVE); });
    assert.equal(r.report.ok, false);
  });

  test('render:true 即使 strict 也不抛(避免整屏弄没)', () => {
    let r;
    assert.doesNotThrow(() => { r = mon.guardText('�'.repeat(30), { render: true }, STRICT); });
    assert.equal(r.report.ok, false);
    assert.equal(_sink.length, 1, 'render 不抛但仍落日志');
  });

  test('off → 全透传,不检测不记日志', () => {
    const r = mon.guardText('�'.repeat(30), {}, OFF);
    assert.equal(r.text.includes('�'), true);
    assert.equal(_sink.length, 0);
  });
});

describe('输出不全权威信号 noteTruncation', () => {
  test('续写恢复耗尽未补全 → 记 error + 落错误日志', () => {
    const r = mon.noteTruncation({ recovered: false, continuations: 3, chars: 4096, source: 'truncation-attempts-exhausted' }, OBSERVE);
    assert.equal(r.recovered, false);
    assert.equal(_sink.length, 1, '不可修复必落日志');
    assert.equal(_sink[0].type, 'incomplete');
    assert.equal(_sink[0].source, 'truncation-attempts-exhausted');
    const s = mon.snapshot();
    assert.equal(s.unrepaired >= 1, true);
    assert.equal(s.byType.incomplete >= 1, true);
  });

  test('续写恢复成功补全 → 仅记 snapshot,不刷错误日志', () => {
    const r = mon.noteTruncation({ recovered: true, continuations: 2, chars: 8000, source: 'truncation-recovered' }, OBSERVE);
    assert.equal(r.recovered, true);
    assert.equal(_sink.length, 0, '已恢复不刷错误日志');
    assert.equal(mon.snapshot().repaired >= 1, true);
  });

  test('off → 不记录、不落日志,返回 null', () => {
    const r = mon.noteTruncation({ recovered: false, continuations: 5, chars: 1000 }, OFF);
    assert.equal(r, null);
    assert.equal(_sink.length, 0);
  });
});

describe('snapshot / hasSignal 契约', () => {
  test('累积已修/不可修计数 + byType', () => {
    assert.equal(mon.hasSignal(), false);
    mon.guardText('a�b', {}, OBSERVE);          // 可修
    mon.guardText('�'.repeat(30), {}, OBSERVE); // 不可修
    const s = mon.snapshot();
    assert.equal(s.repaired >= 1, true);
    assert.equal(s.unrepaired >= 1, true);
    assert.equal(s.byType.mojibake >= 1, true);
    assert.equal(mon.hasSignal(), true);
  });
});
