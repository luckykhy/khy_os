'use strict';

/**
 * directiveRegistryGuard — 指令注册表漂移守卫(node:test)。
 *
 * 回归目标(khyos 自审 #1「多协议堆叠·无编译期冲突检测」):把「DIRECTIVE_REGISTRY vs
 * ai.js 实际编排的 key 集合」的一致性锁死为可断言不变量。任何未来「加法式协议堆叠」若
 * 忘了登记(→ 落 protocol 兜底漂移)或登记了却从不编排(死条目),本守卫立即失败。
 *
 * 纯审计:读源码文本、比对集合,不改运行时行为、不 require ai.js(大文件含内联字符)。
 * node:test(jest 经 rtk 代理报 Exec format error 不可用)。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const audit = require('../src/services/directiveRegistryAudit');
const { DIRECTIVE_REGISTRY } = require('../src/services/directiveComposer');

const AI_JS = path.join(__dirname, '..', 'src', 'cli', 'ai.js');

// ── 单元:auditDirectiveRegistry 语义 ─────────────────────────────────
test('auditDirectiveRegistry: 一致 → ok', () => {
  const reg = { a: { tier: 'guard', label: 'A' }, b: { tier: 'protocol', label: 'B' } };
  const r = audit.auditDirectiveRegistry(reg, ['a', 'b']);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.unregistered, []);
  assert.deepStrictEqual(r.orphaned, []);
  assert.deepStrictEqual(r.duplicates, []);
});

test('auditDirectiveRegistry: 未注册 key(漂移入口)被抓', () => {
  const reg = { a: { tier: 'guard', label: 'A' } };
  const r = audit.auditDirectiveRegistry(reg, ['a', 'newDrift']);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.unregistered, ['newDrift']);
});

test('auditDirectiveRegistry: 死条目(登记但不编排)被抓', () => {
  const reg = { a: { tier: 'guard', label: 'A' }, dead: { tier: 'protocol', label: 'D' } };
  const r = audit.auditDirectiveRegistry(reg, ['a']);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.orphaned, ['dead']);
});

test('auditDirectiveRegistry: 重复 key 被抓', () => {
  const reg = { a: { tier: 'guard', label: 'A' } };
  const r = audit.auditDirectiveRegistry(reg, ['a', 'a']);
  assert.deepStrictEqual(r.duplicates, ['a']);
  assert.strictEqual(r.ok, false);
});

test('auditDirectiveRegistry: fail-soft 异常输入绝不抛', () => {
  assert.doesNotThrow(() => audit.auditDirectiveRegistry(null, null));
  const r = audit.auditDirectiveRegistry(undefined, undefined);
  assert.strictEqual(r.ok, true); // 空 vs 空 → 一致
});

test('extractComposedKeys: 仅在 composeDirectives 块内抽取 key', () => {
  const src = `
    const x = { key: 'OUTSIDE' };
    composeDirectives({
      entries: [
        { key: 'alpha', directive: a },
        { key: 'beta', directive: b },
      ],
    });
    const y = { key: 'ALSO_OUTSIDE' };
  `;
  const keys = audit.extractComposedKeys(src);
  assert.deepStrictEqual(keys, ['alpha', 'beta']);
});

test('auditRegistryShape: 非法 tier / 空 label 被抓', () => {
  const bad = { a: { tier: 'weird', label: 'A' }, b: { tier: 'guard', label: '' } };
  const r = audit.auditRegistryShape(bad);
  assert.deepStrictEqual(r.badTier, ['a']);
  assert.deepStrictEqual(r.emptyLabel, ['b']);
  assert.strictEqual(r.ok, false);
});

// ── 守卫:真实注册表 vs 真实 ai.js ────────────────────────────────────
test('GUARD: DIRECTIVE_REGISTRY 每条目 tier/label 合法', () => {
  const r = audit.auditRegistryShape(DIRECTIVE_REGISTRY);
  assert.strictEqual(r.ok, true, `注册表 shape 问题: ${JSON.stringify(r)}`);
});

test('GUARD: ai.js 编排的每个 key 都已登记、每条登记都被编排(零漂移)', () => {
  const src = fs.readFileSync(AI_JS, 'utf-8');
  const composed = audit.extractComposedKeys(src);
  assert.ok(composed.length >= 10, `应抽到多路指令 key,实际 ${composed.length}`);
  const r = audit.auditDirectiveRegistry(DIRECTIVE_REGISTRY, composed);
  assert.deepStrictEqual(
    r.unregistered, [],
    `以下 key 被 ai.js 编排但未登记 DIRECTIVE_REGISTRY(会静默落 protocol 兜底,漂移):${r.unregistered.join(', ')}`,
  );
  assert.deepStrictEqual(
    r.orphaned, [],
    `以下 key 登记了却从不被 ai.js 编排(死条目):${r.orphaned.join(', ')}`,
  );
  assert.deepStrictEqual(
    r.duplicates, [],
    `以下 key 在编排列表里重复:${r.duplicates.join(', ')}`,
  );
  assert.strictEqual(r.ok, true);
});
