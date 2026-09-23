'use strict';

/**
 * toolCapabilityFalsenegRegression.test.js — BUG-014 的回归护栏。
 *
 * 缺陷:工具调用能力的负向裁决('text')不要求任何正面证据 —— 「成功回了文字、没回
 * tool_calls」即定罪。现场产出 `gpt-4o → text` 这类假阴性;而一旦定罪,剥离门会从每个
 * 后续请求里删掉 tools,模型再也无法用原生调用证明自己,该误判无法被现实推翻(只有
 * 7 天 TTL 到期才重测)。用户可见后果:界面提示「模型不支持工具调用…请切换到支持
 * function calling 的模型」,而工具其实仍在通过文本协议正常执行。
 *
 * 本文件把四件事钉在一起(纯离线,不发网络请求):
 *   1. 「无定论」不得定罪 —— 散文 / 截断 / 自述不会调用工具;
 *   2. 「确证」必须定罪 —— 正文里出现显式调用语法,且判据用与运行时同一个解析器;
 *   3. 「通道拒绝 tools」与「模型不支持」分开 —— A/B 对照组;
 *   4. 用户可见文案不再把内部判定缺陷说成用户的模型选择问题。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const probe = require('../../../src/services/gateway/toolCallingProbe');
const cap = require('../../../src/services/gateway/modelToolingCapability');
const { hasExplicitToolCallSyntax } = require('../../../src/services/tool/toolCallParser');

// 生产接线:verifyToolCalling 注入的正是这一个函数(单一真源,防方言漂移)。
const OPTS = { hasExplicitToolCallSyntax };

describe('1. 无定论不得定罪（回归:旧实现全部判 text）', () => {
  const inconclusive = [
    ['回了散文、没有 tool_calls', { success: true, content: 'Sure, I can help with that.' }],
    ['被 max_tokens 截断', { success: true, content: 'I will now call the tool', finishReason: 'length' }],
    ['模型自述不会调用工具', { success: true, content: 'I cannot call tools, here is text.' }],
    ['内容被上游过滤', { success: true, content: 'x', finishReason: 'content_filter' }],
    ['空响应', { success: true, content: '' }],
  ];
  for (const [name, result] of inconclusive) {
    test(name + ' → unknown（不落库,留待重测）', () => {
      const r = probe.interpretProbeResult(result, OPTS);
      assert.equal(r.verdict, 'unknown', `${name} 不得被判成不支持`);
    });
  }
});

describe('2. 确证必须定罪（只有显式调用语法才算证据）', () => {
  test('正文把调用写成 <tool_call> 文本 → text', () => {
    const r = probe.interpretProbeResult(
      {
        success: true,
        content: '<tool_call>{"name":"khy_probe_echo","arguments":{"ok":"yes"}}</tool_call>',
      },
      OPTS
    );
    assert.equal(r.verdict, 'text');
    assert.equal(r.reason, 'text_tool_call_syntax');
  });

  test('模型自述「不会调用工具」不算证据 —— 自述不是能力事实', () => {
    const r = probe.interpretProbeResult(
      { success: true, content: 'I do not support function calling, sorry.' },
      OPTS
    );
    assert.equal(r.verdict, 'unknown');
  });
});

describe('3. 通道问题与模型问题分开（A/B 对照组）', () => {
  test('带 tools 失败、去掉 tools 成功 → route-rejects-tools（通道属性）', () => {
    const r = probe.interpretProbePair(
      {
        a: { success: false, error: 'HTTP 400 Unrecognized chat message' },
        b: { success: true, content: 'ok' },
      },
      OPTS
    );
    assert.equal(r.verdict, 'route-rejects-tools');
  });

  test('两侧都失败 → unknown（不据单侧失败给模型定罪）', () => {
    assert.equal(
      probe.interpretProbePair({ a: { success: false }, b: { success: false } }, OPTS).verdict,
      'unknown'
    );
  });

  test('对照组只在需要时跑（A 有结论或 A 无定论时不浪费请求）', () => {
    assert.equal(probe.needsControlGroup({ toolUseBlocks: [{}] }, OPTS), false);
    assert.equal(probe.needsControlGroup({ success: true, content: 'prose' }, OPTS), false);
    assert.equal(probe.needsControlGroup({ success: false }, OPTS), true);
  });
});

describe('4. 逃生舱与文案（P0）', () => {
  test('env 强制原生对路由 id 形态同样生效 —— 教学门与剥离门同键', () => {
    const env = { KHY_NATIVE_TOOL_MODELS: 'agnes-3.0-flash' };
    assert.equal(cap.modelLacksReliableToolCalling('api:agnes:agnes-3.0-flash', { env }), false);
  });

  test('剥离说明不再引导用户换模型,并给出复测入口', () => {
    const s = cap.stripToolsNotice('agnes-3.0-flash');
    assert.match(s, /工具仍可用/);
    assert.match(s, /probe-tools/);
    assert.doesNotMatch(s, /切换到支持/);
  });
});

describe('5. P2：未知档一律先发,名字启发退出 wire 判定', () => {
  // 用户可见的现象(截图那条提示)由这一档翻转消除:未实测的 flash 模型不再开局就被剥离。
  test('未实测的 flash 模型不再被剥离（截图场景的直接回归）', () => {
    for (const m of ['agnes-3.0-flash', 'glm-4v-flash', 'step-3.5-flash', 'sensenova-6.8-flash-lite']) {
      assert.equal(
        cap.shouldStripUpstreamTools(m),
        false,
        `${m} 未实测时必须先发 tools —— 否则误判无法被现实推翻`
      );
    }
  });

  test('名字启发仍用于提示词侧（加性回退教学,与 wire 不冲突）', () => {
    assert.equal(cap.modelLacksReliableToolCalling('agnes-3.0-flash'), true);
    assert.equal(cap.shouldStripUpstreamTools('agnes-3.0-flash'), false);
  });

  test('正面证据仍然生效（实测 text / 通道拒收 / env 钉子）', () => {
    assert.equal(cap.shouldStripUpstreamTools('gpt-4o', { measured: 'text' }), true);
    assert.equal(cap.shouldStripUpstreamTools('gpt-4o', { routeRejects: true }), true);
    assert.equal(
      cap.shouldStripUpstreamTools('gpt-4o', {
        env: { KHY_TEXT_ONLY_TOOL_MODELS: 'gpt-4o' },
        measured: 'native',
      }),
      true
    );
  });
});
