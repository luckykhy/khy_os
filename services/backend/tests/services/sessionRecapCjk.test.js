'use strict';

/**
 * sessionRecapCjk.test.js — 会话回顾 CJK 抽取纯叶子契约(node:test)。
 *
 * 背景:`/recap` 命令在、接线全,但抽取器全英文正则,对 khy 中文会话产不出
 * decisions/insights/questions,文件名还被全角标点截断。本叶子补 CJK 抽取,与英文侧
 * 加性合并。本测锁定:CJK 决策/洞见/问句/文件抽取产出、含子去重、CJK 标点边界、
 * 门控关字节回退(全空)、绝不抛。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('../../src/services/sessionRecapCjk');

const ON = { KHY_RECAP_CJK: 'on' };
const OFF = { KHY_RECAP_CJK: 'off' };

function a(content) { return { role: 'assistant', content }; }
function u(content) { return { role: 'user', content }; }

describe('sessionRecapCjk — 决策抽取', () => {
  test('中文决策词干被抽取', () => {
    const out = leaf.extractCjkDecisions([a('我将创建一个纯叶子模块处理这个问题。')], ON);
    assert.ok(out.some((d) => d.includes('创建一个纯叶子模块')), JSON.stringify(out));
  });

  test('全角逗号作为片段右边界', () => {
    const out = leaf.extractCjkDecisions([a('我已经创建了 proxyCoreConfigGen.js，并修复了白名单。')], ON);
    // 应切在全角逗号处,不吞掉「并修复了白名单」
    assert.ok(out.some((d) => d.includes('proxyCoreConfigGen.js') && !d.includes('白名单')), JSON.stringify(out));
  });

  test('含子去重:同句多词干只留最完整者', () => {
    // 「我已经创建了 X」既中「我已」又中「创建」;只应留最长片段一次。
    const out = leaf.extractCjkDecisions([a('我已经创建了 proxyUriParsers.js。')], ON);
    const containingCreate = out.filter((d) => d.includes('proxyUriParsers.js'));
    assert.equal(containingCreate.length, 1, JSON.stringify(out));
  });

  test('决策上限 10', () => {
    const msgs = [];
    for (let i = 0; i < 20; i += 1) msgs.push(a(`我修复了问题编号${i}的具体细节内容。`));
    const out = leaf.extractCjkDecisions(msgs, ON);
    assert.ok(out.length <= 10);
  });
});

describe('sessionRecapCjk — 洞见抽取', () => {
  test('根因/重要 前缀被抽取', () => {
    const out = leaf.extractCjkInsights([a('重要:mihomo 原生支持 hysteria2。根本原因是白名单只放行五种协议。')], ON);
    assert.ok(out.some((i) => i.includes('mihomo 原生支持')), JSON.stringify(out));
    assert.ok(out.some((i) => i.includes('白名单只放行五种协议')), JSON.stringify(out));
  });

  test('洞见含子去重:根本原因 吞并 原因', () => {
    const out = leaf.extractCjkInsights([a('根本原因是配置损坏导致启动失败。')], ON);
    const hits = out.filter((i) => i.includes('配置损坏'));
    assert.equal(hits.length, 1, JSON.stringify(out));
  });

  test('洞见上限 5', () => {
    const msgs = [];
    for (let i = 0; i < 12; i += 1) msgs.push(a(`重要:第${i}条关键事实的详细描述内容在此。`));
    const out = leaf.extractCjkInsights(msgs, ON);
    assert.ok(out.length <= 5);
  });
});

describe('sessionRecapCjk — 中文问句抽取', () => {
  test('全角问号句被抽取', () => {
    const out = leaf.extractCjkQuestions([u('那 tuic 呢？还有 wireguard 支持吗？')], ON);
    assert.ok(out.some((q) => q.includes('tuic')), JSON.stringify(out));
    assert.ok(out.some((q) => q.includes('wireguard')), JSON.stringify(out));
  });

  test('只取最近若干条消息', () => {
    const msgs = [];
    for (let i = 0; i < 10; i += 1) msgs.push(u(`历史问题编号${i}是什么情况呢？`));
    const out = leaf.extractCjkQuestions(msgs, ON);
    // 最近 6 条窗口 + 上限 5
    assert.ok(out.length <= 5);
  });

  test('无问号 → 不误抽', () => {
    const out = leaf.extractCjkQuestions([u('这是一个陈述句没有疑问。')], ON);
    assert.deepEqual(out, []);
  });
});

describe('sessionRecapCjk — CJK 标点感知文件抽取', () => {
  test('全角句号后的文件名被抓到', () => {
    const out = leaf.extractCjkFileReferences([a('我修改了 proxyUriParsers.js。然后更新了 router.js')], ON);
    assert.ok(out.includes('proxyUriParsers.js'), JSON.stringify(out));
    assert.ok(out.includes('router.js'), JSON.stringify(out));
  });

  test('全角逗号/分号边界', () => {
    const out = leaf.extractCjkFileReferences([a('改了 a.js，又改了 b.js；还有 c.js。')], ON);
    assert.ok(['a.js', 'b.js', 'c.js'].every((f) => out.includes(f)), JSON.stringify(out));
  });

  test('域名假阳性被过滤', () => {
    const out = leaf.extractCjkFileReferences([a('访问 example.com。参考 github.io。')], ON);
    assert.ok(!out.includes('example.com'));
    assert.ok(!out.includes('github.io'));
  });

  test('去重', () => {
    const out = leaf.extractCjkFileReferences([a('改了 x.js。又改了 x.js。')], ON);
    assert.equal(out.filter((f) => f === 'x.js').length, 1);
  });
});

describe('sessionRecapCjk — 门控字节回退', () => {
  test('KHY_RECAP_CJK=off → 全部返回空', () => {
    const msgs = [a('我将创建 x.js。重要:根因是配置。'), u('好用吗？')];
    assert.deepEqual(leaf.extractCjkDecisions(msgs, OFF), []);
    assert.deepEqual(leaf.extractCjkInsights(msgs, OFF), []);
    assert.deepEqual(leaf.extractCjkQuestions(msgs, OFF), []);
    assert.deepEqual(leaf.extractCjkFileReferences(msgs, OFF), []);
  });

  test('_cjkEnabled 默认开(空/未设)', () => {
    assert.equal(leaf._cjkEnabled({}), true);
    assert.equal(leaf._cjkEnabled({ KHY_RECAP_CJK: '' }), true);
    assert.equal(leaf._cjkEnabled({ KHY_RECAP_CJK: '0' }), false);
    assert.equal(leaf._cjkEnabled({ KHY_RECAP_CJK: 'false' }), false);
  });
});

describe('sessionRecapCjk — 绝不抛(fail-soft)', () => {
  test('坏输入 → 空数组', () => {
    assert.deepEqual(leaf.extractCjkDecisions(null, ON), []);
    assert.deepEqual(leaf.extractCjkInsights(undefined, ON), []);
    assert.deepEqual(leaf.extractCjkQuestions('not-array', ON), []);
    assert.deepEqual(leaf.extractCjkFileReferences(42, ON), []);
  });

  test('消息 content 缺失 → 不抛', () => {
    const msgs = [{ role: 'assistant' }, { role: 'user', content: null }];
    assert.deepEqual(leaf.extractCjkDecisions(msgs, ON), []);
    assert.deepEqual(leaf.extractCjkFileReferences(msgs, ON), []);
  });
});
