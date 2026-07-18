'use strict';

/**
 * memorySlug — 稳定、非有损文件名 slug 的单测(node:test)。
 *
 * 回归目标(goal 自省报告 #3「记忆碎片化 + 重复」):旧 slug 丢弃所有非 ASCII → 中文名
 * 塌成 `feedback_.md` 互相碰撞、无幂等去重。验证:纯 ASCII 干净名逐字节等价旧实现(零
 * 迁移)、非 ASCII/退化名追加确定性短哈希不碰撞、同名两次稳定(幂等)、剥冗余 type 前缀、
 * 门控关字节回退旧 slug、fail-soft 绝不抛。
 *
 * node:test(jest 经 rtk 代理报 Exec format error 不可用)。
 */
const test = require('node:test');
const assert = require('node:assert');

const m = require('../../src/memdir/memorySlug');

// 旧实现的逐字节复刻(byte-revert oracle)。
function legacyFilename(type, name) {
  const slug = String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 50);
  return `${type}_${slug}.md`;
}

test('纯 ASCII 干净名 → 与旧实现逐字节相同(零迁移)', () => {
  for (const [t, n] of [
    ['reference', 'API Docs'],
    ['feedback', 'avoid tables prefer lines'],
    ['project', 'cache metrics truth'],
    ['user', 'prefers dark mode'],
  ]) {
    assert.strictEqual(m.buildMemoryFilename(t, n, { env: {} }), legacyFilename(t, n), `${t}/${n}`);
  }
});

test('两个不同的中文名 → 不同且稳定的文件名(不再碰撞成 feedback_.md)', () => {
  const a = m.buildMemoryFilename('feedback', '系统提示词膨胀', { env: {} });
  const b = m.buildMemoryFilename('feedback', '记忆碎片化', { env: {} });
  assert.notStrictEqual(a, b, '不同中文名必须落不同文件');
  assert.notStrictEqual(a, 'feedback_.md');
  assert.notStrictEqual(b, 'feedback_.md');
  // 稳定:同名再次生成完全一致(幂等基石)
  assert.strictEqual(m.buildMemoryFilename('feedback', '系统提示词膨胀', { env: {} }), a);
  assert.strictEqual(m.buildMemoryFilename('feedback', '记忆碎片化', { env: {} }), b);
});

test('混中英名 → 保留 ASCII 可读片段 + 短哈希', () => {
  const f = m.buildMemoryFilename('project', 'cache 命中率', { env: {} });
  assert.ok(/^project_cache_[0-9a-f]{8}\.md$/.test(f), f);
});

test('退化名(仅标点/破折号)→ 不塌成裸 type_.md,追加哈希', () => {
  const f = m.buildMemoryFilename('feedback', 'system——', { env: {} });
  assert.notStrictEqual(f, 'feedback_.md');
  assert.ok(/^feedback_system_[0-9a-f]{8}\.md$/.test(f), f);
  // 纯标点名(strip 后全空)也要有哈希,不塌成 feedback_.md
  const g = m.buildMemoryFilename('feedback', '——', { env: {} });
  assert.notStrictEqual(g, 'feedback_.md');
  assert.ok(/^feedback_[0-9a-f]{8}\.md$/.test(g), g);
});

test('剥冗余 type 前缀 → user-home-qujing 与 home-qujing 同文件', () => {
  const a = m.buildMemoryFilename('user', 'user-home-qujing', { env: {} });
  const b = m.buildMemoryFilename('user', 'home-qujing', { env: {} });
  assert.strictEqual(a, b, '带/不带 type 前缀应收敛到同一文件');
  assert.strictEqual(a, 'user_home-qujing.md');
});

test('门控关 → 逐字节回退旧 slug(含塌陷行为)', () => {
  for (const off of ['0', 'false', 'off', 'no', 'disable', 'disabled']) {
    const env = { KHY_MEMORY_SLUG_STABLE: off };
    assert.strictEqual(m.buildMemoryFilename('feedback', '系统提示词膨胀', { env }), 'feedback_.md', off);
    assert.strictEqual(
      m.buildMemoryFilename('reference', 'API Docs', { env }),
      legacyFilename('reference', 'API Docs'),
      off,
    );
  }
});

test('memoryKey:同一事实(带/不带 type 前缀、大小写、空白)→ 同键', () => {
  const k1 = m.memoryKey('user', 'user-home-qujing');
  const k2 = m.memoryKey('user', 'home-qujing');
  const k3 = m.memoryKey('user', '  HOME-QUJING  ');
  assert.strictEqual(k1, k2);
  assert.strictEqual(k2, k3);
  // 不同事实 → 不同键
  assert.notStrictEqual(m.memoryKey('feedback', '系统提示词膨胀'), m.memoryKey('feedback', '记忆碎片化'));
});

test('canonicalMemoryName:NFC 归一 + 小写 + 折叠空白 + 剥前缀', () => {
  assert.strictEqual(m.canonicalMemoryName('user', 'User-Home-Qujing'), 'home-qujing');
  assert.strictEqual(m.canonicalMemoryName('feedback', '  A   B  '), 'a b');
  assert.strictEqual(m.canonicalMemoryName('', '  X '), 'x');
});

test('_shortHash:确定性 8-hex,不同输入不同', () => {
  const h1 = m._shortHash('系统提示词膨胀');
  assert.ok(/^[0-9a-f]{8}$/.test(h1), h1);
  assert.strictEqual(m._shortHash('系统提示词膨胀'), h1);      // 确定性
  assert.notStrictEqual(m._shortHash('记忆碎片化'), h1);       // 区分
});

test('fail-soft:异常/空输入绝不抛', () => {
  for (const [t, n] of [['feedback', null], ['feedback', undefined], ['feedback', 123], ['feedback', {}]]) {
    assert.doesNotThrow(() => m.buildMemoryFilename(t, n, { env: {} }));
  }
  assert.doesNotThrow(() => m.memoryKey(null, null));
  assert.doesNotThrow(() => m.canonicalMemoryName(undefined, undefined));
});

test('slugGateEnabled:默认开 + 关闭词表', () => {
  assert.strictEqual(m.slugGateEnabled({}), true);
  assert.strictEqual(m.slugGateEnabled({ KHY_MEMORY_SLUG_STABLE: 'on' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'disable', 'disabled']) {
    assert.strictEqual(m.slugGateEnabled({ KHY_MEMORY_SLUG_STABLE: off }), false, off);
  }
});
