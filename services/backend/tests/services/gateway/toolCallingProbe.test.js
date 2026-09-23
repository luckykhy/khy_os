'use strict';

/**
 * toolCallingProbe.test.js — 实测工具调用能力的纯逻辑层不变量。
 * interpretProbeResult 三态裁决 + shouldReprobe(TTL) + 门控 + 规范化 + 绝不抛。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const probe = require('../../../src/services/gateway/toolCallingProbe');

describe('isEnabled — gate KHY_TOOL_CAP_PROBE (默认开)', () => {
  test('unset → ON', () => {
    assert.equal(probe.isEnabled({}), true);
  });
  test('falsy values → OFF', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF', '  false ', 'No']) {
      assert.equal(probe.isEnabled({ KHY_TOOL_CAP_PROBE: v }), false, `"${v}" should disable`);
    }
  });
  test('any other value → ON', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'whatever']) {
      assert.equal(probe.isEnabled({ KHY_TOOL_CAP_PROBE: v }), true);
    }
  });
});

describe('normalizeModel', () => {
  test('trims + lowercases', () => {
    assert.equal(probe.normalizeModel('  Agnes-2.0-Flash '), 'agnes-2.0-flash');
    assert.equal(probe.normalizeModel(null), '');
    assert.equal(probe.normalizeModel(undefined), '');
  });
});

describe('TRIVIAL_TOOL / PROBE_PROMPT — probe payload', () => {
  test('tool has a name + minimal schema', () => {
    assert.equal(probe.TRIVIAL_TOOL.name, 'khy_probe_echo');
    assert.equal(probe.TRIVIAL_TOOL.input_schema.type, 'object');
    assert.deepEqual(probe.TRIVIAL_TOOL.input_schema.required, ['ok']);
  });
  test('prompt instructs a tool call', () => {
    assert.match(probe.PROBE_PROMPT, /khy_probe_echo/);
  });
  test('prompt forbids preamble — 前言会吃光输出预算,把「没来得及生成」变成假的「没有调用」', () => {
    assert.match(probe.PROBE_PROMPT, /no prose|no preamble/i);
  });
});

describe('interpretProbeResult — 三态（2026-09-23 起负向裁决要求正面证据）', () => {
  // 判据注入:测试里用一个等价于 toolCallParser.hasExplicitToolCallSyntax 的最小子集,
  // 保持本文件对 tool 层零依赖(探测层是纯叶子)。真实解析器的区分力由
  // toolCallParser 自己的测试与 toolCallingProbe.explicitSyntax 的集成用例覆盖。
  const hasExplicitToolCallSyntax = (t) => /<tool_call>|<function=/i.test(String(t));

  test('native: toolUseBlocks present', () => {
    const r = probe.interpretProbeResult({ success: true, toolUseBlocks: [{ name: 'khy_probe_echo' }] });
    assert.equal(r.verdict, 'native');
  });
  test('native: finish_reason tool_calls (no blocks parsed)', () => {
    assert.equal(probe.interpretProbeResult({ success: true, finishReason: 'tool_calls' }).verdict, 'native');
    assert.equal(probe.interpretProbeResult({ stopReason: 'tool_use' }).verdict, 'native');
  });
  test('native: alt field names (toolCalls / tool_calls)', () => {
    assert.equal(probe.interpretProbeResult({ toolCalls: [{}] }).verdict, 'native');
    assert.equal(probe.interpretProbeResult({ tool_calls: [{}] }).verdict, 'native');
  });

  test('text: 正文含显式调用语法 → 确证走了文本通道', () => {
    const r = probe.interpretProbeResult(
      { success: true, content: '<tool_call>{"name":"khy_probe_echo"}</tool_call>' },
      { hasExplicitToolCallSyntax }
    );
    assert.equal(r.verdict, 'text');
    assert.equal(r.reason, 'text_tool_call_syntax');
  });

  // 以下三个用例是本次修订的核心:旧实现把它们判成 'text',于是「没看到」被当成「不支持」,
  // 产出 gpt-4o → text 这类假阴性,且因剥离门删掉 tools 而无法被现实推翻(BUG-014)。
  test('unknown: 只是回了散文 —— 证据的缺席,不是不支持的确证', () => {
    const r = probe.interpretProbeResult(
      { success: true, content: 'I cannot call tools, here is text.' },
      { hasExplicitToolCallSyntax }
    );
    assert.equal(r.verdict, 'unknown');
    assert.equal(r.reason, 'no_call_syntax_no_evidence');
  });
  test('unknown: content present without explicit success flag', () => {
    assert.equal(
      probe.interpretProbeResult({ content: 'hello' }, { hasExplicitToolCallSyntax }).verdict,
      'unknown'
    );
  });
  test('unknown: 输出被 max_tokens 截断 —— 缺 tool_calls 不携带能力信息', () => {
    const r = probe.interpretProbeResult(
      { success: true, content: 'I will now call the tool', finishReason: 'length' },
      { hasExplicitToolCallSyntax }
    );
    assert.equal(r.verdict, 'unknown');
    assert.equal(r.reason, 'truncated_before_tool_call');
  });
  test('unknown: 截断优先级高于正文判定（截断正文里即便有语法也不定罪）', () => {
    const r = probe.interpretProbeResult(
      { success: true, content: '<tool_call>{"name":"khy_pro', finishReason: 'max_tokens' },
      { hasExplicitToolCallSyntax }
    );
    assert.equal(r.verdict, 'unknown');
    assert.equal(r.reason, 'truncated_before_tool_call');
  });
  test('unknown: 内容被上游过滤', () => {
    const r = probe.interpretProbeResult(
      { success: true, content: 'x', finishReason: 'content_filter' },
      { hasExplicitToolCallSyntax }
    );
    assert.equal(r.verdict, 'unknown');
    assert.equal(r.reason, 'output_filtered');
  });
  test('fail-safe: 未注入判据时永不得出 text（宁可不下结论,不制造假阴性）', () => {
    const r = probe.interpretProbeResult({
      success: true,
      content: '<tool_call>{"name":"khy_probe_echo"}</tool_call>',
    });
    assert.equal(r.verdict, 'unknown');
    assert.equal(r.reason, 'no_call_syntax_no_evidence');
  });
  test('fail-safe: 判据抛异常时按「无结论」处理,不炸也不误判', () => {
    const boom = () => {
      throw new Error('predicate exploded');
    };
    const r = probe.interpretProbeResult(
      { success: true, content: '<tool_call>{}</tool_call>' },
      { hasExplicitToolCallSyntax: boom }
    );
    assert.equal(r.verdict, 'unknown');
  });
  test('unknown: thinking-only 结果同样按正文判定', () => {
    assert.equal(
      probe.interpretProbeResult({ success: true, thinking: '让我想想该怎么调用' }).verdict,
      'unknown'
    );
  });

  test('unknown: explicit failure', () => {
    assert.equal(probe.interpretProbeResult({ success: false, error: 'boom' }).verdict, 'unknown');
  });
  test('unknown: empty response', () => {
    assert.equal(probe.interpretProbeResult({ success: true, content: '' }).verdict, 'unknown');
    assert.equal(probe.interpretProbeResult({}).verdict, 'unknown');
  });
  test('never throws on junk', () => {
    for (const j of [null, undefined, 42, 'str', [], () => {}]) {
      assert.doesNotThrow(() => probe.interpretProbeResult(j));
      assert.equal(probe.interpretProbeResult(j).verdict, 'unknown');
    }
  });
});

describe('needsControlGroup / interpretProbePair — A/B 对照组', () => {
  const hasExplicitToolCallSyntax = (t) => /<tool_call>|<function=/i.test(String(t));
  const opts = { hasExplicitToolCallSyntax };

  test('A 已给出结论(native/text)→ 不必跑对照组', () => {
    assert.equal(probe.needsControlGroup({ toolUseBlocks: [{}] }, opts), false);
    assert.equal(
      probe.needsControlGroup({ success: true, content: '<tool_call>{}</tool_call>' }, opts),
      false
    );
  });
  test('A 失败 → 需要对照组;A 只是散文/截断 → 不需要', () => {
    assert.equal(probe.needsControlGroup({ success: false, error: 'x' }, opts), true);
    assert.equal(probe.needsControlGroup({ success: true, content: 'prose' }, opts), false);
    assert.equal(probe.needsControlGroup({ success: true, content: 'x', finishReason: 'length' }, opts), false);
  });
  test('A 失败且 B 成功 → route-rejects-tools（通道问题,不是模型问题）', () => {
    const r = probe.interpretProbePair(
      { a: { success: false, error: '400 Unrecognized chat message' }, b: { success: true, content: 'ok' } },
      opts
    );
    assert.equal(r.verdict, 'route-rejects-tools');
    assert.equal(r.reason, 'a_failed_b_succeeded');
  });
  test('A 失败且 B 也失败 → unknown', () => {
    const r = probe.interpretProbePair(
      { a: { success: false }, b: { success: false } },
      opts
    );
    assert.equal(r.verdict, 'unknown');
    assert.equal(r.reason, 'both_groups_failed');
  });
  test('A 失败但对照组未跑 → unknown（不据单侧失败下结论）', () => {
    const r = probe.interpretProbePair({ a: { success: false }, b: null }, opts);
    assert.equal(r.verdict, 'unknown');
    assert.equal(r.reason, 'group_a_failed_no_control');
  });
  test('A 有结论时对照组不改变结论', () => {
    assert.equal(
      probe.interpretProbePair({ a: { toolUseBlocks: [{}] }, b: { success: false } }, opts).verdict,
      'native'
    );
    assert.equal(
      probe.interpretProbePair({ a: { success: true, content: 'prose' }, b: { success: true } }, opts)
        .verdict,
      'unknown'
    );
  });
  test('never throws on junk', () => {
    for (const j of [null, undefined, 42, [], {}, { a: null }, { a: 'str', b: 7 }]) {
      assert.doesNotThrow(() => probe.interpretProbePair(j));
      assert.doesNotThrow(() => probe.needsControlGroup(j));
    }
  });
});

describe('shouldReprobe — TTL', () => {
  const now = 1_000_000_000_000;
  test('no record / junk → reprobe', () => {
    assert.equal(probe.shouldReprobe(null, {}, now), true);
    assert.equal(probe.shouldReprobe({}, {}, now), true);
    assert.equal(probe.shouldReprobe({ verdict: 'unknown', measuredAt: now }, {}, now), true);
    assert.equal(probe.shouldReprobe({ verdict: 'native' }, {}, now), true); // no measuredAt
  });
  test('fresh record → no reprobe', () => {
    assert.equal(probe.shouldReprobe({ verdict: 'native', measuredAt: now }, {}, now), false);
    assert.equal(probe.shouldReprobe({ verdict: 'text', measuredAt: now - 1000 }, {}, now), false);
  });
  test('confirmed PASS (native) is sticky — never reprobed by age (避免重复浪费)', () => {
    const ancient = now - probe.DEFAULT_TTL_MS * 100;
    assert.equal(probe.shouldReprobe({ verdict: 'native', measuredAt: ancient }, {}, now), false);
  });
  test('expired TEXT record → reprobe (未确证有界 TTL,假阴性可恢复)', () => {
    const old = now - probe.DEFAULT_TTL_MS - 1;
    assert.equal(probe.shouldReprobe({ verdict: 'text', measuredAt: old }, {}, now), true);
  });
  test('custom TTL env honored (text)', () => {
    const env = { KHY_TOOL_CAP_TTL_MS: '1000' };
    assert.equal(probe.shouldReprobe({ verdict: 'text', measuredAt: now - 500 }, env, now), false);
    assert.equal(probe.shouldReprobe({ verdict: 'text', measuredAt: now - 2000 }, env, now), true);
  });
  test('KHY_TOOL_CAP_NATIVE_TTL_MS re-enables native expiry (self-heal opt-in)', () => {
    const env = { KHY_TOOL_CAP_NATIVE_TTL_MS: '1000' };
    assert.equal(probe.shouldReprobe({ verdict: 'native', measuredAt: now - 500 }, env, now), false);
    assert.equal(probe.shouldReprobe({ verdict: 'native', measuredAt: now - 2000 }, env, now), true);
  });
  test('never throws', () => {
    assert.doesNotThrow(() => probe.shouldReprobe(Symbol('x')));
  });
});
