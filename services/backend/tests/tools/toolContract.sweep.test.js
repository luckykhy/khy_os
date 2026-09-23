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

const { auditTools, toolContractEnabled } = require('../../src/services/domain/catalog/toolCatalog/toolContract.js');

// Debt ledger baselines (scripts/ci/debt-ledger.json). The audit's fallback
// require path pointed at a module that no longer exports getAll → try/catch
// swallowed it → total:0, so every "真实注册表" assertion below passed VACUOUSLY
// against zero tools (a silent no-op defense). Fixing the path (→ src/tools,
// 187 real tools) made the defense live; these constants pin the pre-existing
// registry debt it then revealed so NEW violations fail, while the actual
// cleanup (naming decisions on the twin tools) awaits a human call (task #37).
const KNOWN_COLLISION_ERRORS = 7; // toolContract.naming-collision-error → target 0
const KNOWN_PARAM_WARNINGS = 4; // toolContract.param-warning → target 0

test('真实注册表:0 shape/schema error + 命名冲突不超基线', () => {
  const out = auditTools({}); // 缺省 → 真实 require('../../src/tools').getAll + SSOT
  assert.ok(out.total > 0, '注册表应有工具');
  const errs = out.findings.filter((f) => f.severity === 'error');
  const shape = errs.filter((f) => f.rule !== 'collision');
  const collision = errs.filter((f) => f.rule === 'collision');
  // shape/schema 类零容忍：坏工具、坏 schema 一律阻断。
  if (shape.length) {
    assert.fail(`发现 ${shape.length} 处 shape/schema error（零容忍）:\n` +
      shape.map((f) => `  [${f.rule}] ${f.tool} :: ${f.message}`).join('\n'));
  }
  // 命名冲突为存量债，钉基线棘轮：>基线即回归。
  if (collision.length > KNOWN_COLLISION_ERRORS) {
    assert.fail(`命名冲突 error ${collision.length} 超基线 ${KNOWN_COLLISION_ERRORS}（新增即回归，见 debt-ledger）:\n` +
      collision.map((f) => `  [collision] ${f.tool} :: ${f.message}`).join('\n'));
  }
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

test('真实注册表:0 悬垂 required，参数警告不超基线', () => {
  // 参数级审计(子门控 KHY_TOOL_PARAM_AUDIT 默认开)是「每个工具都能达到预期目的」的更深防线:
  //   悬垂 required = error(该 tool call 被 API 拒绝) → 绝不容忍;
  //   缺 description / 缺 type / required 却带 default / array 却无 items = warning
  //   (模型难以正确填或易填错元素形状) → 钉基线棘轮，存量清一处降一档（debt-ledger toolContract.param-warning）。
  const out = auditTools({});
  const paramFindings = out.findings.filter((f) => f.rule === 'param');
  const dangling = paramFindings.filter((f) => f.severity === 'error');
  const paramWarn = paramFindings.filter((f) => f.severity === 'warning');
  if (dangling.length) {
    assert.fail(`发现 ${dangling.length} 处悬垂 required（零容忍）:\n` + dangling.map((f) => `  ${f.tool} :: ${f.message}`).join('\n'));
  }
  if (paramWarn.length > KNOWN_PARAM_WARNINGS) {
    assert.fail(`参数警告 ${paramWarn.length} 超基线 ${KNOWN_PARAM_WARNINGS}（新增即回归，应修）:\n` + paramWarn.map((f) => `  ${f.tool} :: ${f.message}`).join('\n'));
  }
});

test('子门控 KHY_TOOL_PARAM_AUDIT 关 → 参数 findings 消失（字节回退未加此层前的集合）', () => {
  const on = auditTools({});
  const off = auditTools({}, { KHY_TOOL_PARAM_AUDIT: 'off' });
  // 关掉参数层只移除 param findings；collision 等非 param findings 原样保留。
  assert.strictEqual(off.findings.filter((f) => f.rule === 'param').length, 0);
  const onNonParam = on.findings.filter((f) => f.rule !== 'param');
  assert.strictEqual(off.findings.length, onNonParam.length);
  assert.strictEqual(off.errors, onNonParam.filter((f) => f.severity === 'error').length);
});

test('真实注册表:gitBlame 已注册且合契约（补全 git 只读族）', () => {
  const map = require('../../src/tools').getAll();
  const tools = (map && typeof map.values === 'function') ? Array.from(map.values()) : map;
  const blame = tools.find((t) => t && t.name === 'gitBlame');
  assert.ok(blame, 'gitBlame 应已被自动发现注册');
  assert.strictEqual(blame.category, 'git');
  assert.strictEqual(blame.risk, 'safe');
});
