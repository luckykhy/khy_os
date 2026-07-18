'use strict';

/**
 * intentCoverage.test.js — 「答得没接住意图」收尾回核纯模块单测。
 *
 * 守护(零假阳性是第一铁律):
 *  - 引用字面 / 文件路径 / 代码标识符被点名却在回复里彻底沉默 → 追问一次。
 *  - 同样诉求在回复或"已接住上下文"(已改文件名)里出现 → 绝不追问。
 *  - 泛词(README/config 等裸名)、无具体锚点、反问澄清 → 绝不追问。
 *  - buildIntentCoverageNudge 精确点名缺口,空输入产空串。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  assessIntentCoverage,
  buildIntentCoverageNudge,
  _checkableFromText,
  _looksLikeClarification,
} = require('../../src/services/intentCoverage');

describe('assessIntentCoverage — 文件路径锚点', () => {
  test('点名的文件在回复里只字不提 → 追问', () => {
    const r = assessIntentCoverage({
      rawMessage: '帮我修复 src/login.js 的登录 bug',
      reply: '我已经修好了登录流程，现在应该没问题了。',
    });
    assert.equal(r.shouldNudge, true);
    assert.ok(r.missing.some((m) => /login\.js/.test(m.keys.join('|'))));
  });

  test('回复按基名提到该文件 → 不追问', () => {
    const r = assessIntentCoverage({
      rawMessage: '帮我修复 src/login.js 的登录 bug',
      reply: '我改了 login.js 里的校验逻辑，登录已恢复。',
    });
    assert.equal(r.shouldNudge, false);
  });

  test('已修改文件名(工具落地)抵消 prose 未回显 → 不追问', () => {
    const r = assessIntentCoverage({
      rawMessage: '把 config.json 的端口改掉',
      reply: '端口已经改好了。',
      extraCoveredText: 'config.json',
    });
    assert.equal(r.shouldNudge, false);
  });
});

describe('assessIntentCoverage — 引用字面锚点', () => {
  test('用户引用的文案在回复里缺失 → 追问', () => {
    const r = assessIntentCoverage({
      rawMessage: '把按钮文案改成「立即体验」',
      reply: '我已经更新了按钮的显示文字。',
    });
    assert.equal(r.shouldNudge, true);
    assert.ok(r.missing.some((m) => m.keys.includes('立即体验')));
  });

  test('回复回显了引用文案 → 不追问', () => {
    const r = assessIntentCoverage({
      rawMessage: '把按钮文案改成「立即体验」',
      reply: '已把按钮文案改成「立即体验」。',
    });
    assert.equal(r.shouldNudge, false);
  });
});

describe('assessIntentCoverage — 代码标识符锚点', () => {
  test('点名的 camelCase 标识符缺失 → 追问', () => {
    const r = assessIntentCoverage({
      rawMessage: '看下 parseUserConfig 为什么返回空',
      reply: '配置解析那块逻辑有个边界问题，已经处理。',
    });
    assert.equal(r.shouldNudge, true);
  });

  test('裸小写英文词不算代码标识符,不据此追问', () => {
    const r = assessIntentCoverage({
      rawMessage: '帮我写个 report',
      reply: '好的，我来安排。',
    });
    assert.equal(r.shouldNudge, false);
  });
});

describe('assessIntentCoverage — 尾随子请求(另外/还有)', () => {
  test('尾随子句里点名的文件被漏掉 → 追问', () => {
    const r = assessIntentCoverage({
      rawMessage: '修复登录，另外把 package.json 的版本号也升一下',
      tailDetails: ['另外把 package.json 的版本号也升一下'],
      reply: '登录已经修好了。',
    });
    assert.equal(r.shouldNudge, true);
    assert.ok(r.missing.some((m) => /package\.json/.test(m.keys.join('|'))));
  });
});

describe('assessIntentCoverage — 零假阳性边界', () => {
  test('裸泛名(README/config)不构成可检诉求 → 不追问', () => {
    const r = assessIntentCoverage({
      rawMessage: '更新一下 README 和 config',
      reply: '好的，已经看过了。',
    });
    assert.equal(r.shouldNudge, false);
    assert.equal(r.checked, 0);
  });

  test('回复是反问/澄清 → 绝不追问', () => {
    const r = assessIntentCoverage({
      rawMessage: '改 src/login.js',
      reply: '你是想改登录校验还是会话保持？',
    });
    assert.equal(r.shouldNudge, false);
  });

  test('无具体锚点的普通对话 → 不追问', () => {
    const r = assessIntentCoverage({ rawMessage: '今天过得怎么样', reply: '挺好的，谢谢。' });
    assert.equal(r.shouldNudge, false);
  });

  test('空回复 / 空输入 → 不追问', () => {
    assert.equal(assessIntentCoverage({ rawMessage: '改 a.js', reply: '' }).shouldNudge, false);
    assert.equal(assessIntentCoverage({}).shouldNudge, false);
    assert.equal(assessIntentCoverage(null).shouldNudge, false);
  });
});

describe('_checkableFromText — 抽取精度', () => {
  test('只抽路径/引用/代码标识符,过滤泛词', () => {
    const reqs = _checkableFromText('修复 src/auth.js 的 parseToken，文案改成「成功」，顺便看下 config');
    const flat = reqs.flatMap((r) => r.keys);
    assert.ok(flat.includes('src/auth.js'));
    assert.ok(flat.includes('auth.js'));
    assert.ok(flat.includes('parsetoken'));
    assert.ok(flat.includes('成功'));
    assert.ok(!flat.includes('config')); // 泛词被过滤
  });
});

describe('_looksLikeClarification', () => {
  test('问号结尾 / 澄清措辞 → true;陈述句 → false', () => {
    assert.equal(_looksLikeClarification('你是想改哪个文件？'), true);
    assert.equal(_looksLikeClarification('Could you clarify which one?'), true);
    assert.equal(_looksLikeClarification('我已经改好了。'), false);
  });
});

describe('buildIntentCoverageNudge', () => {
  test('精确点名缺口', () => {
    const msg = buildIntentCoverageNudge([{ label: 'package.json', keys: ['package.json'] }]);
    assert.match(msg, /package\.json/);
    assert.match(msg, /没接住|没提到/);
  });

  test('空输入 → 空串', () => {
    assert.equal(buildIntentCoverageNudge([]), '');
    assert.equal(buildIntentCoverageNudge(null), '');
  });
});
