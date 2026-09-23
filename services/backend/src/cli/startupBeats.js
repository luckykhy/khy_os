'use strict';

/**
 * startupBeats — 启动板块的节拍契约（纯叶子）。
 *
 * 真源：[DESIGN-ARCH-115] TUI 启动板块设计 §4（节拍表与契约）、§6（失败态）。
 * 定位：启动板块的**单一状态真源**。TUI（BootScreen）、经典模式（startupHeader）、
 * pre-Ink 阶段行（bootPhaseLine）三个渲染器都消费这一份状态 —— 界面只是节拍表的投影，
 * 这是「一条路径胜过两条」（[DESIGN-ARCH-102] P8）在启动板块的落法。
 *
 * 三条硬规则（[DESIGN-ARCH-115] §4.2）：
 *   1. 每拍必须有真实工作负载 —— 禁止时长驱动的空壳拍；
 *   2. 完成信号必须是本拍自己的 resolve —— **禁止引用其它功能的副作用**。
 *      这条是为 D1 而写：历史实现把 banner 的 git 来源探测（`bannerUpdateLine`）
 *      当成「会话就绪」的信号，于是一个与启动无关的探测决定了启动时长。
 *   3. 就绪 = 最后一拍完成；**超时只用于降级并告知用户，绝不用来判定完成**。
 *      因此本模块不提供任何 `markDoneAfter(ms)` 之类的 API —— 想超时只能走 `fail()`，
 *      那会被记成降级并在界面上可见，而不是伪装成成功。
 *
 * 模块级单例：pre-mount 阶段（`replSession.js`）与 Ink 内（`App.js`）共享同一份进度，
 * 于是首帧即可呈现「预热起点」—— 在 Ink 挂载前就做完的拍直接显示 ✓，
 * 而不是让用户看着已完成的工作转圈。
 *
 * 纯叶子：零 IO、零 require、不读 process.env、不写 console。**never throws** ——
 * 未知 id / 重复上报一律静默忽略（fail-soft，对齐「自愈优先于报错」）。
 */

const STATUS = Object.freeze({
  PENDING: 'pending',
  ACTIVE: 'active',
  DONE: 'done',
  FAILED: 'failed',
});

/**
 * 六拍。顺序即显示顺序，也是「真实工作」的顺序。
 * critical=true 的拍失败即阻断（[DESIGN-ARCH-115] §6）；非 critical 失败 = 降级继续。
 */
const BEATS = Object.freeze([
  { id: 'env', label: '环境与配置', critical: true },
  { id: 'auth', label: '认证', critical: true },
  { id: 'render', label: '渲染引擎', critical: true },
  { id: 'workspace', label: '工作区', critical: false },
  { id: 'gateway', label: '网关', critical: false },
  { id: 'session', label: '会话', critical: false },
]);

const TERMINAL = Object.freeze([STATUS.DONE, STATUS.FAILED]);

function isTerminal(status) {
  return TERMINAL.indexOf(status) !== -1;
}

/**
 * Create an independent beat tracker.
 *
 * @param {{beats?: Array, now?: () => number}} [options]
 *        `beats` 可覆盖默认六拍（测试用）；`now` 注入时钟（测试确定性）。
 * @returns {object} tracker
 */
function createBeatTracker(options) {
  const opts = options || {};
  const defs = Array.isArray(opts.beats) && opts.beats.length ? opts.beats : BEATS;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  const order = defs.map((b) => b.id);
  const state = new Map();
  defs.forEach((b) => {
    state.set(b.id, {
      id: b.id,
      label: b.label,
      critical: b.critical === true,
      status: STATUS.PENDING,
      note: '',
      at: 0,
    });
  });

  const listeners = new Set();
  const startedAt = now();

  function notify() {
    listeners.forEach((fn) => {
      try {
        fn(tracker);
      } catch {
        /* 订阅者异常绝不能拖垮启动 */
      }
    });
  }

  /** 只允许 pending → active → (done|failed)，单调推进，不可回退（§4.2 规则 4）。 */
  function canTransition(from, to) {
    if (isTerminal(from)) return false;
    if (to === STATUS.ACTIVE) return from === STATUS.PENDING;
    if (to === STATUS.DONE || to === STATUS.FAILED) {
      return from === STATUS.PENDING || from === STATUS.ACTIVE;
    }
    return false;
  }

  function move(id, to, note) {
    const b = state.get(id);
    if (!b || !canTransition(b.status, to)) return false;
    b.status = to;
    b.note = typeof note === 'string' ? note : '';
    b.at = now();
    notify();
    return true;
  }

  const tracker = {
    /** 全部拍的快照（新数组，调用方可自由持有）。 */
    get beats() {
      return order.map((id) => Object.assign({}, state.get(id)));
    },
    /** 单拍快照；未知 id → null。 */
    get(id) {
      const b = state.get(id);
      return b ? Object.assign({}, b) : null;
    },
    /** pending → active。已在推进/已终态 → 静默忽略。 */
    start(id) {
      return move(id, STATUS.ACTIVE);
    },
    /** active|pending → done。这是**唯一**的完成入口，没有定时版本。 */
    done(id) {
      return move(id, STATUS.DONE);
    },
    /**
     * → failed。critical 拍的失败会阻断（见 blockingFailure）；
     * 非 critical 拍的失败是降级，启动继续（[DESIGN-ARCH-115] §6）。
     */
    fail(id, note) {
      return move(id, STATUS.FAILED, note);
    },
    /**
     * 预热起点：把 Ink 挂载**之前**就已完成的一批拍标记为 done。
     * 用于让首帧直接显示 ✓，而不是让用户看着已完成的工作转圈。
     */
    preload(ids) {
      if (!Array.isArray(ids)) return 0;
      let n = 0;
      ids.forEach((id) => {
        const b = state.get(id);
        if (b && !isTerminal(b.status)) {
          b.status = STATUS.DONE;
          b.note = '';
          b.at = now();
          n += 1;
        }
      });
      if (n > 0) notify();
      return n;
    },
    /** 订阅变更；返回退订函数。 */
    subscribe(fn) {
      if (typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /**
     * 就绪判据：每一拍都进入终态（done 或 failed）**且**没有 critical 拍失败。
     * 注意「failed 也算终态」—— 非 critical 的失败是降级就绪，不是卡住。
     */
    isReady() {
      for (const id of order) {
        const b = state.get(id);
        if (!isTerminal(b.status)) return false;
        if (b.status === STATUS.FAILED && b.critical) return false;
      }
      return true;
    },
    /** 第一个阻断性失败（critical 且 failed）；无 → null。 */
    blockingFailure() {
      for (const id of order) {
        const b = state.get(id);
        if (b.critical && b.status === STATUS.FAILED) return Object.assign({}, b);
      }
      return null;
    },
    /** 降级项（非 critical 且 failed）。界面据此显示「! N 项降级」。 */
    degraded() {
      return order
        .map((id) => state.get(id))
        .filter((b) => b.status === STATUS.FAILED && !b.critical)
        .map((b) => Object.assign({}, b));
    },
    /** 进度概览。 */
    progress() {
      const total = order.length;
      let done = 0;
      order.forEach((id) => {
        if (state.get(id).status === STATUS.DONE) done += 1;
      });
      return { done, total, ready: tracker.isReady(), elapsedMs: Math.max(0, now() - startedAt) };
    },
    /** 复位到初始态（测试用；生产路径不应调用）。 */
    reset() {
      order.forEach((id) => {
        const b = state.get(id);
        b.status = STATUS.PENDING;
        b.note = '';
        b.at = 0;
      });
      notify();
    },
  };

  return tracker;
}

/**
 * 模块级单例 —— pre-mount（`replSession.js`）与 Ink（`App.js`）共享。
 * 测试请用 `createBeatTracker()` 构造独立实例，不要动这个单例。
 */
const beats = createBeatTracker();

module.exports = { BEATS, STATUS, createBeatTracker, beats, isTerminal };
