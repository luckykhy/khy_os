'use strict';

/**
 * intentGate.teachingRoleFraming.test.js — role-framed-request anti-misfire (node:test).
 *
 * Bug: a message that assigns a ROLE only to frame a one-shot deliverable
 * ("你是一个客观严苛的项目架构师…请…做一个公正的评价") was hijacked by the
 * teaching-intent gate — TEACH_PERSONA_RE matched the leading "你是…" and the
 * whole request got captured onto a companion ("识别到这是一条教学(人格)，但当前
 * 没有激活的同伴可记入"), instead of being executed as the requested evaluation.
 *
 * The global TASK_VERB_RE missed it because 请 was not immediately followed by a
 * listed verb ("请在…比较后…做") and the ask used evaluative verbs (评价/比较)
 * outside that list. The fix adds a persona-only veto (mirroring the WH
 * interrogative tier): a `你是…` prefix combined with a concrete deliverable
 * request (请/please + 评价/比较/分析… or 做一[个份]…评价/分析/报告) is delegation,
 * not a persona to record.
 *
 * Hard constraint pinned alongside: a genuine persona teaching that carries NO
 * deliverable request ("你是我的专属助手", "你是一个善于总结的人") must STILL be
 * captured, so the anti-misfire does not over-exclude.
 *
 * jest mirrors the same matrix in intentGate.teaching.test.js (CI only).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { detectTeaching, looksLikeRoleFramedRequest } = require('../../src/services/intentGate');

const notTeaching = (t) =>
  assert.equal(detectTeaching(t).isTeaching, false, `role-framing should be delegated (not teaching): ${t}`);
const isPersona = (t) => {
  const d = detectTeaching(t);
  assert.equal(d.isTeaching, true, `genuine persona should still be captured: ${t}`);
  assert.equal(d.target, 'persona', `${t} → target ${d.target} != persona`);
};

describe('detectTeaching — role-framed request anti-misfire', () => {
  test('persona prefix + deliverable request routes to the task path', () => {
    [
      // the original bug report (architect role + "请…做一个公正的评价" comparing tools)
      '你是一个客观严苛的项目架构师，对好的项目不吝惜夸奖，对项目中的不足会好不客气的批评指出，请在和其他类似的项目比较后claude code与open code等对你当前承载你的工具做一个公正的评价',
      '你是一个严苛的架构师，请对这个项目做一个公正的评价',
      '你是资深审查员，麻烦你分析一下这段代码',
      '你是一个测评专家，请比较一下 A 和 B',
      '你扮演产品经理，给出一份竞品分析报告',
      'act as a strict architect, please give a fair evaluation comparing claude code and opencode',
    ].forEach(notTeaching);
  });

  test('genuine persona teachings (no deliverable ask) are still captured', () => {
    [
      '你是我的专属助手',
      '你叫小爱同学',
      '你是一个善于总结的人',          // contains 总结 but no request marker
      '你是一个善于帮人分析问题的助手', // 帮人 (not 帮我) + no request marker
      '你是一个评论家',                 // 评论 as a noun, no marker
      '你是一个一丝不苟的检查员',
      '你的角色是技术顾问',
    ].forEach(isPersona);
  });

  test('non-persona targets are unaffected by the persona-only veto', () => {
    // a red line that happens to mention an evaluative verb stays a principle
    assert.equal(detectTeaching('绝不要在没有评审前合并代码').target, 'principles');
    assert.equal(detectTeaching('以后回答都用中文').target, 'memory');
  });
});

describe('looksLikeRoleFramedRequest — direct unit behavior', () => {
  test('true for explicit deliverable requests', () => {
    assert.equal(looksLikeRoleFramedRequest('请对这个项目做一个公正的评价'), true);
    assert.equal(looksLikeRoleFramedRequest('麻烦你分析一下这段代码'), true);
    assert.equal(looksLikeRoleFramedRequest('给出一份竞品分析报告'), true);
    assert.equal(looksLikeRoleFramedRequest('please give a fair evaluation'), true);
  });

  test('false for trait/identity statements with no request', () => {
    assert.equal(looksLikeRoleFramedRequest('你是一个善于总结的人'), false);
    assert.equal(looksLikeRoleFramedRequest('你是我的专属助手'), false);
    assert.equal(looksLikeRoleFramedRequest('你是一个善于帮人分析问题的助手'), false);
    assert.equal(looksLikeRoleFramedRequest(''), false);
  });
});
