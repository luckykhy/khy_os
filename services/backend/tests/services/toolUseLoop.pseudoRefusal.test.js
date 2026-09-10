'use strict';
/**
 * toolUseLoop.pseudoRefusal.test.js — 伪成功拒绝检测（问题 #3）。
 *
 * 场景：工具已成功取回数据（如新闻正文），模型却回出自相矛盾的套话拒绝
 * （"你好，我无法给到相关内容。"）。`_looksLikeCannedRefusal` 必须识别中英文
 * 套话拒绝，又不能把"取回成功后的正常作答"或"普通失败说明"误判为拒绝。
 *
 * 零网络、零进程、纯函数断言。
 */
const { _looksLikeCannedRefusal } = require('../../src/services/toolUseLoop');
describe('_looksLikeCannedRefusal — 伪成功拒绝识别', () => {
});

describe('Tool Use Loop pseudo Refusal', () => {
  test('识别中文套话拒绝', () => {
        const refusals = [
          '你好，我无法给到相关内容。',
          '抱歉，我不能提供这些信息。',
          '很抱歉，我无法回答这个问题。',
          '作为一个AI语言模型，我无法访问实时新闻。',
          '不便提供相关内容。',
          '这超出了我的能力范围。',
        ];
        for (const t of refusals) {
          expect(_looksLikeCannedRefusal(t)).toBe(true);
        }
  });

  test('识别英文套话拒绝', () => {
        const refusals = [
          "I'm sorry, I can't help with that.",
          'As an AI, I am unable to provide this content.',
          "I cannot answer that question.",
          "I am just an AI and cannot access real-time data.",
        ];
        for (const t of refusals) {
          expect(_looksLikeCannedRefusal(t)).toBe(true);
        }
  });

  test('不把正常作答误判为拒绝', () => {
        const legit = [
          '今天的头条新闻：A股三大指数集体上涨，科技板块领涨……',
          'Here are today\'s top headlines: markets rallied on tech earnings.',
          '根据获取到的内容，主要事件如下：1）……2）……',
        ];
        for (const t of legit) {
          expect(_looksLikeCannedRefusal(t)).toBe(false);
        }
  });

  test('不把普通失败说明误判为拒绝', () => {
        // 真实的操作失败描述（含"失败"但不是套话拒绝）应放行给正常归因链路
        expect(_looksLikeCannedRefusal('操作失败：文件不存在 ENOENT')).toBe(false);
        expect(_looksLikeCannedRefusal('我无法确定具体的发布时间，但内容已取回如下：……')).toBe(false);
  });

  test('空值与超长文本安全返回', () => {
        expect(_looksLikeCannedRefusal('')).toBe(false);
        expect(_looksLikeCannedRefusal(null)).toBe(false);
        expect(_looksLikeCannedRefusal(undefined)).toBe(false);
        // 超长正文（>600 字符）不是套话拒绝 → 放行
        expect(_looksLikeCannedRefusal('内容'.repeat(400))).toBe(false);
  });

});
