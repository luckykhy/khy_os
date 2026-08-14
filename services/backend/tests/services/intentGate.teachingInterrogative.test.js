'use strict';

/**
 * intentGate.teachingInterrogative.test.js — anti-hijack guard (node:test).
 *
 * Goal "教学意图误判劫持闲聊疑问": a QUESTION about the model
 * ("你是小米开发的模型吗") was hijacked by the teaching-intent gate because
 * TEACH_PERSONA_RE matched any sentence starting with "你是…", ignoring
 * interrogative form. The fix adds a two-tier interrogative guard:
 *   STRONG (?/？, sentence-final 吗/呢/吧, A-not-A, 是否) vetoes any target;
 *   WH (什么/谁/哪/为什么…) vetoes only the PERSONA target.
 *
 * The hard constraint — a genuine DECLARATIVE teach ("你叫小爱同学") must NOT be
 * dropped — is pinned alongside, so the balance between anti-misfire and
 * intent-recognition is locked.
 *
 * jest covers the same matrix in intentGate.teaching.test.js (CI only); this
 * mirror runs under the local node:test runner.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { detectTeaching, looksInterrogative } = require('../../src/services/intentGate');

const notTeaching = (t) =>
  assert.equal(detectTeaching(t).isTeaching, false, `should route to chat (not teaching): ${t}`);
const isTeaching = (t, target) => {
  const d = detectTeaching(t);
  assert.equal(d.isTeaching, true, `should be teaching: ${t}`);
  if (target) assert.equal(d.target, target, `${t} → target ${d.target} != ${target}`);
};

describe('detectTeaching — interrogative anti-hijack', () => {
  test('yes/no questions about the model route to chat', () => {
    [
      '你是小米开发的模型吗',
      '你是小米开发的模型吗？',
      '你是 Claude 吗?',
      '你是不是 GPT-4',
      '你是否支持中文',
      '你应该是哪个版本呢',
    ].forEach(notTeaching);
  });

  test('wh-questions about the model persona route to chat', () => {
    ['你是什么模型', '你是谁', '你是哪家公司的', '你叫什么名字', '你的角色是什么？'].forEach(notTeaching);
  });

  test('declarative / imperative teaching is still captured (no over-exclusion)', () => {
    isTeaching('你叫小爱同学', 'persona'); // hard-constraint example
    isTeaching('你是我的专属助手', 'persona');
    isTeaching('你的名字是小冰', 'persona');
    isTeaching('你是一个严谨的法务助手', 'persona');
    isTeaching('记住你是小米模型');
  });

  test('a wh-word inside a real red-line rule does not veto teaching', () => {
    isTeaching('绝不要问我为什么', 'principles');
  });

  test('task verbs still win over teaching keywords', () => {
    notTeaching('帮我写一个登录页面');
    notTeaching('帮我写一个脚本，以后每天跑一次');
  });
});

describe('looksInterrogative — tier behavior', () => {
  test('STRONG markers veto any target', () => {
    assert.equal(looksInterrogative('随便一句吗', 'memory'), true);
    assert.equal(looksInterrogative('这样行不行？', 'principles'), true);
    assert.equal(looksInterrogative('是不是这样', 'principles'), true);
  });

  test('WH words veto only the persona target', () => {
    assert.equal(looksInterrogative('你是什么模型', 'persona'), true);
    assert.equal(looksInterrogative('绝不要问我为什么', 'principles'), false);
    assert.equal(looksInterrogative('绝不要问我为什么', 'memory'), false);
  });

  test('plain declaratives are not interrogative', () => {
    assert.equal(looksInterrogative('你叫小爱同学', 'persona'), false);
    assert.equal(looksInterrogative('以后用中文', 'memory'), false);
  });
});
