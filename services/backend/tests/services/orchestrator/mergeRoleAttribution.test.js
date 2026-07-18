'use strict';

/**
 * OPS-MAN-101 — role-attribution honesty leaf + wired e2e via real mergeResults.
 * Run: node --test services/backend/tests/services/orchestrator/mergeRoleAttribution.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
  roleLabel,
  formatRoleTag,
  formatRoleFailureSummary,
  _roleAttributionEnabled,
} = require('../../../src/services/orchestrator/mergeRoleAttribution');

// Toggle the gate for one synchronous body, restoring the prior value after.
function withGate(value, fn) {
  const key = 'KHY_MERGE_ROLE_ATTRIBUTION';
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[key] = prev;
    else delete process.env[key];
  }
}

// ── roleLabel ──────────────────────────────────────────────────────────
test('roleLabel maps the four known roles', () => {
  assert.strictEqual(roleLabel('implement'), '实现');
  assert.strictEqual(roleLabel('verify'), '验证');
  assert.strictEqual(roleLabel('explore'), '探索');
  assert.strictEqual(roleLabel('general'), '通用');
});

test('roleLabel normalises case/whitespace', () => {
  assert.strictEqual(roleLabel('  VERIFY '), '验证');
  assert.strictEqual(roleLabel('Implement'), '实现');
});

test('roleLabel returns empty string for unknown/malformed', () => {
  assert.strictEqual(roleLabel('wat'), '');
  assert.strictEqual(roleLabel(''), '');
  assert.strictEqual(roleLabel(null), '');
  assert.strictEqual(roleLabel(undefined), '');
  assert.strictEqual(roleLabel(42), '');
  assert.strictEqual(roleLabel({}), '');
});

// ── formatRoleTag ──────────────────────────────────────────────────────
test('formatRoleTag wraps a known label in fullwidth parens (gate on)', () => {
  withGate('1', () => {
    assert.strictEqual(formatRoleTag('verify'), '（验证）');
    assert.strictEqual(formatRoleTag('implement'), '（实现）');
  });
});

test('formatRoleTag suppresses unknown/malformed roles (never mislabels)', () => {
  withGate('1', () => {
    assert.strictEqual(formatRoleTag('wat'), '');
    assert.strictEqual(formatRoleTag(null), '');
    assert.strictEqual(formatRoleTag(undefined), '');
  });
});

test('formatRoleTag returns "" for all falsy gate tokens (byte-revert)', () => {
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    withGate(off, () => {
      assert.strictEqual(formatRoleTag('verify'), '', `gate=${off}`);
    });
  }
});

test('formatRoleTag enabled by default (undefined env) and for non-falsy', () => {
  withGate(undefined, () => assert.strictEqual(formatRoleTag('verify'), '（验证）'));
  withGate('yes', () => assert.strictEqual(formatRoleTag('verify'), '（验证）'));
  assert.strictEqual(_roleAttributionEnabled(), true);
});

// ── formatRoleFailureSummary ────────────────────────────────────────────
test('formatRoleFailureSummary counts by bucket in declaration order', () => {
  withGate('1', () => {
    const line = formatRoleFailureSummary(['explore', 'implement', 'implement']);
    assert.strictEqual(line, '⚠️ 失败分布: 实现 2 项、探索 1 项');
  });
});

test('formatRoleFailureSummary flags a failed verify as critical', () => {
  withGate('1', () => {
    const line = formatRoleFailureSummary(['verify']);
    assert.ok(line.includes('验证 1 项'));
    assert.ok(line.includes('验证失败=结果未经校验，请复查'));
  });
});

test('formatRoleFailureSummary buckets unknown/malformed roles into 通用 (never dropped)', () => {
  withGate('1', () => {
    // 3 failures: unknown + null + general → all land in 通用 → count sums to 3.
    const line = formatRoleFailureSummary(['wat', null, 'general']);
    assert.strictEqual(line, '⚠️ 失败分布: 通用 3 项');
  });
});

test('formatRoleFailureSummary count sums to input length (honesty invariant)', () => {
  withGate('1', () => {
    const roles = ['verify', 'explore', 'wat', 'implement', null, undefined];
    const line = formatRoleFailureSummary(roles);
    // Sum the "N 项" numbers out of the line; must equal roles.length.
    const nums = [...line.matchAll(/(\d+) 项/g)].map(m => Number(m[1]));
    assert.strictEqual(nums.reduce((a, b) => a + b, 0), roles.length);
  });
});

test('formatRoleFailureSummary returns "" for empty/non-array/gate-off', () => {
  withGate('1', () => {
    assert.strictEqual(formatRoleFailureSummary([]), '');
    assert.strictEqual(formatRoleFailureSummary(null), '');
    assert.strictEqual(formatRoleFailureSummary('verify'), '');
    assert.strictEqual(formatRoleFailureSummary(undefined), '');
  });
  withGate('off', () => {
    assert.strictEqual(formatRoleFailureSummary(['verify']), '');
  });
});

test('formatRoleFailureSummary never throws on malformed input', () => {
  withGate('1', () => {
    assert.doesNotThrow(() => formatRoleFailureSummary([{}, 42, [], NaN]));
  });
});

// ── WIRED e2e: through the real mergeResults consumer ───────────────────
const { mergeResults } = require('../../../src/services/taskDecomposer');

// Build inputs in mergeResults' shape: subtasks keyed subtask-${i+1}.
function sub(prompt, originIndex, role) {
  return { prompt, originIndex, role };
}
function agg(i, result) {
  return { agentId: `a${i}`, name: `subtask-${i}`, depth: 1, result };
}

test('WIRED: real mergeResults header carries the role tag (gate on)', () => {
  withGate('1', () => {
    const subtasks = [sub('验证登录逻辑', 0, 'verify')];
    const aggregated = [agg(1, { success: true, text: 'ok', toolCalls: 2 })];
    const out = mergeResults(subtasks, aggregated);
    assert.ok(out.includes('### 子任务 1（验证）: 验证登录逻辑'), out);
  });
});

test('WIRED: real mergeResults footer surfaces failed-role distribution + verify hint', () => {
  withGate('1', () => {
    const subtasks = [
      sub('实现分页', 0, 'implement'),
      sub('验证分页', 1, 'verify'),
    ];
    const aggregated = [
      agg(1, { success: true, text: 'done', toolCalls: 3 }),
      agg(2, { success: false, error: '测试失败' }),
    ];
    const out = mergeResults(subtasks, aggregated);
    assert.ok(out.includes('⚠️ 失败分布: 验证 1 项'), out);
    assert.ok(out.includes('验证失败=结果未经校验'), out);
  });
});

test('WIRED: gate off → no role tag in header AND no failure-distribution line (byte-revert)', () => {
  withGate('off', () => {
    const subtasks = [
      sub('实现分页', 0, 'implement'),
      sub('验证分页', 1, 'verify'),
    ];
    const aggregated = [
      agg(1, { success: true, text: 'done', toolCalls: 3 }),
      agg(2, { success: false, error: '测试失败' }),
    ];
    const out = mergeResults(subtasks, aggregated);
    assert.ok(out.includes('### 子任务 1: 实现分页'), out); // no （实现）
    assert.ok(!out.includes('（验证）'), out);
    assert.ok(!out.includes('失败分布'), out);
    // existing footer still present & unchanged in shape
    assert.ok(out.includes('- 失败: 1 项'), out);
  });
});

test('WIRED: an unexecuted (null-result) subtask still contributes its role to the failure line', () => {
  withGate('1', () => {
    const subtasks = [sub('探索代码库', 0, 'explore')];
    const aggregated = [agg(99, { success: true, text: 'x' })]; // no subtask-1 match → null
    const out = mergeResults(subtasks, aggregated);
    assert.ok(out.includes('未执行'), out);
    assert.ok(out.includes('⚠️ 失败分布: 探索 1 项'), out);
  });
});
