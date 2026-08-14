'use strict';

/**
 * Tests for metaToolEngine.js + CreateToolTool（设计 DESIGN-ARCH-017）。
 * 覆盖：默认关闭门禁、静态安全黑名单、结构/复杂度校验、沙箱冒烟、
 * LLM 生成解析、forge 全流程(创建/拒绝/复用/会话上限)、运行期始终沙箱化、
 * CreateToolTool 装配与自然语言透出。
 *
 * 注入假 LLM，绝不依赖真实网关。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const engine = require('../../src/services/metaToolEngine');

const GOOD_DEF = {
  name: 'celsiusToFahrenheit',
  description: '摄氏转华氏',
  category: 'custom',
  risk: 'safe',
  inputSchema: { celsius: { type: 'number', required: true, description: '摄氏温度' } },
  code: 'return { fahrenheit: params.celsius * 9 / 5 + 32 };',
};

function fakeLlm(def) {
  return async () => JSON.stringify(def);
}

function withEnabled(fn) {
  const prev = process.env.KHY_ENABLE_META_TOOL;
  process.env.KHY_ENABLE_META_TOOL = '1';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.KHY_ENABLE_META_TOOL;
      else process.env.KHY_ENABLE_META_TOOL = prev;
    });
}

describe('isEnabled (§0 default-off)', () => {
  test('off by default', () => {
    const prev = process.env.KHY_ENABLE_META_TOOL;
    delete process.env.KHY_ENABLE_META_TOOL;
    assert.strictEqual(engine.isEnabled(), false);
    if (prev !== undefined) process.env.KHY_ENABLE_META_TOOL = prev;
  });

  test('on when KHY_ENABLE_META_TOOL=1', () => withEnabled(() => {
    assert.strictEqual(engine.isEnabled(), true);
  }));
});

describe('staticSafetyScan (§4 G2)', () => {
  test('accepts pure compute', () => {
    assert.strictEqual(engine.staticSafetyScan(GOOD_DEF.code).ok, true);
  });

  for (const bad of [
    "return require('fs');",
    'return process.env;',
    'return eval("1+1");',
    'return this.constructor.constructor("return process")();',
    'const f = Function("return 1"); return f();',
    'while (true) {}',
    'return globalThis;',
    'return fetch("http://x");',
    'return createTool({});',
    'obj.__proto__.x = 1; return 1;',
  ]) {
    test(`rejects: ${bad.slice(0, 30)}`, () => {
      assert.strictEqual(engine.staticSafetyScan(bad).ok, false);
    });
  }

  test('rejects empty', () => {
    assert.strictEqual(engine.staticSafetyScan('').ok, false);
  });
});

describe('validateDefinition (§3/§4 G1)', () => {
  test('accepts good def', () => {
    assert.strictEqual(engine.validateDefinition(GOOD_DEF).ok, true);
  });

  test('rejects bad name', () => {
    assert.strictEqual(engine.validateDefinition({ ...GOOD_DEF, name: '1bad' }).ok, false);
  });

  test('rejects existing name', () => {
    assert.strictEqual(engine.validateDefinition(GOOD_DEF, new Set(['celsiusToFahrenheit'])).ok, false);
  });

  test('rejects over-long code', () => {
    assert.strictEqual(engine.validateDefinition({ ...GOOD_DEF, code: 'x'.repeat(5000) + ';return 1;' }).ok, false);
  });

  test('rejects too many params', () => {
    const schema = {};
    for (let i = 0; i < 9; i++) schema[`p${i}`] = { type: 'string' };
    assert.strictEqual(engine.validateDefinition({ ...GOOD_DEF, inputSchema: schema }).ok, false);
  });
});

describe('sandboxSmokeTest + makeSandboxedExecute (§4 G3/G4)', () => {
  test('smoke test passes for valid code', () => {
    const r = engine.sandboxSmokeTest(GOOD_DEF.code, { celsius: 0 });
    assert.strictEqual(r.ok, true);
  });

  test('smoke test fails for syntax error', () => {
    const r = engine.sandboxSmokeTest('return (((;', { x: 1 });
    assert.strictEqual(r.ok, false);
  });

  test('runtime execute is always sandboxed and returns normalized result', async () => {
    const exec = engine.makeSandboxedExecute(GOOD_DEF.code, GOOD_DEF.inputSchema);
    const out = await exec({ celsius: 100 });
    assert.strictEqual(out.success, true);
    assert.deepStrictEqual(out.data, { fahrenheit: 212 });
  });

  test('runtime execute cannot reach require/process (sandbox物理隔离)', async () => {
    // 即便绕过静态扫描注入危险代码，运行期 vm 也无 require/process 句柄。
    const exec = engine.makeSandboxedExecute('return typeof require + ":" + typeof process;', {});
    const out = await exec({});
    assert.strictEqual(out.success, true);
    assert.strictEqual(out.data, 'undefined:undefined');
  });
});

describe('generateToolDefinition (§3)', () => {
  test('parses JSON from llm and forces safe/custom', async () => {
    const gen = await engine.generateToolDefinition(
      { purpose: 'convert temperature' },
      { llm: fakeLlm({ ...GOOD_DEF, category: 'execution', risk: 'high' }) },
    );
    assert.strictEqual(gen.ok, true);
    assert.strictEqual(gen.def.category, 'custom');
    assert.strictEqual(gen.def.risk, 'safe');
  });

  test('handles fenced / noisy llm output', async () => {
    const noisy = async () => 'Sure!\n```json\n' + JSON.stringify(GOOD_DEF) + '\n```\nDone.';
    const gen = await engine.generateToolDefinition({ purpose: 'x' }, { llm: noisy });
    assert.strictEqual(gen.ok, true);
    assert.strictEqual(gen.def.name, 'celsiusToFahrenheit');
  });

  test('fails when llm returns garbage', async () => {
    const gen = await engine.generateToolDefinition({ purpose: 'x' }, { llm: async () => 'no json here' });
    assert.strictEqual(gen.ok, false);
  });
});

describe('forgeTool — full orchestration (§1)', () => {
  beforeEach(() => engine._resetForTest());
  afterEach(() => engine._resetForTest());

  test('disabled → status disabled', async () => {
    const prev = process.env.KHY_ENABLE_META_TOOL;
    delete process.env.KHY_ENABLE_META_TOOL;
    const r = await engine.forgeTool({ purpose: 'x' }, { llm: fakeLlm(GOOD_DEF) });
    assert.strictEqual(r.status, 'disabled');
    if (prev !== undefined) process.env.KHY_ENABLE_META_TOOL = prev;
  });

  test('happy path → created + registered + callable', () => withEnabled(async () => {
    const registered = [];
    const existing = new Set();
    const r = await engine.forgeTool(
      { purpose: 'convert celsius to fahrenheit', name: 'celsiusToFahrenheit' },
      { llm: fakeLlm(GOOD_DEF), register: (t) => registered.push(t), existingNames: existing },
    );
    assert.strictEqual(r.status, 'created');
    assert.strictEqual(r.toolName, 'celsiusToFahrenheit');
    assert.ok(r.message.includes('已为你新建工具'));
    assert.strictEqual(registered.length, 1);
    // registered tool runs through sandbox
    const out = await registered[0].execute({ celsius: 0 });
    assert.strictEqual(out.success, true);
    assert.deepStrictEqual(out.data, { fahrenheit: 32 });
    // registered as read-only, safe, custom
    assert.strictEqual(registered[0].risk, 'safe');
    assert.strictEqual(registered[0].isReadOnly, true);
  }));

  test('dangerous generated code → rejected, not registered', () => withEnabled(async () => {
    const registered = [];
    const r = await engine.forgeTool(
      { purpose: 'read a file' },
      { llm: fakeLlm({ ...GOOD_DEF, name: 'evilTool', code: "return require('fs').readFileSync('/etc/passwd');" }), register: (t) => registered.push(t), existingNames: new Set() },
    );
    assert.strictEqual(r.status, 'rejected');
    assert.match(r.reason, /forbidden token/);
    assert.strictEqual(registered.length, 0);
  }));

  test('reuse when name already exists', () => withEnabled(async () => {
    const r = await engine.forgeTool(
      { purpose: 'x', name: 'celsiusToFahrenheit' },
      { llm: fakeLlm(GOOD_DEF), existingNames: new Set(['celsiusToFahrenheit']) },
    );
    assert.strictEqual(r.status, 'reused');
  }));

  test('empty purpose → rejected', () => withEnabled(async () => {
    const r = await engine.forgeTool({ purpose: '   ' }, { llm: fakeLlm(GOOD_DEF) });
    assert.strictEqual(r.status, 'rejected');
  }));

  test('session forge cap enforced (§7 anti-loop)', () => withEnabled(async () => {
    const prev = process.env.KHY_META_TOOL_MAX_PER_SESSION;
    process.env.KHY_META_TOOL_MAX_PER_SESSION = '2';
    try {
      const session = { id: 's1' };
      const mk = (i) => engine.forgeTool(
        { purpose: `tool number ${i}`, name: `genTool${i}` },
        { llm: fakeLlm({ ...GOOD_DEF, name: `genTool${i}` }), register: () => {}, existingNames: new Set(), session },
      );
      const r1 = await mk(1);
      const r2 = await mk(2);
      const r3 = await mk(3);
      assert.strictEqual(r1.status, 'created');
      assert.strictEqual(r2.status, 'created');
      assert.strictEqual(r3.status, 'rejected');
      assert.match(r3.reason, /session cap/);
    } finally {
      if (prev === undefined) delete process.env.KHY_META_TOOL_MAX_PER_SESSION;
      else process.env.KHY_META_TOOL_MAX_PER_SESSION = prev;
    }
  }));
});

describe('CreateToolTool — agent-facing wrapper', () => {
  beforeEach(() => engine._resetForTest());

  const tool = require('../../src/tools/CreateToolTool');

  test('exposes defineTool interface', () => {
    assert.strictEqual(tool.name, 'createTool');
    assert.strictEqual(typeof tool.execute, 'function');
    assert.strictEqual(typeof tool.toFunctionDef, 'function');
  });

  test('disabled by default → isEnabled false', () => {
    const prev = process.env.KHY_ENABLE_META_TOOL;
    delete process.env.KHY_ENABLE_META_TOOL;
    assert.strictEqual(tool.isEnabled(), false);
    if (prev !== undefined) process.env.KHY_ENABLE_META_TOOL = prev;
  });

  test('execute returns natural-language content, no internal fields leaked', () => withEnabled(async () => {
    const out = await tool.execute(
      { purpose: 'convert celsius to fahrenheit', name: 'celsiusToFahrenheit' },
      { llm: fakeLlm(GOOD_DEF), session: { id: 'wrap1' } },
    );
    assert.strictEqual(typeof out.content, 'string');
    assert.ok(!out.content.includes('{'), 'content 不得回显 JSON');
    assert.ok(!out.content.includes('code'), 'content 不得回显源码字段');
  }));

  test('execute disabled → graceful message', async () => {
    const prev = process.env.KHY_ENABLE_META_TOOL;
    delete process.env.KHY_ENABLE_META_TOOL;
    const out = await tool.execute({ purpose: 'x' }, {});
    assert.strictEqual(out.success, false);
    assert.match(out.content, /未启用/);
    if (prev !== undefined) process.env.KHY_ENABLE_META_TOOL = prev;
  });
});
