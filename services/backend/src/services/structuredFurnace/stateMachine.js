'use strict';

/**
 * stateMachine.js — 有限状态机数据结构（DESIGN-ARCH-036 §3.2 L2 产出物）。
 *
 * L2「骨相重构」的承载体：把极度混乱/矛盾/长文输入语义切片后，重构为
 * 状态集 + 转移矩阵，让机器以确定性方式推进，而非靠模型临场猜测。
 *
 *   状态 state       = { uid, name, status, slice }   （slice = 来源语义切片摘要）
 *   转移 transition  = { from, to, on, guard?, confidence }
 *   矛盾 contradiction= { a, b, reason }   （被标记的不可调和点，喂 AnomalyHandler）
 *
 * 转移矩阵以稀疏三元组（transitions 列表）表达；matrix() 可物化为
 * from→on→to 的密集查表，供执行期 O(1) 状态流转。
 *
 * 纯数据结构、零依赖。
 */

const STATE_STATUS = Object.freeze(['PENDING', 'ACTIVE', 'DONE', 'BLOCKED', 'CONFLICT']);

class StateMachine {
  constructor() {
    this.states = new Map();    // uid -> state
    this.transitions = [];      // { from, to, on, guard, confidence }
    this.contradictions = [];   // { a, b, reason }
    this.initial = null;        // uid
  }

  addState(state) {
    if (!state || !state.uid) throw new Error('stateMachine.addState: state.uid required');
    const s = { status: 'PENDING', ...state };
    if (!STATE_STATUS.includes(s.status)) s.status = 'PENDING';
    this.states.set(s.uid, s);
    if (!this.initial) this.initial = s.uid;
    return s.uid;
  }

  setInitial(uid) {
    if (!this.states.has(uid)) throw new Error(`stateMachine.setInitial: unknown state ${uid}`);
    this.initial = uid;
  }

  addTransition(from, to, on, opts = {}) {
    if (!this.states.has(from) || !this.states.has(to)) {
      throw new Error(`stateMachine.addTransition: endpoint not found (${from} -> ${to})`);
    }
    this.transitions.push({
      from, to,
      on: String(on || 'next'),
      ...(opts.guard ? { guard: opts.guard } : {}),
      confidence: typeof opts.confidence === 'number' ? opts.confidence : 1,
    });
  }

  /** 标记一对不可调和的矛盾（L2 语义切片阶段产出，供拒损判定）。 */
  markContradiction(a, b, reason) {
    this.contradictions.push({ a, b, reason: String(reason || 'conflicting-requirements') });
  }

  hasContradictions() { return this.contradictions.length > 0; }
  stateCount() { return this.states.size; }
  transitionCount() { return this.transitions.length; }

  /** 物化转移矩阵：from -> { on -> to }。 */
  matrix() {
    const m = {};
    for (const uid of this.states.keys()) m[uid] = {};
    for (const t of this.transitions) m[t.from][t.on] = t.to;
    return m;
  }

  /** 不可达状态检测（除 initial 外入度为 0 的状态）——孤儿切片的早期信号。 */
  unreachableStates() {
    const reached = new Set(this.transitions.map((t) => t.to));
    const orphans = [];
    for (const uid of this.states.keys()) {
      if (uid !== this.initial && !reached.has(uid)) orphans.push(uid);
    }
    return orphans;
  }

  toJSON() {
    return {
      initial: this.initial,
      states: Array.from(this.states.values()),
      transitions: this.transitions.slice(),
      contradictions: this.contradictions.slice(),
    };
  }
}

module.exports = { StateMachine, STATE_STATUS };
