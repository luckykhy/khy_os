'use strict';

/**
 * flag-registry.test.js — flagRegistryGuard 结构守卫的单元测试(node:test)。
 *
 * 背景(goal 2026-07-03「khy 中有许多规则但是缺乏优先级,我希望能完善」):守卫把 flagRegistry
 * 声明式表的结构不变量(parent 存在、无环、mode/off/numeric 合法)固化成机器检查。本测证:
 *   ① 真实注册表 + 真实守卫 ⇒ 零 error(自净,这是发布门禁的前提);
 *   ② 各类坏表(悬垂 parent / 环 / 非法 mode / 非法 off / numeric 边界倒挂)各被点名;
 *   ③ 输出确定性(乱序输入 → 稳定排序);④ 门控关 ⇒ 空 findings。
 */

const test = require('node:test');
const assert = require('node:assert');

const guard = require('../lib/flagRegistryGuard');
const realRegistry = require('../../services/backend/src/services/flagRegistry');

// 构造一个「像注册表」的注入对象(listFlags + 名白名单),用于喂坏表。
function mkRegistry(FLAGS) {
  return {
    FLAGS,
    listFlags: () => Object.keys(FLAGS).sort().map((name) => ({ name, ...FLAGS[name] })),
    OFF_WORDS: { CANON: 1, EXTENDED: 1, MINIMAL: 1 },
    VALID_MODES: new Set(['default-on', 'opt-in', 'numeric']),
    VALID_OFF_NAMES: new Set(['CANON', 'EXTENDED', 'MINIMAL']),
  };
}
const rulesOf = (findings) => findings.map((f) => f.rule);

test('自净:真实 flagRegistry + 真实守卫 ⇒ 零 error', () => {
  const { findings } = guard.assess({ registry: realRegistry });
  const errors = findings.filter((f) => f.severity === 'error');
  assert.strictEqual(errors.length, 0, `期望零 error,实得: ${JSON.stringify(errors)}`);
});

test('悬垂 parent ⇒ parent-exists error', () => {
  const reg = mkRegistry({ A: { mode: 'default-on', off: 'CANON', default: true, parent: 'GHOST' } });
  const { findings } = guard.assess({ registry: reg });
  assert.ok(rulesOf(findings).includes('parent-exists'), JSON.stringify(findings));
  assert.strictEqual(findings[0].severity, 'error');
});

test('parent 成环 A→B→A ⇒ no-cycles error(只报一次)', () => {
  const reg = mkRegistry({
    A: { mode: 'default-on', off: 'CANON', default: true, parent: 'B' },
    B: { mode: 'default-on', off: 'CANON', default: true, parent: 'A' },
  });
  const cyc = guard.assess({ registry: reg }).findings.filter((f) => f.rule === 'no-cycles');
  assert.strictEqual(cyc.length, 1, `环应只报一次,实得 ${cyc.length}`);
});

test('自环 A→A ⇒ no-cycles error', () => {
  const reg = mkRegistry({ A: { mode: 'default-on', off: 'CANON', default: true, parent: 'A' } });
  const cyc = guard.assess({ registry: reg }).findings.filter((f) => f.rule === 'no-cycles');
  assert.strictEqual(cyc.length, 1);
});

test('非法 mode ⇒ valid-shape error', () => {
  const reg = mkRegistry({ A: { mode: 'nonsense', default: true } });
  assert.ok(rulesOf(guard.assess({ registry: reg }).findings).includes('valid-shape'));
});

test('default-on 非法 off 名 ⇒ valid-shape error', () => {
  const reg = mkRegistry({ A: { mode: 'default-on', off: 'NOPE', default: true } });
  assert.ok(rulesOf(guard.assess({ registry: reg }).findings).includes('valid-shape'));
});

test('numeric min>max ⇒ valid-shape error', () => {
  const reg = mkRegistry({ A: { mode: 'numeric', default: 5, min: 10, max: 2 } });
  const shape = guard.assess({ registry: reg }).findings.filter((f) => f.rule === 'valid-shape');
  assert.ok(shape.length >= 1);
  assert.ok(shape.some((f) => /倒挂/.test(f.message)));
});

test('numeric default 越界 ⇒ valid-shape error', () => {
  const reg = mkRegistry({ A: { mode: 'numeric', default: 99, min: 0, max: 10 } });
  assert.ok(rulesOf(guard.assess({ registry: reg }).findings).includes('valid-shape'));
});

test('干净种子表 ⇒ 零 findings', () => {
  const reg = mkRegistry({
    P: { mode: 'default-on', off: 'CANON', default: true },
    C: { mode: 'default-on', off: 'EXTENDED', default: true, parent: 'P' },
    N: { mode: 'numeric', default: 1, min: 0, max: 10 },
  });
  assert.strictEqual(guard.assess({ registry: reg }).findings.length, 0);
});

test('输出确定性:同一坏表两次调用结果逐字节一致', () => {
  const reg = mkRegistry({
    Z: { mode: 'default-on', off: 'BAD', default: true },
    A: { mode: 'weird', default: true },
    M: { mode: 'default-on', off: 'CANON', default: true, parent: 'GHOST' },
  });
  const a = JSON.stringify(guard.assess({ registry: reg }).findings);
  const b = JSON.stringify(guard.assess({ registry: reg }).findings);
  assert.strictEqual(a, b);
});

test('门控 KHY_FLAG_REGISTRY_GUARD=off ⇒ 空 findings', () => {
  const reg = mkRegistry({ A: { mode: 'weird', default: true } });
  const { findings } = guard.assess({ registry: reg, env: { KHY_FLAG_REGISTRY_GUARD: 'off' } });
  assert.strictEqual(findings.length, 0);
});

test('绝不抛:坏注册表 / null 注入 → 安全空集', () => {
  assert.doesNotThrow(() => guard.assess({ registry: null }));
  assert.doesNotThrow(() => guard.assess({ registry: { listFlags: () => { throw new Error('boom'); } } }));
  assert.doesNotThrow(() => guard.assess({}));
});
