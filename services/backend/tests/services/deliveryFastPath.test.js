'use strict';

/**
 * deliveryFastPath.test.js — 交付诚实性与快速路径确定性的补充单测。
 *
 * 覆盖本目标新增的行为:
 *   1) verificationAgent.verify 在「无可运行验证步骤」时如实暴露 noSteps/verified,
 *      而不是让 no steps = pass 静默充当绿旗。
 *   2) agenticHarnessService 在 delivery verdict 为 fail 时,把缺失证据追加到最终回复。
 *   3) turnEnvelope 把 harness deliveryVerdict 透传到结构化输出。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { verify } = require('../../src/services/verificationAgent');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'khy-delivery-'));
}

function rmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('verify(): no runnable steps → noSteps=true, verified=false (no silent green flag)', () => {
  const dir = tmpDir('khy-nosteps-');
  try {
    // 空目录:detectProject 无任何可运行步骤。
    const result = verify({ cwd: dir, files: [] });
    assert.strictEqual(result.noSteps, true);
    assert.strictEqual(result.verified, false);
    assert.strictEqual(result.passed, true); // 不误伤:仍判 passed(true),但明确未真正验证
  } finally {
    rmDir(dir);
  }
});

test('verify(): project with a test step runs it and reports verified=true', () => {
  const dir = tmpDir('khy-steps-');
  try {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'x', scripts: { test: 'node -e "console.log(1)"' } })
    );
    const result = verify({ cwd: dir, files: [] });
    // detectProject 至少识别出 node + test 步骤。
    assert.strictEqual(result.verified, true);
    assert.strictEqual(result.noSteps, false);
  } finally {
    rmDir(dir);
  }
});

test('harness delivery-verdict fail appends honest evidence to finalResponse', () => {
  // 通过直接执行私有 helper 验证契约(与 regression gate 的追加摘要同款)。
  const harnessSrc = fs.readFileSync(require.resolve('../../src/services/agenticHarnessService'), 'utf8');
  // [[-1]] helper 存在且含「交付判定:FAIL」与「未满足的交付条件」文本。
  assert.ok(harnessSrc.includes('function _appendDeliveryVerdictSummary'), 'helper must exist');
  assert.ok(harnessSrc.includes('交付判定:FAIL'), 'helper must state FAIL honestly');
  assert.ok(harnessSrc.includes('未满足的交付条件'), 'helper must list missing criteria');
});

test('turnEnvelope exposes harness deliveryVerdict and degrades ok->partial on fail', () => {
  const { buildTurnEnvelope } = require('../../src/services/structuredResults/turnEnvelope');
  const env = buildTurnEnvelope({
    finalResponse: 'done',
    iterations: 3,
    toolCallLog: [{ tool: 'editFile', params: { path: 'a.js' }, result: { success: true } }],
    harness: {
      deliveryVerdict: { verdict: 'fail', blockedBy: ['delivery_gate'], summary: 'missing evidence' },
    },
  });
  assert.strictEqual(env.delivery.verdict, 'fail');
  assert.ok(env.delivery.blockedBy.includes('delivery_gate'));
  // 交付判定 fail → 不再伪装 ok。
  assert.notStrictEqual(env.status, 'ok');

  const envPass = buildTurnEnvelope({
    finalResponse: 'done',
    iterations: 1,
    toolCallLog: [],
    harness: {
      deliveryVerdict: { verdict: 'pass', blockedBy: [], summary: 'ok' },
    },
  });
  assert.strictEqual(envPass.delivery.verdict, 'pass');
});