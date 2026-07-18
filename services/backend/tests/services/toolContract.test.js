'use strict';

/**
 * toolCatalog/toolContract — 工具契约审计器（node:test，注入 fake 注册表）。
 * 断言形状/schema 违规检出、冲突分级（跨 risk/跨 category=error，同类孪生=warning）、
 * 门控关 → 空 findings。注册表与 SSOT 常量全注入（零 IO、确定性）。
 */
const test = require('node:test');
const assert = require('node:assert');

const tc = require('../../src/services/toolCatalog/toolContract');

const CATEGORIES = { filesystem: 'x', data: 'x', execution: 'x', coordinator: 'x' };
const RISK_LEVELS = ['safe', 'low', 'medium', 'high', 'critical'];

/** 造一个「合契约」的工具对象（可覆写字段做违规样本）。 */
function goodTool(over = {}) {
  const base = {
    name: 'Ok',
    description: 'A fine tool.',
    category: 'filesystem',
    risk: 'safe',
    aliases: [],
    isReadOnly: () => true,
    isDestructive: () => false,
    isEnabled: () => true,
    validate: () => ({ valid: true }),
    execute: async () => ({}),
    toFunctionDef() {
      return { name: this.name, description: this.description, parameters: { type: 'object', properties: {}, required: undefined } };
    },
  };
  return Object.assign(base, over);
}

function audit(tools, env = {}) {
  return tc.auditTools({ getAll: () => tools, CATEGORIES, RISK_LEVELS }, env);
}

test('门控关 → 空 findings', () => {
  const out = tc.auditTools({ getAll: () => [goodTool()], CATEGORIES, RISK_LEVELS }, { KHY_TOOL_CONTRACT: 'off' });
  assert.deepStrictEqual(out, { findings: [], errors: 0, warnings: 0, total: 0 });
});

test('全合契约 → 0 error 0 warning', () => {
  const out = audit([goodTool({ name: 'A' }), goodTool({ name: 'B' })]);
  assert.strictEqual(out.errors, 0);
  assert.strictEqual(out.warnings, 0);
  assert.strictEqual(out.total, 2);
});

test('形状:坏 category / 坏 risk / 空 name / 空 desc → error', () => {
  const badCat = audit([goodTool({ name: 'C', category: 'nope' })]);
  assert.ok(badCat.findings.some((f) => f.rule === 'shape' && /category/.test(f.message)));
  const badRisk = audit([goodTool({ name: 'D', risk: 'extreme' })]);
  assert.ok(badRisk.findings.some((f) => f.rule === 'shape' && /risk/.test(f.message)));
  const noName = audit([goodTool({ name: '' })]);
  assert.ok(noName.findings.some((f) => /name 缺失/.test(f.message)));
  const noDesc = audit([goodTool({ name: 'E', description: '' })]);
  assert.ok(noDesc.findings.some((f) => /description 缺失/.test(f.message)));
});

test('形状:行为字段非函数 → error', () => {
  const out = audit([goodTool({ name: 'F', isReadOnly: true, execute: null })]);
  assert.ok(out.findings.some((f) => /isReadOnly 应为函数/.test(f.message)));
  assert.ok(out.findings.some((f) => /execute 应为函数/.test(f.message)));
});

test('schema:toFunctionDef 抛异常 → error', () => {
  const out = audit([goodTool({ name: 'G', toFunctionDef() { throw new Error('boom'); } })]);
  assert.ok(out.findings.some((f) => f.rule === 'schema' && /抛异常/.test(f.message)));
});

test('schema:parameters 非 {type:object,properties} → error', () => {
  const out = audit([goodTool({ name: 'H', toFunctionDef() { return { name: 'H', description: 'x', parameters: { type: 'array' } }; } })]);
  assert.ok(out.findings.some((f) => f.rule === 'schema' && /parameters/.test(f.message)));
});

test('schema:required 无(undefined) 合法', () => {
  const out = audit([goodTool({ name: 'I' })]); // required: undefined
  assert.strictEqual(out.errors, 0);
});

test('冲突:同 category 同 risk 孪生 → warning', () => {
  const out = audit([
    goodTool({ name: 'Read', category: 'filesystem', risk: 'low', aliases: ['readFile'] }),
    goodTool({ name: 'readFile', category: 'filesystem', risk: 'low' }),
  ]);
  const coll = out.findings.filter((f) => f.rule === 'collision');
  assert.ok(coll.length >= 1);
  assert.ok(coll.every((f) => f.severity === 'warning'));
  assert.strictEqual(out.errors, 0);
});

test('冲突:跨 risk → error', () => {
  const out = audit([
    goodTool({ name: 'WebFetch', category: 'data', risk: 'low', aliases: ['curl'] }),
    goodTool({ name: 'httpRequest', category: 'data', risk: 'medium', aliases: ['curl'] }),
  ]);
  const coll = out.findings.filter((f) => f.rule === 'collision' && f.message.includes("'curl'"));
  assert.strictEqual(coll.length, 1);
  assert.strictEqual(coll[0].severity, 'error');
  assert.ok(/跨 risk/.test(coll[0].message));
  assert.strictEqual(out.errors, 1);
});

test('冲突:跨 category → error', () => {
  const out = audit([
    goodTool({ name: 'ProjectBlueprint', category: 'coordinator', risk: 'low', aliases: ['build_project'] }),
    goodTool({ name: 'buildProject', category: 'execution', risk: 'low', aliases: ['build_project'] }),
  ]);
  const coll = out.findings.filter((f) => f.rule === 'collision' && f.message.includes("'buildproject'"));
  assert.strictEqual(coll.length, 1);
  assert.strictEqual(coll[0].severity, 'error');
});

test('_toolKey:归一化对齐 toolCalling', () => {
  assert.strictEqual(tc._toolKey('Web_Fetch'), 'webfetch');
  assert.strictEqual(tc._toolKey('build-project'), 'buildproject');
  assert.strictEqual(tc._toolKey(null), '');
});

test('fail-soft:getAll 抛 → 空结果', () => {
  const out = tc.auditTools({ getAll: () => { throw new Error('x'); }, CATEGORIES, RISK_LEVELS }, {});
  assert.deepStrictEqual(out, { findings: [], errors: 0, warnings: 0, total: 0 });
});

test('SSOT 空表回退:CATEGORIES/RISK 空 → 不误报形状', () => {
  const out = tc.auditTools({ getAll: () => [goodTool({ name: 'Z', category: 'weird', risk: 'weird' })], CATEGORIES: {}, RISK_LEVELS: [] }, {});
  // 空 SSOT → category/risk 维度跳过（不误报）
  assert.ok(!out.findings.some((f) => /不在 CATEGORIES/.test(f.message)));
  assert.ok(!out.findings.some((f) => /不在 RISK_LEVELS/.test(f.message)));
});

test('toolContractEnabled:关闭词表', () => {
  assert.strictEqual(tc.toolContractEnabled({}), true);
  assert.strictEqual(tc.toolContractEnabled({ KHY_TOOL_CONTRACT: '0' }), false);
  assert.strictEqual(tc.toolContractEnabled({ KHY_TOOL_CONTRACT: 'off' }), false);
  assert.strictEqual(tc.toolContractEnabled({ KHY_TOOL_CONTRACT: 'on' }), true);
});

// ── 参数级审计（悬垂 required / 缺 description / 缺 type；子门控 KHY_TOOL_PARAM_AUDIT）──

/** 造一个带自定义 properties/required 的工具（其余合契约）。 */
function paramTool(name, properties, required) {
  return goodTool({
    name,
    toFunctionDef() {
      return { name, description: 'p', parameters: { type: 'object', properties, required } };
    },
  });
}

test('参数:悬垂 required（名不在 properties）→ error', () => {
  const out = audit([paramTool('Dangle', { url: { type: 'string', description: 'u' } }, ['url', 'ghost'])]);
  const f = out.findings.filter((x) => x.rule === 'param' && /ghost/.test(x.message));
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].severity, 'error');
  assert.ok(out.errors >= 1);
});

test('参数:缺 description → warning', () => {
  const out = audit([paramTool('NoDesc', { method: { type: 'string' } }, [])]);
  const f = out.findings.filter((x) => x.rule === 'param' && /缺 description/.test(x.message));
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].severity, 'warning');
  assert.strictEqual(out.errors, 0);
});

test('参数:缺 type/enum → warning（enum 或 $ref 视为有类型，不误报）', () => {
  const out = audit([paramTool('NoType', { foo: { description: 'no type here' } }, [])]);
  assert.ok(out.findings.some((x) => x.rule === 'param' && /缺 type/.test(x.message)));
  // enum 视为有类型
  const okEnum = audit([paramTool('EnumOk', { mode: { enum: ['a', 'b'], description: 'm' } }, [])]);
  assert.ok(!okEnum.findings.some((x) => x.rule === 'param' && /缺 type/.test(x.message)));
});

test('参数:合规参数（有 desc + type）→ 0 param finding', () => {
  const out = audit([paramTool('Clean', { file: { type: 'string', description: 'path' } }, ['file'])]);
  assert.strictEqual(out.findings.filter((x) => x.rule === 'param').length, 0);
});

test('参数:required 却带 default → warning（default 永不生效）', () => {
  const out = audit([paramTool(
    'ReqDefault',
    { mode: { type: 'string', enum: ['a', 'b'], description: 'm', default: 'a' } },
    ['mode'],
  )]);
  const f = out.findings.filter((x) => x.rule === 'param' && /required 却带 default/.test(x.message));
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].severity, 'warning');
  assert.strictEqual(out.errors, 0);
  // 可选参数带 default 不触发（default 正常生效）。
  const optional = audit([paramTool(
    'OptDefault',
    { mode: { type: 'string', enum: ['a', 'b'], description: 'm', default: 'a' } },
    [],
  )]);
  assert.ok(!optional.findings.some((x) => x.rule === 'param' && /required 却带 default/.test(x.message)));
});

test('参数:子门控 KHY_TOOL_PARAM_AUDIT 关 → 无 param findings（字节回退）', () => {
  const bad = { method: { type: 'string' } }; // 缺 description
  const on = audit([paramTool('P1', bad, ['nope'])]); // 门控开:悬垂 required(error)+缺 desc(warning)
  assert.ok(on.findings.some((x) => x.rule === 'param'));
  const off = tc.auditTools(
    { getAll: () => [paramTool('P1', bad, ['nope'])], CATEGORIES, RISK_LEVELS },
    { KHY_TOOL_PARAM_AUDIT: 'off' },
  );
  assert.strictEqual(off.findings.filter((x) => x.rule === 'param').length, 0);
  // 总门控仍开 → 形状/schema/冲突照跑（此例无违规 → 0 error）。
  assert.strictEqual(off.errors, 0);
});

test('参数:array 却无 items → warning（元素类型不明）', () => {
  const out = audit([paramTool('NoItems', { tags: { type: 'array', description: 't' } }, [])]);
  const f = out.findings.filter((x) => x.rule === 'param' && /array 却无 items/.test(x.message));
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].severity, 'warning');
  assert.strictEqual(out.errors, 0);
  // array 带 items 不触发。
  const withItems = audit([paramTool('WithItems', { tags: { type: 'array', description: 't', items: { type: 'string' } } }, [])]);
  assert.ok(!withItems.findings.some((x) => x.rule === 'param' && /array 却无 items/.test(x.message)));
});

test('paramAuditEnabled:关闭词表', () => {
  assert.strictEqual(tc.paramAuditEnabled({}), true);
  assert.strictEqual(tc.paramAuditEnabled({ KHY_TOOL_PARAM_AUDIT: 'off' }), false);
  assert.strictEqual(tc.paramAuditEnabled({ KHY_TOOL_PARAM_AUDIT: '0' }), false);
  assert.strictEqual(tc.paramAuditEnabled({ KHY_TOOL_PARAM_AUDIT: 'on' }), true);
});
