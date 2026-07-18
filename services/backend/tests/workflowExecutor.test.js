/**
 * Unit tests for the native workflow DAG interpreter (workflowExecutor).
 *
 * Pure interpreter coverage with MOCKED primitives — no LLM / tools / DB / agent
 * engine booted. Verifies: pure helpers (interpolate / evalCondition / resolveArgs),
 * linear control flow, ifElse true/false branch selection, count loop iteration,
 * the askUserQuestion placeholder (auto-answer + skipped), node failure wrapping,
 * the MAX_STEPS infinite-loop guard, and human-in-the-loop pause/resume
 * (pauseOnAsk durable checkpoint + resume answer injection + loopState round-trip).
 */
'use strict';

const {
  runGraph,
  interpolate,
  evalCondition,
  resolveArgs,
  getPath,
  MAX_STEPS,
} = require('../src/services/workflow/workflowExecutor');

// ── Graph builder helpers ────────────────────────────────────────────────────

function node(id, type, data = {}, name) {
  return { id, type, name: name || type, position: { x: 0, y: 0 }, data };
}
function edge(id, from, to, fromPort = 'default', toPort = 'input') {
  return { id, from, to, fromPort, toPort };
}

// A primitive set that records calls and returns deterministic values.
function mockPrimitives(overrides = {}) {
  const calls = [];
  const base = {
    async chat(prompt, opts) { calls.push(['chat', prompt, opts]); return `echo:${prompt}`; },
    async executeTool(name, params) { calls.push(['tool', name, params]); return { ok: true, name, params }; },
    async executeSkill(name, params) { calls.push(['skill', name, params]); return `skill:${name}`; },
    async runSubAgent(spec) { calls.push(['agent', spec]); return `agent:${spec.agentName}`; },
    async runCode(lang, src) { calls.push(['code', lang, src]); return `ran:${src}`; },
    async http(req) { calls.push(['http', req]); return { status: 200, data: 'OK' }; },
  };
  return { primitives: { ...base, ...overrides }, calls };
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('pure helpers', () => {
  test('getPath walks dotted paths', () => {
    expect(getPath({ a: { b: 7 } }, 'a.b')).toBe(7);
    expect(getPath({ a: 1 }, 'x.y')).toBeUndefined();
    expect(getPath(null, 'a')).toBeUndefined();
  });

  test('interpolate replaces {{ var }} and stringifies objects', () => {
    expect(interpolate('Hi {{ name }}', { name: 'Ada' })).toBe('Hi Ada');
    expect(interpolate('{{missing}}', {})).toBe('');
    expect(interpolate('{{ obj }}', { obj: { a: 1 } })).toBe('{"a":1}');
  });

  test('evalCondition: numeric, string, var-ref, truthiness', () => {
    expect(evalCondition('3 > 2', {})).toBe(true);
    expect(evalCondition('{{ n }} >= 5', { n: 5 })).toBe(true);
    expect(evalCondition('{{ n }} < 5', { n: 9 })).toBe(false);
    expect(evalCondition('"a" == "a"', {})).toBe(true);
    expect(evalCondition('{{ flag }}', { flag: true })).toBe(true);
    expect(evalCondition('{{ flag }}', { flag: false })).toBe(false);
    expect(evalCondition('', {})).toBe(false);
  });

  test('resolveArgs deep-resolves refs and preserves exact-ref types', () => {
    const vars = { id: 42, list: [1, 2] };
    expect(resolveArgs({ x: '{{ id }}' }, vars)).toEqual({ x: 42 });
    expect(resolveArgs({ x: 'id={{ id }}' }, vars)).toEqual({ x: 'id=42' });
    expect(resolveArgs('{{ list }}', vars)).toEqual([1, 2]);
  });
});

// ── Control flow ─────────────────────────────────────────────────────────────

describe('runGraph control flow', () => {
  test('linear: start -> prompt -> end, captures outputVar', async () => {
    const graph = {
      nodes: [
        node('s', 'start'),
        node('p', 'prompt', { prompt: 'Q {{ topic }}', outputVar: 'answer' }),
        node('e', 'end'),
      ],
      connections: [edge('e1', 's', 'p'), edge('e2', 'p', 'e')],
    };
    const { primitives, calls } = mockPrimitives();
    const { vars, log, status } = await runGraph(graph, { primitives, vars: { topic: 'AI' } });
    expect(status).toBe('completed');
    expect(vars.answer).toBe('echo:Q AI');
    expect(calls[0]).toEqual(['chat', 'Q AI', { model: undefined }]);
    expect(log.map((l) => l.type)).toEqual(['start', 'prompt', 'end']);
    expect(log.every((l) => l.status === 'succeeded')).toBe(true);
  });

  test('ifElse selects branch-true', async () => {
    const graph = {
      nodes: [
        node('s', 'start'),
        node('c', 'ifElse', { expression: '{{ n }} > 1' }),
        node('t', 'prompt', { prompt: 'TRUE', outputVar: 'r' }),
        node('f', 'prompt', { prompt: 'FALSE', outputVar: 'r' }),
        node('e', 'end'),
      ],
      connections: [
        edge('e0', 's', 'c'),
        edge('e1', 'c', 't', 'branch-true'),
        edge('e2', 'c', 'f', 'branch-false'),
        edge('e3', 't', 'e'),
        edge('e4', 'f', 'e'),
      ],
    };
    const { primitives } = mockPrimitives();
    const { vars } = await runGraph(graph, { primitives, vars: { n: 5 } });
    expect(vars.r).toBe('echo:TRUE');
  });

  test('ifElse selects branch-false', async () => {
    const graph = {
      nodes: [
        node('s', 'start'),
        node('c', 'ifElse', { expression: '{{ n }} > 10' }),
        node('t', 'prompt', { prompt: 'TRUE', outputVar: 'r' }),
        node('f', 'prompt', { prompt: 'FALSE', outputVar: 'r' }),
        node('e', 'end'),
      ],
      connections: [
        edge('e0', 's', 'c'),
        edge('e1', 'c', 't', 'branch-true'),
        edge('e2', 'c', 'f', 'branch-false'),
        edge('e3', 't', 'e'),
        edge('e4', 'f', 'e'),
      ],
    };
    const { primitives } = mockPrimitives();
    const { vars } = await runGraph(graph, { primitives, vars: { n: 5 } });
    expect(vars.r).toBe('echo:FALSE');
  });

  test('count loop iterates body N times then exits via loop-done', async () => {
    let bodyRuns = 0;
    const graph = {
      nodes: [
        node('s', 'start'),
        node('lp', 'loop', { mode: 'count', count: 3 }),
        node('b', 'toolCall', { tool: 'tick', args: {} }),
        node('e', 'end'),
      ],
      connections: [
        edge('e0', 's', 'lp'),
        edge('e1', 'lp', 'b', 'loop-body'),
        edge('e2', 'b', 'lp'),          // back-edge to loop
        edge('e3', 'lp', 'e', 'loop-done'),
      ],
    };
    const { primitives } = mockPrimitives({
      async executeTool() { bodyRuns += 1; return 'tick'; },
    });
    const { log } = await runGraph(graph, { primitives });
    expect(bodyRuns).toBe(3);
    expect(log[log.length - 1].type).toBe('end');
  });

  test('askUserQuestion placeholder auto-answers and marks skipped', async () => {
    const graph = {
      nodes: [
        node('s', 'start'),
        node('q', 'askUserQuestion', { options: ['Yes', 'No'], answerVar: 'choice' }),
        node('e', 'end'),
      ],
      connections: [edge('e0', 's', 'q'), edge('e1', 'q', 'e')],
    };
    const { primitives } = mockPrimitives();
    const { vars, log } = await runGraph(graph, { primitives });
    expect(vars.choice).toBe('Yes');
    expect(log.find((l) => l.type === 'askUserQuestion').status).toBe('skipped');
  });

  test('toolCall / skill / subAgent / code / http dispatch to primitives', async () => {
    const graph = {
      nodes: [
        node('s', 'start'),
        node('t', 'toolCall', { tool: 'Read', args: { path: '{{ p }}' }, outputVar: 'tr' }),
        node('k', 'skill', { skillName: 'fmt', args: {} }),
        node('a', 'subAgent', { agentName: 'rsr', instructions: 'go {{ p }}', outputVar: 'ar' }),
        node('c', 'code', { language: 'js', source: 'x', outputVar: 'cr' }),
        node('h', 'http', { method: 'GET', url: 'http://x/{{ p }}', outputVar: 'hr' }),
        node('e', 'end'),
      ],
      connections: [
        edge('e0', 's', 't'), edge('e1', 't', 'k'), edge('e2', 'k', 'a'),
        edge('e3', 'a', 'c'), edge('e4', 'c', 'h'), edge('e5', 'h', 'e'),
      ],
    };
    const { primitives, calls } = mockPrimitives();
    const { vars } = await runGraph(graph, { primitives, vars: { p: 'q' } });
    expect(calls.find((c) => c[0] === 'tool')).toEqual(['tool', 'Read', { path: 'q' }]);
    expect(calls.find((c) => c[0] === 'agent')[1].instructions).toBe('go q');
    expect(vars.cr).toBe('ran:x');
    expect(vars.hr).toEqual({ status: 200, data: 'OK' });
  });

  test('node failure throws wrapped error carrying vars + log', async () => {
    const graph = {
      nodes: [
        node('s', 'start'),
        node('p', 'prompt', { prompt: 'boom' }),
        node('e', 'end'),
      ],
      connections: [edge('e0', 's', 'p'), edge('e1', 'p', 'e')],
    };
    const { primitives } = mockPrimitives({
      async chat() { throw new Error('LLM down'); },
    });
    await expect(runGraph(graph, { primitives })).rejects.toMatchObject({
      message: expect.stringContaining('LLM down'),
    });
  });

  test('missing start node throws', async () => {
    await expect(runGraph({ nodes: [node('e', 'end')], connections: [] }))
      .rejects.toThrow(/no start/);
  });

  test('MAX_STEPS guard trips on an infinite loop', async () => {
    const graph = {
      nodes: [node('s', 'start'), node('p', 'prompt', { prompt: 'x' })],
      connections: [edge('e0', 's', 'p'), edge('e1', 'p', 'p')], // p -> p forever
    };
    const { primitives } = mockPrimitives();
    await expect(runGraph(graph, { primitives, maxSteps: 25 }))
      .rejects.toThrow(/exceeded 25 steps/);
    expect(MAX_STEPS).toBe(1000);
  });
});

// ── Human-in-the-loop: pause & resume (durable checkpoint) ────────────────────

describe('runGraph pause / resume (askUserQuestion)', () => {
  // start -> ask -> prompt(uses answer) -> end
  function askGraph() {
    return {
      nodes: [
        node('s', 'start'),
        node('q', 'askUserQuestion', { question: 'Pick {{ topic }}?', options: ['Yes', 'No'], answerVar: 'choice' }),
        node('p', 'prompt', { prompt: 'You said {{ choice }}', outputVar: 'echoed' }),
        node('e', 'end'),
      ],
      connections: [edge('e0', 's', 'q'), edge('e1', 'q', 'p'), edge('e2', 'p', 'e')],
    };
  }

  test('pauseOnAsk halts at the ask node and returns a durable checkpoint', async () => {
    const { primitives, calls } = mockPrimitives();
    const res = await runGraph(askGraph(), { primitives, vars: { topic: 'AI' }, pauseOnAsk: true });

    expect(res.status).toBe('paused');
    expect(res.pause).toEqual({
      nodeId: 'q',
      question: 'Pick AI?',          // interpolated against vars
      options: ['Yes', 'No'],
      answerVar: 'choice',
      loopState: {},
    });
    // Halts BEFORE the downstream prompt — no chat call yet.
    expect(calls.find((c) => c[0] === 'chat')).toBeUndefined();
    // Trailing log entry is the parked ask, marked awaiting_input.
    const last = res.log[res.log.length - 1];
    expect(last).toMatchObject({ nodeId: 'q', type: 'askUserQuestion', status: 'awaiting_input' });
  });

  test('resume injects the answer and runs to completion', async () => {
    const { primitives } = mockPrimitives();
    const res = await runGraph(askGraph(), {
      primitives,
      vars: { topic: 'AI' },
      pauseOnAsk: true,
      resume: { nodeId: 'q', answer: 'No', loopState: {} },
    });

    expect(res.status).toBe('completed');
    expect(res.vars.choice).toBe('No');           // injected answer
    expect(res.vars.echoed).toBe('echo:You said No'); // downstream consumed it
    const askEntry = res.log.find((l) => l.type === 'askUserQuestion');
    expect(askEntry.status).toBe('succeeded');
  });

  test('resume restores loopState so a loop continues from where it paused', async () => {
    // start -> loop(count 3) -[body]-> ask -> (back to loop); loop-done -> end
    const graph = {
      nodes: [
        node('s', 'start'),
        node('lp', 'loop', { mode: 'count', count: 3 }),
        node('q', 'askUserQuestion', { options: ['ok'], answerVar: 'a' }),
        node('e', 'end'),
      ],
      connections: [
        edge('e0', 's', 'lp'),
        edge('e1', 'lp', 'q', 'loop-body'),
        edge('e2', 'q', 'lp'),
        edge('e3', 'lp', 'e', 'loop-done'),
      ],
    };
    const { primitives } = mockPrimitives();
    // First entry: loop ticks to i=1, then pauses at the ask.
    const first = await runGraph(graph, { primitives, pauseOnAsk: true });
    expect(first.status).toBe('paused');
    expect(first.pause.loopState).toEqual({ lp: { i: 1 } });

    // Resume with the captured loopState — the loop must NOT restart from 0.
    const second = await runGraph(graph, {
      primitives,
      pauseOnAsk: true,
      resume: { nodeId: 'q', answer: 'ok', loopState: first.pause.loopState },
    });
    // It answers iteration 1, loops back, ticks to i=2, pauses again.
    expect(second.status).toBe('paused');
    expect(second.pause.loopState).toEqual({ lp: { i: 2 } });
  });

  test('without pauseOnAsk the placeholder still auto-answers (backward compatible)', async () => {
    const { primitives } = mockPrimitives();
    const res = await runGraph(askGraph(), { primitives, vars: { topic: 'AI' } });
    expect(res.status).toBe('completed');
    expect(res.vars.choice).toBe('Yes'); // first option
    expect(res.log.find((l) => l.type === 'askUserQuestion').status).toBe('skipped');
  });

  test('resume at a non-existent node throws', async () => {
    const { primitives } = mockPrimitives();
    await expect(runGraph(askGraph(), {
      primitives, pauseOnAsk: true, resume: { nodeId: 'ghost', answer: 'x' },
    })).rejects.toThrow(/resume node ghost not found/);
  });
});

// ── Loops: forEach, nesting, and resume across loop boundaries ────────────────

describe('runGraph loops (forEach / nested / resume)', () => {
  test('forEach iterates over an array var and exposes itemVar each pass', async () => {
    const seen = [];
    const graph = {
      nodes: [
        node('s', 'start'),
        node('lp', 'loop', { mode: 'forEach', itemsVar: 'list', itemVar: 'x' }),
        node('b', 'toolCall', { tool: 'collect', args: { v: '{{ x }}' } }),
        node('e', 'end'),
      ],
      connections: [
        edge('e0', 's', 'lp'),
        edge('e1', 'lp', 'b', 'loop-body'),
        edge('e2', 'b', 'lp'),
        edge('e3', 'lp', 'e', 'loop-done'),
      ],
    };
    const { primitives } = mockPrimitives({
      async executeTool(_name, params) { seen.push(params.v); return 'ok'; },
    });
    const res = await runGraph(graph, { primitives, vars: { list: ['a', 'b', 'c'] } });
    expect(res.status).toBe('completed');
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  test('nested count loops: inner loop restarts each outer pass (loopState reset on done)', async () => {
    let bodyRuns = 0;
    // outer(2) { inner(3) { body } }
    const graph = {
      nodes: [
        node('s', 'start'),
        node('outer', 'loop', { mode: 'count', count: 2 }),
        node('inner', 'loop', { mode: 'count', count: 3 }),
        node('b', 'toolCall', { tool: 'tick', args: {} }),
        node('e', 'end'),
      ],
      connections: [
        edge('e0', 's', 'outer'),
        edge('e1', 'outer', 'inner', 'loop-body'),   // outer body enters inner
        edge('e2', 'inner', 'b', 'loop-body'),        // inner body
        edge('e3', 'b', 'inner'),                      // back to inner
        edge('e4', 'inner', 'outer', 'loop-done'),    // inner drained -> back to outer
        edge('e5', 'outer', 'e', 'loop-done'),         // outer drained -> end
      ],
    };
    const { primitives } = mockPrimitives({
      async executeTool() { bodyRuns += 1; return 'tick'; },
    });
    const res = await runGraph(graph, { primitives });
    expect(res.status).toBe('completed');
    expect(bodyRuns).toBe(6); // 2 outer * 3 inner — inner counter reset each outer pass
  });

  test('forEach pause/resume: vars + loopState round-trip continues iteration', async () => {
    // forEach over list; body asks per item. Pausing then resuming with the
    // worker-persisted vars + loopState must continue, not restart.
    const graph = {
      nodes: [
        node('s', 'start'),
        node('lp', 'loop', { mode: 'forEach', itemsVar: 'list', itemVar: 'x' }),
        node('q', 'askUserQuestion', { question: 'keep {{ x }}?', options: ['y', 'n'], answerVar: 'a' }),
        node('e', 'end'),
      ],
      connections: [
        edge('e0', 's', 'lp'),
        edge('e1', 'lp', 'q', 'loop-body'),
        edge('e2', 'q', 'lp'),
        edge('e3', 'lp', 'e', 'loop-done'),
      ],
    };
    const { primitives } = mockPrimitives();
    const vars0 = { list: ['p', 'q'] };

    // Pass 1: loop ticks to i=1, sets x='p', pauses at ask.
    const r1 = await runGraph(graph, { primitives, vars: vars0, pauseOnAsk: true });
    expect(r1.status).toBe('paused');
    expect(r1.pause.question).toBe('keep p?');
    expect(r1.pause.loopState).toEqual({ lp: { i: 1 } });

    // Resume pass 1 with the persisted vars (worker would store r1.vars) + loopState.
    const r2 = await runGraph(graph, {
      primitives,
      vars: r1.vars,
      pauseOnAsk: true,
      resume: { nodeId: 'q', answer: 'y', loopState: r1.pause.loopState },
    });
    // Answers item 'p', loops back, ticks to i=2 (x='q'), pauses again.
    expect(r2.status).toBe('paused');
    expect(r2.vars.a).toBe('y');
    expect(r2.pause.question).toBe('keep q?');
    expect(r2.pause.loopState).toEqual({ lp: { i: 2 } });

    // Resume pass 2 — answers item 'q', loop drains, runs to completion.
    const r3 = await runGraph(graph, {
      primitives,
      vars: r2.vars,
      pauseOnAsk: true,
      resume: { nodeId: 'q', answer: 'n', loopState: r2.pause.loopState },
    });
    expect(r3.status).toBe('completed');
    expect(r3.vars.a).toBe('n');
  });

  test('nested loop pause/resume restores BOTH counters', async () => {
    let bodyRuns = 0;
    // outer(2){ inner(2){ ask } } — pause fires inside the inner body.
    const graph = {
      nodes: [
        node('s', 'start'),
        node('outer', 'loop', { mode: 'count', count: 2 }),
        node('inner', 'loop', { mode: 'count', count: 2 }),
        node('q', 'askUserQuestion', { options: ['ok'], answerVar: 'a' }),
        node('e', 'end'),
      ],
      connections: [
        edge('e0', 's', 'outer'),
        edge('e1', 'outer', 'inner', 'loop-body'),
        edge('e2', 'inner', 'q', 'loop-body'),
        edge('e3', 'q', 'inner'),
        edge('e4', 'inner', 'outer', 'loop-done'),
        edge('e5', 'outer', 'e', 'loop-done'),
      ],
    };
    const { primitives } = mockPrimitives();

    // First pause: outer i=1, inner i=1 — both active, both in the snapshot.
    const first = await runGraph(graph, { primitives, pauseOnAsk: true });
    expect(first.status).toBe('paused');
    expect(first.pause.loopState).toEqual({ outer: { i: 1 }, inner: { i: 1 } });

    // Drive the whole thing to completion by repeatedly answering and resuming,
    // threading vars + loopState each round (what the worker persists in the DB).
    let cur = first;
    let answers = 0;
    while (cur.status === 'paused') {
      answers += 1;
      bodyRuns += 1;
      cur = await runGraph(graph, {
        primitives,
        vars: cur.vars,
        pauseOnAsk: true,
        resume: { nodeId: 'q', answer: 'ok', loopState: cur.pause.loopState },
      });
    }
    expect(cur.status).toBe('completed');
    // 2 outer * 2 inner = 4 ask hits total (1 before first pause + 3 via resume).
    expect(bodyRuns).toBe(4);
    expect(answers).toBe(4);
  });
});
