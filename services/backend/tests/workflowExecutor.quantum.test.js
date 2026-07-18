'use strict';

/**
 * workflowExecutor.quantum.test.js — Phase C-3 of the CB-SSP redesign (§4.C).
 *
 * Quantum preemption gives the single-cursor interpreter a time slice: after
 * `quantum` node-steps it yields a durable checkpoint instead of running to the
 * end, so the shared worker can interleave other ready runs (fairness). These
 * tests assert the MATHEMATICAL properties the design requires:
 *
 *   1. TRANSPARENCY — resuming across quantum yields reproduces the EXACT same
 *      node sequence, final vars, and log as an uninterrupted run. Preemption is
 *      invisible to the computation (for any quantum Q).
 *   2. YIELD BOUNDARY — with quantum Q on a graph longer than Q, the first
 *      segment executes exactly Q nodes and parks at the (Q+1)-th (the cursor
 *      points at the NEXT node to run).
 *   3. NO SPURIOUS YIELD — a graph no longer than Q completes in one segment.
 *   4. DISABLED (Q=0) — behaves identically to no quantum (never preempts).
 *   5. LOOP STATE — a yield landing mid-loop resumes with the loop counter intact
 *      (correct total iterations, no restart, no double-count).
 *   6. QUANTUM ≠ ANSWER RESUME — a yield that lands on an askUserQuestion node
 *      resumes by EXECUTING that node (it pauses for input), never injecting a
 *      phantom answer the way an answer-resume does.
 */

const { runGraph } = require('../src/services/workflow/workflowExecutor');

// Deterministic primitives — chat echoes its prompt so vars are reproducible.
function primitives() {
  return {
    async chat(prompt) { return `echo:${prompt}`; },
    async executeTool() { return 'tool-ok'; },
    async executeSkill() { return 'skill-ok'; },
    async runSubAgent() { return 'agent-ok'; },
    async runCode() { return 'code-ok'; },
    async http() { return { status: 200, data: 'ok' }; },
  };
}

function n(id, type, data = {}) {
  return { id, type, name: type, position: { x: 0, y: 0 }, data };
}
function e(id, from, to, fromPort = 'default') {
  return { id, from, to, fromPort, toPort: 'input' };
}

// A linear chain: start -> p1 -> p2 -> ... -> pK -> end  (K prompt nodes).
function linearGraph(k) {
  const nodes = [n('s', 'start')];
  const conns = [];
  let prev = 's';
  for (let i = 1; i <= k; i++) {
    const id = `p${i}`;
    nodes.push(n(id, 'prompt', { prompt: `step ${i} {{ seed }}`, outputVar: `r${i}` }));
    conns.push(e(`c${i}`, prev, id));
    prev = id;
  }
  nodes.push(n('e', 'end'));
  conns.push(e('cend', prev, 'e'));
  return { nodes, connections: conns };
}

// A counted loop: start -> loop(count=N, body=acc) -> end ; body appends to vars.
function loopGraph(count) {
  return {
    nodes: [
      n('s', 'start'),
      n('lp', 'loop', { mode: 'count', count }),
      n('body', 'prompt', { prompt: 'iter {{ seed }}', outputVar: 'last' }),
      n('e', 'end'),
    ],
    connections: [
      e('c0', 's', 'lp'),
      e('c1', 'lp', 'body', 'loop-body'),
      e('c2', 'body', 'lp'), // back-edge to the loop
      e('c3', 'lp', 'e', 'loop-done'),
    ],
  };
}

// Drive runGraph under a quantum exactly as the worker does: thread vars +
// loopState across yields until the run completes (or parks for input). Returns
// the concatenated log, the final vars, and how many segments it took.
async function runSliced(graph, quantum, opts = {}) {
  let vars = opts.vars || {};
  let resume = null;
  const log = [];
  let segments = 0;
  // Bound the loop so a bug cannot hang the test.
  for (let guard = 0; guard < 10000; guard++) {
    // eslint-disable-next-line no-await-in-loop
    const res = await runGraph(graph, {
      primitives: primitives(), vars, quantum, resume, pauseOnAsk: opts.pauseOnAsk,
    });
    log.push(...res.log);
    segments += 1;
    if (res.status === 'completed') return { status: 'completed', vars: res.vars, log, segments };
    if (res.pause && res.pause.kind === 'quantum') {
      vars = res.vars;
      resume = { nodeId: res.pause.nodeId, kind: 'quantum', loopState: res.pause.loopState };
      continue;
    }
    // Non-quantum pause (awaiting_input) — surface it.
    return { status: res.status, vars: res.vars, log, pause: res.pause, segments };
  }
  throw new Error('runSliced did not converge');
}

const seq = (log) => log.map((l) => l.nodeId);

describe('quantum transparency — preemption is invisible to the computation', () => {
  test.each([1, 2, 3, 5, 7, 100])('quantum=%i reproduces the uninterrupted run', async (q) => {
    const graph = linearGraph(6); // start + 6 prompts + end = 8 nodes
    const whole = await runGraph(graph, { primitives: primitives(), vars: { seed: 'X' } });
    const sliced = await runSliced(graph, q, { vars: { seed: 'X' } });

    expect(sliced.status).toBe('completed');
    // Same final variable bag.
    expect(sliced.vars).toEqual(whole.vars);
    // Same node-execution order, each node exactly once.
    expect(seq(sliced.log)).toEqual(seq(whole.log));
    // Sanity: every prompt output landed.
    expect(sliced.vars.r6).toBe('echo:step 6 X');
  });

  test('loop run is transparent under preemption (counter survives yields)', async () => {
    const graph = loopGraph(5);
    const whole = await runGraph(graph, { primitives: primitives(), vars: { seed: 'Y' } });
    // quantum=1 forces a yield between essentially every node, maximally stressing
    // the mid-loop checkpoint of loopState.
    const sliced = await runSliced(graph, 1, { vars: { seed: 'Y' } });

    expect(sliced.status).toBe('completed');
    expect(seq(sliced.log)).toEqual(seq(whole.log));
    // The loop body ran exactly `count` times in both.
    const bodyRuns = (log) => log.filter((l) => l.nodeId === 'body').length;
    expect(bodyRuns(sliced.log)).toBe(5);
    expect(bodyRuns(sliced.log)).toBe(bodyRuns(whole.log));
    expect(sliced.vars.last).toBe('echo:iter Y');
  });
});

describe('quantum yield boundary', () => {
  test('first segment executes exactly Q nodes and parks at the (Q+1)-th', async () => {
    const graph = linearGraph(6); // executed order: s, p1..p6, e
    const Q = 3;
    const first = await runGraph(graph, { primitives: primitives(), vars: { seed: 'X' }, quantum: Q });

    expect(first.status).toBe('paused');
    expect(first.pause.kind).toBe('quantum');
    expect(first.log).toHaveLength(Q); // exactly Q nodes ran this slice
    // Order is s, p1, p2 → cursor parks at p3 (the next, not-yet-run node).
    expect(seq(first.log)).toEqual(['s', 'p1', 'p2']);
    expect(first.pause.nodeId).toBe('p3');
  });

  test('a graph no longer than Q completes in one segment (no spurious yield)', async () => {
    const graph = linearGraph(2); // s, p1, p2, e = 4 nodes
    const res = await runGraph(graph, { primitives: primitives(), vars: { seed: 'X' }, quantum: 10 });
    expect(res.status).toBe('completed');
    const sliced = await runSliced(graph, 10, { vars: { seed: 'X' } });
    expect(sliced.segments).toBe(1);
  });
});

describe('quantum disabled (Q=0) is a no-op', () => {
  test('Q=0 never preempts and equals the no-quantum run', async () => {
    const graph = linearGraph(6);
    const withZero = await runGraph(graph, { primitives: primitives(), vars: { seed: 'Z' }, quantum: 0 });
    const without = await runGraph(graph, { primitives: primitives(), vars: { seed: 'Z' } });
    expect(withZero.status).toBe('completed');
    expect(seq(withZero.log)).toEqual(seq(without.log));
    expect(withZero.vars).toEqual(without.vars);
  });
});

describe('quantum resume is NOT an answer resume', () => {
  test('a yield landing on an askUserQuestion node resumes by EXECUTING it (parks for input)', async () => {
    // start -> p1 -> ask -> p2 -> end. With Q=2 the first slice runs s, p1 and
    // parks the cursor at the ask node. Resuming must EXECUTE the ask (pause for
    // input) — never inject a phantom answer (that is the answer-resume path).
    const graph = {
      nodes: [
        n('s', 'start'),
        n('p1', 'prompt', { prompt: 'a {{ seed }}', outputVar: 'r1' }),
        n('q', 'askUserQuestion', { question: 'Pick?', options: ['A', 'B'], answerVar: 'choice' }),
        n('p2', 'prompt', { prompt: 'b {{ choice }}', outputVar: 'r2' }),
        n('e', 'end'),
      ],
      connections: [e('c0', 's', 'p1'), e('c1', 'p1', 'q'), e('c2', 'q', 'p2'), e('c3', 'p2', 'e')],
    };

    const first = await runGraph(graph, { primitives: primitives(), vars: { seed: 'X' }, quantum: 2, pauseOnAsk: true });
    expect(first.status).toBe('paused');
    expect(first.pause.kind).toBe('quantum');
    expect(first.pause.nodeId).toBe('q'); // parked AT the ask, not past it

    // Resume the quantum checkpoint. It must hit the ask and pause for input —
    // with NO answer injected (choice still unset).
    const second = await runGraph(graph, {
      primitives: primitives(),
      vars: first.vars,
      quantum: 2,
      pauseOnAsk: true,
      resume: { nodeId: first.pause.nodeId, kind: 'quantum', loopState: first.pause.loopState },
    });
    expect(second.status).toBe('paused');
    expect(second.pause.kind).toBeUndefined(); // an askUserQuestion pause, not quantum
    expect(second.pause.nodeId).toBe('q');
    expect(second.pause.question).toBe('Pick?');
    expect(second.vars.choice).toBeUndefined(); // never auto-answered
  });
});
