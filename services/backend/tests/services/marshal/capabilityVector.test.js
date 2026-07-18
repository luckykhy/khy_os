'use strict';

/**
 * capabilityVector.test.js — marshal 的**唯一在产叶子**的覆盖。
 *
 * 背景：marshal 的「生命周期半边」(任命/弹劾/接力/SOP/强弱主协议) 经 2026-06-14 核实
 * **零消费者、三入口零引用**，已按 `.ai/GOVERNANCE-LEDGER.md` §B.0 删除。唯一仍在产的是
 * `capabilityVector`——经 `metaConstraint/capabilityProbe` 投影分带，是「模型→数值能力」的
 * 单一真源（见 `.ai/GUARDS-AI.md` §2）。本文件从原 `marshalSubsystem.test.js` 抽出其覆盖，
 * 直接 require 叶子（不经已删的 index.js），保住在产叶子的回归。
 *
 * 纯确定性、零外部依赖；node:test 直跑。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const cap = require('../../../src/services/marshal/capabilityVector');

describe('capabilityVector: 评分与强弱裁决', () => {
  test('分数随层级单调下降，reasoning 主导', () => {
    const t0 = cap.capabilityScore('claude-opus-4-8');
    const t1 = cap.capabilityScore('claude-sonnet-4-6');
    const t2 = cap.capabilityScore('qwen-4b');
    const t3 = cap.capabilityScore('gpt-4o-mini');
    assert.ok(t0 > t1 && t1 > t2 && t2 > t3, `期望 T0>T1>T2>T3，实得 ${t0}/${t1}/${t2}/${t3}`);
  });

  test('强弱裁决按 reasoning 阈值切分：T0/T1 强、T2/T3 弱', () => {
    assert.equal(cap.assess('claude-opus-4-8').strength, 'strong');
    assert.equal(cap.assess('claude-sonnet-4-6').strength, 'strong');
    assert.equal(cap.assess('qwen-4b').strength, 'weak');
    assert.equal(cap.assess('gpt-4o-mini').strength, 'weak');
  });

  test('阈值可由环境变量覆盖（零硬编码）', () => {
    const prev = process.env.KHY_MARSHAL_STRONG_THRESHOLD;
    try {
      process.env.KHY_MARSHAL_STRONG_THRESHOLD = '10'; // 极低阈值 → 连弱模型也算强
      assert.equal(cap.assess('qwen-4b').strength, 'strong');
    } finally {
      if (prev === undefined) delete process.env.KHY_MARSHAL_STRONG_THRESHOLD;
      else process.env.KHY_MARSHAL_STRONG_THRESHOLD = prev;
    }
  });
});
