'use strict';

/**
 * OPS-MAN-155 接线验证 + 守卫:directiveRegistryAudit 叶 → CI 编译期收敛守卫。
 *
 * directiveRegistryAudit.js(auditDirectiveRegistry/auditRegistryShape/extractComposedKeys)
 * 是一枚**全实现的纯审计原语**,其文件头明确写它「被守卫测试消费」——但此前**没有任何守卫
 * 消费它**,能力完全休眠。本守卫就是它设计意图里的那个消费者:把「DIRECTIVE_REGISTRY(指令
 * SSOT)vs aiChatCore.js 实际 compose 的 key 集合」的一致性,在 CI/提交期锁成不变量。
 *
 * 服务送别礼「能力存在但没接线 → 负责接线」+ khyos 自审报告 #1「系统提示词膨胀 + 多协议
 * 冲突·根因=叠加式协议堆叠、无编译期冲突检测」:接上这道守卫,未来「加法式协议堆叠」再也
 * 不能悄悄漂移进无类型 protocol 兜底。
 *
 * node:test 风格(可 `node --test <file>`),已登记进 test:maintainer:safety 聚合套件。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const audit = require('../../src/services/directiveRegistryAudit');
const composer = require('../../src/services/directiveComposer');

const AI_CHAT_CORE = path.join(__dirname, '../../src/cli/aiChatCore.js');

// ── 叶纯函数单元 ──────────────────────────────────────────────

test('auditDirectiveRegistry: 一致时 ok=true,三差异皆空', () => {
  const r = audit.auditDirectiveRegistry(
    { a: { tier: 'guard', label: 'A' }, b: { tier: 'protocol', label: 'B' } },
    ['a', 'b']
  );
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.unregistered, []);
  assert.deepStrictEqual(r.orphaned, []);
  assert.deepStrictEqual(r.duplicates, []);
});

test('auditDirectiveRegistry: 检出 unregistered / orphaned / duplicates', () => {
  const r = audit.auditDirectiveRegistry(
    { registered: { tier: 'guard', label: 'R' }, deadEntry: { tier: 'protocol', label: 'D' } },
    ['registered', 'ghost', 'registered'] // ghost 未登记;registered 重复;deadEntry 从不 compose
  );
  assert.deepStrictEqual(r.unregistered, ['ghost']);
  assert.deepStrictEqual(r.orphaned, ['deadEntry']);
  assert.deepStrictEqual(r.duplicates, ['registered']);
  assert.strictEqual(r.ok, false);
});

test('auditRegistryShape: 检出非法 tier 与空 label', () => {
  const r = audit.auditRegistryShape({
    good: { tier: 'guard', label: 'G' },
    badTier: { tier: 'nonsense', label: 'X' },
    emptyLabel: { tier: 'protocol', label: '  ' },
  });
  assert.ok(r.badTier.includes('badTier'));
  assert.ok(r.emptyLabel.includes('emptyLabel'));
  assert.strictEqual(r.ok, false);
});

test('extractComposedKeys: 只在 composeDirectives(...) 实参块内抽 key', () => {
  const src = "const x = { key: 'OUTSIDE' };\ncomposeDirectives({ entries: [ { key: 'alpha' }, { key: 'beta' } ] });";
  const keys = audit.extractComposedKeys(src);
  assert.deepStrictEqual(keys, ['alpha', 'beta']);
  assert.ok(!keys.includes('OUTSIDE'), 'must not capture keys outside the compose block');
});

test('extractComposedKeys: 无 composeDirectives 调用 → 空数组,绝不抛', () => {
  assert.deepStrictEqual(audit.extractComposedKeys('no call here'), []);
  assert.deepStrictEqual(audit.extractComposedKeys(null), []);
});

// ── 接线守卫:真 registry vs 真 compose 源(编译期收敛不变量) ──────────

test('WIRING GUARD: DIRECTIVE_REGISTRY 与 aiChatCore.js compose 的 key 集合完全一致', () => {
  const registry = composer.DIRECTIVE_REGISTRY;
  assert.ok(registry && typeof registry === 'object', 'directiveComposer must export DIRECTIVE_REGISTRY');

  const src = fs.readFileSync(AI_CHAT_CORE, 'utf-8');
  const composedKeys = audit.extractComposedKeys(src);
  assert.ok(composedKeys.length > 0, 'expected to extract composed keys from aiChatCore.js');

  const result = audit.auditDirectiveRegistry(registry, composedKeys);
  assert.deepStrictEqual(
    result.unregistered, [],
    `未登记指令(会静默落 protocol 兜底,协议漂移):${result.unregistered.join(', ')} — 请在 directiveComposer.DIRECTIVE_REGISTRY 登记并给正确 tier`
  );
  assert.deepStrictEqual(
    result.duplicates, [],
    `compose 列表重复 key:${result.duplicates.join(', ')}`
  );
  assert.deepStrictEqual(
    result.orphaned, [],
    `死条目(登记了但从不 compose):${result.orphaned.join(', ')} — 请从注册表移除或接进 compose`
  );
  assert.strictEqual(result.ok, true, 'directive registry drift detected');
});

test('WIRING GUARD: 注册表每条目 tier 合法 + label 非空', () => {
  const shape = audit.auditRegistryShape(composer.DIRECTIVE_REGISTRY);
  assert.deepStrictEqual(shape.badTier, [], `非法 tier 条目:${shape.badTier.join(', ')}`);
  assert.deepStrictEqual(shape.emptyLabel, [], `空 label 条目:${shape.emptyLabel.join(', ')}`);
  assert.strictEqual(shape.ok, true);
});
