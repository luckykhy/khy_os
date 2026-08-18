/**
 * Built-in workflow templates — ready-to-run demonstration graphs.
 *
 * These are the "示范模板" surfaced in the editor's "从模板新建" flow. Each template
 * is a complete canvas graph ({ nodes, connections }) in the SAME shape the visual
 * editor saves, the native interpreter (workflowExecutor) runs, and the Markdown
 * exporter reads — so a template can be instantiated, run, and exported with no
 * extra wiring.
 *
 * Single source of truth: every node `type` and every connection port here is a
 * value defined in nodeCatalog. The accompanying test validates each template with
 * workflowService.validateGraph({ strict:true }), so a template that drifts from
 * the catalog (unknown type, bad port, missing start/end) fails CI rather than
 * shipping a broken graph.
 *
 * Loop convention (see workflowExecutor): a `loop` body must connect its last node
 * BACK to the loop node's `input` port so the single-cursor interpreter advances
 * the iteration; `loop-done` leads to the post-loop branch.
 *
 * @module workflow/templates
 */
'use strict';

// Deep clone so callers (and the editor) can freely mutate an instantiated copy
// without ever touching the canonical definitions below.
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const TEMPLATES = [
  // ── 1. Single-turn prompt — the "hello world" of workflows ──────────────────
  {
    id: 'simple-prompt',
    name: '单轮问答',
    description: '最小可用流程：开始 → 提示词 → 结束。演示如何用工作流输入变量驱动一次模型调用。',
    graph: {
      nodes: [
        { id: 'n_start', type: 'start', name: '开始', position: { x: 40, y: 140 }, data: { inputs: [{ key: 'topic', value: '向量数据库' }] } },
        { id: 'n_ask', type: 'prompt', name: '回答问题', position: { x: 300, y: 140 }, data: { prompt: '用三句话解释「{{topic}}」是什么，以及它的典型用途。', model: '', outputVar: 'answer' } },
        { id: 'n_end', type: 'end', name: '结束', position: { x: 560, y: 140 }, data: { outputs: [{ key: 'answer', value: '{{answer}}' }] } },
      ],
      connections: [
        { id: 'e1', from: 'n_start', fromPort: 'default', to: 'n_ask', toPort: 'input', condition: null },
        { id: 'e2', from: 'n_ask', fromPort: 'default', to: 'n_end', toPort: 'input', condition: null },
      ],
    },
  },

  // ── 2. Conditional branch — ifElse routes to two outcomes ───────────────────
  {
    id: 'conditional-review',
    name: '条件分支审查',
    description: '根据条件表达式分流：达标走「通过」，否则走「驳回」，两条分支汇入同一个结束节点。演示 ifElse 的真/假端口。',
    graph: {
      nodes: [
        { id: 'n_start', type: 'start', name: '开始', position: { x: 40, y: 180 }, data: { inputs: [{ key: 'score', value: '72' }] } },
        { id: 'n_check', type: 'ifElse', name: '是否达标', position: { x: 300, y: 180 }, data: { expression: '{{score}} >= 60', trueLabel: '达标', falseLabel: '不达标' } },
        { id: 'n_pass', type: 'prompt', name: '通过处理', position: { x: 580, y: 60 }, data: { prompt: '分数 {{score}} 已达标，生成一段祝贺语和后续建议。', model: '', outputVar: 'result' } },
        { id: 'n_fail', type: 'prompt', name: '驳回处理', position: { x: 580, y: 320 }, data: { prompt: '分数 {{score}} 未达标，说明差距并给出改进计划。', model: '', outputVar: 'result' } },
        { id: 'n_end', type: 'end', name: '结束', position: { x: 860, y: 180 }, data: { outputs: [{ key: 'result', value: '{{result}}' }] } },
      ],
      connections: [
        { id: 'e1', from: 'n_start', fromPort: 'default', to: 'n_check', toPort: 'input', condition: null },
        { id: 'e2', from: 'n_check', fromPort: 'branch-true', to: 'n_pass', toPort: 'input', condition: null },
        { id: 'e3', from: 'n_check', fromPort: 'branch-false', to: 'n_fail', toPort: 'input', condition: null },
        { id: 'e4', from: 'n_pass', fromPort: 'default', to: 'n_end', toPort: 'input', condition: null },
        { id: 'e5', from: 'n_fail', fromPort: 'default', to: 'n_end', toPort: 'input', condition: null },
      ],
    },
  },

  // ── 3. Batch loop — forEach over a list, body back-edges to the loop ─────────
  {
    id: 'batch-loop',
    name: '批量处理循环',
    description: '对集合变量逐项处理（forEach）：循环体回连到循环节点推进迭代，处理完成后由 loop-done 走向汇总与结束。演示 loop 的回边写法。',
    graph: {
      nodes: [
        { id: 'n_start', type: 'start', name: '开始', position: { x: 40, y: 200 }, data: { inputs: [{ key: 'items', value: '["北京","上海","深圳"]' }] } },
        { id: 'n_loop', type: 'loop', name: '逐项循环', position: { x: 300, y: 200 }, data: { mode: 'forEach', count: 1, itemsVar: 'items', itemVar: 'item' } },
        { id: 'n_item', type: 'prompt', name: '处理单项', position: { x: 560, y: 80 }, data: { prompt: '为城市「{{item}}」写一句话旅行推荐。', model: '', outputVar: 'itemResult' } },
        { id: 'n_summary', type: 'prompt', name: '汇总', position: { x: 560, y: 340 }, data: { prompt: '所有城市处理完成，给出一句总体总结。', model: '', outputVar: 'summary' } },
        { id: 'n_end', type: 'end', name: '结束', position: { x: 840, y: 340 }, data: { outputs: [{ key: 'summary', value: '{{summary}}' }] } },
      ],
      connections: [
        { id: 'e1', from: 'n_start', fromPort: 'default', to: 'n_loop', toPort: 'input', condition: null },
        { id: 'e2', from: 'n_loop', fromPort: 'loop-body', to: 'n_item', toPort: 'input', condition: null },
        // Back-edge: the body returns the cursor to the loop to advance the iteration.
        { id: 'e3', from: 'n_item', fromPort: 'default', to: 'n_loop', toPort: 'input', condition: null },
        { id: 'e4', from: 'n_loop', fromPort: 'loop-done', to: 'n_summary', toPort: 'input', condition: null },
        { id: 'e5', from: 'n_summary', fromPort: 'default', to: 'n_end', toPort: 'input', condition: null },
      ],
    },
  },

  // ── 4. Human-in-the-loop — agent → ask → branch on the answer ───────────────
  {
    id: 'human-in-the-loop',
    name: '人工确认发布',
    description: '子代理调研 → 询问用户是否批准 → 按回答分流到「发布」或「归档」。演示 askUserQuestion 暂停/恢复与基于回答的条件分支。',
    graph: {
      nodes: [
        { id: 'n_start', type: 'start', name: '开始', position: { x: 40, y: 200 }, data: { inputs: [{ key: 'topic', value: '新功能发布' }] } },
        { id: 'n_research', type: 'subAgent', name: '资料调研', position: { x: 260, y: 200 }, data: { agentName: 'researcher', instructions: '围绕「{{topic}}」收集 5 条关键事实并汇总。', model: '', tools: [], maxTurns: 0, outputVar: 'findings' } },
        { id: 'n_ask', type: 'askUserQuestion', name: '人工确认', position: { x: 500, y: 200 }, data: { question: '调研结论如下：\n{{findings}}\n\n是否批准发布？', options: ['批准', '驳回'], answerVar: 'decision' } },
        { id: 'n_check', type: 'ifElse', name: '是否批准', position: { x: 740, y: 200 }, data: { expression: '{{decision}} == "批准"', trueLabel: '批准', falseLabel: '驳回' } },
        { id: 'n_publish', type: 'prompt', name: '发布', position: { x: 1000, y: 80 }, data: { prompt: '已批准。撰写一段对外发布公告。', model: '', outputVar: 'result' } },
        { id: 'n_discard', type: 'prompt', name: '归档', position: { x: 1000, y: 340 }, data: { prompt: '已驳回。撰写一段说明并归档原因。', model: '', outputVar: 'result' } },
        { id: 'n_end', type: 'end', name: '结束', position: { x: 1260, y: 200 }, data: { outputs: [{ key: 'result', value: '{{result}}' }] } },
      ],
      connections: [
        { id: 'e1', from: 'n_start', fromPort: 'default', to: 'n_research', toPort: 'input', condition: null },
        { id: 'e2', from: 'n_research', fromPort: 'default', to: 'n_ask', toPort: 'input', condition: null },
        { id: 'e3', from: 'n_ask', fromPort: 'default', to: 'n_check', toPort: 'input', condition: null },
        { id: 'e4', from: 'n_check', fromPort: 'branch-true', to: 'n_publish', toPort: 'input', condition: null },
        { id: 'e5', from: 'n_check', fromPort: 'branch-false', to: 'n_discard', toPort: 'input', condition: null },
        { id: 'e6', from: 'n_publish', fromPort: 'default', to: 'n_end', toPort: 'input', condition: null },
        { id: 'e7', from: 'n_discard', fromPort: 'default', to: 'n_end', toPort: 'input', condition: null },
      ],
    },
  },

  // ── 5. Multi-agent pipeline — research → write → edit ───────────────────────
  {
    id: 'multi-agent-pipeline',
    name: '多代理写作流水线',
    description: '三个子代理串联：研究员产出提纲 → 撰稿人写初稿 → 编辑润色定稿，逐级用上一步的结果变量。演示 subAgent 的链式协作。',
    graph: {
      nodes: [
        { id: 'n_start', type: 'start', name: '开始', position: { x: 40, y: 140 }, data: { inputs: [{ key: 'topic', value: '边缘计算趋势' }] } },
        { id: 'n_researcher', type: 'subAgent', name: '研究员', position: { x: 260, y: 140 }, data: { agentName: 'researcher', instructions: '调研「{{topic}}」，输出要点提纲。', model: '', tools: [], maxTurns: 0, outputVar: 'research' } },
        { id: 'n_writer', type: 'subAgent', name: '撰稿人', position: { x: 500, y: 140 }, data: { agentName: 'writer', instructions: '根据以下提纲撰写初稿：\n{{research}}', model: '', tools: [], maxTurns: 0, outputVar: 'draft' } },
        { id: 'n_editor', type: 'subAgent', name: '编辑', position: { x: 740, y: 140 }, data: { agentName: 'editor', instructions: '润色并精简以下初稿，输出定稿：\n{{draft}}', model: '', tools: [], maxTurns: 0, outputVar: 'final' } },
        { id: 'n_end', type: 'end', name: '结束', position: { x: 980, y: 140 }, data: { outputs: [{ key: 'final', value: '{{final}}' }] } },
      ],
      connections: [
        { id: 'e1', from: 'n_start', fromPort: 'default', to: 'n_researcher', toPort: 'input', condition: null },
        { id: 'e2', from: 'n_researcher', fromPort: 'default', to: 'n_writer', toPort: 'input', condition: null },
        { id: 'e3', from: 'n_writer', fromPort: 'default', to: 'n_editor', toPort: 'input', condition: null },
        { id: 'e4', from: 'n_editor', fromPort: 'default', to: 'n_end', toPort: 'input', condition: null },
      ],
    },
  },
];

const BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));

/** Full template definitions (deep-cloned so callers cannot mutate the source). */
function getTemplates() {
  return TEMPLATES.map(clone);
}

/** One template by id, or null. Deep-cloned. */
function getTemplate(id) {
  const t = BY_ID.get(id);
  return t ? clone(t) : null;
}

/** Lightweight catalog for the picker UI — no graph payload. */
function listTemplateSummaries() {
  return TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    nodeCount: t.graph.nodes.length,
  }));
}

module.exports = {
  TEMPLATES,
  getTemplates,
  getTemplate,
  listTemplateSummaries,
};
