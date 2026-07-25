'use strict';

/**
 * taskGraph.js — 有向无环图（DAG）数据结构（DESIGN-ARCH-036 §3.2 L1 产出物）。
 *
 * L1「意图织网」的承载体：把含时序/因果/条件依赖的复合需求织成节点 + 有向边，
 * 而非扁平列表（防呆②：依赖必须织成 DAG）。
 *
 *   节点 node  = 一个原子子任务 { uid, action, target, params, confidence, status }
 *   边   edge  = 依赖关系       { from, to, type:'seq'|'cond'|'cause', condition? }
 *
 * 关键能力：Kahn 拓扑排序。排序成功 ⇒ 是合法 DAG；排序失败（残留入度>0）⇒ 存在环
 * ⇒ 逻辑死锁，直接喂给 AnomalyHandler 拒损（防呆④，绝不“脑补”调和）。
 *
 * 纯数据结构、零依赖。
 */

const EDGE_TYPES = Object.freeze(['seq', 'cond', 'cause']);

class TaskGraph {
  constructor() {
    this.nodes = new Map(); // uid -> node
    this.edges = [];        // { from, to, type, condition }
  }

  addNode(node) {
    if (!node || !node.uid) throw new Error('taskGraph.addNode: node.uid required');
    this.nodes.set(node.uid, { status: 'PENDING', confidence: 1, params: {}, ...node });
    return node.uid;
  }

  /**
   * @param {string} from  前置节点 uid
   * @param {string} to    后继节点 uid
   * @param {'seq'|'cond'|'cause'} type
   * @param {object} [condition]  cond/cause 边的判定（{ on, expect } 等结构化字段）
   */
  addEdge(from, to, type = 'seq', condition = null) {
    if (!this.nodes.has(from) || !this.nodes.has(to)) {
      throw new Error(`taskGraph.addEdge: endpoint not found (${from} -> ${to})`);
    }
    const t = EDGE_TYPES.includes(type) ? type : 'seq';
    this.edges.push({ from, to, type: t, ...(condition ? { condition } : {}) });
  }

  nodeCount() { return this.nodes.size; }
  edgeCount() { return this.edges.length; }

  /** 入度表 uid -> indegree。 */
  _indegrees() {
    const deg = new Map();
    for (const uid of this.nodes.keys()) deg.set(uid, 0);
    for (const e of this.edges) deg.set(e.to, (deg.get(e.to) || 0) + 1);
    return deg;
  }

  /**
   * Kahn 拓扑排序。
   * @returns {{ ok:true, order:string[] } | { ok:false, cycle:string[] }}
   *   ok:false 时 cycle = 仍处于环中（入度未清零）的节点集合 —— 死锁证据。
   */
  topoSort() {
    const deg = this._indegrees();
    const adj = new Map();
    for (const uid of this.nodes.keys()) adj.set(uid, []);
    for (const e of this.edges) adj.get(e.from).push(e.to);

    const queue = [];
    for (const [uid, d] of deg) if (d === 0) queue.push(uid);

    const order = [];
    while (queue.length) {
      const u = queue.shift();
      order.push(u);
      for (const v of adj.get(u)) {
        deg.set(v, deg.get(v) - 1);
        if (deg.get(v) === 0) queue.push(v);
      }
    }

    if (order.length === this.nodes.size) return { ok: true, order };
    const cycle = [];
    for (const [uid, d] of deg) if (d > 0) cycle.push(uid);
    return { ok: false, cycle };
  }

  /** 是否为合法 DAG（无环）。 */
  isAcyclic() {
    return this.topoSort().ok;
  }

  /** 找到一个环（用于 AnomalyHandler 报告死锁）；无环返回 null。 */
  findCycle() {
    const r = this.topoSort();
    return r.ok ? null : r.cycle;
  }

  /** 序列化为纯 JSON（机器可解析的最终产出）。 */
  toJSON() {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: this.edges.slice(),
    };
  }
}

module.exports = { TaskGraph, EDGE_TYPES };
