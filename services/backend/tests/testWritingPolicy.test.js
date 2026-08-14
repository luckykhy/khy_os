'use strict';

/**
 * testWritingPolicy — 「教会 khyos 怎么给项目写测试」单一真源单元测试。
 *
 * 验证:
 *  - isEnabled 默认开、仅显式 falsy 关。
 *  - detectTestWritingIntent:写作动词 + 测试名词 → 命中;零假阳性(运行测试 / 测试一下功能 不命中)。
 *  - 题型细分 unit / integration / e2e / general。
 *  - buildTestWritingDirective:含七要素(对齐框架/测行为/成体系覆盖/确定性/有意义断言/跑出证据/诚实边界)。
 *  - routeTestWriting:门控开命中→有指令;门控关→空指令(字节回退)。
 *  - 绝不抛。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  isEnabled,
  detectTestWritingIntent,
  buildTestWritingDirective,
  routeTestWriting,
} = require('../src/services/testWritingPolicy');

const ON = { KHY_TEST_WRITING: '1' };
const OFF = { KHY_TEST_WRITING: 'off' };

describe('isEnabled — 默认开,仅显式 falsy 关', () => {
  test('无 env / 空 → 开', () => {
    assert.equal(isEnabled({}), true);
    assert.equal(isEnabled({ KHY_TEST_WRITING: '' }), true);
  });
  test('显式 falsy → 关', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
      assert.equal(isEnabled({ KHY_TEST_WRITING: v }), false, v);
    }
  });
});

describe('detectTestWritingIntent — 写作动词 + 测试名词,零假阳性', () => {
  test('命中:写/补/生成 + 测试/用例', () => {
    for (const s of [
      '给这个项目写些测试',
      '帮我给 utils.js 补充单元测试',
      '为这个函数写测试用例',
      'write tests for this module',
      '加一些集成测试',
      '生成测试覆盖',
    ]) {
      assert.equal(detectTestWritingIntent(s).shouldInject, true, s);
    }
  });
  test('不命中(零假阳性):无写作动词 / 非写测试意图', () => {
    for (const s of [
      '运行测试',
      '跑一下测试',
      'run the tests',
      '测试一下这个功能',          // 试用,不是写测试
      '帮我看看为什么测试失败了',    // 调试,不是写测试
      '今天天气不错',
      '解释一下这段代码',
    ]) {
      assert.equal(detectTestWritingIntent(s).shouldInject, false, s);
    }
  });
  test('题型细分', () => {
    assert.deepEqual(detectTestWritingIntent('写单元测试').kinds, ['unit']);
    assert.ok(detectTestWritingIntent('补充集成测试').kinds.includes('integration'));
    assert.ok(detectTestWritingIntent('加端到端测试').kinds.includes('e2e'));
    assert.deepEqual(detectTestWritingIntent('给项目写些测试').kinds, ['general']);
  });
  test('代码块/反引号内的内容被剥离,不参与识别', () => {
    // 纯代码块、外部无写测试意图 → 不命中
    assert.equal(detectTestWritingIntent('```\nwrite tests\n```').shouldInject, false);
  });
});

describe('buildTestWritingDirective — 协议七要素齐全', () => {
  const d = buildTestWritingDirective({ kinds: ['general'] });
  test('含 [SYSTEM:] 头与关键要素', () => {
    assert.ok(d.includes('[SYSTEM: 测试编写协议]'));
    assert.ok(d.includes('对齐项目约定'), '对齐框架');
    assert.ok(d.includes('测行为,不测实现'), '测行为非实现');
    assert.ok(d.includes('覆盖成体系'), '成体系覆盖');
    assert.ok(d.includes('边界值'));
    assert.ok(d.includes('错误与异常路径'));
    assert.ok(d.includes('确定性、隔离、可重复'), '确定性隔离');
    assert.ok(d.includes('flaky'));
    assert.ok(d.includes('断言要有意义'));
    assert.ok(d.includes('assert(true)'));
    assert.ok(d.includes('实际运行'), '跑出证据');
    assert.ok(d.includes('诚实边界'));
    assert.ok(d.includes('迁就'), '绝不为变绿迁就当前输出');
  });
  test('集成/端到端 → 追加跨组件接线提示;general 不追加', () => {
    const di = buildTestWritingDirective({ kinds: ['integration'] });
    assert.ok(di.includes('集成 / 端到端'));
    const dg = buildTestWritingDirective({ kinds: ['general'] });
    assert.ok(!dg.includes('集成 / 端到端'));
  });
  test('确定性:两次调用字节一致(无随机/时钟)', () => {
    assert.equal(buildTestWritingDirective({ kinds: ['general'] }), d);
  });
});

describe('routeTestWriting — 门控开命中,关字节回退', () => {
  test('门控开 + 命中 → 有指令', () => {
    const r = routeTestWriting({ text: '给项目写些测试', env: ON });
    assert.equal(r.shouldInject, true);
    assert.ok(r.directive.includes('[SYSTEM: 测试编写协议]'));
  });
  test('门控关 → 空指令(字节回退)', () => {
    const r = routeTestWriting({ text: '给项目写些测试', env: OFF });
    assert.equal(r.shouldInject, false);
    assert.equal(r.directive, '');
  });
  test('未命中 → 空指令', () => {
    const r = routeTestWriting({ text: '运行测试', env: ON });
    assert.equal(r.shouldInject, false);
    assert.equal(r.directive, '');
  });
});

describe('绝不抛 — fail-soft', () => {
  test('异常 / 缺参输入全部 doesNotThrow', () => {
    assert.doesNotThrow(() => isEnabled(null));
    assert.doesNotThrow(() => detectTestWritingIntent(null));
    assert.doesNotThrow(() => detectTestWritingIntent(undefined));
    assert.doesNotThrow(() => buildTestWritingDirective(undefined));
    assert.doesNotThrow(() => routeTestWriting({}));
    assert.doesNotThrow(() => routeTestWriting(undefined));
  });
});
