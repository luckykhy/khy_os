'use strict';

/**
 * onboardingPlan.test.js — 纯叶子 `/onboarding` 逻辑单一真源测试(零 IO·确定性·绝不抛)。
 * 覆盖:parseOnboardingArgs 全语法 + 空参=full + 别名 + 未知;describeStep/isStepAvailable;
 * buildUnavailableText(trust 诚实)；buildStatusText 缺面诚实留白;build*Text 渲染器;isEnabled 门控梯。
 */

const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../../../src/services/onboarding/onboardingPlan');

test('parseOnboardingArgs: 空参 → full', () => {
  const p = leaf.parseOnboardingArgs([]);
  assert.strictEqual(p.step, 'full');
  assert.strictEqual(p.valid, true);
  assert.strictEqual(p.parseError, null);
});

test('parseOnboardingArgs: undefined/非数组不抛 → full', () => {
  assert.strictEqual(leaf.parseOnboardingArgs(undefined).step, 'full');
  assert.strictEqual(leaf.parseOnboardingArgs(null).step, 'full');
  assert.strictEqual(leaf.parseOnboardingArgs('nope').step, 'full');
});

test('parseOnboardingArgs: full 别名', () => {
  for (const w of ['full', 'all', 'wizard', '全部', '完整', '引导']) {
    assert.strictEqual(leaf.parseOnboardingArgs([w]).step, 'full', `word=${w}`);
  }
});

test('parseOnboardingArgs: theme/model/mcp/status/trust 别名', () => {
  assert.strictEqual(leaf.parseOnboardingArgs(['theme']).step, 'theme');
  assert.strictEqual(leaf.parseOnboardingArgs(['主题']).step, 'theme');
  assert.strictEqual(leaf.parseOnboardingArgs(['model']).step, 'model');
  assert.strictEqual(leaf.parseOnboardingArgs(['供应商']).step, 'model');
  assert.strictEqual(leaf.parseOnboardingArgs(['mcp']).step, 'mcp');
  assert.strictEqual(leaf.parseOnboardingArgs(['status']).step, 'status');
  assert.strictEqual(leaf.parseOnboardingArgs(['状态']).step, 'status');
  assert.strictEqual(leaf.parseOnboardingArgs(['trust']).step, 'trust');
  assert.strictEqual(leaf.parseOnboardingArgs(['信任']).step, 'trust');
});

test('parseOnboardingArgs: rest 透传', () => {
  const p = leaf.parseOnboardingArgs(['theme', 'dracula']);
  assert.strictEqual(p.step, 'theme');
  assert.deepStrictEqual(p.rest, ['dracula']);
});

test('parseOnboardingArgs: help/-h/--help → help', () => {
  assert.strictEqual(leaf.parseOnboardingArgs(['help']).step, 'help');
  assert.strictEqual(leaf.parseOnboardingArgs(['-h']).step, 'help');
  assert.strictEqual(leaf.parseOnboardingArgs(['--help']).step, 'help');
});

test('parseOnboardingArgs: 未知 → valid:false unknown_step(兜底 status)', () => {
  const p = leaf.parseOnboardingArgs(['frobnicate']);
  assert.strictEqual(p.valid, false);
  assert.strictEqual(p.parseError, 'unknown_step');
  assert.strictEqual(p.step, 'status');
});

test('isStepAvailable: 所有已知步骤均可用(含 trust,已接真实 workspace-trust)', () => {
  for (const s of ['full', 'theme', 'trust', 'model', 'mcp', 'status']) {
    assert.strictEqual(leaf.isStepAvailable(s), true, `step=${s}`);
  }
  assert.strictEqual(leaf.isStepAvailable('zzz'), false);
});

test('describeStep: 元数据 + 未知步骤安全占位', () => {
  const m = leaf.describeStep('mcp');
  assert.strictEqual(m.available, true);
  assert.strictEqual(m.runnable, false);
  assert.match(m.title, /MCP/);
  const t = leaf.describeStep('trust');
  assert.strictEqual(t.available, true);
  assert.strictEqual(t.runnable, true);
  assert.match(t.title, /folder trust/);
  const u = leaf.describeStep('zzz');
  assert.strictEqual(u.available, false);
  assert.strictEqual(u.runnable, false);
});

test('buildUnavailableText: 通用兜底(不再声称 khy 无信任机制)', () => {
  const txt = leaf.buildUnavailableText('zzz');
  assert.match(txt, /暂不可用/);
  assert.doesNotMatch(txt, /暂无此机制/);
});

test('buildTrustStatusText: 渲染门控/信任/持久化各字段,缺面留白,绝不抛', () => {
  const on = leaf.buildTrustStatusText({
    gateEnabled: true, cwd: '/home/u/proj', trusted: true, reason: 'persisted',
    isHomeDir: false, persistedCount: 2,
  });
  assert.match(on, /文件夹信任/);
  assert.match(on, /当前目录: \/home\/u\/proj/);
  assert.match(on, /信任门控\(KHY_WORKSPACE_TRUST\): 开/);
  assert.match(on, /当前目录已信任: 是（已持久化信任/);
  assert.match(on, /已持久化信任目录: 2 个/);
  assert.match(on, /\/permissions/);

  const off = leaf.buildTrustStatusText({
    gateEnabled: false, cwd: '/x', trusted: undefined, persistedCount: 0,
  });
  assert.match(off, /信任门控\(KHY_WORKSPACE_TRUST\): 关/);
  assert.match(off, /当前目录已信任: 未知/);

  const home = leaf.buildTrustStatusText({
    gateEnabled: true, cwd: '/home/u', trusted: false, reason: 'untrusted',
    isHomeDir: true, persistedCount: 0,
  });
  assert.match(home, /home 目录/);
  assert.match(home, /当前目录已信任: 否（尚未信任）/);

  // 缺面 / 坏输入诚实留白,绝不抛。
  assert.doesNotThrow(() => leaf.buildTrustStatusText(null));
  assert.doesNotThrow(() => leaf.buildTrustStatusText('x'));
  assert.match(leaf.buildTrustStatusText({}), /当前目录: 未知/);
});

test('buildStatusText: 缺面诚实留白,绝不抛', () => {
  const txt = leaf.buildStatusText({});
  assert.match(txt, /引导状态/);
  assert.match(txt, /引导完成标记: 未知/);
  assert.match(txt, /当前主题: 未知/);
  assert.doesNotThrow(() => leaf.buildStatusText(null));
  assert.doesNotThrow(() => leaf.buildStatusText('x'));
});

test('buildStatusText: 有面渲染各字段', () => {
  const txt = leaf.buildStatusText({
    onboardingDone: true, configured: true, activeTheme: 'dracula',
    gettingStartedPending: false, mcpServerCount: 3,
  });
  assert.match(txt, /引导完成标记: 是/);
  assert.match(txt, /已配置模型供应商: 是/);
  assert.match(txt, /当前主题: dracula/);
  assert.match(txt, /Getting-Started 待展示: 否/);
  assert.match(txt, /MCP 工具服务: 3 个已配置/);
});

test('buildStepHeader / buildHelpText / buildUnknownStepText', () => {
  assert.match(leaf.buildStepHeader('theme'), /引导步骤/);
  const h = leaf.buildHelpText();
  assert.match(h, /\/onboarding theme/);
  assert.match(h, /\/onboarding status/);
  assert.match(h, /\/onboarding trust/);
  assert.doesNotMatch(h, /trust.*暂不可用/); // trust 现已可用,不再带「暂不可用」标签
  assert.match(leaf.buildUnknownStepText('xyz'), /未知引导步骤:xyz/);
});

test('isEnabled: 默认开;0/false/off/no/空 → 关', () => {
  assert.strictEqual(leaf.isEnabled({}), true);
  assert.strictEqual(leaf.isEnabled(undefined), true);
  assert.strictEqual(leaf.isEnabled({ KHY_ONBOARDING_COMMAND: 'true' }), true);
  for (const v of ['0', 'false', 'off', 'no', '']) {
    assert.strictEqual(leaf.isEnabled({ KHY_ONBOARDING_COMMAND: v }), false, `v=${v}`);
  }
});
