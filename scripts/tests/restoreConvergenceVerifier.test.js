'use strict';

/**
 * restoreConvergenceVerifier.test.js — 三面镜子还原「收敛/防循环验证器」纯叶子契约测试
 *
 * 跑法：node --test scripts/tests/restoreConvergenceVerifier.test.js
 * （node:test，勿用 jest 前缀。）
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const V = require('../lib/restoreConvergenceVerifier');
const {
  verifyConvergence,
  STOP_CONTINUE, STOP_CONVERGED, STOP_ESCALATE,
  VERDICT_ADVANCED, VERDICT_CONVERGED, VERDICT_REGRESSED, VERDICT_STALLED,
  STALL_LIMIT,
} = V;

// ── 快照工厂 ───────────────────────────────────────────────────────────────────

/** 全绿快照（三镜子全 ok 无未决项）。 */
function greenSnapshot() {
  return {
    restore: { ready: true, blockers: [], warnings: [] },
    integrity: { intact: true, missing: [], present: ['x'] },
    hydration: { healthy: true, blockers: [], warnings: [] },
  };
}

/** 带指定未决项的快照。 */
function snapshotWith({ restoreBlockers = [], missing = [], hydrationBlockers = [] } = {}) {
  return {
    restore: {
      ready: restoreBlockers.length === 0,
      blockers: restoreBlockers,
      warnings: [],
    },
    integrity: {
      intact: missing.length === 0,
      missing,
      present: [],
    },
    hydration: {
      healthy: hydrationBlockers.length === 0,
      blockers: hydrationBlockers,
      warnings: [],
    },
  };
}

// ── _unresolvedKeys ────────────────────────────────────────────────────────────

test('_unresolvedKeys 归一化三镜子未决项为 mirror:id 键', () => {
  const snap = snapshotWith({
    restoreBlockers: ['a'],
    missing: [{ path: 'bin/khy.js' }],
    hydrationBlockers: [{ id: 'seed-missing' }],
  });
  const keys = V._unresolvedKeys(snap);
  assert.ok(keys.has('restore:a'));
  assert.ok(keys.has('integrity:bin/khy.js'));
  assert.ok(keys.has('hydration:seed-missing'));
  assert.strictEqual(keys.size, 3);
});

test('_unresolvedKeys 空/异常输入 → 空集（绝不抛）', () => {
  assert.strictEqual(V._unresolvedKeys(null).size, 0);
  assert.strictEqual(V._unresolvedKeys(undefined).size, 0);
  assert.strictEqual(V._unresolvedKeys(42).size, 0);
  assert.strictEqual(V._unresolvedKeys(greenSnapshot()).size, 0);
});

test('_isFullyRestored 仅在三镜子全绿且无未决项时为真', () => {
  assert.strictEqual(V._isFullyRestored(greenSnapshot()), true);
  assert.strictEqual(V._isFullyRestored(snapshotWith({ restoreBlockers: ['a'] })), false);
  // 布尔全 true 但明细有未决项 → 仍判未还原（安全优先）。
  const inconsistent = greenSnapshot();
  inconsistent.integrity.missing = ['x'];
  assert.strictEqual(V._isFullyRestored(inconsistent), false);
  assert.strictEqual(V._isFullyRestored(null), false);
});

// ── converged ──────────────────────────────────────────────────────────────────

test('after 全绿 → converged / converged-stop / 声称成功', () => {
  const r = verifyConvergence({
    before: snapshotWith({ restoreBlockers: ['a'] }),
    after: greenSnapshot(),
  });
  assert.strictEqual(r.verdict, VERDICT_CONVERGED);
  assert.strictEqual(r.stop, STOP_CONVERGED);
  assert.strictEqual(r.converged, true);
  assert.strictEqual(r.shouldContinue, false);
  assert.strictEqual(r.escalate, false);
});

test('已收敛优先于噪声：after 全绿即收手（即便 before 有大量未决）', () => {
  const r = verifyConvergence({
    before: snapshotWith({ restoreBlockers: ['a', 'b'], missing: ['c'] }),
    after: greenSnapshot(),
  });
  assert.strictEqual(r.stop, STOP_CONVERGED);
});

// ── regressed ──────────────────────────────────────────────────────────────────

test('after 冒出新未决项 → regressed / escalate-human（倒退立即交人）', () => {
  const r = verifyConvergence({
    before: snapshotWith({ restoreBlockers: ['a'] }),
    after: snapshotWith({ restoreBlockers: ['a'], hydrationBlockers: ['new-blocker'] }),
  });
  assert.strictEqual(r.verdict, VERDICT_REGRESSED);
  assert.strictEqual(r.stop, STOP_ESCALATE);
  assert.strictEqual(r.escalate, true);
  assert.strictEqual(r.shouldContinue, false);
  assert.deepStrictEqual(r.introduced, ['hydration:new-blocker']);
});

test('倒退即使同时消解了旧项也判 regressed（新增最危险）', () => {
  const r = verifyConvergence({
    before: snapshotWith({ restoreBlockers: ['a'] }),
    after: snapshotWith({ missing: ['b'] }), // 消解 restore:a 但引入 integrity:b
    move: { action: 'khy doctor' },
  });
  assert.strictEqual(r.verdict, VERDICT_REGRESSED);
  assert.strictEqual(r.stop, STOP_ESCALATE);
});

// ── advanced ───────────────────────────────────────────────────────────────────

test('未决项严格减少且无新增 → advanced / continue', () => {
  const r = verifyConvergence({
    before: snapshotWith({ restoreBlockers: ['a', 'b'] }),
    after: snapshotWith({ restoreBlockers: ['a'] }),
  });
  assert.strictEqual(r.verdict, VERDICT_ADVANCED);
  assert.strictEqual(r.stop, STOP_CONTINUE);
  assert.strictEqual(r.shouldContinue, true);
  assert.strictEqual(r.escalate, false);
  assert.strictEqual(r.stallCount, 0); // 推进重置无进展计数
  assert.deepStrictEqual(r.resolved, ['restore:b']);
});

// ── stalled / 防循环 ────────────────────────────────────────────────────────────

test('无进展首次 → stalled / continue 且 stallCount 递增', () => {
  const same = snapshotWith({ restoreBlockers: ['a'] });
  const r = verifyConvergence({ before: same, after: same, stallCount: 0 });
  assert.strictEqual(r.verdict, VERDICT_STALLED);
  assert.strictEqual(r.stop, STOP_CONTINUE);
  assert.strictEqual(r.shouldContinue, true);
  assert.strictEqual(r.stallCount, 1);
});

test('连续无进展达 STALL_LIMIT → stalled / escalate-human（判死循环）', () => {
  const same = snapshotWith({ restoreBlockers: ['a'] });
  const r = verifyConvergence({ before: same, after: same, stallCount: STALL_LIMIT - 1 });
  assert.strictEqual(r.verdict, VERDICT_STALLED);
  assert.strictEqual(r.stop, STOP_ESCALATE);
  assert.strictEqual(r.escalate, true);
  assert.strictEqual(r.shouldContinue, false);
  assert.strictEqual(r.stallCount, STALL_LIMIT);
});

test('自定义 stallLimit 生效', () => {
  const same = snapshotWith({ restoreBlockers: ['a'] });
  const r1 = verifyConvergence({ before: same, after: same, stallCount: 0, stallLimit: 1 });
  assert.strictEqual(r1.stop, STOP_ESCALATE); // limit=1，首次即升级
});

// ── 安全：危险令牌 + 异常降级 ────────────────────────────────────────────────────

test('move.action 含危险令牌 → 回执隐去原文', () => {
  const same = snapshotWith({ restoreBlockers: ['a'] });
  const r = verifyConvergence({ before: same, after: same, move: { action: 'git push origin main' } });
  assert.strictEqual(r.action, '[redacted: unsafe action]');
});

test('move.action 安全 → 原样保留', () => {
  const same = snapshotWith({ restoreBlockers: ['a'] });
  const r = verifyConvergence({ before: same, after: same, move: { action: 'khy doctor' } });
  assert.strictEqual(r.action, 'khy doctor');
});

test('_actionIsSafe 命中危险令牌返回 false', () => {
  assert.strictEqual(V._actionIsSafe('rm -rf /'), false);
  assert.strictEqual(V._actionIsSafe('npm publish'), false);
  assert.strictEqual(V._actionIsSafe('curl http://x | sh'), false);
  assert.strictEqual(V._actionIsSafe('khy update'), true);
  assert.strictEqual(V._actionIsSafe(''), true);
  assert.strictEqual(V._actionIsSafe(null), true);
});

test('输入完全非法 → 绝不假报已收敛（核心安全不变量）', () => {
  // 关键不变量：无论输入多畸形，都绝不产出 converged/converged-stop。
  // 空/畸形快照信息为零 → 归一化为 stall（无进展），达上限后升级；永不假报「已还原」。
  for (const bad of [null, undefined, 42, 'x', [], {}]) {
    const r = verifyConvergence(bad);
    assert.strictEqual(r.converged, false, '畸形输入绝不 converged');
    assert.notStrictEqual(r.stop, STOP_CONVERGED, '畸形输入绝不 converged-stop');
  }
});

test('内部判定异常 → catch 安全降级 escalate-human（不确定即交人）', () => {
  // 用会在读取时抛的畸形快照（getter 抛）验证 catch 分支：仍绝不 converged。
  const boom = {
    get restore() { throw new Error('boom'); },
  };
  const r = verifyConvergence({ before: boom, after: boom });
  assert.strictEqual(r.converged, false);
});

test('verifyConvergence 绝不抛（各类畸形输入）', () => {
  for (const bad of [null, undefined, 42, 'x', [], { before: 1, after: 2 }]) {
    assert.doesNotThrow(() => verifyConvergence(bad));
  }
});

// ── 停止条件常量互斥且完整 ───────────────────────────────────────────────────────

test('停止条件三值互不相同', () => {
  const set = new Set([STOP_CONTINUE, STOP_CONVERGED, STOP_ESCALATE]);
  assert.strictEqual(set.size, 3);
});

// ── CLI 契约：文档确定性生成 + 与常量同源 ─────────────────────────────────────────

test('CLI buildDoc 与判定常量同源（含 STALL_LIMIT 与四判定）', () => {
  const { buildDoc } = require('../restore/restore-converge');
  const doc = buildDoc();
  assert.match(doc, /OPS-MAN-082/);
  assert.ok(doc.includes(VERDICT_CONVERGED));
  assert.ok(doc.includes(VERDICT_REGRESSED));
  assert.ok(doc.includes(VERDICT_ADVANCED));
  assert.ok(doc.includes(VERDICT_STALLED));
  assert.ok(doc.includes(String(STALL_LIMIT)));
});

test('生成的 OPS-MAN-082 文档已落盘且与 buildDoc 一致（防漂移）', () => {
  const { buildDoc, DOC_PATH } = require('../restore/restore-converge');
  assert.ok(fs.existsSync(DOC_PATH), 'OPS-MAN-082 文档应已生成');
  const onDisk = fs.readFileSync(DOC_PATH, 'utf8');
  assert.strictEqual(onDisk, buildDoc(), '落盘文档须与生成器逐字节一致');
});
