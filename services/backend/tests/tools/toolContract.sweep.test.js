'use strict';

/**
 * toolContract.sweep — 全量扫描：对真实工具注册表跑契约审计（node:test）。
 *
 * 这是「保证每个小工具都对」的回归防线:直接 require 真实注册表，跑 auditTools，
 * 断言 **0 error**（无坏形状、无坏 schema、无跨 risk/跨 category 的命名冲突）。
 * 同类孪生 warning 是信息性的（已由 toolRegistryDedup 在模型可见清单折叠），只打印不断言。
 *
 * 与单测 toolContract.test.js 的分工:单测用注入 fake 表验证审计**逻辑**；本 sweep
 * 用真实 137+ 工具验证 khy 当前**实际状态**合契约。二者互补。
 */
const test = require('node:test');
const assert = require('node:assert');

const { auditTools, toolContractEnabled } = require('../../src/services/toolCatalog/toolContract');

test('真实注册表:0 error（无坏工具、无跨风险/跨类别冲突）', () => {
  const out = auditTools({}); // 缺省 → 真实 require('../../tools').getAll + SSOT
  assert.ok(out.total > 0, '注册表应有工具');
  if (out.errors > 0) {
    const errs = out.findings.filter((f) => f.severity === 'error')
      .map((f) => `  [${f.rule}] ${f.tool} :: ${f.message}`).join('\n');
    assert.fail(`契约审计发现 ${out.errors} 个 error:\n${errs}`);
  }
  assert.strictEqual(out.errors, 0);
});

test('真实注册表:孪生 warning 全为同类（信息性，不失败）', () => {
  const out = auditTools({});
  const warnColls = out.findings.filter((f) => f.rule === 'collision' && f.severity === 'warning');
  // 打印供人核对，不作断言（数量随工具增删浮动）。
  // eslint-disable-next-line no-console
  console.log(`[sweep] tools=${out.total} errors=${out.errors} twin-warnings=${warnColls.length}`);
  // 语义断言:凡 warning 冲突，其 message 必标注「同类孪生」。
  for (const f of warnColls) {
    assert.ok(/同类孪生/.test(f.message), `warning 冲突应标注同类孪生: ${f.message}`);
  }
});

test('门控关 → 空 findings（运行时入口可隐藏）', () => {
  const out = auditTools({}, { KHY_TOOL_CONTRACT: 'off' });
  assert.deepStrictEqual(out, { findings: [], errors: 0, warnings: 0, total: 0 });
  assert.strictEqual(toolContractEnabled({ KHY_TOOL_CONTRACT: 'off' }), false);
});

test('真实注册表:参数级审计——0 悬垂 required，参数警告全清零', () => {
  // 参数级审计(子门控 KHY_TOOL_PARAM_AUDIT 默认开)是「每个工具都能达到预期目的」的更深防线:
  //   悬垂 required = error(该 tool call 被 API 拒绝) → 绝不容忍;
  //   缺 description / 缺 type / required 却带 default / array 却无 items = warning
  //   (模型难以正确填或易填错元素形状) → 全表清零并锁定为守卫不变量。
  const out = auditTools({});
  const paramFindings = out.findings.filter((f) => f.rule === 'param');
  const dangling = paramFindings.filter((f) => f.severity === 'error');
  const paramWarn = paramFindings.filter((f) => f.severity === 'warning');
  if (dangling.length) {
    assert.fail(`发现 ${dangling.length} 处悬垂 required:\n` + dangling.map((f) => `  ${f.tool} :: ${f.message}`).join('\n'));
  }
  if (paramWarn.length) {
    assert.fail(`发现 ${paramWarn.length} 处参数警告（缺 description/type、required+default、array 缺 items，应修）:\n` + paramWarn.map((f) => `  ${f.tool} :: ${f.message}`).join('\n'));
  }
  assert.strictEqual(paramFindings.length, 0);
});

test('子门控 KHY_TOOL_PARAM_AUDIT 关 → 参数 findings 消失（字节回退未加此层前的集合）', () => {
  const off = auditTools({}, { KHY_TOOL_PARAM_AUDIT: 'off' });
  assert.strictEqual(off.findings.filter((f) => f.rule === 'param').length, 0);
  assert.strictEqual(off.errors, 0);
});

test('真实注册表:gitBlame 已注册且合契约（补全 git 只读族）', () => {
  const map = require('../../src/tools').getAll();
  const tools = (map && typeof map.values === 'function') ? Array.from(map.values()) : map;
  const blame = tools.find((t) => t && t.name === 'gitBlame');
  assert.ok(blame, 'gitBlame 应已被自动发现注册');
  assert.strictEqual(blame.category, 'git');
  assert.strictEqual(blame.risk, 'safe');
});
