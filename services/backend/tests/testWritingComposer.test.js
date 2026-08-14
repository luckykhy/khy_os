'use strict';

/**
 * testWriting(e2e)—— 经真 directiveComposer + routeTestWriting 验证「写测试」协议端到端注入。
 *
 * 复刻 ai.js 三缝中的整合层一段:routeTestWriting 产出指令 → 作为 {key:'testWriting'} 进
 * composeDirectives(protocol tier)。验证:
 *  - 门控开 + 命中:指令进入整合结果,协调头(多 protocol 时)列出「测试编写协议」label。
 *  - 门控关:routeTestWriting 返空 → 该 entry 为空 → 整合结果不含测试协议(字节回退)。
 *  - 与既有 protocol(mathSolve)同在时,两者都在 protocol tier、guard 仍在最前。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { routeTestWriting } = require('../src/services/testWritingPolicy');
const { composeDirectives, DIRECTIVE_REGISTRY } = require('../src/services/directiveComposer');

const ON = { KHY_TEST_WRITING: '1' };
const OFF = { KHY_TEST_WRITING: 'off' };

describe('testWriting 经 directiveComposer 端到端', () => {
  test('注册表已知 testWriting 为 protocol tier', () => {
    assert.ok(DIRECTIVE_REGISTRY.testWriting, 'testWriting 应在注册表');
    assert.equal(DIRECTIVE_REGISTRY.testWriting.tier, 'protocol');
  });

  test('门控开 + 命中 → 指令进入整合结果', () => {
    const tw = routeTestWriting({ text: '给这个项目写些单元测试', env: ON });
    assert.ok(tw.directive);
    const out = composeDirectives({
      entries: [{ key: 'testWriting', directive: tw.directive }],
      options: {},
    });
    assert.ok(out.includes('[SYSTEM: 测试编写协议]'), out.slice(0, 120));
    assert.ok(out.includes('对齐项目约定'));
  });

  test('多 protocol 同在 → 协调头列出测试编写协议 label', () => {
    const tw = routeTestWriting({ text: '给项目补单元测试', env: ON });
    const out = composeDirectives({
      entries: [
        { key: 'mathSolve', directive: '[SYSTEM: 数学解题协议]\n...' },
        { key: 'testWriting', directive: tw.directive },
      ],
      options: {},
    });
    // 协调头取自注册表 label
    assert.ok(out.includes('测试编写协议'), '协调头应含测试编写协议 label');
    assert.ok(out.includes('[SYSTEM: 测试编写协议]'));
  });

  test('门控关 → routeTestWriting 返空 → 整合结果不含测试协议(字节回退)', () => {
    const tw = routeTestWriting({ text: '给这个项目写些单元测试', env: OFF });
    assert.equal(tw.directive, '');
    const out = composeDirectives({
      entries: [{ key: 'testWriting', directive: tw.directive }],
      options: {},
    });
    assert.ok(!out.includes('测试编写协议'), '门控关不应出现测试协议');
  });

  test('普通对话(无写测试意图)→ 不注入', () => {
    const tw = routeTestWriting({ text: '帮我解释一下这段代码', env: ON });
    assert.equal(tw.directive, '');
  });
});
