'use strict';

/**
 * metaPlanSubsystem.test.js — 目标11 元规划/动态约束 子系统验收测试。
 *
 * Covers the goal's §6 verification ("同一个任务，在不同的风险判断下，会生成不同的
 * 策略") plus every 防呆 rule:
 *   - meta-plan must precede execution (防呆①)
 *   - executors must come from the registry (防呆: 不可凭空捏造)
 *   - Prompt_Soft without a real dissent auto-escalates (拒绝偷懒)
 *   - same JS task: low-risk comment edit (Soft) vs async-refactor (Hard) → different
 *     strategies AND different mounted constraints
 *   - Code_Hard genuinely rejects broken JS (real AST interceptor)
 *   - 2 consecutive Soft mis-judgments → whole-session forced Code_Hard
 *   - constitutional red line forces System_Block regardless of the model's choice
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  MetaPlanCoordinator,
  constraintStrategy: S,
  executorRegistry: registry,
  metaPlanSchema: schema,
  constraintInjection: injection,
  constitutionalRedLines: redLines,
  TrustCircuitBreaker,
} = require('../../../src/services/metaplan');

const SOFT = S.STRATEGIES.PROMPT_SOFT;
const HARD = S.STRATEGIES.CODE_HARD;
const BLOCK = S.STRATEGIES.SYSTEM_BLOCK;

// A dissent long enough to clear the anti-laziness threshold.
const GOOD_DISSENT = '仅修改行内注释文本，不触及任何 AST 节点，绝不改变控制流或语义。';

describe('constraintStrategy — 单调升级阶梯', () => {
  test('escalate 取更严者（LUB），override 只能加锁', () => {
    assert.equal(S.escalate(SOFT, HARD), HARD);
    assert.equal(S.escalate(HARD, SOFT), HARD);
    assert.equal(S.escalate(HARD, BLOCK), BLOCK);
    assert.equal(S.escalate(SOFT, SOFT), SOFT);
  });
  test('未知策略按最严处理（fail-safe）', () => {
    assert.equal(S.rankOf('???'), S.rankOf(BLOCK));
  });
});

describe('executorRegistry — 武器库单一真源 (§4)', () => {
  test('schema 的 toolchain enum == 注册表 ids', () => {
    const sc = schema.buildMetaPlanSchema();
    assert.deepEqual(sc.properties.toolchain.items.enum, registry.executorIds());
  });
  test('防呆：未注册执行器被拒', () => {
    const v = registry.validateToolchain(['totally_made_up_writer']);
    assert.equal(v.valid, false);
    assert.match(v.reason, /未注册/);
  });
  test('防呆：空 toolchain 被拒', () => {
    assert.equal(registry.validateToolchain([]).valid, false);
  });
  test('裸执行器无 AST 安全网', () => {
    assert.equal(registry.toolchainHasUnguarded(['raw_string_injector']), true);
    assert.equal(registry.toolchainHasUnguarded(['js_babel_writer']), false);
  });
});

describe('metaPlanSchema — 解析与防偷懒升级 (§2)', () => {
  test('防呆①：无法解析元规划即拒绝（先规划后执行）', () => {
    const r = schema.parseMetaPlan('这是一段没有 JSON 的自然语言');
    assert.equal(r.ok, false);
    assert.match(r.error, /防呆①/);
  });

  test('Prompt_Soft 且论证充分 → 保持 Soft', () => {
    const v = schema.validateMetaPlan({
      toolchain: ['raw_string_injector'],
      constraint_strategy: SOFT,
      risk_dissent: GOOD_DISSENT,
    });
    assert.equal(v.valid, true);
    assert.equal(v.normalized.constraint_strategy, SOFT);
    assert.equal(v.normalized.escalations.length, 0);
  });

  test('拒绝偷懒：Prompt_Soft 但论证缺失 → 自动升级 Code_Hard', () => {
    const v = schema.validateMetaPlan({
      toolchain: ['raw_string_injector'],
      constraint_strategy: SOFT,
      risk_dissent: '安全', // too short
    });
    assert.equal(v.valid, true);
    assert.equal(v.normalized.declared_strategy, SOFT);
    assert.equal(v.normalized.constraint_strategy, HARD);
    assert.ok(v.normalized.escalations.length >= 1);
  });

  test('非法策略枚举被拒', () => {
    const v = schema.validateMetaPlan({
      toolchain: ['js_babel_writer'],
      constraint_strategy: 'YOLO',
    });
    assert.equal(v.valid, false);
  });
});

describe('constraintInjection — 按需配发锁具 (§3)', () => {
  test('Soft 不挂载任何拦截器（极速路径）', () => {
    const inj = injection.resolveInjection({ toolchain: ['raw_string_injector'], constraint_strategy: SOFT });
    assert.equal(inj.mountInterceptors, false);
    assert.equal(inj.validators.length, 0);
    assert.ok(inj.promptHint.length > 0);
  });
  test('Hard 挂载执行器拦截器', () => {
    const inj = injection.resolveInjection({ toolchain: ['js_babel_writer'], constraint_strategy: HARD });
    assert.equal(inj.mountInterceptors, true);
    assert.equal(inj.validators[0].validator, 'babel');
  });
  test('Block 要求快照 + 确认', () => {
    const inj = injection.resolveInjection({ toolchain: ['js_babel_writer'], constraint_strategy: BLOCK });
    assert.equal(inj.requireSnapshot, true);
    assert.equal(inj.requireConfirmation, true);
  });
  test('Hard 真校验：坏 JS 被打回，好 JS 通过', () => {
    const plan = { toolchain: ['js_babel_writer'], constraint_strategy: HARD };
    const bad = injection.runHardValidation(plan, 'const x = (', { language: 'javascript' });
    assert.equal(bad.passed, false);
    assert.ok(bad.violations.length >= 1);
    const good = injection.runHardValidation(plan, 'const x = 1;\nfunction f(){ return x; }', { language: 'javascript' });
    assert.equal(good.passed, true);
  });
});

describe('constitutionalRedLines — 不可覆盖的红线 (§5)', () => {
  test('drop database 强制 System_Block', () => {
    const r = redLines.enforce(SOFT, { command: 'mysql -e "DROP DATABASE prod"' });
    assert.equal(r.strategy, BLOCK);
    assert.equal(r.redLine.rule, 'db_destruction');
  });
  test('删除 .env 机密文件 强制 System_Block', () => {
    const r = redLines.enforce(SOFT, { tool: 'deleteFile', params: { path: '/app/.env' } });
    assert.equal(r.strategy, BLOCK);
    assert.equal(r.redLine.rule, 'secret_exposure');
  });
  test('清空 package.json 强制 System_Block', () => {
    const r = redLines.enforce(HARD, { tool: 'writeFile', params: { path: '/app/package.json', content: '' } });
    assert.equal(r.strategy, BLOCK);
    assert.equal(r.redLine.rule, 'package_core_delete');
  });
  test('普通操作不触红线', () => {
    const r = redLines.enforce(SOFT, { tool: 'writeFile', params: { path: '/app/src/util.js', content: 'const a=1;' } });
    assert.equal(r.redLine, null);
    assert.equal(r.strategy, SOFT);
  });
});

describe('trustCircuitBreaker — 信任熔断 (§5 闭环自愈)', () => {
  test('Soft 翻车 → 同类型后续强制 Code_Hard', () => {
    const b = new TrustCircuitBreaker();
    b.recordOutcome({ ok: false, declaredStrategy: SOFT, taskType: 'edit:javascript', error: 'SyntaxError' });
    const eff = b.effectiveStrategy(SOFT, 'edit:javascript');
    assert.equal(eff.strategy, HARD);
    assert.equal(eff.floored, true);
  });
  test('其它类型不受牵连', () => {
    const b = new TrustCircuitBreaker();
    b.recordOutcome({ ok: false, declaredStrategy: SOFT, taskType: 'edit:javascript', error: 'x' });
    assert.equal(b.effectiveStrategy(SOFT, 'edit:python').floored, false);
  });
  test('连续 2 次 Soft 翻车 → 全会话强制 Code_Hard', () => {
    const b = new TrustCircuitBreaker();
    b.recordOutcome({ ok: false, declaredStrategy: SOFT, taskType: 'edit:javascript', error: 'x' });
    b.recordOutcome({ ok: false, declaredStrategy: SOFT, taskType: 'edit:python', error: 'y' });
    assert.equal(b.isSessionLocked(), true);
    // even a brand-new task type is now floored
    assert.equal(b.effectiveStrategy(SOFT, 'edit:go').strategy, HARD);
  });
  test('Hard 下失败不算误判（安全网生效，非信任违约）', () => {
    const b = new TrustCircuitBreaker();
    b.recordOutcome({ ok: false, declaredStrategy: HARD, taskType: 'edit:javascript', error: 'x' });
    assert.equal(b.isSessionLocked(), false);
    assert.equal(b.effectiveStrategy(SOFT, 'edit:javascript').floored, false);
  });
  test('Soft 成功重置连击计数', () => {
    const b = new TrustCircuitBreaker();
    b.recordOutcome({ ok: false, declaredStrategy: SOFT, taskType: 'edit:javascript', error: 'x' });
    b.recordOutcome({ ok: true, declaredStrategy: SOFT, taskType: 'edit:javascript' });
    b.recordOutcome({ ok: false, declaredStrategy: SOFT, taskType: 'edit:python', error: 'y' });
    assert.equal(b.isSessionLocked(), false); // streak broke, not 2-in-a-row
  });
});

describe('MetaPlanCoordinator — §6 端到端：同一任务不同风险 → 不同策略', () => {
  test('低风险改注释 → Prompt_Soft，跳过校验', () => {
    const c = new MetaPlanCoordinator();
    const action = { taskType: 'edit:javascript', language: 'javascript', tool: 'editFile', params: { path: '/app/src/a.js' } };
    const out = c.ingestMetaPlan(JSON.stringify({
      toolchain: ['raw_string_injector'],
      constraint_strategy: SOFT,
      risk_dissent: GOOD_DISSENT,
    }), action);
    assert.equal(out.ok, true);
    assert.equal(out.ticket.effectiveStrategy, SOFT);
    const v = c.validateExecution(out.ticket, { content: '// 这里随便写都不校验 const = (', language: 'javascript' });
    assert.equal(v.allowed, true);
    assert.equal(v.ranValidation, false); // Soft 不校验
  });

  test('同一文件高风险重构异步控制流 → Code_Hard，真校验拦截坏代码', () => {
    const c = new MetaPlanCoordinator();
    const action = { taskType: 'refactor:javascript', language: 'javascript', tool: 'editFile', params: { path: '/app/src/a.js' } };
    const out = c.ingestMetaPlan(JSON.stringify({
      toolchain: ['js_babel_writer'],
      constraint_strategy: HARD,
      risk_dissent: '',
    }), action);
    assert.equal(out.ok, true);
    assert.equal(out.ticket.effectiveStrategy, HARD);
    // broken async refactor is rejected by the real babel interceptor
    const bad = c.validateExecution(out.ticket, { content: 'async function f(){ await (', language: 'javascript' });
    assert.equal(bad.allowed, false);
    assert.ok(bad.violations.length >= 1);
    // a correct refactor passes
    const good = c.validateExecution(out.ticket, { content: 'async function f(){ await g(); return 1; }', language: 'javascript' });
    assert.equal(good.allowed, true);
  });

  test('防呆①：没有元规划 JSON → 拒绝执行', () => {
    const c = new MetaPlanCoordinator();
    const out = c.ingestMetaPlan('我直接开始改代码了', { taskType: 'edit:javascript' });
    assert.equal(out.ok, false);
    assert.match(out.error, /防呆①|元规划/);
  });

  test('防呆：捏造执行器 → 拒绝', () => {
    const c = new MetaPlanCoordinator();
    const out = c.ingestMetaPlan(JSON.stringify({
      toolchain: ['ghost_writer_9000'],
      constraint_strategy: HARD,
    }), { taskType: 'edit:javascript' });
    assert.equal(out.ok, false);
  });

  test('拒绝偷懒：Soft 无论证在协调器层也升级为 Hard', () => {
    const c = new MetaPlanCoordinator();
    const out = c.ingestMetaPlan(JSON.stringify({
      toolchain: ['raw_string_injector'],
      constraint_strategy: SOFT,
      risk_dissent: 'ok',
    }), { taskType: 'edit:javascript', language: 'javascript' });
    assert.equal(out.ticket.declaredStrategy, SOFT);
    assert.equal(out.ticket.effectiveStrategy, HARD);
    assert.ok(out.ticket.overrides.length >= 1);
  });

  test('宪法红线覆盖模型选择：删库即便选 Soft 也强制 System_Block', () => {
    const c = new MetaPlanCoordinator();
    const out = c.ingestMetaPlan(JSON.stringify({
      toolchain: ['raw_string_injector'],
      constraint_strategy: SOFT,
      risk_dissent: GOOD_DISSENT,
    }), { taskType: 'shell', tool: 'runShell', command: 'rm /var/data/app.sqlite' });
    assert.equal(out.ok, true);
    assert.equal(out.ticket.effectiveStrategy, BLOCK);
    assert.ok(out.ticket.redLine);
    // Block path demands snapshot + confirm before any execution
    const v = c.validateExecution(out.ticket, { content: '', language: '' });
    assert.equal(v.requireSnapshot, true);
    assert.equal(v.requireConfirmation, true);
  });

  test('闭环自愈：Soft 翻车后，协调器对同类型任务强制 Code_Hard', () => {
    const c = new MetaPlanCoordinator();
    const action = { taskType: 'edit:javascript', language: 'javascript' };
    const first = c.ingestMetaPlan(JSON.stringify({
      toolchain: ['raw_string_injector'], constraint_strategy: SOFT, risk_dissent: GOOD_DISSENT,
    }), action);
    assert.equal(first.ticket.effectiveStrategy, SOFT);
    // execution fails → trust deducted
    c.recordExecutionOutcome(first.ticket, { ok: false, error: 'SyntaxError: unexpected token' });
    // next same-type Soft bet is now floored to Hard by the breaker
    const second = c.ingestMetaPlan(JSON.stringify({
      toolchain: ['raw_string_injector'], constraint_strategy: SOFT, risk_dissent: GOOD_DISSENT,
    }), action);
    assert.equal(second.ticket.effectiveStrategy, HARD);
    assert.ok(second.ticket.overrides.some((o) => /翻车|强制 Code_Hard|熔断/.test(o)));
  });

  test('缺失票据 → validateExecution 拒绝（防呆①兜底）', () => {
    const c = new MetaPlanCoordinator();
    const v = c.validateExecution(null, { content: 'x', language: 'javascript' });
    assert.equal(v.allowed, false);
    assert.equal(v.requireSnapshot, true);
  });
});
