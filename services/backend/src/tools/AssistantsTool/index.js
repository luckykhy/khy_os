const { BaseTool } = require('../_baseTool');
const { resolveToolTimeoutMs, withDeadline } = require('../_toolTimeout');

class AssistantsTool extends BaseTool {
  static toolName = 'Assistants';
  static category = 'ai';
  static risk = 'medium';
  static aliases = ['assistants', 'assistant', 'create_assistant'];
  static searchHint = 'assistants api create manage thread';
  static shouldDefer = false;
  static shouldDefer = false;

  isReadOnly() {
    return false;
  }
  isConcurrencySafe() {
    return true;
  }


  prompt() {
    return `Manage AI assistants via OpenAI Assistants API.

Operations:
- "create_assistant" — Create a new assistant
- "list_assistants" — List all assistants
- "get_assistant" — Get assistant details
- "delete_assistant" — Delete an assistant
- "create_thread" — Create a new conversation thread
- "create_message" — Add a message to a thread
- "create_run" — Execute a run on a thread`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['create_assistant', 'list_assistants', 'get_assistant', 'delete_assistant', 'create_thread', 'create_message', 'create_run'],
          description: 'Operation to perform',
        },
        assistantId: {
          type: 'string',
          description: 'Assistant ID (for get/delete operations)',
        },
        threadId: {
          type: 'string',
          description: 'Thread ID (for message/run operations)',
        },
        name: {
          type: 'string',
          description: 'Assistant name (for create_assistant)',
        },
        instructions: {
          type: 'string',
          description: 'Assistant instructions (for create_assistant)',
        },
        model: {
          type: 'string',
          description: 'Model to use',
        },
        content: {
          type: 'string',
          description: 'Message content (for create_message)',
        },
      },
      required: ['operation'],
    };
  }

  async execute(params) {
    const timeoutMs = resolveToolTimeoutMs({
      paramMs: params?.timeoutMs,
      envKey: 'KHY_ASSISTANTS_TIMEOUT_MS',
      defaultMs: 60000,
      min: 1000,
      max: 120000,
    });

    try {
      const assistants = require('../../services/assistants');

      if (!assistants.isProviderConfigured('openai')) {
        return { success: false, error: 'OpenAI API Key not configured.' };
      }

      switch (params.operation) {
        case 'create_assistant':
          return await withDeadline(
            () => assistants.openaiCreateAssistant({
              name: params.name,
              instructions: params.instructions,
              model: params.model,
            }),
            timeoutMs
          );

        case 'list_assistants':
          return await withDeadline(() => assistants.openaiListAssistants(), timeoutMs);

        case 'get_assistant':
          if (!params.assistantId) return { success: false, error: 'assistantId is required' };
          return await withDeadline(() => assistants.openaiGetAssistant(params.assistantId), timeoutMs);

        case 'delete_assistant':
          if (!params.assistantId) return { success: false, error: 'assistantId is required' };
          return await withDeadline(() => assistants.openaiDeleteAssistant(params.assistantId), timeoutMs);

        case 'create_thread':
          return await withDeadline(() => assistants.openaiCreateThread(), timeoutMs);

        case 'create_message':
          if (!params.threadId || !params.content) return { success: false, error: 'threadId and content are required' };
          return await withDeadline(() => assistants.openaiCreateMessage(params.threadId, params.content), timeoutMs);

        case 'create_run':
          if (!params.threadId || !params.assistantId) return { success: false, error: 'threadId and assistantId are required' };
          return await withDeadline(() => assistants.openaiCreateRun(params.threadId, params.assistantId), timeoutMs);

        default:
          return { success: false, error: `Unknown operation: ${params.operation}` };
      }
    } catch (err) {
      return { success: false, error: `Assistants error: ${err.message}` };
    }
  }

  getActivityDescription(input) {
    return `助手API：${input.operation || ''}`;
  }
}

module.exports = AssistantsTool;
