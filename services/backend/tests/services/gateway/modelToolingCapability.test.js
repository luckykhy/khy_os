'use strict';

/**
 * modelToolingCapability.test.js — 「模型是否具备可靠原生工具调用,否则退回文本拦截」
 * 单一真源的不变量。
 *
 * model 维度判定优先级(modelLacksReliableToolCalling):
 *   1. 强制原生集(env KHY_NATIVE_TOOL_MODELS) —— 命中即「不缺」(false),优先级最高
 *      (用户主权:纠正任何误判,把某个模型钉死为原生)。
 *   2. 强制纯文本集(env KHY_TEXT_ONLY_TOOL_MODELS) —— 命中即「缺」(true)。
 *   3. **实测裁决(opts.measured)** —— 'native'→不缺、'text'→缺。由 toolCapabilityStore 提供
 *      (live probe / 被动学习的真实结果)。**实测胜过任何按名字的启发**——这是「不硬编码、
 *      实测为准」的落点:一个名字含 flash 但实测能调工具的模型,measured='native' 即拉回原生。
 *   4. 小模型名启发(SMALL_MODEL_HINTS) —— 命中即「缺」。仅作**провизионально(暂定)**默认:
 *      实测前安全地走文本协议(永远能用),一旦实测/被动学习有结果即被第 3 步覆盖。
 *   5. 默认「不缺」(false:未知/非小名模型不过度教学,保留原生路径)。
 *
 * 设计变更(用户裁决「工具可调用模型不要硬编码,需要实测后才算」):**删除**了原先的正向
 * 名字白名单 FULL_SIZE_TOOL_EXCEPTIONS(deepseek-v[3-9]/sensenova-\d/agnes-\d)。名字含
 * flash/lite 的全尺寸模型不再靠硬编码豁免,而是经实测缓存晋升为原生(探测/被动学习)。
 * 过渡期(未测前)这类模型暂走文本协议——安全可用;需立即原生可用 env KHY_NATIVE_TOOL_MODELS。
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const cap = require('../../../src/services/gateway/modelToolingCapability');

const ENV_KEYS = [
  'KHY_MODEL_TOOLING_CAPABILITY',
  'KHY_NATIVE_TOOL_MODELS',
  'KHY_TEXT_ONLY_TOOL_MODELS',
];
function snapshotEnv() {
  const prev = {};
  for (const k of ENV_KEYS) prev[k] = process.env[k];
  return prev;
}
function restoreEnv(prev) {
  for (const k of ENV_KEYS) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
}

describe('isEnabled — gate semantics (默认开)', () => {
  const prev = snapshotEnv();
  afterEach(() => restoreEnv(prev));

  test('default (unset) is ON', () => {
    delete process.env.KHY_MODEL_TOOLING_CAPABILITY;
    assert.equal(cap.isEnabled(), true);
  });

  test('reverts on {0,false,off,no} (any case / whitespace)', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF', '  false ', 'No']) {
      assert.equal(cap.isEnabled({ KHY_MODEL_TOOLING_CAPABILITY: v }), false, `"${v}" should disable`);
    }
  });

  test('stays ON for any other value', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'whatever']) {
      assert.equal(cap.isEnabled({ KHY_MODEL_TOOLING_CAPABILITY: v }), true, `"${v}" should enable`);
    }
  });
});

describe('adapterSupportsNativeToolUse — adapter dimension', () => {
  test('native-capable adapters are true', () => {
    for (const a of ['kiro', 'cursor', 'trae', 'claude', 'codex', 'api',
      'windsurf', 'vscode', 'warp', 'cursor2api', 'relay_api']) {
      assert.equal(cap.adapterSupportsNativeToolUse(a), true, `${a} should be native`);
    }
  });

  test('text-only / non-listed adapters are false', () => {
    for (const a of ['local', 'localllm', 'ollama', 'clipboard', 'webrelay', '', null, undefined]) {
      assert.equal(cap.adapterSupportsNativeToolUse(a), false, `${a} should NOT be native`);
    }
  });

  test('case-insensitive / trimmed', () => {
    assert.equal(cap.adapterSupportsNativeToolUse('  CLAUDE '), true);
    assert.equal(cap.adapterSupportsNativeToolUse('Relay_Api'), true);
  });
});

describe('modelLacksReliableToolCalling — model dimension', () => {
  const prev = snapshotEnv();
  afterEach(() => restoreEnv(prev));

  test('small-model name hints → lacks (true)', () => {
    for (const m of [
      'gpt-4o-mini', 'sensenova-x-lite', 'qwen-flash', 'claude-3-haiku',
      'foo-small', 'qwen2.5-7b', 'llama-8b', 'phi-3b', 'gemma-1.5b', 'nemotron-nano', 'tiny-llm',
    ]) {
      assert.equal(cap.modelLacksReliableToolCalling(m), true, `${m} should lack native tools`);
    }
  });

  test('flash/lite full-size models WITHOUT a measurement → lacks (provisional text protocol)', () => {
    // 删除正向硬编码后:实测前,名字含 flash/lite 的全尺寸模型暂走文本协议(安全可用)。
    for (const m of ['deepseek-v4-flash', 'deepseek-v3-flash', 'sensenova-6.7-flash-lite',
      'agnes-2.0-flash', 'agnes-2.5-flash']) {
      assert.equal(cap.modelLacksReliableToolCalling(m), true, `${m} provisionally lacks until measured`);
    }
  });

  test('measured="native" overrides the small-name heuristic (实测为准) → has (false)', () => {
    for (const m of ['agnes-2.0-flash', 'deepseek-v4-flash', 'sensenova-6.7-flash-lite', 'gpt-4o-mini']) {
      assert.equal(cap.modelLacksReliableToolCalling(m, { measured: 'native' }), false,
        `${m} measured native → has tools`);
    }
  });

  test('measured="text" forces text protocol even for frontier names → lacks (true)', () => {
    for (const m of ['gpt-4o', 'claude-opus-4-8', 'deepseek-v4']) {
      assert.equal(cap.modelLacksReliableToolCalling(m, { measured: 'text' }), true,
        `${m} measured text → lacks`);
    }
  });

  test('env force-native beats measured="text" (用户主权最高)', () => {
    const env = { KHY_NATIVE_TOOL_MODELS: 'agnes-2.0-flash' };
    assert.equal(cap.modelLacksReliableToolCalling('agnes-2.0-flash', { env, measured: 'text' }), false);
  });

  test('env force-text beats measured="native"', () => {
    const env = { KHY_TEXT_ONLY_TOOL_MODELS: 'agnes-2.0-flash' };
    assert.equal(cap.modelLacksReliableToolCalling('agnes-2.0-flash', { env, measured: 'native' }), true);
  });

  test('frontier / non-small models → has (false)', () => {
    for (const m of ['claude-opus-4-8', 'claude-sonnet-4-6', 'gpt-4o', 'deepseek-v4', 'qwen2.5-72b']) {
      assert.equal(cap.modelLacksReliableToolCalling(m), false, `${m} should have native tools`);
    }
  });

  test('unknown / empty model → has (false) — no over-teaching', () => {
    for (const m of ['', null, undefined, '   ']) {
      assert.equal(cap.modelLacksReliableToolCalling(m), false);
    }
  });

  test('KHY_NATIVE_TOOL_MODELS forces native (highest priority, overrides small-name)', () => {
    const env = { KHY_NATIVE_TOOL_MODELS: 'gpt-4o-mini, qwen-flash' };
    assert.equal(cap.modelLacksReliableToolCalling('gpt-4o-mini', { env }), false);
    assert.equal(cap.modelLacksReliableToolCalling('qwen-flash', { env }), false);
  });

  test('KHY_TEXT_ONLY_TOOL_MODELS forces text-only (overrides full-size exception)', () => {
    const env = { KHY_TEXT_ONLY_TOOL_MODELS: 'deepseek-v4-flash' };
    assert.equal(cap.modelLacksReliableToolCalling('deepseek-v4-flash', { env }), true);
  });

  test('native-forced beats text-forced when a model is (mistakenly) in both', () => {
    const env = {
      KHY_NATIVE_TOOL_MODELS: 'some-model',
      KHY_TEXT_ONLY_TOOL_MODELS: 'some-model',
    };
    assert.equal(cap.modelLacksReliableToolCalling('some-model', { env }), false);
  });
});

describe('hasNativeToolUse — composition (teaching gate)', () => {
  test('native adapter + small model → false (must teach text protocol)', () => {
    assert.equal(cap.hasNativeToolUse({ model: 'gpt-4o-mini', adapter: 'api' }), false);
    assert.equal(cap.hasNativeToolUse({ model: 'qwen-flash', adapter: 'relay_api' }), false);
  });

  test('native adapter + flash/lite model, no measurement → false (provisional text teaching)', () => {
    // 删除正向硬编码后:实测前这些暂走文本协议(教学 <tool_call>),不再靠名字豁免。
    assert.equal(cap.hasNativeToolUse({ model: 'deepseek-v4-flash', adapter: 'relay_api' }), false);
    assert.equal(cap.hasNativeToolUse({ model: 'sensenova-6.7-flash-lite', adapter: 'api' }), false);
    assert.equal(cap.hasNativeToolUse({ model: 'agnes-2.0-flash', adapter: 'api' }), false);
  });

  test('native adapter + flash/lite model, measured="native" → true (实测晋升原生)', () => {
    assert.equal(cap.hasNativeToolUse({ model: 'agnes-2.0-flash', adapter: 'api', measured: 'native' }), true);
    assert.equal(cap.hasNativeToolUse({ model: 'deepseek-v4-flash', adapter: 'relay_api', measured: 'native' }), true);
  });

  test('native adapter + frontier model → true', () => {
    assert.equal(cap.hasNativeToolUse({ model: 'claude-opus-4-8', adapter: 'claude' }), true);
  });

  test('non-native adapter → false regardless of model', () => {
    assert.equal(cap.hasNativeToolUse({ model: 'claude-opus-4-8', adapter: 'local' }), false);
    assert.equal(cap.hasNativeToolUse({ model: 'qwen3.5:4b', adapter: 'localllm' }), false);
  });
});

describe('shouldStripUpstreamTools — strip gate mirrors model dimension', () => {
  test('strip ⟺ model lacks reliable tool calling (lockstep with teaching)', () => {
    for (const m of ['gpt-4o-mini', 'qwen-flash', 'llama-8b']) {
      assert.equal(cap.shouldStripUpstreamTools(m), cap.modelLacksReliableToolCalling(m));
      assert.equal(cap.shouldStripUpstreamTools(m), true);
    }
    // 无实测:flash/lite 暂剥离;frontier 不剥离。
    for (const m of ['deepseek-v4-flash', 'sensenova-6.7-flash-lite', 'agnes-2.0-flash']) {
      assert.equal(cap.shouldStripUpstreamTools(m), true);
    }
    assert.equal(cap.shouldStripUpstreamTools('claude-opus-4-8'), false);
  });

  test('measured="native" stops stripping (实测后 tools 发出)', () => {
    assert.equal(cap.shouldStripUpstreamTools('agnes-2.0-flash', { measured: 'native' }), false);
    assert.equal(cap.shouldStripUpstreamTools('gpt-4o-mini', { measured: 'native' }), false);
  });
});

describe('determinism / never throws', () => {
  test('malformed inputs never throw', () => {
    const junk = [null, undefined, 42, {}, [], () => {}, Symbol('x')];
    for (const j of junk) {
      assert.doesNotThrow(() => cap.modelLacksReliableToolCalling(j));
      assert.doesNotThrow(() => cap.adapterSupportsNativeToolUse(j));
      assert.doesNotThrow(() => cap.hasNativeToolUse({ model: j, adapter: j }));
      assert.doesNotThrow(() => cap.shouldStripUpstreamTools(j));
    }
  });

  test('parseModelListEnv splits on commas/whitespace, lowercases, ignores blanks', () => {
    const set = cap.parseModelListEnv('  Foo-Bar,  baz qux ,,\nQUUX ');
    assert.deepEqual([...set].sort(), ['baz', 'foo-bar', 'quux', 'qux']);
    assert.equal(cap.parseModelListEnv('').size, 0);
    assert.equal(cap.parseModelListEnv(null).size, 0);
  });
});
