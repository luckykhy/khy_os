const { BaseTool } = require('../_baseTool');
const { resolveToolTimeoutMs, withDeadline } = require('../_toolTimeout');

class A2ATool extends BaseTool {
  static toolName = 'A2A';
  static category = 'coordinator';
  static risk = 'medium';
  static aliases = ['a2a', 'agent_to_agent', 'send_message'];
  static searchHint = 'agent-to-agent protocol message';
  static shouldDefer = false;

  isReadOnly() {
    return false;
  }
  isConcurrencySafe() {
    return true;
  }

  prompt() {
    return `A2A (Agent-to-Agent) Protocol — communicate with other AI agents.

Operations:
- "get_agent_card" — Get agent card from remote agent
- "send_message" — Send a message to another agent
- "create_task" — Create a task on a remote agent
- "get_task" — Get task status from remote agent
- "create_local_card" — Create local agent card`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['get_agent_card', 'send_message', 'create_task', 'get_task', 'create_local_card'],
          description: 'Operation to perform',
        },
        agentUrl: {
          type: 'string',
          description: 'URL of the remote agent',
        },
        message: {
          type: 'string',
          description: 'Message to send',
        },
        taskId: {
          type: 'string',
          description: 'Task ID (for get_task)',
        },
        name: {
          type: 'string',
          description: 'Agent name (for create_local_card)',
        },
      },
      required: ['operation'],
    };
  }

  async execute(params) {
    const timeoutMs = resolveToolTimeoutMs({
      paramMs: params?.timeoutMs,
      envKey: 'KHY_A2A_TIMEOUT_MS',
      defaultMs: 30000,
      min: 1000,
      max: 60000,
    });

    try {
      const a2a = require('../../services/a2a');

      switch (params.operation) {
        case 'get_agent_card':
          if (!params.agentUrl) return { success: false, error: 'agentUrl is required' };
          return await withDeadline(() => a2a.getAgentCard(params.agentUrl), timeoutMs);

        case 'send_message':
          if (!params.agentUrl || !params.message) return { success: false, error: 'agentUrl and message are required' };
          return await withDeadline(() => a2a.sendMessage(params.agentUrl, params.message), timeoutMs);

        case 'create_task':
          if (!params.agentUrl || !params.message) return { success: false, error: 'agentUrl and message are required' };
          return await withDeadline(() => a2a.createTask(params.agentUrl, params.message), timeoutMs);

        case 'get_task':
          if (!params.agentUrl || !params.taskId) return { success: false, error: 'agentUrl and taskId are required' };
          return await withDeadline(() => a2a.getTask(params.agentUrl, params.taskId), timeoutMs);

        case 'create_local_card':
          return { success: true, card: a2a.createLocalAgentCard({ name: params.name }) };

        default:
          return { success: false, error: `Unknown operation: ${params.operation}` };
      }
    } catch (err) {
      return { success: false, error: `A2A error: ${err.message}` };
    }
  }

  getActivityDescription(input) {
    return `A2A：${input.operation || ''}`;
  }
}

module.exports = A2ATool;
