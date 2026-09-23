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

  // BUG-014 / P0:强制名单必须与实测缓存用同一套键。调用方拿到的 model 有两种形态 ——
  // 教学门给路由 id(`api:agnes:agnes-3.0-flash`),剥离门给裸模型名。只比裸名会让同一条
  // env 只在一个门上生效:用户设了 KHY_NATIVE_TOOL_MODELS,模型却仍被注入「你没有原生工具,
  // 请用文本语法」的教学 —— 正是仓库注释里抱怨过的自相矛盾指令。
  test('env 强制原生对路由 id 形态同样生效（教学门与剥离门同键）', () => {
    const env = { KHY_NATIVE_TOOL_MODELS: 'agnes-3.0-flash' };
    assert.equal(cap.modelLacksReliableToolCalling('agnes-3.0-flash', { env }), false);
    assert.equal(
      cap.modelLacksReliableToolCalling('api:agnes:agnes-3.0-flash', { env }),
      false,
      '路由 id 形态必须与裸名同判——否则教学门会继续教文本协议'
    );
  });

  test('env 强制纯文本对路由 id 形态同样生效', () => {
    const env = { KHY_TEXT_ONLY_TOOL_MODELS: 'glm-4v-flash' };
    assert.equal(cap.modelLacksReliableToolCalling('glm-4v-flash', { env }), true);
    assert.equal(cap.modelLacksReliableToolCalling('api:glm:glm-4v-flash', { env }), true);
  });

  test('env 名单里写路由 id 也能命中（两种写法都认）', () => {
    const env = { KHY_NATIVE_TOOL_MODELS: 'api:agnes:agnes-3.0-flash' };
    assert.equal(cap.modelLacksReliableToolCalling('api:agnes:agnes-3.0-flash', { env }), false);
  });
});

describe('stripToolsNotice — 剥离说明文案', () => {
  test('含模型名与复测入口,且不再引导用户换模型', () => {
    const s = cap.stripToolsNotice('agnes-3.0-flash');
    assert.match(s, /agnes-3\.0-flash/);
    assert.match(s, /probe-tools/);
    // 旧文案的教训:工具其实仍在通过文本协议执行,却让用户「切换到支持 function calling 的
    // 模型」——把内部判定缺陷说成用户的环境问题,还指错排障方向。锁死这两句不再出现。
    assert.doesNotMatch(s, /切换到支持/);
    assert.doesNotMatch(s, /不支持工具调用/);
  });
  test('缺模型名 → 占位,不产出 "undefined"', () => {
    for (const v of ['', null, undefined, '   ']) {
      const s = cap.stripToolsNotice(v);
      assert.doesNotMatch(s, /undefined|null/);
      assert.match(s, /当前模型/);
    }
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

describe('shouldStripUpstreamTools — wire 侧只认正面证据（2026-09-23 起）', () => {
  // 旧契约是「剥离门与教学门锁步」。P2 有意打破这条锁步:名字启发可以决定**教学**
  // (教一遍文本回退语法是加性提示,零代价),但不能决定 **wire**(剥掉 tools 会让模型
  // 再也无法用原生调用证明自己,猜错就锁死到 TTL 到期 —— BUG-014)。
  test('未实测 + 名字含 flash/lite → **不剥**(先发,让现实给证据)', () => {
    for (const m of [
      'gpt-4o-mini',
      'qwen-flash',
      'llama-8b',
      'deepseek-v4-flash',
      'sensenova-6.7-flash-lite',
      'agnes-2.0-flash',
    ]) {
      assert.equal(cap.shouldStripUpstreamTools(m), false, `${m} 未实测不得被剥掉 tools`);
    }
  });

  test('教学门**仍**按名字启发暂定教学（锁步被有意打破的那一半）', () => {
    // 同一批模型:wire 侧发 tools,提示词侧仍教文本回退语法。两者不矛盾 —— 教学文案是
    // 加性的(prompts.js:_toolCallingFallbackProfile 标题即 "text-based fallback"),
    // 且文本调用在两条协议下都会被解析执行。
    for (const m of ['gpt-4o-mini', 'qwen-flash', 'agnes-2.0-flash']) {
      assert.equal(cap.modelLacksReliableToolCalling(m), true, `${m} 暂定档应继续教文本协议`);
      assert.equal(cap.shouldStripUpstreamTools(m), false, `${m} 但 wire 侧必须照发 tools`);
    }
  });

  test('实测 text → 剥;实测 native → 不剥', () => {
    assert.equal(cap.shouldStripUpstreamTools('agnes-2.0-flash', { measured: 'text' }), true);
    assert.equal(cap.shouldStripUpstreamTools('agnes-2.0-flash', { measured: 'native' }), false);
    assert.equal(cap.shouldStripUpstreamTools('gpt-4o-mini', { measured: 'native' }), false);
  });

  test('通道拒收 tools → 剥（端点属性,不管模型是谁）', () => {
    assert.equal(cap.shouldStripUpstreamTools('claude-opus-4-8', { routeRejects: true }), true);
    assert.equal(cap.shouldStripUpstreamTools('gpt-4o', { routeRejects: true }), true);
  });

  test('实测 native 压过通道否决（见过真实原生调用的模型换通道仍原生）', () => {
    assert.equal(
      cap.shouldStripUpstreamTools('gpt-4o', { measured: 'native', routeRejects: true }),
      false
    );
  });

  test('env 钉子对 wire 与教学两侧都是最高优先', () => {
    const envNative = { KHY_NATIVE_TOOL_MODELS: 'gpt-4o-mini' };
    assert.equal(
      cap.shouldStripUpstreamTools('gpt-4o-mini', { env: envNative, measured: 'text' }),
      false,
      '强制原生必须压过实测 text'
    );
    const envText = { KHY_TEXT_ONLY_TOOL_MODELS: 'gpt-4o' };
    assert.equal(
      cap.shouldStripUpstreamTools('gpt-4o', { env: envText, measured: 'native' }),
      true,
      '强制纯文本必须压过实测 native'
    );
  });

  test('未知/空模型 → 不剥（不过度作为）', () => {
    for (const m of ['', null, undefined, '   ']) {
      assert.equal(cap.shouldStripUpstreamTools(m), false);
    }
  });

  // P3 隔离式挑战:被判 text 的模型每 N 次请求放行一次原生,好让模型有机会推翻判定。
  describe('隔离式挑战（挑战轮照发 tools）', () => {
    test('实测 text + 挑战轮 → **不剥**（给模型一次翻案机会）', () => {
      assert.equal(cap.shouldStripUpstreamTools('gpt-4o', { measured: 'text' }), true);
      assert.equal(
        cap.shouldStripUpstreamTools('gpt-4o', { measured: 'text', challenge: true }),
        false,
        '挑战轮的整个意义就是让被判 text 的模型还能原生调用一次'
      );
    });

    test('通道拒收是端点定论，挑战**不越权**', () => {
      // 严格端点每次带 tools 都吃 400;挑战它只会白付一个 400 往返。它该由自己的 TTL 到期重试。
      assert.equal(
        cap.shouldStripUpstreamTools('gpt-4o', { routeRejects: true, challenge: true }),
        true
      );
    });

    test('env 钉子连挑战轮也不越过', () => {
      const env = { KHY_TEXT_ONLY_TOOL_MODELS: 'gpt-4o' };
      assert.equal(
        cap.shouldStripUpstreamTools('gpt-4o', { env, challenge: true }),
        true,
        '用户明确要的纯文本状态不该被内部挑战推翻'
      );
    });

    test('已确证 native 不受挑战影响', () => {
      assert.equal(
        cap.shouldStripUpstreamTools('gpt-4o', { measured: 'native', challenge: true }),
        false
      );
    });

    test('未实测档挑战与不挑战都是发（未知本来就发）', () => {
      assert.equal(cap.shouldStripUpstreamTools('agnes-3.0-flash', { challenge: true }), false);
      assert.equal(cap.shouldStripUpstreamTools('agnes-3.0-flash'), false);
    });
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
