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
const tpls = require('../../src/services/localTemplates');
describe('Local Templates', () => {
  test('detectTemplate: explicit "模板" intent + topic → matches', () => {
    expect(tpls.detectTemplate('周报模板')).toBe('weekly_report');
    expect(tpls.detectTemplate('请假条怎么写')).toBe('leave_request');
    expect(tpls.detectTemplate('简历模板')).toBe('resume');
    expect(tpls.detectTemplate('README 格式')).toBe('readme');
  });
  
  test('detectTemplate: writing-verb intent + topic → matches', () => {
      expect(tpls.detectTemplate('帮我写周报')).toBe('weekly_report');
      expect(tpls.detectTemplate('起草一封正式邮件')).toBe('email');
      expect(tpls.detectTemplate('帮我写一份会议纪要')).toBe('meeting_minutes');
      expect(tpls.detectTemplate('写一个 bug 报告')).toBe('bug_report');
  });

  test('detectTemplate: topic without intent → null (no false positive)', () => {
      // "周报" alone is not enough; needs template/write intent.
      expect(tpls.detectTemplate('周报')).toBe(null);
  });

  test('detectTemplate: factual / unrelated queries → null', () => {
      expect(tpls.detectTemplate('java是什么')).toBe(null);
      expect(tpls.detectTemplate('北京天气')).toBe(null);
      expect(tpls.detectTemplate('123 * 456')).toBe(null);
      expect(tpls.detectTemplate('')).toBe(null);
  });

});
