'use strict';

/**
 * OPS-MAN-162 接线验证 + 守卫:management/parityGuard 叶 → CI CLI/Web 管理面平价守卫。
 *
 * parityGuard.js(checkParity)是一枚**全实现的纯只读不变量核验器**,其文件头声明它
 * 「证明 CLI 与 Web 通过同一漏斗管理同一批资源,两个面永不矛盾」——但此前**没有任何守卫
 * 消费它**,能力完全休眠(仓库零生产消费者,只有自身单测)。本守卫就是它设计意图里缺失
 * 的那个消费者:把三条平价不变量(source 唯一性 / CLI 子命令平价 / op 可达性)在 CI/提交
 * 期锁成硬门,未来任何一面(新增 manage 子命令、注册表改资源、能力少实现)悄悄漂移都会亮红。
 *
 * 服务送别礼「能力存在但没接线 → 负责接线」+ 直接护住「网页中代理」等 Web 管理面与 CLI 的
 * 一致性:两个面都走 registry.invoke / registry.describe 单一契约,本守卫锁死该契约不被单面破坏。
 *
 * ★零运行时改动、零门控(纯审计原语,同 OPS-155 directiveRegistryAudit 模式):
 *   接线 = 给能力一个真消费者(本守卫 + 登记进 test:maintainer:safety)。
 *
 * node:test 风格(可 `node --test <file>`)。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { checkParity } = require('../../../src/services/management/parityGuard');

// ── 叶纯函数单元:用 deps 注入伪 registry/schema 证明每类违例都被检出(守卫有牙) ──

/** 构造一个一致的最小 registry + schema:两资源、source 各异、能力均有实现。 */
function makeConsistentDeps() {
  const contracts = {
    alpha: {
      capabilities: ['list', 'add'],
      ops: { list: () => {}, add: () => {} },
    },
    beta: {
      capabilities: ['list'],
      ops: { list: () => {} },
    },
  };
  const matrix = [
    { id: 'alpha', source: 'file', sourceDetail: 'a.json' },
    { id: 'beta', source: 'file', sourceDetail: 'b.json' },
  ];
  const registry = {
    describe: () => matrix.map((r) => ({ ...r })),
    get: (id) => contracts[id] || null,
  };
  const commandSchema = {
    getRouterSubCommands: () => ({ manage: ['list', 'alpha', 'beta'] }),
  };
  return { registry, commandSchema };
}

test('checkParity: 一致的 CLI/Web 契约 → ok=true,errors 空', () => {
  const r = checkParity(makeConsistentDeps());
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.errors, []);
});

test('checkParity: 检出 SOURCE_CONFLICT(两资源绑同一 source-of-truth)', () => {
  const deps = makeConsistentDeps();
  const base = deps.registry.describe();
  // 让 beta 与 alpha 绑同一 source:模拟 dataHome 式双根漂移
  deps.registry.describe = () => [
    base[0],
    { id: 'beta', source: 'file', sourceDetail: 'a.json' },
  ];
  const r = checkParity(deps);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('SOURCE_CONFLICT')), r.errors.join('; '));
});

test('checkParity: 检出 CLI_PARITY(manage 子命令集合 != 注册表资源)', () => {
  const deps = makeConsistentDeps();
  // CLI 少暴露 beta:Web 能管 beta 但 CLI 不能 → 两面矛盾
  deps.commandSchema.getRouterSubCommands = () => ({ manage: ['list', 'alpha'] });
  const r = checkParity(deps);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('CLI_PARITY')), r.errors.join('; '));
});

test("checkParity: 检出 manage 缺 'list' 子命令", () => {
  const deps = makeConsistentDeps();
  deps.commandSchema.getRouterSubCommands = () => ({ manage: ['alpha', 'beta'] });
  const r = checkParity(deps);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("must include 'list'")), r.errors.join('; '));
});

test('checkParity: 检出 NO_IMPL(声明的能力无 ops 实现 → 面上可见但不可达)', () => {
  const deps = makeConsistentDeps();
  const contracts = {
    alpha: { capabilities: ['list', 'add'], ops: { list: () => {} } }, // add 无实现
    beta: { capabilities: ['list'], ops: { list: () => {} } },
  };
  deps.registry.get = (id) => contracts[id] || null;
  const r = checkParity(deps);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('NO_IMPL') && e.includes('alpha.add')), r.errors.join('; '));
});

test('checkParity: 检出 NO_CAPABILITIES(资源声明零能力)', () => {
  const deps = makeConsistentDeps();
  const contracts = {
    alpha: { capabilities: [], ops: {} },
    beta: { capabilities: ['list'], ops: { list: () => {} } },
  };
  deps.registry.get = (id) => contracts[id] || null;
  const r = checkParity(deps);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('NO_CAPABILITIES')), r.errors.join('; '));
});

test('checkParity: 检出 MISSING_CONTRACT(describe 列了但 get 返回 nothing)', () => {
  const deps = makeConsistentDeps();
  deps.registry.get = (id) => (id === 'alpha' ? deps.registry._alpha : null);
  // alpha 的契约缺失
  deps.registry._alpha = null;
  const r = checkParity(deps);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('MISSING_CONTRACT')), r.errors.join('; '));
});

// ── 接线守卫:真 registry + 真 commandSchema(生产 CLI/Web 平价不变量) ──────────

test('WIRING GUARD: 真 management registry 与 commandSchema 三条平价不变量全成立', () => {
  // deps 不传 → checkParity 走 require('./index') + require('../../constants/commandSchema')
  const result = checkParity();
  assert.deepStrictEqual(
    result.errors, [],
    'CLI/Web 管理面平价被破坏:' + result.errors.join(' | ')
  );
  assert.strictEqual(result.ok, true, 'management parity drift detected');
});
