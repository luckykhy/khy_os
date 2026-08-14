'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  isEmptySuccess,
  formatEmptySuccessWarning,
} = require('../../../src/services/orchestrator/mergeEmptySuccess');

// 切门辅助：保存/恢复 KHY_MERGE_EMPTY_SUCCESS。
function withGate(value, fn) {
  const prev = process.env.KHY_MERGE_EMPTY_SUCCESS;
  if (value === undefined) delete process.env.KHY_MERGE_EMPTY_SUCCESS;
  else process.env.KHY_MERGE_EMPTY_SUCCESS = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.KHY_MERGE_EMPTY_SUCCESS;
    else process.env.KHY_MERGE_EMPTY_SUCCESS = prev;
  }
}

// ── 门开：核心判定 ────────────────────────────────────────────────────

test('门开：success 非 false + 空 output + 空 filesModified + 0 toolCalls → true', () => {
  withGate(undefined, () => {
    assert.strictEqual(
      isEmptySuccess({ success: true, output: '', filesModified: [], toolCalls: 0 }),
      true
    );
  });
});

test('门开：success 隐式（缺 success 字段）+ 全空 → true（producer 用 success!==false）', () => {
  withGate(undefined, () => {
    assert.strictEqual(isEmptySuccess({ output: '', filesModified: [] }), true);
  });
});

test('门开：有非空 text → false（有产出）', () => {
  withGate(undefined, () => {
    assert.strictEqual(
      isEmptySuccess({ success: true, text: '干了活', filesModified: [] }),
      false
    );
  });
});

test('门开：有非空 output → false（有产出）', () => {
  withGate(undefined, () => {
    assert.strictEqual(isEmptySuccess({ success: true, output: '结果在此' }), false);
  });
});

test('门开：有 filesModified（长度≥1）→ false（改了文件即有产出）', () => {
  withGate(undefined, () => {
    assert.strictEqual(
      isEmptySuccess({ success: true, output: '', filesModified: ['a.js'] }),
      false
    );
  });
});

test('门开：toolCalls≥1 → false（跑了工具即有产出）', () => {
  withGate(undefined, () => {
    assert.strictEqual(
      isEmptySuccess({ success: true, output: '', filesModified: [], toolCalls: 3 }),
      false
    );
  });
});

test('门开：success:false → false（失败另有归属，不重复标）', () => {
  withGate(undefined, () => {
    assert.strictEqual(
      isEmptySuccess({ success: false, output: '', filesModified: [] }),
      false
    );
  });
});

test('门开：skipped:true → false（跳过项 092 另有归属）', () => {
  withGate(undefined, () => {
    assert.strictEqual(
      isEmptySuccess({ success: false, skipped: true, output: '' }),
      false
    );
  });
});

test('门开：空白 body（text 全空格）trim 后空 → true', () => {
  withGate(undefined, () => {
    assert.strictEqual(
      isEmptySuccess({ success: true, text: '   ', output: '  ', filesModified: [] }),
      true
    );
  });
});

// ── 门开：畸形安全（绝不抛，保守漏标不误报）──────────────────────────

test('门开：畸形输入（null/非对象/缺字段）→ false，绝不抛', () => {
  withGate(undefined, () => {
    assert.strictEqual(isEmptySuccess(null), false);
    assert.strictEqual(isEmptySuccess(undefined), false);
    assert.strictEqual(isEmptySuccess('nope'), false);
    assert.strictEqual(isEmptySuccess(42), false);
    assert.strictEqual(isEmptySuccess([]), true); // 数组是对象、无 body/无字段 → 保守视为空成功（但实际 producer 不会传数组）
    // 注：上一条记录真实行为；真实 producer 只传 result 对象。
    assert.doesNotThrow(() => isEmptySuccess({ filesModified: 'not-array' }));
    // filesModified 非数组 → 走「非数组」分支不视为有文件 → 仍可能 true（无 body/无 tool）
    assert.strictEqual(isEmptySuccess({ success: true, filesModified: 'x' }), true);
  });
});

// ── 门关：逐字节回退 ──────────────────────────────────────────────────

test('门关四 falsy token（0/false/off/no）→ 恒 false（逐字节回退）', () => {
  for (const off of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
    withGate(off, () => {
      assert.strictEqual(
        isEmptySuccess({ success: true, output: '', filesModified: [], toolCalls: 0 }),
        false,
        `gate=${off} should disable`
      );
    });
  }
});

test('门开非 falsy 值（如 on/1/空串）→ 启用', () => {
  for (const on of ['on', '1', 'true', 'yes', '']) {
    withGate(on, () => {
      assert.strictEqual(
        isEmptySuccess({ success: true, output: '', filesModified: [] }),
        true,
        `gate=${JSON.stringify(on)} should enable`
      );
    });
  }
});

// ── formatEmptySuccessWarning ────────────────────────────────────────

test('formatEmptySuccessWarning：count≥1 → 含 ⚠️ + N', () => {
  const w = formatEmptySuccessWarning(2);
  assert.match(w, /⚠️/);
  assert.match(w, /2 项/);
  assert.match(w, /无产出/);
});

test('formatEmptySuccessWarning：count 0/负/畸形 → 空串', () => {
  assert.strictEqual(formatEmptySuccessWarning(0), '');
  assert.strictEqual(formatEmptySuccessWarning(-1), '');
  assert.strictEqual(formatEmptySuccessWarning(NaN), '');
  assert.strictEqual(formatEmptySuccessWarning(undefined), '');
});

// ── 端到端联通（断桥可闭合）──────────────────────────────────────────

test('端到端：一个空成功 result → isEmptySuccess true 且 warning 含「无产出」', () => {
  withGate(undefined, () => {
    const result = { success: true, output: '', filesModified: [], toolCalls: 0 };
    let count = 0;
    if (isEmptySuccess(result)) count++;
    assert.strictEqual(count, 1);
    const w = formatEmptySuccessWarning(count);
    assert.match(w, /无产出/);
    assert.match(w, /1 项/);
  });
});

// ── 接线联通：经真实 mergeResults 验证 status 标注 + footer 告警 ────────────
// 证明断桥在真实 consumer（taskDecomposer.mergeResults）里闭合，而非只在纯叶。

const { mergeResults } = require('../../../src/services/taskDecomposer');
const sub = (prompt, originIndex) => ({ prompt, role: 'general', originIndex });
const agg = (n, result) => ({ name: `subtask-${n}`, result });

test('接线：门开 + 一个空成功子任务 → status 渲「⚠️ 完成（无产出）」+ footer 计数', () => {
  withGate(undefined, () => {
    const subtasks = [sub('干活的 A', 0), sub('空转的 B', 1)];
    const aggregated = [
      agg(1, { success: true, text: 'A 真做了事', filesModified: ['a.js'] }),
      agg(2, { success: true, output: '', filesModified: [], toolCalls: 0 }),
    ];
    const out = mergeResults(subtasks, aggregated);
    assert.ok(out.includes('⚠️ 完成（无产出）'), 'status 应标注空产出');
    assert.ok(out.includes('⚠️ 完成但无产出: 1 项'), 'footer 应含空成功计数');
    // 干活的 A 仍渲普通「完成」（不误标）
    assert.ok(/状态\*\*: 完成\n/.test(out) || out.includes('**状态**: 完成'), 'A 应渲普通完成');
  });
});

test('接线：门开 + 全部真有产出 → 无空产出标注/告警（不误报）', () => {
  withGate(undefined, () => {
    const subtasks = [sub('A', 0), sub('B', 1)];
    const aggregated = [
      agg(1, { success: true, text: 'A done', filesModified: ['a.js'] }),
      agg(2, { success: true, text: 'B done', toolCalls: 2 }),
    ];
    const out = mergeResults(subtasks, aggregated);
    assert.ok(!out.includes('无产出'), '有产出不应告警');
  });
});

test('接线：门关（KHY_MERGE_EMPTY_SUCCESS=0）+ 空成功输入 → 逐字节回退今日（渲「完成」，无告警）', () => {
  withGate('0', () => {
    const subtasks = [sub('空转 A', 0)];
    const aggregated = [agg(1, { success: true, output: '', filesModified: [], toolCalls: 0 })];
    const out = mergeResults(subtasks, aggregated);
    assert.ok(!out.includes('无产出'), '门关时不应告警');
    assert.ok(out.includes('**状态**: 完成'), '门关时空成功仍渲普通完成（今日行为）');
  });
});

test('接线：空成功不改 successCount 总数（仍计入「完成 N/N」）', () => {
  withGate(undefined, () => {
    const subtasks = [sub('空转', 0)];
    const aggregated = [agg(1, { success: true, output: '', filesModified: [] })];
    const out = mergeResults(subtasks, aggregated);
    assert.ok(out.includes('- 完成: 1/1 项'), '空成功仍计入完成总数（它确实没失败）');
    assert.ok(out.includes('⚠️ 完成但无产出: 1 项'), '但 footer 醒目提示复查');
  });
});
