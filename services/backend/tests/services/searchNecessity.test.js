'use strict';

/**
 * searchNecessity.test.js — 「该不该联网搜索」单一真源纯模块单测。
 *
 * 守护(goal 2026-06-26「有的任务模型知识库就可以回答的,不一定要搜索,可以不搜」):
 *   1. 三档判定 need ∈ required | optional | skip,确定性、绝不抛。
 *   2. 时效零漏判:任何时效 / 实时 / 显式联网信号 → required,即便同时含「解释一下」。
 *   3. skip:稳定知识 / 写代码 / 算数 / 翻译 / 创作,且无任何时效信号。
 *   4. optional:拿不准 → 不注入(directiveKind=null,系统提示词字节不变)。
 *   5. env 门控 KHY_SEARCH_NECESSITY 默认开,显式 0/false/off 关闭后退化为空指令。
 *   6. routeSearchNecessity:媒体输入不参与该判定。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

// 门控经函数入参 { env } 注入,无需重载模块缓存。
const sn = require('../../src/services/search/searchNecessity');

describe('1. 门控', () => {
  test('默认开', () => {
    assert.equal(sn.isEnabled({}), true);
    assert.equal(sn.isEnabled(undefined), true);
  });
  test('显式 0/false/off 关闭', () => {
    for (const v of ['0', 'false', 'off']) {
      assert.equal(sn.isEnabled({ KHY_SEARCH_NECESSITY: v }), false, v);
    }
  });
  test('关闭后 assess 返回 optional/null,route 返回空指令', () => {
    const env = { KHY_SEARCH_NECESSITY: '0' };
    const a = sn.assessSearchNeed('什么是闭包', { env });
    assert.equal(a.need, 'optional');
    assert.equal(a.directiveKind, null);
    const r = sn.routeSearchNecessity({ text: '今天的金价', env });
    assert.equal(r.directive, '');
    assert.equal(r.assessment, null);
  });
});

describe('2. required — 时效 / 实时 / 显式联网(零漏判)', () => {
  test('显式联网请求', () => {
    for (const q of ['帮我搜索一下 Node 22', '查一下这个报错', '联网看看', 'search for the latest react', 'look it up']) {
      const a = sn.assessSearchNeed(q);
      assert.equal(a.need, 'required', q);
      assert.equal(a.directiveKind, 'required', q);
    }
  });
  test('实时状态', () => {
    for (const q of ['600519 的股价', '今天的天气', '美元汇率是多少', 'live score of the match']) {
      assert.equal(sn.assessSearchNeed(q).need, 'required', q);
    }
  });
  test('时效窗口(复用 searchFreshness)', () => {
    const a = sn.assessSearchNeed('最新的 Node.js 版本');
    assert.equal(a.need, 'required');
    assert.ok(a.freshness, '应带 freshness 窗口');
  });
  test('零漏判:时效信号优先压过「解释一下」', () => {
    const a = sn.assessSearchNeed('解释一下今天股市为什么大跌');
    assert.equal(a.need, 'required', '含时效/实时信号即便有「解释一下」也必须 required');
  });
});

describe('3. skip — 知识库可答', () => {
  test('稳定知识', () => {
    for (const q of ['什么是闭包', '解释一下 TCP 三次握手', 'JS 的原型链原理', 'what is a monad', 'why is the sky blue']) {
      const a = sn.assessSearchNeed(q);
      assert.equal(a.need, 'skip', q);
      assert.equal(a.directiveKind, 'skip', q);
    }
  });
  test('写代码 / 调试', () => {
    for (const q of ['帮我写一段快排代码', '重构这个函数', 'implement a binary search', 'write a function to reverse a string']) {
      assert.equal(sn.assessSearchNeed(q).need, 'skip', q);
    }
  });
  test('翻译 / 计算 / 创作', () => {
    for (const q of ['把这句翻译成英文', '帮我算一下 23*47', '写一首关于秋天的诗', 'brainstorm names for a cat']) {
      assert.equal(sn.assessSearchNeed(q).need, 'skip', q);
    }
  });
});

describe('4. optional — 拿不准', () => {
  test('既非时效也非明确知识库任务 → optional/null', () => {
    for (const q of ['张三这个人怎么样', '这家公司靠谱吗', '帮我看看这个']) {
      const a = sn.assessSearchNeed(q);
      assert.equal(a.need, 'optional', q);
      assert.equal(a.directiveKind, null, q);
    }
  });
  test('空 / 空白 → optional', () => {
    assert.equal(sn.assessSearchNeed('').need, 'optional');
    assert.equal(sn.assessSearchNeed('   ').need, 'optional');
    assert.equal(sn.assessSearchNeed(null).need, 'optional');
  });
});

describe('5. buildNecessityDirective 措辞', () => {
  test('skip 指令引导优先知识库直接作答', () => {
    const a = sn.assessSearchNeed('什么是闭包');
    const d = sn.buildNecessityDirective(a);
    assert.match(d, /搜索必要性/);
    assert.match(d, /不要贸然联网|直接回答|直接作答/);
  });
  test('required 指令引导先搜再答 + 传 freshness', () => {
    const a = sn.assessSearchNeed('最新的 Node.js 版本');
    const d = sn.buildNecessityDirective(a);
    assert.match(d, /WebSearch/);
    assert.match(d, /freshness/);
  });
  test('optional → 空串(系统提示词字节不变)', () => {
    const a = sn.assessSearchNeed('张三这个人怎么样');
    assert.equal(sn.buildNecessityDirective(a), '');
  });
});

describe('6. routeSearchNecessity', () => {
  test('媒体输入不参与判定 → 空指令', () => {
    const r = sn.routeSearchNecessity({ text: '今天的金价', hasMedia: true });
    assert.equal(r.directive, '');
    assert.equal(r.assessment, null);
  });
  test('skip 任务产出 skip 指令 + assessment', () => {
    const r = sn.routeSearchNecessity({ text: '什么是闭包' });
    assert.ok(r.directive);
    assert.equal(r.assessment.directiveKind, 'skip');
  });
  test('required 任务产出 required 指令', () => {
    const r = sn.routeSearchNecessity({ text: '最新的显卡价格' });
    assert.ok(r.directive);
    assert.equal(r.assessment.need, 'required');
  });
  test('optional 任务 → 空指令但 assessment 非空', () => {
    const r = sn.routeSearchNecessity({ text: '张三这个人怎么样' });
    assert.equal(r.directive, '');
    assert.equal(r.assessment.need, 'optional');
  });
});
