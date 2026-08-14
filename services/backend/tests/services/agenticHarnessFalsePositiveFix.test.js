'use strict';

/**
 * agenticHarnessFalsePositiveFix.test.js — 复现先行守卫在 harness 收口的分档拦 + 自动沉淀集成。
 *
 * goal(2026-06-25):防小模型误判 bug 把正确代码改坏。本套件守三件事:
 *   1. 复用既有阻断路径:弱档命中 → 合成的 regressionGateReport(passed:false,skipped:false)
 *      经 deliveryGate.buildHarnessDeliveryVerdict → verdict:'fail'、blockedBy 含 'regression_gate'
 *      (证明「零新增阻断管线」)。强档恒 caution → 不产 block → 不阻断。
 *   2. 自动沉淀复现测试 IO(_internals._depositReproTest):RED→GREEN 真修 → 临时目录落文件;
 *      幂等(同签名第二次 collision-skip 不重写);KHY_FPF_AUTO_DEPOSIT_REPRO=off → 不落;
 *      目标目录不存在 → 静默跳过;内容带 AUTO-DEPOSIT marker。
 *   3. 呈现 / fail-soft helper(_appendFalsePositiveFixSummary / _listKnownFiles)。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const guard = require('../../src/services/falsePositiveFixGuard');
const { buildHarnessDeliveryVerdict } = require('../../src/services/deliveryGate');
const { _internals } = require('../../src/services/agenticHarnessService');

const ON = { KHY_FALSE_POSITIVE_FIX_GUARD: 'on' };
const edit = (p) => ({ tool: 'edit_file', params: { path: p }, result: { success: true } });
const red = () => ({ kind: 'test', framework: 'jest', command: 'npx jest foo', green: false, failed: 2, failures: ['foo › a', 'foo › b'] });
const green = () => ({ kind: 'test', framework: 'jest', command: 'npx jest foo', green: true, failed: 0, failures: [] });

function bugfixState() {
  const st = guard.createState();
  st.bugfixIntent = true;
  return st;
}

// 复刻 harness 在弱档 block 时合成 / 并入 regressionGateReport 的最小逻辑(与生产同形)。
function mergeFpfBlock(regressionGateReport, fpfVerdict) {
  if (fpfVerdict.verdict !== 'block') return regressionGateReport;
  if (!regressionGateReport || regressionGateReport.skipped) {
    return {
      ...(regressionGateReport || {}),
      passed: false,
      skipped: false,
      regressedSteps: (regressionGateReport && regressionGateReport.regressedSteps) || [],
      summary: fpfVerdict.summary,
      falsePositiveFix: fpfVerdict,
    };
  }
  regressionGateReport.passed = false;
  regressionGateReport.falsePositiveFix = fpfVerdict;
  return regressionGateReport;
}

describe('harness FPF — 分档拦复用 regression_gate 阻断路径', () => {
  test('弱档幻想 bug → 合成报告经 deliveryGate 阻断(blockedBy 含 regression_gate)', () => {
    const st = bugfixState();
    guard.recordIteration(st, { toolResults: [edit('src/services/foo.js')] }, ON);
    const v = guard.finalize(st, { tier: 'low', changedFiles: ['src/services/foo.js'], knownFiles: [] }, ON);
    expect(v.verdict).toBe('block');

    const report = mergeFpfBlock(null /* 回归门未产报告 */, v);
    expect(report.skipped).toBe(false);
    expect(report.passed).toBe(false);

    const verdict = buildHarnessDeliveryVerdict({
      loopResult: { finalResponse: 'done' },
      regressionGateReport: report,
      toolCallLog: [edit('src/services/foo.js')],
    });
    expect(verdict.verdict).toBe('fail');
    expect(verdict.blockedBy).toContain('regression_gate');
  });

  test('强档同样命中 → caution 不 block → 不阻断交付', () => {
    const st = bugfixState();
    guard.recordIteration(st, { toolResults: [edit('src/services/foo.js')] }, ON);
    const v = guard.finalize(st, { tier: 'high', changedFiles: ['src/services/foo.js'], knownFiles: [] }, ON);
    expect(v.verdict).toBe('caution');
    expect(v.passed).toBe(true);

    const report = mergeFpfBlock(null, v); // caution → 不合成 → null
    expect(report).toBeNull();

    const verdict = buildHarnessDeliveryVerdict({
      loopResult: { finalResponse: 'done' },
      regressionGateReport: report,
      toolCallLog: [edit('src/services/foo.js')],
    });
    expect(verdict.verdict).toBe('pass');
    expect(verdict.blockedBy).not.toContain('regression_gate');
  });

  test('既有回归门已 PASS 的报告被弱档 block 翻成 fail(并入同一报告)', () => {
    const st = bugfixState();
    guard.recordIteration(st, { toolResults: [edit('src/services/foo.js')] }, ON);
    const v = guard.finalize(st, { tier: 'low', changedFiles: ['src/services/foo.js'], knownFiles: [] }, ON);

    const passingGate = { passed: true, skipped: false, regressedSteps: [], summary: 'regression clean' };
    const merged = mergeFpfBlock(passingGate, v);
    expect(merged.passed).toBe(false);
    expect(merged.falsePositiveFix).toBeTruthy();

    const verdict = buildHarnessDeliveryVerdict({
      loopResult: { finalResponse: 'done' },
      regressionGateReport: merged,
      toolCallLog: [],
    });
    expect(verdict.blockedBy).toContain('regression_gate');
  });
});

describe('harness FPF — 自动沉淀复现测试 IO 幂等', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpf-deposit-'));
  });
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function reproDeposit() {
    const st = bugfixState();
    guard.recordIteration(st, { toolResults: [], testFindings: [red()] }, ON);
    guard.recordIteration(st, { toolResults: [edit('src/services/foo.js')] }, ON);
    guard.recordIteration(st, { toolResults: [], testFindings: [green()] }, ON);
    const v = guard.finalize(st, { tier: 'low', changedFiles: ['src/services/foo.js'], knownFiles: [] }, ON);
    expect(v.deposit.shouldDeposit).toBe(true);
    return v.deposit;
  }

  test('RED→GREEN → 落文件,带 AUTO-DEPOSIT marker;第二次同签名 collision-skip', () => {
    const deposit = reproDeposit();
    const first = _internals._depositReproTest(dir, deposit, ON, dir);
    expect(first.created).toBe(true);
    expect(fs.existsSync(first.file)).toBe(true);
    const content = fs.readFileSync(first.file, 'utf8');
    expect(content).toMatch(/AUTO-DEPOSIT/);
    expect(content).toMatch(/npx jest foo/);

    // 幂等:同签名第二次不重写、不新建。
    const second = _internals._depositReproTest(dir, deposit, ON, dir);
    expect(second.created).toBe(false);
    expect(second.file).toBe(first.file);
    expect(fs.readdirSync(dir).length).toBe(1);
  });

  test('KHY_FPF_AUTO_DEPOSIT_REPRO=off → 不落文件', () => {
    const deposit = reproDeposit();
    const r = _internals._depositReproTest(dir, deposit, { ...ON, KHY_FPF_AUTO_DEPOSIT_REPRO: 'off' }, dir);
    expect(r.created).toBe(false);
    expect(fs.readdirSync(dir).length).toBe(0);
  });

  test('目标目录不存在 → 静默跳过(不抛、不创建)', () => {
    const deposit = reproDeposit();
    const missing = path.join(dir, 'does', 'not', 'exist');
    const r = _internals._depositReproTest(dir, deposit, ON, missing);
    expect(r.created).toBe(false);
  });
});

describe('harness FPF — 呈现 / fail-soft helper', () => {
  test('_appendFalsePositiveFixSummary 含摘要 + 建议', () => {
    const out = _internals._appendFalsePositiveFixSummary('原始回答', {
      summary: 'guard blocked: phantom-no-repro',
      recommendations: ['先写一个能复现该 bug 的失败测试'],
    });
    expect(out).toMatch(/原始回答/);
    expect(out).toMatch(/\[复现先行守卫\]/);
    expect(out).toMatch(/phantom-no-repro/);
    expect(out).toMatch(/先写一个能复现该 bug 的失败测试/);
  });

  test('_listKnownFiles 在非 git 目录 fail-soft 返回 []', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fpf-nogit-'));
    try {
      const files = _internals._listKnownFiles(tmp);
      expect(Array.isArray(files)).toBe(true);
      expect(files.length).toBe(0);
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
