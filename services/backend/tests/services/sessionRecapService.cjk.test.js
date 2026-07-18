'use strict';

/**
 * sessionRecapService.cjk.test.js — 服务层 CJK 合并契约(node:test)。
 *
 * 锁定 generateRecap 在中文会话下的端到端行为:决策/洞见/问句/文件四段非空(此前全空),
 * 且门 KHY_RECAP_CJK=off 逐字节回退到原英文行为(四段空)。这是「缺少了 recap」缺口
 * 的回归护栏 —— 命令在、接线全,但对 khy 中文会话产不出内容的真身。
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const SERVICE_PATH = require.resolve('../../src/services/sessionRecapService');
const CJK_PATH = require.resolve('../../src/services/sessionRecapCjk');

function freshService() {
  delete require.cache[SERVICE_PATH];
  delete require.cache[CJK_PATH];
  return require('../../src/services/sessionRecapService');
}

const CHINESE_SESSION = [
  { role: 'user', content: '帮我修复节点无法选择的问题，hysteria2 报未能启用' },
  { role: 'assistant', content: '我将创建一个纯叶子模块处理这个问题。根本原因是 CORE_REQUIRED_TYPES 只放行五种协议。重要:mihomo 原生支持 hysteria2。我已经创建了 proxyCoreConfigGen.js，并修复了白名单。' },
  { role: 'user', content: '那 tuic 呢？还有 wireguard 支持吗？' },
  { role: 'assistant', content: '决定采用 REQUIRED_FIELDS 扩展方案。我已经更新了 proxyUriParsers.js。注意:socks5 仍然诚实 unsupported。' },
];

afterEach(() => { delete process.env.KHY_RECAP_CJK; });

describe('sessionRecapService — CJK 会话端到端', () => {
  test('门开:四段均非空(缺口已修)', () => {
    process.env.KHY_RECAP_CJK = 'on';
    const svc = freshService();
    const r = svc.generateRecap(CHINESE_SESSION);
    assert.ok(r.sections.decisions.length > 0, 'decisions 应非空');
    assert.ok(r.sections.keyInsights.length > 0, 'keyInsights 应非空');
    assert.ok(r.sections.openQuestions.length > 0, 'openQuestions 应非空');
    assert.ok(r.sections.filesChanged.includes('proxyCoreConfigGen.js'), 'filesChanged 应含全角逗号后的文件');
    assert.ok(r.sections.filesChanged.includes('proxyUriParsers.js'), 'filesChanged 应含全角句号后的文件');
  });

  test('门关:逐字节回退到原英文行为(中文四段空)', () => {
    process.env.KHY_RECAP_CJK = 'off';
    const svc = freshService();
    const r = svc.generateRecap(CHINESE_SESSION);
    assert.deepEqual(r.sections.decisions, []);
    assert.deepEqual(r.sections.keyInsights, []);
    assert.deepEqual(r.sections.openQuestions, []);
    // 中文全角句号截断下,英文正则只捞行尾;proxyCoreConfigGen.js 被全角逗号截断故缺失
    assert.ok(!r.sections.filesChanged.includes('proxyCoreConfigGen.js'));
  });

  test('英文会话不受影响(union 加性)', () => {
    process.env.KHY_RECAP_CJK = 'on';
    const svc = freshService();
    const r = svc.generateRecap([
      { role: 'user', content: 'fix the proxy bug' },
      { role: 'assistant', content: "I'll create a helper module.\nThe root cause is the whitelist. Important: mihomo supports it." },
    ]);
    assert.ok(r.sections.decisions.some((d) => /create a helper/i.test(d)), JSON.stringify(r.sections.decisions));
    assert.ok(r.sections.keyInsights.length > 0);
  });

  test('空会话 → 不抛,sections 为 {}', () => {
    process.env.KHY_RECAP_CJK = 'on';
    const svc = freshService();
    const r = svc.generateRecap([]);
    assert.equal(r.turns, 0);
    assert.deepEqual(r.sections, {});
  });
});
