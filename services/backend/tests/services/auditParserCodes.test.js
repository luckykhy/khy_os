'use strict';

/**
 * auditParserCodes.test.js — 审计解析器对「严重性分级编号」(H1/M1/LOW1…) 的解析与
 * 确定性赋码守护(goal 2026-06-25「项目 bug 问题分级 高 H1/H2、中 M1/M2、低 LOW1…」)。
 *
 * 关注:
 *   1. 带序号码标题 [H1] 与裸 tier 词 [HIGH] 都能解析到正确 tier。
 *   2. 解析后 tier 内序号确定性重排(H1,H2,M1,LOW1),不受模型自报序号影响。
 *   3. counts / actionable 不受编号影响(仍按 tier 统计、critical+high 可修)。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const parser = require('../../src/services/auditFixLoop/auditParser');

const REPORT = [
  '### [H1] Null deref in handler',
  '**Location:** src/a.js:42',
  '**Problem:** x.y when x is null',
  '',
  '### [HIGH] Race on shared map',          // 裸 tier 词也接受
  '**Location:** src/b.js:10',
  '',
  '### [M1] Missing validation',
  '**Location:** src/c.js:5',
  '',
  '### [LOW2] Magic number',                // 模型自报 LOW2,但它是首个 low → 重排 LOW1
  '**Location:** src/d.js:7',
  '',
  'AUDIT: 4 findings (0 critical, 2 high, 1 medium, 1 low, 0 nits)',
].join('\n');

describe('审计严重性编号解析', () => {
  test('带码与裸 tier 词都解析到 tier', () => {
    const r = parser.parseAuditReport(REPORT);
    assert.equal(r.total, 4);
    assert.deepEqual(r.findings.map(f => f.severity), ['high', 'high', 'medium', 'low']);
  });

  test('tier 内序号确定性重排(忽略模型自报序号)', () => {
    const r = parser.parseAuditReport(REPORT);
    assert.deepEqual(r.findings.map(f => f.code), ['H1', 'H2', 'M1', 'LOW1']);
  });

  test('counts 按 tier 统计、actionable=critical+high', () => {
    const r = parser.parseAuditReport(REPORT);
    assert.deepEqual(r.counts, { critical: 0, high: 2, medium: 1, low: 1, nit: 0 });
    assert.deepEqual(parser.actionableFindings(r).map(f => f.code), ['H1', 'H2']);
  });

  test('KHY_BUG_SEVERITY=off → 不赋码(向后兼容)', () => {
    const prev = process.env.KHY_BUG_SEVERITY;
    process.env.KHY_BUG_SEVERITY = 'off';
    try {
      const r = parser.parseAuditReport(REPORT);
      assert.equal(r.total, 4);
      assert.equal(r.findings.every(f => !f.code), true);
    } finally {
      if (prev === undefined) delete process.env.KHY_BUG_SEVERITY; else process.env.KHY_BUG_SEVERITY = prev;
    }
  });
});
