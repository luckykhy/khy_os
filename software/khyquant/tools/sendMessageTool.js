/**
 * SendMessage Tool — send follow-up instructions to a running worker.
 *
 * Only available when coordinator mode is active.
 */
const { defineTool } = require('./_baseTool');

module.exports = defineTool({
  name: 'sendMessage',
  description:
    'Send a follow-up message to a running worker agent. ' +
    'Use this to provide additional instructions based on synthesized findings.',
  category: 'coordinator',
  risk: 'low',
  isReadOnly: false,
  isConcurrencySafe: true,

  aliases: ['message_worker', 'continue_worker'],
  searchHint: 'send message worker continue follow-up coordinator',

  inputSchema: {
    to: {
      type: 'string',
      required: true,
      description: 'Worker ID (e.g., "w-abc123")',
    },
    message: {
      type: 'string',
      required: true,
      description: 'Follow-up instructions for the worker',
    },
  },

  isEnabled() {
    try {
      const { isCoordinatorMode } = require('../coordinator/coordinatorMode');
      return isCoordinatorMode();
    } catch { return false; }
  },

  getActivityDescription(input) {
    return `向工作代理发送消息：${input.to}`;
  },

  async execute(params) {
    const { sendMessage, getWorkerStatus } = require('../coordinator/workerAgent');

    const success = sendMessage(params.to, params.message);
    if (!success) {
      const worker = getWorkerStatus(params.to);
      if (!worker) {
        return { success: false, error: `Worker ${params.to} not found` };
      }
      return { success: false, error: `Worker ${params.to} is ${worker.status}, cannot receive messages` };
    }

    return {
      success: true,
      message: `已向工作代理 ${params.to} 排队发送消息`,
    };
  },
});
