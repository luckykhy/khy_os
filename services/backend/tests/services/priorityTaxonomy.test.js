'use strict';

/**
 * priorityTaxonomy.test.js — 计划优先级 + bug 严重性分级单一真源纯模块单测。
 *
 * 守护(goal 2026-06-25「计划区分优先级 P0/P1/P2…;bug 问题分级 高 H1/H2、中 M1/M2、
 * 低 LOW1/LOW2…」):
 *   1. 优先级解析:P0..P3 + 裸数字 + 越界夹取。
 *   2. 严重性 token 解析:tier 名 / 前缀码 / 带序号码 互通。
 *   3. tier 内序号确定性赋码(H1,H2,M1,LOW1…),保序、不改入参。
 *   4. 注入指令:开关门控,内容含各档标号。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const tax = require('../../src/services/priorityTaxonomy');

const ON = {};
const PLAN_OFF = { KHY_PLAN_PRIORITY: 'off' };
const SEV_OFF = { KHY_BUG_SEVERITY: 'off' };

describe('优先级 normalizePriority', () => {
  test('P0..P3 标准码', () => {
    assert.equal(tax.normalizePriority('P0').code, 'P0');
    assert.equal(tax.normalizePriority('p1').rank, 1);
    assert.equal(tax.normalizePriority('Priority 2').code, 'P2');
  });
  test('裸数字 → Pn', () => {
    assert.equal(tax.normalizePriority('0').code, 'P0');
    assert.equal(tax.normalizePriority('3').code, 'P3');
  });
  test('越界数字夹到最低档', () => {
    assert.equal(tax.normalizePriority('9').code, 'P3');
  });
  test('无法识别 → null', () => {
    assert.equal(tax.normalizePriority('urgent'), null);
    assert.equal(tax.normalizePriority(''), null);
    assert.equal(tax.normalizePriority(null), null);
  });
});

describe('严重性 token 解析 normalizeSeverityToken', () => {
  test('tier 名(含 nits/crit/med 变体)', () => {
    assert.equal(tax.normalizeSeverityToken('critical').key, 'critical');
    assert.equal(tax.normalizeSeverityToken('High').key, 'high');
    assert.equal(tax.normalizeSeverityToken('nits').key, 'nit');
    assert.equal(tax.normalizeSeverityToken('med').key, 'medium');
  });
  test('带序号码 → tier + rank', () => {
    assert.deepEqual(tax.normalizeSeverityToken('H1'), { key: 'high', rank: 1 });
    assert.deepEqual(tax.normalizeSeverityToken('m2'), { key: 'medium', rank: 2 });
    assert.deepEqual(tax.normalizeSeverityToken('LOW3'), { key: 'low', rank: 3 });
    assert.deepEqual(tax.normalizeSeverityToken('C1'), { key: 'critical', rank: 1 });
  });
  test('裸前缀 LOW → low', () => {
    assert.equal(tax.normalizeSeverityToken('LOW').key, 'low');
  });
  test('未知 → null', () => {
    assert.equal(tax.normalizeSeverityToken('???'), null);
  });
});

describe('severityCode 拼码', () => {
  test('tier + rank → 前缀码', () => {
    assert.equal(tax.severityCode('high', 2), 'H2');
    assert.equal(tax.severityCode('low', 1), 'LOW1');
    assert.equal(tax.severityCode('critical', 3), 'C3');
  });
  test('rank 缺省 → 1', () => {
    assert.equal(tax.severityCode('medium'), 'M1');
  });
  test('未知 tier → 空串', () => {
    assert.equal(tax.severityCode('bogus', 1), '');
  });
});

describe('assignSeverityCodes tier 内序号', () => {
  test('保序赋 H1/H2/M1/LOW1,不改入参', () => {
    const input = [
      { severity: 'high', title: 'a' },
      { severity: 'high', title: 'b' },
      { severity: 'medium', title: 'c' },
      { severity: 'low', title: 'd' },
      { severity: 'high', title: 'e' },
    ];
    const out = tax.assignSeverityCodes(input);
    assert.deepEqual(out.map(f => f.code), ['H1', 'H2', 'M1', 'LOW1', 'H3']);
    assert.deepEqual(out.map(f => f.tierRank), [1, 2, 1, 1, 3]);
    // 入参不被改写
    assert.equal(input[0].code, undefined);
    // 标题保持
    assert.equal(out[0].title, 'a');
  });
  test('未知 severity → 空码', () => {
    const out = tax.assignSeverityCodes([{ severity: 'weird' }]);
    assert.equal(out[0].code, '');
  });
  test('非数组 → 空数组', () => {
    assert.deepEqual(tax.assignSeverityCodes(null), []);
  });
  test('summarizeFindingCodes 摘要', () => {
    const out = tax.assignSeverityCodes([{ severity: 'high' }, { severity: 'medium' }]);
    assert.equal(tax.summarizeFindingCodes(out), 'H1,M1');
  });
});

describe('注入指令 + 开关门控', () => {
  test('计划优先级指令含 P0/P1/P2,默认开', () => {
    const s = tax.buildPlanPriorityInstruction(ON);
    assert.equal(s.includes('P0'), true);
    assert.equal(s.includes('P1'), true);
    assert.equal(s.includes('P2'), true);
    assert.equal(s.startsWith('[System'), true);
  });
  test('KHY_PLAN_PRIORITY=off → 空串', () => {
    assert.equal(tax.buildPlanPriorityInstruction(PLAN_OFF), '');
  });
  test('bug 严重性指令含 H1/M1/LOW1,默认开', () => {
    const s = tax.buildBugSeverityInstruction(ON);
    assert.equal(s.includes('H1'), true);
    assert.equal(s.includes('M1') || s.includes('M1/M2'), true);
    assert.equal(s.includes('LOW1'), true);
  });
  test('KHY_BUG_SEVERITY=off → 空串 + 解析器不赋码', () => {
    assert.equal(tax.buildBugSeverityInstruction(SEV_OFF), '');
    assert.equal(tax.isBugSeverityEnabled(SEV_OFF), false);
  });
});
