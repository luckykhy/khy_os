'use strict';

/**
 * criticalPathSchedule.js — PURE LEAF (zero IO, deterministic, no Date.now/Math.random).
 *
 * Single source of truth for "task-time 统筹规划" (overall time planning) — the
 * Critical Path Method (CPM). This is the algorithm behind Hua Luogeng's classic
 * boiling-water-for-tea example: when one task has a long wait (boil water, 15 min)
 * you slot the small flexible tasks (rinse cups, fetch tea leaves) into that wait
 * instead of doing everything one-after-another. The minimum total time is the
 * critical path, NOT the sum of every task's duration.
 *
 * Given a task DAG where each task has a duration and depends on others, this leaf
 * computes (under unlimited concurrency — the theoretical optimum 统筹):
 *
 *   - earliest start / finish (ES/EF)   forward pass over a topological order
 *   - latest   start / finish (LS/LF)   backward pass
 *   - slack = LS - ES                   how much a task can float without delaying
 *   - critical path = the zero-slack chain that fixes the makespan
 *   - makespan      = min wall-clock time (= longest dependency chain by duration)
 *   - serialTotal   = sum of durations  (= doing everything one-by-one)
 *   - savedTime     = serialTotal - makespan  (what 统筹 buys you)
 *   - waitFill      = for each critical task, which independent slack tasks can be
 *                     done DURING its run window ("while boiling water, rinse cups")
 *
 * The metaphor maps exactly: a critical task is the "boil water" you must wait on;
 * the slack tasks whose flexible window [ES, LF] overlaps that wait are the
 * "watch TV / rinse cups" you fit into it for free.
 *
 * NET-NEW behavior gated at the command boundary (KHY_ORCHESTRATE_SCHEDULE);
 * the algorithm itself is unconditional pure math (mirrors orchestrationPlan.js).
 *
 * Pure leaf: no requires, no IO, deterministic, throws only on invalid input
 * (unknown dependency / dependency cycle / malformed task) so the caller surfaces
 * a clear error instead of producing a silently-wrong schedule.
 */

const FALSY = new Set(['0', 'false', 'off', 'no']);
const EPS = 1e-9;

/**
 * Gate predicate for the schedule/plan command surface. Default ON.
 * @param {object} [env=process.env]
 * @returns {boolean}
 */
function scheduleEnabled(env = process.env) {
  const flag = String((env && env.KHY_ORCHESTRATE_SCHEDULE) || '').trim().toLowerCase();
  return !FALSY.has(flag);
}

function _isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Coerce a duration to a finite non-negative number; default 1 when absent. */
function _coerceDuration(v) {
  if (v === undefined || v === null || v === '') return 1;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`criticalPathSchedule: duration must be a non-negative number (got ${JSON.stringify(v)})`);
  }
  return n;
}

/**
 * Normalize the raw task list into a canonical, validated shape.
 * @returns {Array<{id,label,duration,dependsOn:string[]}>}
 */
function _normalizeTasks(tasks) {
  if (!Array.isArray(tasks)) {
    throw new Error('criticalPathSchedule: tasks must be an array');
  }
  const seen = new Set();
  const norm = tasks.map((raw, i) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`criticalPathSchedule: tasks[${i}] must be an object`);
    }
    const id = _isNonEmptyString(raw.id) ? raw.id.trim() : `t${i + 1}`;
    if (seen.has(id)) {
      throw new Error(`criticalPathSchedule: duplicate task id "${id}"`);
    }
    seen.add(id);
    const label = _isNonEmptyString(raw.label) ? raw.label.trim() : id;
    const duration = _coerceDuration(raw.duration);
    const dependsOn = Array.isArray(raw.dependsOn)
      ? raw.dependsOn.map((d) => String(d).trim()).filter(Boolean)
      : [];
    return { id, label, duration, dependsOn };
  });
  // Validate dependency references after all ids are known.
  for (const t of norm) {
    for (const d of t.dependsOn) {
      if (!seen.has(d)) {
        throw new Error(`criticalPathSchedule: task "${t.id}" depends on unknown task "${d}"`);
      }
      if (d === t.id) {
        throw new Error(`criticalPathSchedule: task "${t.id}" depends on itself`);
      }
    }
  }
  return norm;
}

/** Kahn topological sort. Throws on a dependency cycle. */
function _topoOrder(norm) {
  const byId = new Map(norm.map((t) => [t.id, t]));
  const indeg = new Map(norm.map((t) => [t.id, 0]));
  const succ = new Map(norm.map((t) => [t.id, []]));
  for (const t of norm) {
    for (const d of t.dependsOn) {
      indeg.set(t.id, indeg.get(t.id) + 1);
      succ.get(d).push(t.id);
    }
  }
  // Seed with zero-indegree nodes in original order (stable, deterministic).
  const queue = norm.filter((t) => indeg.get(t.id) === 0).map((t) => t.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const s of succ.get(id)) {
      indeg.set(s, indeg.get(s) - 1);
      if (indeg.get(s) === 0) queue.push(s);
    }
  }
  if (order.length !== norm.length) {
    throw new Error('criticalPathSchedule: dependency cycle detected');
  }
  return { order, byId, succ };
}

/** Transitive ancestor set (all upstream deps) for every node. */
function _ancestors(norm, order, byId) {
  const anc = new Map(norm.map((t) => [t.id, new Set()]));
  // Process in topo order so a node's deps already have their ancestor sets filled.
  for (const id of order) {
    const t = byId.get(id);
    const set = anc.get(id);
    for (const d of t.dependsOn) {
      set.add(d);
      for (const a of anc.get(d)) set.add(a);
    }
  }
  return anc;
}

function _overlaps(a1, a2, b1, b2) {
  return Math.max(a1, b1) < Math.min(a2, b2); // strict: merely touching windows do not overlap
}

/**
 * Analyze a task DAG and produce the 统筹 (critical-path) schedule.
 *
 * @param {Array<{id?:string,label?:string,duration?:number,dependsOn?:string[]}>} tasks
 * @param {object} [opts]
 * @returns {{
 *   tasks: Array<{id,label,duration,dependsOn,es,ef,ls,lf,slack,critical}>,
 *   order: string[],
 *   makespan: number,
 *   serialTotal: number,
 *   savedTime: number,
 *   criticalPath: string[],
 *   waitFill: Array<{during:string,label:string,window:[number,number],canDo:Array<{id,label,duration}>}>,
 * }}
 */
function analyzeSchedule(tasks, opts = {}) {
  const norm = _normalizeTasks(tasks);
  if (norm.length === 0) {
    return { tasks: [], order: [], makespan: 0, serialTotal: 0, savedTime: 0, criticalPath: [], waitFill: [] };
  }

  const { order, byId, succ } = _topoOrder(norm);
  const anc = _ancestors(norm, order, byId);

  const es = new Map();
  const ef = new Map();
  // Forward pass: earliest start/finish.
  for (const id of order) {
    const t = byId.get(id);
    let start = 0;
    for (const d of t.dependsOn) start = Math.max(start, ef.get(d));
    es.set(id, start);
    ef.set(id, start + t.duration);
  }

  let makespan = 0;
  for (const id of order) makespan = Math.max(makespan, ef.get(id));

  const ls = new Map();
  const lf = new Map();
  // Backward pass: latest start/finish (reverse topo order).
  for (let k = order.length - 1; k >= 0; k--) {
    const id = order[k];
    const t = byId.get(id);
    const successors = succ.get(id);
    let latestFinish = successors.length === 0 ? makespan : Infinity;
    for (const s of successors) latestFinish = Math.min(latestFinish, ls.get(s));
    lf.set(id, latestFinish);
    ls.set(id, latestFinish - t.duration);
  }

  const enriched = norm.map((t) => {
    const slack = ls.get(t.id) - es.get(t.id);
    return {
      id: t.id,
      label: t.label,
      duration: t.duration,
      dependsOn: t.dependsOn.slice(),
      es: es.get(t.id),
      ef: ef.get(t.id),
      ls: ls.get(t.id),
      lf: lf.get(t.id),
      slack,
      critical: Math.abs(slack) < EPS,
    };
  });
  const byEnriched = new Map(enriched.map((e) => [e.id, e]));

  // Critical path = zero-slack tasks in topological order (the backbone that fixes makespan).
  const criticalPath = order.filter((id) => byEnriched.get(id).critical);

  // 统筹 insight: for each critical task that has a real wait (duration > 0),
  // list the independent slack tasks whose flexible window overlaps its run window.
  const waitFill = [];
  for (const id of criticalPath) {
    const C = byEnriched.get(id);
    if (C.duration <= 0) continue;
    const canDo = [];
    for (const T of enriched) {
      if (T.id === C.id) continue;
      if (T.critical) continue; // recommend only flexible (slack) tasks to fill a wait
      const independent = !anc.get(C.id).has(T.id) && !anc.get(T.id).has(C.id);
      if (!independent) continue;
      if (_overlaps(T.es, T.lf, C.es, C.ef)) {
        canDo.push({ id: T.id, label: T.label, duration: T.duration });
      }
    }
    if (canDo.length) {
      waitFill.push({ during: C.id, label: C.label, window: [C.es, C.ef], canDo });
    }
  }

  const serialTotal = norm.reduce((sum, t) => sum + t.duration, 0);

  return {
    tasks: enriched,
    order: order.slice(),
    makespan,
    serialTotal,
    savedTime: serialTotal - makespan,
    criticalPath,
    waitFill,
  };
}

module.exports = {
  scheduleEnabled,
  analyzeSchedule,
};
