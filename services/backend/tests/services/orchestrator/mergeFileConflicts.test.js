'use strict';

/**
 * mergeFileConflicts.test.js — 并行写冲突检测纯叶的 node:test。
 *
 * 覆盖：门开检测 ≥2 子任务改同一文件（含 2/3 子任务）、单改无冲突、同一子任务
 * 重复列同一文件不算冲突、路径 trim 但大小写敏感（诚实边界）、畸形绝不抛、门关
 * 四 falsy token 逐字节回退、formatConflictWarning 渲染、以及 producer→consumer
 * 端到端联通（两子任务改同一文件 → 用户报告能看到冲突告警）。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  detectFileConflicts,
  formatConflictWarning,
} = require('../../../src/services/orchestrator/mergeFileConflicts');

// 切门 helper：设定 KHY_MERGE_FILE_CONFLICT，跑 fn，恢复原值。
function withGate(value, fn) {
  const prev = process.env.KHY_MERGE_FILE_CONFLICT;
  if (value === undefined) delete process.env.KHY_MERGE_FILE_CONFLICT;
  else process.env.KHY_MERGE_FILE_CONFLICT = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.KHY_MERGE_FILE_CONFLICT;
    else process.env.KHY_MERGE_FILE_CONFLICT = prev;
  }
}

test('门开：同一文件被 2 个子任务改 → 冲突项含该 file + 两 labels', () => {
  withGate(undefined, () => {
    const conflicts = detectFileConflicts([
      { label: '子任务 1', files: ['a.js', 'b.js'] },
      { label: '子任务 2', files: ['a.js', 'c.js'] },
    ]);
    assert.strictEqual(conflicts.length, 1);
    assert.strictEqual(conflicts[0].file, 'a.js');
    assert.deepStrictEqual(conflicts[0].labels.sort(), ['子任务 1', '子任务 2']);
  });
});

test('门开：同一文件被 3 个子任务改 → 3 labels', () => {
  withGate(undefined, () => {
    const conflicts = detectFileConflicts([
      { label: '子任务 1', files: ['x.js'] },
      { label: '子任务 2', files: ['x.js'] },
      { label: '子任务 3', files: ['x.js'] },
    ]);
    assert.strictEqual(conflicts.length, 1);
    assert.strictEqual(conflicts[0].labels.length, 3);
  });
});

test('门开：每个文件只被 1 个子任务改 → 无冲突', () => {
  withGate(undefined, () => {
    const conflicts = detectFileConflicts([
      { label: '子任务 1', files: ['a.js', 'b.js'] },
      { label: '子任务 2', files: ['c.js', 'd.js'] },
    ]);
    assert.deepStrictEqual(conflicts, []);
  });
});

test('门开：同一子任务重复列同一文件 → 不算冲突（label Set 去重后 <2）', () => {
  withGate(undefined, () => {
    const conflicts = detectFileConflicts([
      { label: '子任务 1', files: ['a.js', 'a.js', 'a.js'] },
    ]);
    assert.deepStrictEqual(conflicts, []);
  });
});

test('门开：文件名 trim 空白归一（" a.js " 与 "a.js" 同）', () => {
  withGate(undefined, () => {
    const conflicts = detectFileConflicts([
      { label: '子任务 1', files: [' a.js '] },
      { label: '子任务 2', files: ['a.js'] },
    ]);
    assert.strictEqual(conflicts.length, 1);
    assert.strictEqual(conflicts[0].file, 'a.js');
  });
});

test('门开：大小写敏感（A.js ≠ a.js·不 lowercase·诚实边界，避免误报）', () => {
  withGate(undefined, () => {
    const conflicts = detectFileConflicts([
      { label: '子任务 1', files: ['A.js'] },
      { label: '子任务 2', files: ['a.js'] },
    ]);
    assert.deepStrictEqual(conflicts, []);
  });
});

test('门开：畸形输入绝不抛（null / 非数组 / 项无 files / files 非数组 / 文件名非字符串 / 空串）', () => {
  withGate(undefined, () => {
    assert.deepStrictEqual(detectFileConflicts(null), []);
    assert.deepStrictEqual(detectFileConflicts('nope'), []);
    assert.deepStrictEqual(detectFileConflicts(42), []);
    assert.deepStrictEqual(detectFileConflicts([]), []);
    // 项畸形 / 文件名畸形一律安全跳过
    const conflicts = detectFileConflicts([
      null,
      { label: '子任务 1' }, // 无 files
      { label: '子任务 2', files: 'not-array' },
      { label: '子任务 3', files: [42, {}, '', '   ', null] }, // 非字符串 / 空 / 空白全跳
      { label: '子任务 4', files: ['ok.js'] },
      { label: '子任务 5', files: ['ok.js'] },
    ]);
    assert.strictEqual(conflicts.length, 1);
    assert.strictEqual(conflicts[0].file, 'ok.js');
  });
});

test('门开：多个冲突文件按 file 名稳定排序（确定性）', () => {
  withGate(undefined, () => {
    const conflicts = detectFileConflicts([
      { label: '子任务 1', files: ['z.js', 'a.js'] },
      { label: '子任务 2', files: ['z.js', 'a.js'] },
    ]);
    assert.deepStrictEqual(conflicts.map((c) => c.file), ['a.js', 'z.js']);
  });
});

test('门关：四 falsy token（0 / false / off / no）→ [] 逐字节回退', () => {
  const input = [
    { label: '子任务 1', files: ['a.js'] },
    { label: '子任务 2', files: ['a.js'] },
  ];
  for (const token of ['0', 'false', 'off', 'no']) {
    withGate(token, () => {
      assert.deepStrictEqual(
        detectFileConflicts(input),
        [],
        `门关 token=${token} 应返回 []`
      );
    });
  }
});

test('门关：大小写 / 空白不敏感（" OFF " 也关）', () => {
  withGate(' OFF ', () => {
    assert.deepStrictEqual(
      detectFileConflicts([
        { label: '子任务 1', files: ['a.js'] },
        { label: '子任务 2', files: ['a.js'] },
      ]),
      []
    );
  });
});

test('门默认（未设 env）→ 检测开启', () => {
  const prev = process.env.KHY_MERGE_FILE_CONFLICT;
  delete process.env.KHY_MERGE_FILE_CONFLICT;
  try {
    const conflicts = detectFileConflicts([
      { label: '子任务 1', files: ['a.js'] },
      { label: '子任务 2', files: ['a.js'] },
    ]);
    assert.strictEqual(conflicts.length, 1);
  } finally {
    if (prev === undefined) delete process.env.KHY_MERGE_FILE_CONFLICT;
    else process.env.KHY_MERGE_FILE_CONFLICT = prev;
  }
});

test('formatConflictWarning：非空冲突 → 含 ⚠️ + 文件名 + labels', () => {
  const warning = formatConflictWarning([
    { file: 'a.js', labels: ['子任务 1', '子任务 2'] },
  ]);
  assert.ok(warning.includes('⚠️'), '应含警示符');
  assert.ok(warning.includes('a.js'), '应含文件名');
  assert.ok(warning.includes('子任务 1'), '应含 label 1');
  assert.ok(warning.includes('子任务 2'), '应含 label 2');
});

test('formatConflictWarning：空 / 非数组 → 空串', () => {
  assert.strictEqual(formatConflictWarning([]), '');
  assert.strictEqual(formatConflictWarning(null), '');
  assert.strictEqual(formatConflictWarning('nope'), '');
});

test('端到端联通：两子任务都改 x.js → formatConflictWarning(detectFileConflicts(...)) 含 x.js + 两 label（断桥可闭合）', () => {
  withGate(undefined, () => {
    const perSubtaskFiles = [
      { label: '子任务 1', files: ['x.js', 'y.js'] },
      { label: '子任务 3', files: ['x.js', 'z.js'] },
    ];
    const warning = formatConflictWarning(detectFileConflicts(perSubtaskFiles));
    assert.ok(warning.includes('x.js'), '用户报告应看到冲突文件 x.js');
    assert.ok(warning.includes('子任务 1') && warning.includes('子任务 3'), '应指名两个冲突子任务');
    // y.js / z.js 各只被一个子任务改，不应误报
    assert.ok(!warning.includes('y.js'), 'y.js 单改不应告警');
    assert.ok(!warning.includes('z.js'), 'z.js 单改不应告警');
  });
});

test('端到端：门关时 formatConflictWarning(detectFileConflicts(...)) → 空串（无告警行 = 逐字节回退）', () => {
  withGate('0', () => {
    const warning = formatConflictWarning(detectFileConflicts([
      { label: '子任务 1', files: ['x.js'] },
      { label: '子任务 2', files: ['x.js'] },
    ]));
    assert.strictEqual(warning, '');
  });
});

// ── 接线联通：经真实 mergeResults 验证 footer 真的追加冲突告警行 ──────────────
// 证明断桥在**真实 consumer**（taskDecomposer.mergeResults）里闭合，而非只在纯叶。

const { mergeResults } = require('../../../src/services/taskDecomposer');
const sub = (prompt, originIndex) => ({ prompt, role: 'general', originIndex });
const agg = (n, result) => ({ name: `subtask-${n}`, result });

test('接线：门开 + 两并行子任务改同一文件 → mergeResults footer 含 ⚠️ 并行写冲突行', () => {
  withGate(undefined, () => {
    const subtasks = [sub('实现 A', 0), sub('实现 B', 1)];
    const aggregated = [
      agg(1, { success: true, text: 'A done', filesModified: ['shared.js', 'a.js'] }),
      agg(2, { success: true, text: 'B done', filesModified: ['shared.js', 'b.js'] }),
    ];
    const out = mergeResults(subtasks, aggregated);
    assert.ok(out.includes('⚠️ 并行写冲突'), 'footer 应含冲突告警');
    assert.ok(out.includes('shared.js'), '应指名冲突文件 shared.js');
    assert.ok(out.includes('子任务 1') && out.includes('子任务 2'), '应指名两个冲突子任务');
    // 既有「修改文件」行仍在（纯加性，不替换）
    assert.ok(out.includes('- 修改文件:'), '既有修改文件行应保留');
  });
});

test('接线：门开 + 无重叠文件 → mergeResults footer 无冲突行（不误报）', () => {
  withGate(undefined, () => {
    const subtasks = [sub('实现 A', 0), sub('实现 B', 1)];
    const aggregated = [
      agg(1, { success: true, text: 'A', filesModified: ['a.js'] }),
      agg(2, { success: true, text: 'B', filesModified: ['b.js'] }),
    ];
    const out = mergeResults(subtasks, aggregated);
    assert.ok(!out.includes('⚠️ 并行写冲突'), '无重叠不应告警');
  });
});

test('接线：门关（KHY_MERGE_FILE_CONFLICT=0）+ 冲突输入 → mergeResults footer 无冲突行（逐字节回退今日）', () => {
  withGate('0', () => {
    const subtasks = [sub('实现 A', 0), sub('实现 B', 1)];
    const aggregated = [
      agg(1, { success: true, text: 'A', filesModified: ['shared.js'] }),
      agg(2, { success: true, text: 'B', filesModified: ['shared.js'] }),
    ];
    const out = mergeResults(subtasks, aggregated);
    assert.ok(!out.includes('⚠️ 并行写冲突'), '门关时不应告警');
    // 既有去重「修改文件」行仍在（今日行为不变）
    assert.ok(out.includes('- 修改文件: shared.js'), '门关时既有去重行为不变');
  });
});
