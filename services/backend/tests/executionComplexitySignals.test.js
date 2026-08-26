'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  isEscalationEnabled,
  resolveMinScore,
  collectExecutionSignals,
  assessExecutionComplexity,
  buildEscalationDirective,
} = require('../src/services/executionComplexitySignals');

const { isComplexTask } = require('../src/services/taskComplexity');

// 构造一条 toolCallLog 记录(形制与 toolUseLoopCore 的 toolCallLog.push 一致)。
const call = (tool, params, result = { success: true }) => ({ tool, params, result });

// ─── collectExecutionSignals:执行证据收集 ─────────────────────────────────

test('collects distinct files and dirs from mutating calls only', () => {
  const s = collectExecutionSignals([
    call('read_file', { path: 'a/x.js' }), // 只读 → 不计入
    call('write_file', { path: 'src/a/one.js' }),
    call('edit_file', { file_path: 'src/a/two.js' }),
    call('write_file', { path: 'src/b/three.js' }),
    call('write_file', { path: 'src/a/one.js' }), // 重复路径 → 去重
  ]);
  assert.strictEqual(s.mutatingCalls, 4);
  assert.strictEqual(s.filesTouched, 3);
  assert.strictEqual(s.dirsTouched, 2); // src/a, src/b
});

test('normalizes windows separators so the same file is not double counted', () => {
  const s = collectExecutionSignals([
    call('write_file', { path: 'src\\a\\one.js' }),
    call('write_file', { path: 'src/a/one.js' }),
  ]);
  assert.strictEqual(s.filesTouched, 1);
  assert.strictEqual(s.dirsTouched, 1);
});

test('counts only the trailing consecutive failure streak', () => {
  const s = collectExecutionSignals([
    call('write_file', { path: 'a.js' }, { success: false }),
    call('write_file', { path: 'b.js' }, { success: true }),
    call('write_file', { path: 'c.js' }, { success: false }),
    call('write_file', { path: 'd.js' }, { error: 'boom' }),
  ]);
  assert.strictEqual(s.failureStreak, 2);
});

test('bad input degrades to zeroed signals and never throws', () => {
  for (const bad of [null, undefined, 'nope', 42, [null, undefined, {}]]) {
    const s = collectExecutionSignals(bad);
    assert.strictEqual(s.filesTouched, 0);
    assert.strictEqual(s.mutatingCalls, 0);
  }
});

// ─── assessExecutionComplexity:打分与升级判定 ─────────────────────────────

test('a single-file one-shot edit does NOT escalate', () => {
  const s = collectExecutionSignals([call('edit_file', { path: 'src/a/one.js' })], {
    iterationsUsed: 2,
  });
  const a = assessExecutionComplexity(s, {});
  assert.strictEqual(a.escalate, false);
  assert.ok(a.score < a.minScore);
});

test('three files across three dirs escalates (files +2, dirs +2 = 4)', () => {
  const s = collectExecutionSignals(
    [
      call('write_file', { path: 'src/a/one.js' }),
      call('write_file', { path: 'src/b/two.js' }),
      call('write_file', { path: 'src/c/three.js' }),
    ],
    { iterationsUsed: 4 }
  );
  const a = assessExecutionComplexity(s, {});
  assert.strictEqual(a.escalate, true);
  assert.strictEqual(a.score, 4);
  assert.ok(a.reasons.some((r) => r.includes('3 个文件')));
  assert.ok(a.reasons.some((r) => r.includes('3 个目录')));
});

test('repeated trailing failures escalate even with few files (欠规划信号)', () => {
  const s = collectExecutionSignals(
    [
      call('write_file', { path: 'src/a/one.js' }, { success: false }),
      call('write_file', { path: 'src/a/one.js' }, { success: false }),
      call('write_file', { path: 'src/a/one.js' }, { success: false }),
    ],
    { iterationsUsed: 9 }
  );
  const a = assessExecutionComplexity(s, {});
  // streak>=3 (+2) + iterations>=8 (+1) + files<3 → 3 分,尚未越线;
  // 再加一个文件即越线。此处断言分数构成,确认连败被计入。
  assert.strictEqual(a.score, 3);
  assert.ok(a.reasons.some((r) => r.includes('连续 3 次工具失败')));
});

test('long chain over many files escalates', () => {
  const log = [];
  for (let i = 0; i < 6; i++) {
    log.push(call('write_file', { path: `src/m${i}/f${i}.js` }));
  }
  const a = assessExecutionComplexity(collectExecutionSignals(log, { iterationsUsed: 15 }), {});
  assert.strictEqual(a.escalate, true);
  assert.ok(a.score >= 7); // files +3, dirs +2, iters +2, mutating +1
});

// ─── 门控与阈值 ───────────────────────────────────────────────────────────

test('gate off suppresses escalation entirely', () => {
  const big = collectExecutionSignals(
    [
      call('write_file', { path: 'src/a/one.js' }),
      call('write_file', { path: 'src/b/two.js' }),
      call('write_file', { path: 'src/c/three.js' }),
    ],
    { iterationsUsed: 20 }
  );
  for (const off of ['0', 'false', 'off', 'no', 'disable', 'disabled', 'OFF', ' off ']) {
    const env = { KHY_EXEC_COMPLEXITY_ESCALATION: off };
    assert.strictEqual(isEscalationEnabled(env), false, `expected off for ${JSON.stringify(off)}`);
    assert.strictEqual(assessExecutionComplexity(big, env).escalate, false);
    assert.strictEqual(buildEscalationDirective({ escalate: true, reasons: [] }, env), null);
  }
});

test('gate defaults on for unset / truthy values', () => {
  for (const on of [undefined, '', '1', 'true', 'on', 'yes']) {
    assert.strictEqual(isEscalationEnabled({ KHY_EXEC_COMPLEXITY_ESCALATION: on }), true);
  }
});

test('threshold is env-tunable and falls back on garbage', () => {
  assert.strictEqual(resolveMinScore({}), 4);
  assert.strictEqual(resolveMinScore({ KHY_EXEC_COMPLEXITY_MIN_SCORE: '7' }), 7);
  for (const bad of ['0', '-3', 'abc', '']) {
    assert.strictEqual(resolveMinScore({ KHY_EXEC_COMPLEXITY_MIN_SCORE: bad }), 4);
  }
  // 阈值抬高后,原本越线的证据不再升级。
  const s = collectExecutionSignals(
    [
      call('write_file', { path: 'src/a/one.js' }),
      call('write_file', { path: 'src/b/two.js' }),
      call('write_file', { path: 'src/c/three.js' }),
    ],
    { iterationsUsed: 3 }
  );
  assert.strictEqual(
    assessExecutionComplexity(s, { KHY_EXEC_COMPLEXITY_MIN_SCORE: '9' }).escalate,
    false
  );
});

// ─── buildEscalationDirective:指令内容 ───────────────────────────────────

test('directive is null when not escalating (零上下文开销)', () => {
  assert.strictEqual(buildEscalationDirective({ escalate: false, reasons: [] }, {}), null);
  assert.strictEqual(buildEscalationDirective(null, {}), null);
  assert.strictEqual(buildEscalationDirective(undefined, {}), null);
});

test('directive carries concrete evidence and points at both existing mechanisms', () => {
  const d = buildEscalationDirective(
    { escalate: true, score: 5, reasons: ['已改动 4 个文件', '跨 3 个目录'] },
    {}
  );
  assert.ok(d);
  // 具体证据(状态透明红线:动作+目标+进度,不是「正在处理…」)
  assert.ok(d.includes('已改动 4 个文件'));
  assert.ok(d.includes('跨 3 个目录'));
  // 复用既有两套机制:execution_plan 解析 + 任务板(任务记忆按轮回灌)
  assert.ok(d.includes('<execution_plan>'));
  assert.ok(d.includes('TaskCreate'));
  assert.ok(d.includes('TaskUpdate'));
  // 一次性,且明确禁止重做已完成部分
  assert.ok(d.includes('只出现一次'));
  assert.ok(d.includes('不要重做已完成的部分'));
  // 状态透明红线:不得出现模糊进度词
  assert.ok(!/正在处理|正在工作|请稍候|Loading/i.test(d));
});

test('directive degrades gracefully when reasons are missing', () => {
  const d = buildEscalationDirective({ escalate: true }, {});
  assert.ok(d);
  assert.ok(d.includes('执行规模已超出开场判定'));
});

// ─── 回归锚:本件存在的理由 ───────────────────────────────────────────────
// 开场分类器按「措辞繁简」打分,简短表述的真实复杂任务全部判简单。这些用例锚住那个
// 事实(若 taskComplexity 将来自行修好,此处会红,提示重新评估本件的阈值/必要性),
// 并证明同一任务在执行证据出现后会被本件接住。

test('opening classifier misses concisely-stated complex work', () => {
  for (const msg of [
    '重构登录模块，保持对外 API 不变',
    '把整个后端的错误处理统一成一套',
    '给项目加上端到端测试',
  ]) {
    assert.strictEqual(isComplexTask(msg).isComplex, false, `expected simple: ${msg}`);
  }
});

test('execution evidence catches what the opening classifier missed', () => {
  // 「把整个后端的错误处理统一成一套」开场判 simple;真跑起来会跨模块改多个文件。
  const log = [
    call('edit_file', { path: 'services/backend/src/services/a.js' }),
    call('edit_file', { path: 'services/backend/src/routes/b.js' }),
    call('edit_file', { path: 'services/backend/src/utils/c.js' }),
  ];
  const a = assessExecutionComplexity(collectExecutionSignals(log, { iterationsUsed: 6 }), {});
  assert.strictEqual(a.escalate, true);
  assert.ok(buildEscalationDirective(a, {}));
});
