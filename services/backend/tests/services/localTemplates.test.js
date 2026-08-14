'use strict';

/**
 * localTemplates.test.js (node:test)
 *
 * Goal "提供一些常见任务的模板": verifies the model-free template library that
 * lets local mode hand users a ready-to-fill skeleton for common writing tasks
 * (周报/会议纪要/邮件/请假条/PRD/README/简历/commit/Bug报告/日计划).
 *
 * Detection rule under test: a template fires only when a topic keyword hits
 * AND the user signals intent ("…模板/格式/怎么写" OR a writing verb "写一份…").
 * Bare factual queries ("java是什么", "北京天气") must NOT trigger a template.
 */

const test = require('node:test');
const assert = require('node:assert');

const tpls = require('../../src/services/localTemplates');

test('detectTemplate: explicit "模板" intent + topic → matches', () => {
  assert.strictEqual(tpls.detectTemplate('周报模板'), 'weekly_report');
  assert.strictEqual(tpls.detectTemplate('请假条怎么写'), 'leave_request');
  assert.strictEqual(tpls.detectTemplate('简历模板'), 'resume');
  assert.strictEqual(tpls.detectTemplate('README 格式'), 'readme');
});

test('detectTemplate: writing-verb intent + topic → matches', () => {
  assert.strictEqual(tpls.detectTemplate('帮我写周报'), 'weekly_report');
  assert.strictEqual(tpls.detectTemplate('起草一封正式邮件'), 'email');
  assert.strictEqual(tpls.detectTemplate('帮我写一份会议纪要'), 'meeting_minutes');
  assert.strictEqual(tpls.detectTemplate('写一个 bug 报告'), 'bug_report');
});

test('detectTemplate: topic without intent → null (no false positive)', () => {
  // "周报" alone is not enough; needs template/write intent.
  assert.strictEqual(tpls.detectTemplate('周报'), null);
});

test('detectTemplate: factual / unrelated queries → null', () => {
  assert.strictEqual(tpls.detectTemplate('java是什么'), null);
  assert.strictEqual(tpls.detectTemplate('北京天气'), null);
  assert.strictEqual(tpls.detectTemplate('123 * 456'), null);
  assert.strictEqual(tpls.detectTemplate(''), null);
});

test('renderTemplate: produces skeleton with placeholders + guidance header', () => {
  const out = tpls.renderTemplate('weekly_report');
  assert.ok(out, 'should render');
  assert.ok(out.includes('周报'), 'mentions template label');
  assert.ok(out.includes('{{'), 'contains fill-in placeholders');
  assert.ok(out.includes('本地 · 无模型'), 'marks model-free origin');
});

test('renderTemplate: unknown id → null', () => {
  assert.strictEqual(tpls.renderTemplate('does_not_exist'), null);
});

test('tryTemplate: detect + render in one step', () => {
  const out = tpls.tryTemplate('帮我写请假条');
  assert.ok(out, 'should render for matched query');
  assert.ok(out.includes('请假条'));
  assert.strictEqual(tpls.tryTemplate('随便聊聊'), null);
});

test('listTemplates: exposes all 10 templates with id+label', () => {
  const list = tpls.listTemplates();
  assert.strictEqual(list.length, 10, 'expected 10 built-in templates');
  for (const t of list) {
    assert.ok(t.id && typeof t.id === 'string');
    assert.ok(t.label && typeof t.label === 'string');
  }
  const ids = list.map(t => t.id);
  for (const want of ['weekly_report', 'meeting_minutes', 'email', 'leave_request',
    'prd', 'readme', 'resume', 'commit_message', 'bug_report', 'daily_plan']) {
    assert.ok(ids.includes(want), `missing template: ${want}`);
  }
});

test('every template renders non-empty with fill-in placeholders', () => {
  // Placeholders are either {{…}} (most templates) or <…> (commit_message,
  // which follows the conventional-commits angle-bracket convention).
  const hasPlaceholder = (s) => s.includes('{{') || /<[^>\n]+>/.test(s);
  for (const t of tpls.TEMPLATES) {
    const body = t.render();
    assert.ok(typeof body === 'string' && body.length > 0, `${t.id} renders text`);
    assert.ok(hasPlaceholder(body), `${t.id} has placeholders`);
  }
});
