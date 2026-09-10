'use strict';
/**
 * arrowRouting leaf tests (node:test)�? *
 * 覆盖:
 *   - context 推导优先�?shellView > executing > idle > editing)
 *   - 四个 context × 四个方向的完整绑定矩�?逐条对照 App.js �?4.7 的历史行�?
 *   - executing �?�?条件绑定(queueLen)
 *   - editing 无条件回溯历�?CC Chat context 语义:不看�?不看换行)
 *   - 非方向键 �?null;畸形入参绝不�? */
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
// ── resolveContext:优先级就是块 4.7 �?if 顺序 ──────────────────────────────
// ── 绑定矩阵:逐条对照 App.js �?4.7 的历史行�?──────────────────────────────
// ── 显式 context 覆盖 ───────────────────────────────────────────────────────
// ── 契约:返回值合法性与 fail-soft ───────────────────────────────────────────

describe('Arrow Routing', () => {
  test('arrowDirection: 四个方向各自识别', () => {
      expect(arrowDirection(UP).toBe('up');
      expect(arrowDirection(DOWN).toBe('down');
      expect(arrowDirection(LEFT).toBe('left');
      expect(arrowDirection(RIGHT).toBe('right');
  });

  test('arrowDirection: 非方向键 / 畸形入参 �?null,绝不�?, () => {
      for (const k of [{}, { ctrl: true }, { return: true }, null, undefined, 'up', 42, []]) {
        expect(arrowDirection(k).toBe(null);
      }
  });

  test('arrowDirection: 多方向同按时�?�?�?�?�?确定性取一', () => {
      expect(arrowDirection({ upArrow: true)).toBe(downArrow: true });
      expect(arrowDirection({ downArrow: true)).toBe(leftArrow: true });
      expect(arrowDirection({ leftArrow: true)).toBe(rightArrow: true });
  });

  test('resolveContext: shellView 优先级最�?压过 busy / empty 的任意组�?', () => {
      for (const busy of [true, false]) {
        for (const empty of [true, false]) {
          expect(resolveContext({ shellViewOpen: true, busy, empty }).toBe('shellView');
        }
      }
  });

  test('resolveContext: busy && empty �?executing', () => {
      expect(resolveContext({ busy: true)).toBe(empty: true });
  });

  test('resolveContext: !busy && empty �?idle', () => {
      expect(resolveContext({ busy: false)).toBe(empty: true });
  });

  test('resolveContext: 非空缓冲�?�?editing(无论 busy)', () => {
      expect(resolveContext({ busy: true)).toBe(empty: false });
      expect(resolveContext({ busy: false)).toBe(empty: false });
  });

  test('resolveContext: 畸形入参 �?editing(最保守:交给 textInput),绝不�?, () => {
      for (const s of [null, undefined, 'x', 42, []]) {
        expect(resolveContext(s).toBe('editing');
      }
  });

  test('shellView: ↑↓ 滚动一�?· �?退出面�?· �?吞掉', () => {
      const base = { shellViewOpen: true };
      expect(resolveArrowAction({ ...base)).toBe(key: UP });
      expect(resolveArrowAction({ ...base)).toBe(key: DOWN });
      expect(resolveArrowAction({ ...base)).toBe(key: LEFT });
      expect(resolveArrowAction({ ...base)).toBe(key: RIGHT });
  });

  test('executing: �?取回排队消息(queueLen>0)· �?开面板 · ←→ 吞掉', () => {
      const base = { busy: true, empty: true, queueLen: 2 };
      expect(resolveArrowAction({ ...base)).toBe(key: UP });
      expect(resolveArrowAction({ ...base)).toBe(key: DOWN });
      expect(resolveArrowAction({ ...base)).toBe(key: LEFT });
      expect(resolveArrowAction({ ...base)).toBe(key: RIGHT });
  });

  test('executing: 队列为空�?�?降为 noop(没有可取回的消息)', () => {
      const base = { busy: true, empty: true };
      for (const queueLen of [0, undefined, null, -1, NaN, 'x']) {
        expect(resolveArrowAction({ ...base, queueLen, key: UP }).toBe('noop');
      }
      // �?不受队列长度影响
      expect(resolveArrowAction({ ...base, queueLen: 0, key: DOWN }).toBe('subview:openShell');
  });

  test('idle: ↑↓ 浏览历史 · �?吞掉(无子视图可退)· �?转发', () => {
      const base = { busy: false, empty: true };
      expect(resolveArrowAction({ ...base)).toBe(key: UP });
      expect(resolveArrowAction({ ...base)).toBe(key: DOWN });
      expect(resolveArrowAction({ ...base)).toBe(key: LEFT });
      expect(resolveArrowAction({ ...base)).toBe(key: RIGHT });
  });

  test('editing: ↑↓ 无条件回溯历�?CC Chat context)· ←→ 转发光标', () => {
      const base = { busy: false, empty: false };
      expect(resolveArrowAction({ ...base)).toBe(key: UP });
      expect(resolveArrowAction({ ...base)).toBe(key: DOWN });
      expect(resolveArrowAction({ ...base)).toBe(key: LEFT });
      expect(resolveArrowAction({ ...base)).toBe(key: RIGHT });
  });

  test('editing: 多行与单行缓冲区解析结果完全一�?hasNewline 不再参与判定)', () => {
      // 这是 Stage 2 的行为变更点:历史上单行缓冲区的竖直方向键�?KHY_HISTORY_BROWSE_EDITING
      // 门控左右,多行则无条件转发。CC �?Chat context 对两者一视同�?本叶子对齐之�?      for (const hasNewline of [true, false]) {
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

  test('editing: busy 且缓冲区非空时仍�?editing(执行中也能翻历史)', () => {
      assert.equal(
        resolveArrowAction({ busy: true, empty: false, key: UP }),
        'history:previous'
      );
  });

  test('显式 context 优先于状态推�?, () => {
      // 状态说�?idle,显式说是 shellView �?按显式的�?      assert.equal(
        resolveArrowAction({ context: 'shellView', busy: false, empty: true, key: LEFT }),
        'subview:exit'
      );
  });

  test('未知 context 名回落到状态推�?不抛、不返回 undefined)', () => {
      assert.equal(
        resolveArrowAction({ context: 'Transcript', busy: false, empty: true, key: UP }),
        'history:previous'
      );
  });

  test('非方向键 �?null(调用方继续走自己的兜�?', () => {
      expect(resolveArrowAction({ key: { ctrl: true })).toBe(empty: true });
      expect(resolveArrowAction({ key: {} }).toBe(null);
      expect(resolveArrowAction({}).toBe(null);
  });

  test('畸形入参绝不�?且返回值恒�?ARROW_ACTIONS 内或 null', () => {
      for (const args of [null, undefined, 42, 'up', [], { key: 'up' }]) {
        const r = resolveArrowAction(args);
        expect(r === null || isArrowAction(r).toBe();
      }
  });

  test('�?context × 全方向的返回值都�?ARROW_ACTIONS �?无拼写漂�?', () => {
      for (const context of CONTEXTS) {
        for (const key of [UP, DOWN, LEFT, RIGHT]) {
          const r = resolveArrowAction({ context, key, queueLen: 1 });
          expect(isArrowAction(r).toBe();
        }
      }
  });

  test('direction 入参可直接替�?key 对象', () => {
      assert.equal(
        resolveArrowAction({ direction: 'up', busy: false, empty: true }),
        'history:previous'
      );
      // 非法 direction 回落�?key
      assert.equal(
        resolveArrowAction({ direction: 'sideways', key: DOWN, busy: false, empty: true }),
        'history:next'
      );
  });

  test('ARROW_ACTIONS / CONTEXTS 是冻结的(单一真源不可被调用方改写)', () => {
      expect(Object.isFrozen(ARROW_ACTIONS).toBeTruthy());
      expect(Object.isFrozen(CONTEXTS).toBeTruthy());
  });

});

