/**
 * Native workflow DAG interpreter (Phase 2).
 *
 * Executes a canvas graph ({ nodes, connections }) directly — the SAME JSON the
 * visual editor saves and the Markdown exporter reads. No code generation: this
 * is the runtime path.
 *
 * Control flow uses a SINGLE CURSOR rather than a topological sort, because the
 * graph legitimately contains cycles (loop back-edges). The cursor executes the
 * current node, then follows the output port the node selects (default /
 * branch-true|false / loop-body|done) to the next node, until it reaches an end
 * node or a dangling port. A MAX_STEPS guard bounds runaway loops.
 *
 * Node side effects (LLM calls, tool calls, sub-agents) are injected via
 * `primitives`, so the worker supplies the real backend infra and tests supply
 * mocks. This keeps the interpreter pure and unit-testable without booting the
 * agent engine.
 *
 * Expression evaluation (ifElse) is a CONSTRAINED comparator (`a OP b`), never
 * eval/Function — no arbitrary code execution from a stored graph.
 *
 * @pattern Interpreter
 */
'use strict';

const MAX_STEPS = 1000;

// ── Pure helpers (exported for unit tests) ───────────────────────────────────

function getPath(obj, path) {
  if (!obj || !path) return undefined;
  return String(path).split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

// Replace {{ var.path }} occurrences in a template string.
function interpolate(tmpl, vars) {
  if (tmpl == null) return '';
  return String(tmpl).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
    const v = getPath(vars, k);
    if (v == null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

// Best-effort extraction of textual output from heterogeneous primitive returns.
function extractText(res) {
  if (res == null) return '';
  if (typeof res === 'string') return res;
  if (typeof res === 'object') {
    const cand = res.text ?? res.content ?? res.finalResponse ?? res.output ?? res.result ?? res.message;
    if (cand != null) return typeof cand === 'string' ? cand : JSON.stringify(cand);
    if (res.data != null) return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    return JSON.stringify(res);
  }
  return String(res);
}

function truncate(text, max = 280) {
  const s = String(text == null ? '' : text);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// Resolve one ifElse operand token: {{var}}, bare var name, quoted string,
// number, or boolean literal.
function resolveOperand(tok, vars) {
  const t = String(tok).trim();
  const m = t.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
  if (m) return getPath(vars, m[1]);
  if (/^".*"$/.test(t) || /^'.*'$/.test(t)) return t.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^[\w.]+$/.test(t)) {
    const v = getPath(vars, t);
    if (v !== undefined) return v;
  }
  return t;
}

function compare(a, op, b) {
  const na = Number(a);
  const nb = Number(b);
  const numeric = a !== '' && b !== '' && a != null && b != null && !Number.isNaN(na) && !Number.isNaN(nb);
  switch (op) {
    case '==': return numeric ? na === nb : String(a) === String(b);
    case '!=': return numeric ? na !== nb : String(a) !== String(b);
    case '>': return numeric ? na > nb : String(a) > String(b);
    case '<': return numeric ? na < nb : String(a) < String(b);
    case '>=': return numeric ? na >= nb : String(a) >= String(b);
    case '<=': return numeric ? na <= nb : String(a) <= String(b);
    default: return false;
  }
}

// Evaluate an ifElse expression to a boolean. Supports "a OP b" and bare
// truthiness of a single value/var. NEVER executes arbitrary code.
function evalCondition(expr, vars) {
  const s = String(expr == null ? '' : expr).trim();
  if (!s) return false;
  const m = s.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (!m) {
    const v = resolveOperand(s, vars);
    return !!v && v !== 'false' && v !== '0';
  }
  return compare(resolveOperand(m[1], vars), m[2], resolveOperand(m[3], vars));
}

// Deep-resolve {{var}} references inside a tool/skill args object. A string that
// is EXACTLY "{{var}}" preserves the referenced value's type; otherwise the
// reference is interpolated into the string.
function resolveArgs(args, vars) {
  if (args == null) return {};
  if (typeof args === 'string') {
    const m = args.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
    if (m) return getPath(vars, m[1]);
    return interpolate(args, vars);
  }
  if (Array.isArray(args)) return args.map((a) => resolveArgs(a, vars));
  if (typeof args === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(args)) out[k] = resolveArgs(v, vars);
    return out;
  }
  return args;
}

// ── Default primitives (real backend infra, lazily required) ─────────────────

/**
 * Build the default side-effect primitives.
 * @param {object} [ctx]  optional execution context. `ctx.userId` is threaded
 *   into executeTool's traceContext so per-user, dynamic tools (Coze-compatible
 *   plugin tools, `plugin__<slug>__<op>`) resolve against the run owner's
 *   installed plugins + auth config.
 */
function defaultPrimitives(ctx = {}) {
  const userId = ctx && ctx.userId != null ? ctx.userId : null;
  return {
    async chat(prompt, opts = {}) {
      // Consume the cli/ai chat core via the inversion port (cli self-registers on
      // load) rather than reaching up into the CLI layer. Callers that need a
      // guaranteed chat in a non-CLI process should inject options.primitives.chat.
      const { getAiChat } = require('../aiChatPort');
      const fn = getAiChat();
      if (typeof fn !== 'function') {
        throw new Error('AI chat provider not registered (CLI not loaded; inject primitives.chat)');
      }
      return fn(prompt, opts);
    },
    async executeTool(name, params) {
      const { executeTool } = require('../toolCalling');
      return executeTool(name, params || {}, userId != null ? { userId } : {});
    },
    async executeSkill(name, params) {
      const skills = require('../../skills');
      return skills.executeSkill(name, params || {}, {});
    },
    async runSubAgent(spec) {
      // Best-effort: route through the Agent/Task tool; fall back to a plain
      // prompt if the tool surface differs.
      try {
        const AgentTool = require('../../tools/AgentTool');
        const tool = AgentTool.execute ? AgentTool : (AgentTool.default || AgentTool.AgentTool);
        if (tool && typeof tool.execute === 'function') {
          return tool.execute({
            subagent_type: 'general-purpose',
            description: spec.agentName || 'workflow sub-agent',
            prompt: spec.instructions || '',
          }, {});
        }
      } catch { /* fall through to chat */ }
      return this.chat(spec.instructions || '', { model: spec.model });
    },
    async runCode(language, source, vars) {
      if (language === 'js') {
        // The graph is the user's own, authored on their authenticated backend —
        // same trust boundary as the Bash node. Scope a vars bag, no module access.
        // eslint-disable-next-line no-new-func
        const fn = new Function('vars', `"use strict";\n${source}`);
        return fn(vars);
      }
      return this.executeTool('Bash', { command: source });
    },
    async http(req) {
      const axios = require('axios');
      const res = await axios({
        method: req.method || 'GET',
        url: req.url,
        headers: req.headers || {},
        data: req.body || undefined,
        timeout: 30000,
        validateStatus: () => true,
      });
      return { status: res.status, data: res.data };
    },
  };
}

// ── Interpreter ──────────────────────────────────────────────────────────────

function loopStateToObj(map) {
  const o = {};
  for (const [k, v] of map) o[k] = v;
  return o;
}

/**
 * Execute a graph natively.
 *
 * @param {object} graph  canonical { nodes, connections }
 * @param {object} [options]
 * @param {object} [options.primitives]  injectable side-effect fns (see defaults)
 * @param {object} [options.vars]        initial variable bag
 * @param {(entry)=>void} [options.onLog]  called after each node (live progress)
 * @param {number} [options.maxSteps]
 * @param {number} [options.quantum]  when > 0, preemptive time-slicing: after
 *   executing this many nodes in a segment, the interpreter yields control with a
 *   durable checkpoint { status:'paused', pause:{ kind:'quantum', nodeId, loopState } }
 *   pointing at the NEXT node to run. The worker re-queues and resumes it later,
 *   so a long workflow cannot monopolize the shared poller (ready-queue fairness).
 *   Yielding is transparent: resuming reproduces the exact same node sequence,
 *   final vars, and concatenated log as an uninterrupted run. 0 disables it.
 * @param {boolean} [options.pauseOnAsk]  when true, an askUserQuestion node halts
 *   the run and returns { status:'paused', pause } instead of auto-answering.
 * @param {object} [options.resume]  resume checkpoint { nodeId, answer, loopState }:
 *   start the cursor at `nodeId` (the parked askUserQuestion node), inject
 *   `answer`, and continue. Loop counters are restored from `loopState`.
 * @returns {Promise<{ status:'completed'|'paused', vars, log, pause? }>}
 */
async function runGraph(graph, options = {}) {
  const primitives = options.primitives || defaultPrimitives();
  const vars = { ...(options.vars || {}) };
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
  const maxSteps = options.maxSteps || MAX_STEPS;
  // Quantum preemption: > 0 ⇒ yield after this many nodes in the current segment.
  const quantum = Number(options.quantum) > 0 ? Math.floor(Number(options.quantum)) : 0;
  const log = [];

  const nodeList = Array.isArray(graph.nodes) ? graph.nodes : [];
  const nodes = new Map(nodeList.map((n) => [n.id, n]));
  const outEdges = new Map();
  for (const c of (Array.isArray(graph.connections) ? graph.connections : [])) {
    if (!outEdges.has(c.from)) outEdges.set(c.from, []);
    outEdges.get(c.from).push(c);
  }

  const nextNode = (nodeId, port) => {
    const edges = outEdges.get(nodeId) || [];
    const edge = edges.find((e) => (e.fromPort || 'default') === port);
    return edge ? nodes.get(edge.to) || null : null;
  };

  const start = nodeList.find((n) => n.type === 'start');
  if (!start) throw new Error('graph has no start node');

  // Resume from a durable checkpoint (cross-process human-in-the-loop OR quantum
  // preemption). A quantum resume ONLY repositions the cursor — the node it
  // points at must execute normally; only an answer (askUserQuestion) resume
  // injects a saved answer and skips its parked node. So resumeNodeId/
  // pendingAnswer stay null for a quantum resume.
  const resume = options.resume && options.resume.nodeId ? options.resume : null;
  const isQuantumResume = !!(resume && resume.kind === 'quantum');
  const loopState = new Map();
  if (resume && resume.loopState && typeof resume.loopState === 'object') {
    for (const [k, v] of Object.entries(resume.loopState)) loopState.set(k, v);
  }
  let resumeNodeId = resume && !isQuantumResume ? resume.nodeId : null;
  let pendingAnswer = resume && !isQuantumResume ? resume.answer : undefined;
  let cur = resume ? nodes.get(resume.nodeId) : start;
  if (resume && !cur) throw new Error(`resume node ${resume.nodeId} not found in graph`);
  let steps = 0;

  while (cur) {
    if (++steps > maxSteps) {
      throw new Error(`workflow exceeded ${maxSteps} steps (possible infinite loop)`);
    }
    const node = cur;
    const d = node.data || {};
    const entry = { nodeId: node.id, type: node.type, name: node.name || node.type, status: 'running' };
    let port = 'default';

    try {
      switch (node.type) {
        case 'start':
          break;

        case 'end':
          entry.status = 'succeeded';
          log.push(entry);
          onLog(entry);
          return { status: 'completed', vars, log };

        case 'prompt': {
          const text = interpolate(d.prompt, vars);
          const value = extractText(await primitives.chat(text, { model: d.model || undefined }));
          if (d.outputVar) vars[d.outputVar] = value;
          entry.summary = truncate(value);
          break;
        }

        case 'ifElse': {
          const ok = evalCondition(d.expression, vars);
          port = ok ? 'branch-true' : 'branch-false';
          entry.summary = `条件求值 => ${ok}`;
          break;
        }

        case 'loop': {
          const st = loopState.get(node.id) || { i: 0 };
          loopState.set(node.id, st);
          const forEach = d.mode === 'forEach';
          const items = forEach && Array.isArray(vars[d.itemsVar]) ? vars[d.itemsVar] : null;
          const limit = forEach ? (items ? items.length : 0) : Number(d.count || 0);
          if (st.i < limit) {
            if (forEach && items) vars[d.itemVar || 'item'] = items[st.i];
            st.i += 1;
            port = 'loop-body';
            entry.summary = `迭代 ${st.i}/${limit}`;
          } else {
            port = 'loop-done';
            entry.summary = `循环完成（共 ${st.i} 次）`;
            // Reset this loop's counter once it drains. A nested or otherwise
            // re-entered loop must restart from 0 on its next entry, not see the
            // stale terminal count (the single cursor keeps the Map alive across
            // the whole run). Only ACTIVE (mid-iteration) loops stay in the Map,
            // so a pause checkpoint snapshots exactly the loops still running.
            loopState.delete(node.id);
          }
          break;
        }

        case 'toolCall': {
          const value = extractText(await primitives.executeTool(d.tool, resolveArgs(d.args, vars)));
          if (d.outputVar) vars[d.outputVar] = value;
          entry.summary = truncate(value);
          break;
        }

        case 'skill': {
          const value = extractText(await primitives.executeSkill(d.skillName, resolveArgs(d.args, vars)));
          entry.summary = truncate(value);
          break;
        }

        case 'subAgent': {
          const value = extractText(await primitives.runSubAgent({
            agentName: d.agentName,
            instructions: interpolate(d.instructions, vars),
            model: d.model || undefined,
            tools: d.tools,
            maxTurns: d.maxTurns,
          }));
          if (d.outputVar) vars[d.outputVar] = value;
          entry.summary = truncate(value);
          break;
        }

        case 'code': {
          const source = interpolate(d.source, vars);
          const value = extractText(await primitives.runCode(d.language || 'bash', source, vars));
          if (d.outputVar) vars[d.outputVar] = value;
          entry.summary = truncate(value);
          break;
        }

        case 'http': {
          const res = await primitives.http({
            method: d.method || 'GET',
            url: interpolate(d.url, vars),
            headers: resolveArgs(d.headers, vars),
            body: d.body ? interpolate(d.body, vars) : undefined,
          });
          if (d.outputVar) vars[d.outputVar] = res;
          entry.summary = truncate(extractText(res));
          break;
        }

        case 'askUserQuestion': {
          // Human-in-the-loop. If we are resuming AT this node, inject the saved
          // answer and continue. Otherwise either pause (durable checkpoint) or,
          // when pausing is not requested, auto-answer with the first option.
          if (resumeNodeId === node.id) {
            const answer = pendingAnswer == null ? '' : pendingAnswer;
            if (d.answerVar) vars[d.answerVar] = answer;
            entry.status = 'succeeded';
            entry.summary = `已收到回答：${truncate(answer) || '(空)'}`;
            // Checkpoint consumed — clear so later asks pause normally.
            resumeNodeId = null;
            pendingAnswer = undefined;
            break;
          }
          if (options.pauseOnAsk) {
            entry.status = 'awaiting_input';
            entry.summary = '等待用户回答';
            log.push(entry);
            onLog(entry);
            return {
              status: 'paused',
              vars,
              log,
              pause: {
                nodeId: node.id,
                question: interpolate(d.question, vars),
                options: Array.isArray(d.options) ? d.options.slice() : [],
                answerVar: d.answerVar || 'answer',
                loopState: loopStateToObj(loopState),
              },
            };
          }
          const answer = (Array.isArray(d.options) && d.options[0]) || '';
          if (d.answerVar) vars[d.answerVar] = answer;
          entry.status = 'skipped';
          entry.summary = `人机交互占位，自动答：${answer || '(空)'}`;
          break;
        }

        default:
          entry.status = 'skipped';
          entry.summary = `未知节点类型 ${node.type}，已跳过`;
      }

      if (entry.status === 'running') entry.status = 'succeeded';
    } catch (err) {
      entry.status = 'failed';
      entry.error = err && err.message ? err.message : String(err);
      log.push(entry);
      onLog(entry);
      const wrapped = new Error(`节点 ${node.id} (${node.type}) 执行失败: ${entry.error}`);
      wrapped.vars = vars;
      wrapped.log = log;
      throw wrapped;
    }

    log.push(entry);
    onLog(entry);
    cur = nextNode(node.id, port);

    // Quantum preemption: after executing `quantum` nodes in this segment, yield
    // with a durable checkpoint so the worker can fairly interleave other queued
    // runs and resume this one later. Yield only when more work remains (cur set);
    // the checkpoint points at the NEXT node, which on resume runs normally (a
    // quantum resume neither skips nor injects — unlike an answer resume).
    if (quantum > 0 && cur && steps >= quantum) {
      return {
        status: 'paused',
        vars,
        log,
        pause: {
          kind: 'quantum',
          nodeId: cur.id,
          loopState: loopStateToObj(loopState),
        },
      };
    }
  }

  return { status: 'completed', vars, log };
}

module.exports = {
  runGraph,
  defaultPrimitives,
  MAX_STEPS,
  // pure helpers (unit-tested)
  interpolate,
  extractText,
  evalCondition,
  resolveArgs,
  getPath,
};
