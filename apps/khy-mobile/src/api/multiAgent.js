// khy.multiAgent —— 多 Agent 协作框架
//
// 角色分工（借鉴 OpenClaude Agent Swarm）：
// - Manager：    规划任务 → 分解为子任务 → 分配给子 Agent
// - Executor：   执行具体子任务 → 调用工具 → 返回结果
// - Reflector：  反思结果 → 决定"继续 / 调整 / 完成"
// - Aggregator： 汇总多个子 Agent 结果 → 生成最终输出
//
// 每个子 Agent 拥有独立上下文（conversationHistory），互不干扰

import { streamChatCompletion } from './standalone.js';
import { localToolSchemas, executeLocalTool } from './localTools.js';
import { mcpToolSchemas, executeMCPTool, isMCPTool } from './mcpTools.js';

// ---------- 子 Agent ----------

/**
 * 子 Agent 类 - 独立上下文和执行能力
 */
class SubAgent {
  constructor({ id, role, systemPrompt, context = [], tools = null }) {
    this.id = id;
    this.role = role;
    this.systemPrompt = systemPrompt;
    this.context = [...context]; // 独立上下文
    this.tools = tools; // null = 继承父 Agent 工具
    this.status = 'idle'; // idle | running | completed | failed
    this.result = null;
    this.error = null;
    this.steps = 0;
    this.maxSteps = 15;
  }

  /**
   * 执行子任务
   */
  async run(task, options = {}) {
    this.status = 'running';
    const {
      baseUrl,
      apiKey,
      model,
      signal,
      onStep = () => {},
      globalTools = null,
    } = options;

    try {
      // 构建消息历史
      const messages = [
        { role: 'system', content: this.systemPrompt },
        ...this.context,
        { role: 'user', content: task },
      ];

      // 决定使用哪些工具
      const tools = this.tools || globalTools || [...localToolSchemas(), ...mcpToolSchemas()];

      // Agent 循环
      for (let step = 0; step < this.maxSteps; step++) {
        if (signal?.aborted) {
          this.status = 'failed';
          this.error = '已取消';
          return;
        }

        this.steps = step + 1;
        let accText = '';
        let accToolCall = null;

        await streamChatCompletion({
          baseUrl,
          apiKey,
          model,
          messages,
          signal,
          tools,
          onChunk: (c) => { accText += c; },
          onToolCall: (calls) => {
            accToolCall = pickToolCall({ tool_calls: calls });
          },
        });

        // 添加 assistant 消息
        const assistantMsg = {
          role: 'assistant',
          content: accText || '',
          tool_calls: accToolCall ? [{
            id: accToolCall.id,
            type: 'function',
            function: { name: accToolCall.name, arguments: JSON.stringify(accToolCall.args) },
          }] : undefined,
        };
        messages.push(assistantMsg);

        // 没有工具调用 → 任务完成
        if (!accToolCall) {
          this.status = 'completed';
          this.result = accText;
          onStep({ agentId: this.id, step: step + 1, action: 'completed', result: accText });
          return;
        }

        // 执行工具
        const { name, args, id } = accToolCall;
        onStep({ agentId: this.id, step: step + 1, action: 'tool_call', tool: name, args });

        let toolResult;
        try {
          if (isMCPTool(name)) {
            toolResult = await executeMCPTool(name, args);
          } else {
            toolResult = await executeLocalTool(name, args);
          }
        } catch (error) {
          toolResult = { ok: false, content: `执行失败: ${error.message}` };
        }

        // 添加工具结果
        messages.push({
          role: 'tool',
          tool_call_id: id,
          content: toolResult.content,
        });

        onStep({ agentId: this.id, step: step + 1, action: 'tool_result', tool: name, result: toolResult.content });
      }

      // 达到最大步数
      this.status = 'completed';
      this.result = accText || '达到最大步数限制';
    } catch (error) {
      this.status = 'failed';
      this.error = error.message;
      onStep({ agentId: this.id, step: this.steps, action: 'error', error: error.message });
    }
  }
}

/**
 * 解析工具调用
 */
function pickToolCall(assistant) {
  const tcs = assistant?.tool_calls || assistant?.message?.tool_calls || [];
  if (!Array.isArray(tcs) || tcs.length === 0) return null;
  const c = tcs[0];
  let args = {};
  try { args = c.function?.arguments ? JSON.parse(c.function.arguments) : {}; }
  catch { args = { raw: c.function?.arguments || '' }; }
  return { id: c.id || `call_${Date.now()}`, name: c.function?.name || '', args };
}

// ---------- 多 Agent 编排器 ----------

/**
 * 多 Agent 编排器
 * 协调多个子 Agent 并行或串行执行
 */
class MultiAgentOrchestrator {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.signal = options.signal;
    this.agents = new Map();
    this.results = new Map();
    this.onProgress = options.onProgress || (() => {});
  }

  /**
   * 创建子 Agent
   */
  createAgent({ id, role, systemPrompt, context = [], tools = null }) {
    const agent = new SubAgent({ id, role, systemPrompt, context, tools });
    this.agents.set(id, agent);
    return agent;
  }

  /**
   * 并行执行多个子任务
   */
  async runParallel(tasks) {
    const promises = tasks.map(({ id, task, systemPrompt, context, tools }) => {
      const agent = this.createAgent({ id, systemPrompt, context, tools });
      return agent.run(task, {
        baseUrl: this.baseUrl,
        apiKey: this.apiKey,
        model: this.model,
        signal: this.signal,
        onStep: (step) => this.onProgress({ type: 'step', agentId: id, ...step }),
      }).then(() => {
        this.results.set(id, { result: agent.result, error: agent.error, steps: agent.steps });
      });
    });

    await Promise.all(promises);
    return this.getResults();
  }

  /**
   * 串行执行多个子任务（每个任务的输入依赖前一个的输出）
   */
  async runSequential(tasks) {
    let previousResult = null;

    for (const { id, task, systemPrompt, context, tools } of tasks) {
      const agent = this.createAgent({ id, systemPrompt, context, tools });

      // 如果有前一个结果，注入到任务中
      const enrichedTask = previousResult
        ? `${task}\n\n前一个任务的结果:\n${previousResult}`
        : task;

      await agent.run(enrichedTask, {
        baseUrl: this.baseUrl,
        apiKey: this.apiKey,
        model: this.model,
        signal: this.signal,
        onStep: (step) => this.onProgress({ type: 'step', agentId: id, ...step }),
      });

      this.results.set(id, { result: agent.result, error: agent.error, steps: agent.steps });
      previousResult = agent.result;

      if (agent.status === 'failed') break;
    }

    return this.getResults();
  }

  /**
   * Manager → Executor → Reflector 工作流
   */
  async runWorkflow(task, options = {}) {
    const { managerPrompt, executorPrompt, reflectorPrompt } = options;

    // 1. Manager 规划
    const manager = this.createAgent({
      id: 'manager',
      role: 'manager',
      systemPrompt: managerPrompt || `你是任务规划师。分析用户任务，输出：
1. 任务分解（2-5 个子任务）
2. 每个子任务的执行策略
3. 预期输出格式

输出 JSON 格式：{"tasks": [{"id": "...", "task": "...", "strategy": "..."}]}`,
    });

    await manager.run(task, {
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      model: this.model,
      signal: this.signal,
    });

    // 解析 Manager 的规划
    let subtasks;
    try {
      const parsed = JSON.parse(manager.result || '{}');
      subtasks = parsed.tasks || [{ id: 'default', task: task }];
    } catch {
      subtasks = [{ id: 'default', task: task }];
    }

    this.onProgress({ type: 'plan', plan: manager.result, subtasks });

    // 2. Executor 并行执行子任务
    const executorTasks = subtasks.map((st) => ({
      id: st.id,
      task: st.task,
      systemPrompt: executorPrompt || `你是任务执行者。执行以下任务，使用可用工具。
任务：${st.task}
策略：${st.strategy || '直接执行'}

完成后输出执行结果和关键发现。`,
    }));

    await this.runParallel(executorTasks);

    // 3. Reflector 反思和汇总
    const executorResults = Array.from(this.results.entries())
      .filter(([id]) => id !== 'manager')
      .map(([id, r]) => `${id}: ${r.result}`)
      .join('\n\n');

    const reflector = this.createAgent({
      id: 'reflector',
      role: 'reflector',
      systemPrompt: reflectorPrompt || `你是结果审查员。审查以下子任务执行结果，输出：
1. 整体评估（成功/部分成功/失败）
2. 关键发现汇总
3. 建议（如有遗漏）
4. 最终结论`,
    });

    await reflector.run(`审查以下子任务结果:\n\n${executorResults}`, {
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      model: this.model,
      signal: this.signal,
    });

    return {
      plan: manager.result,
      executorResults: this.getResults(),
      reflection: reflector.result,
    };
  }

  /**
   * 获取所有结果
   */
  getResults() {
    const results = {};
    for (const [id, data] of this.results) {
      results[id] = data;
    }
    return results;
  }

  /**
   * 获取所有 Agent 状态
   */
  getStatus() {
    const status = {};
    for (const [id, agent] of this.agents) {
      status[id] = {
        role: agent.role,
        status: agent.status,
        steps: agent.steps,
        result: agent.result,
        error: agent.error,
      };
    }
    return status;
  }
}

// ---------- 导出 ----------

export { SubAgent, MultiAgentOrchestrator };

/**
 * 便捷函数：执行单 Agent 任务
 */
export async function runSingleAgent(task, options) {
  const orchestrator = new MultiAgentOrchestrator(options);
  const agent = orchestrator.createAgent({
    id: 'single',
    role: 'executor',
    systemPrompt: options.systemPrompt || `你是 AI 助手。执行用户任务，使用可用工具。`,
  });

  await agent.run(task, {
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    model: options.model,
    signal: options.signal,
    onStep: options.onStep,
  });

  return { result: agent.result, error: agent.error, steps: agent.steps };
}

/**
 * 便捷函数：执行多 Agent 并行任务
 */
export async function runParallelAgents(tasks, options) {
  const orchestrator = new MultiAgentOrchestrator(options);
  return orchestrator.runParallel(tasks);
}

/**
 * 便捷函数：执行 Manager → Executor → Reflector 工作流
 */
export async function runAgentWorkflow(task, options) {
  const orchestrator = new MultiAgentOrchestrator(options);
  return orchestrator.runWorkflow(task, options);
}
