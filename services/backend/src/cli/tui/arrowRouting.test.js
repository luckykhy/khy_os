'use strict';

/**
 * arrowRouting leaf tests (node:test)。
 *
 * 覆盖:
 *   - context 推导优先级(shellView > executing > idle > editing)
 *   - 四个 context × 四个方向的完整绑定矩阵(逐条对照 App.js 块 4.7 的历史行为)
 *   - executing 的 ↑ 条件绑定(queueLen)
 *   - editing 无条件回溯历史(CC Chat context 语义:不看空/不看换行)
 *   - 非方向键 → null;畸形入参绝不抛
 */

const assert = require('node:assert');
const test = require('node:test');

const {
  CONTEXTS,
  ARROW_ACTIONS,
  arrowDirection,
  resolveContext,
  resolveArrowAction,
  isArrowAction,
} = require('./arrowRouting');

const UP = { upArrow: true };
const DOWN = { downArrow: true };
const LEFT = { leftArrow: true };
const RIGHT = { rightArrow: true };

// ── arrowDirection ──────────────────────────────────────────────────────────
test('arrowDirection: 四个方向各自识别', () => {
  assert.equal(arrowDirection(UP), 'up');
  assert.equal(arrowDirection(DOWN), 'down');
  assert.equal(arrowDirection(LEFT), 'left');
  assert.equal(arrowDirection(RIGHT), 'right');
});

test('arrowDirection: 非方向键 / 畸形入参 → null,绝不抛', () => {
  for (const k of [{}, { ctrl: true }, { return: true }, null, undefined, 'up', 42, []]) {
    assert.equal(arrowDirection(k), null);
  }
});

test('arrowDirection: 多方向同按时按 上>下>左>右 确定性取一', () => {
  assert.equal(arrowDirection({ upArrow: true, downArrow: true }), 'up');
  assert.equal(arrowDirection({ downArrow: true, leftArrow: true }), 'down');
  assert.equal(arrowDirection({ leftArrow: true, rightArrow: true }), 'left');
});

// ── resolveContext:优先级就是块 4.7 的 if 顺序 ──────────────────────────────
test('resolveContext: shellView 优先级最高(压过 busy / empty 的任意组合)', () => {
  for (const busy of [true, false]) {
    for (const empty of [true, false]) {
      assert.equal(resolveContext({ shellViewOpen: true, busy, empty }), 'shellView');
    }
  }
});

test('resolveContext: busy && empty → executing', () => {
  assert.equal(resolveContext({ busy: true, empty: true }), 'executing');
});

test('resolveContext: !busy && empty → idle', () => {
  assert.equal(resolveContext({ busy: false, empty: true }), 'idle');
});

test('resolveContext: 非空缓冲区 → editing(无论 busy)', () => {
  assert.equal(resolveContext({ busy: true, empty: false }), 'editing');
  assert.equal(resolveContext({ busy: false, empty: false }), 'editing');
});

test('resolveContext: 畸形入参 → editing(最保守:交给 textInput),绝不抛', () => {
  for (const s of [null, undefined, 'x', 42, []]) {
    assert.equal(resolveContext(s), 'editing');
  }
});

// ── 绑定矩阵:逐条对照 App.js 块 4.7 的历史行为 ──────────────────────────────
test('shellView: ↑↓ 滚动一行 · ← 退出面板 · → 吞掉', () => {
  const base = { shellViewOpen: true };
  assert.equal(resolveArrowAction({ ...base, key: UP }), 'scroll:lineUp');
  assert.equal(resolveArrowAction({ ...base, key: DOWN }), 'scroll:lineDown');
  assert.equal(resolveArrowAction({ ...base, key: LEFT }), 'subview:exit');
  assert.equal(resolveArrowAction({ ...base, key: RIGHT }), 'noop');
});

test('executing: ↑ 取回排队消息(queueLen>0)· ↓ 开面板 · ←→ 吞掉', () => {
  const base = { busy: true, empty: true, queueLen: 2 };
  assert.equal(resolveArrowAction({ ...base, key: UP }), 'queue:editLast');
  assert.equal(resolveArrowAction({ ...base, key: DOWN }), 'subview:openShell');
  assert.equal(resolveArrowAction({ ...base, key: LEFT }), 'noop');
  assert.equal(resolveArrowAction({ ...base, key: RIGHT }), 'noop');
});

test('executing: 队列为空时 ↑ 降为 noop(没有可取回的消息)', () => {
  const base = { busy: true, empty: true };
  for (const queueLen of [0, undefined, null, -1, NaN, 'x']) {
    assert.equal(resolveArrowAction({ ...base, queueLen, key: UP }), 'noop');
  }
  // ↓ 不受队列长度影响
  assert.equal(resolveArrowAction({ ...base, queueLen: 0, key: DOWN }), 'subview:openShell');
});

test('idle: ↑↓ 浏览历史 · ← 吞掉(无子视图可退)· → 转发', () => {
  const base = { busy: false, empty: true };
  assert.equal(resolveArrowAction({ ...base, key: UP }), 'history:previous');
  assert.equal(resolveArrowAction({ ...base, key: DOWN }), 'history:next');
  assert.equal(resolveArrowAction({ ...base, key: LEFT }), 'noop');
  assert.equal(resolveArrowAction({ ...base, key: RIGHT }), 'input:forward');
});

test('editing: ↑↓ 无条件回溯历史(CC Chat context)· ←→ 转发光标', () => {
  const base = { busy: false, empty: false };
  assert.equal(resolveArrowAction({ ...base, key: UP }), 'history:previous');
  assert.equal(resolveArrowAction({ ...base, key: DOWN }), 'history:next');
  assert.equal(resolveArrowAction({ ...base, key: LEFT }), 'input:forward');
  assert.equal(resolveArrowAction({ ...base, key: RIGHT }), 'input:forward');
});

test('editing: 多行与单行缓冲区解析结果完全一致(hasNewline 不再参与判定)', () => {
  // 这是 Stage 2 的行为变更点:历史上单行缓冲区的竖直方向键被 KHY_HISTORY_BROWSE_EDITING
  // 门控左右,多行则无条件转发。CC 的 Chat context 对两者一视同仁,本叶子对齐之。
  for (const hasNewline of [true, false]) {
    assert.equal(
      resolveArrowAction({ busy: false, empty: false, hasNewline, key: UP }),
      'history:previous'
    );
    assert.equal(
      resolveArrowAction({ busy: false, empty: false, hasNewline, key: DOWN }),
      'history:next'
    );
  }
});

test('editing: busy 且缓冲区非空时仍是 editing(执行中也能翻历史)', () => {
  assert.equal(
    resolveArrowAction({ busy: true, empty: false, key: UP }),
    'history:previous'
  );
});

// ── 显式 context 覆盖 ───────────────────────────────────────────────────────
test('显式 context 优先于状态推导', () => {
  // 状态说是 idle,显式说是 shellView → 按显式的来
  assert.equal(
    resolveArrowAction({ context: 'shellView', busy: false, empty: true, key: LEFT }),
    'subview:exit'
  );
});

test('未知 context 名回落到状态推导(不抛、不返回 undefined)', () => {
  assert.equal(
    resolveArrowAction({ context: 'Transcript', busy: false, empty: true, key: UP }),
    'history:previous'
  );
});

// ── 契约:返回值合法性与 fail-soft ───────────────────────────────────────────
test('非方向键 → null(调用方继续走自己的兜底)', () => {
  assert.equal(resolveArrowAction({ key: { ctrl: true }, empty: true }), null);
  assert.equal(resolveArrowAction({ key: {} }), null);
  assert.equal(resolveArrowAction({}), null);
});

test('畸形入参绝不抛,且返回值恒在 ARROW_ACTIONS 内或 null', () => {
  for (const args of [null, undefined, 42, 'up', [], { key: 'up' }]) {
    const r = resolveArrowAction(args);
    assert.ok(r === null || isArrowAction(r), `unexpected: ${String(r)}`);
  }
});

test('全 context × 全方向的返回值都在 ARROW_ACTIONS 内(无拼写漂移)', () => {
  for (const context of CONTEXTS) {
    for (const key of [UP, DOWN, LEFT, RIGHT]) {
      const r = resolveArrowAction({ context, key, queueLen: 1 });
      assert.ok(isArrowAction(r), `${context} → ${String(r)}`);
    }
  }
});

test('direction 入参可直接替代 key 对象', () => {
  assert.equal(
    resolveArrowAction({ direction: 'up', busy: false, empty: true }),
    'history:previous'
  );
  // 非法 direction 回落到 key
  assert.equal(
    resolveArrowAction({ direction: 'sideways', key: DOWN, busy: false, empty: true }),
    'history:next'
  );
});

test('ARROW_ACTIONS / CONTEXTS 是冻结的(单一真源不可被调用方改写)', () => {
  assert.ok(Object.isFrozen(ARROW_ACTIONS));
  assert.ok(Object.isFrozen(CONTEXTS));
});
