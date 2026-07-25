/**
 * SendMessageTool — inter-agent messaging, aligned with Claude Code's SendMessage tool.
 *
 * Sends follow-up instructions to a running worker agent. Only available
 * when coordinator mode is active. Delegates to the coordinator's
 * worker communication infrastructure.
 */
const { BaseTool } = require('../_baseTool');

class SendMessageTool extends BaseTool {
  static toolName = 'SendMessage';
  static category = 'coordinator';
  static risk = 'low';
  static aliases = ['sendMessage', 'message_worker', 'continue_worker'];
  static searchHint = 'send message worker continue follow-up coordinator agent';

  isReadOnly() { return false; }
  isConcurrencySafe() { return true; }

  isEnabled() {
    // Enabled when coordinator mode is active (process workers) OR when at least
    // one in-process teammate is registered (s15 teammate messaging).
    try {
      const { isCoordinatorMode } = require('../../coordinator/coordinatorMode');
      if (isCoordinatorMode()) return true;
    } catch { /* coordinator not available */ }
    try {
      return require('../teammateBus').listTeammates().length > 0;
    } catch { return false; }
  }

  prompt() {
    return `Send a follow-up message to a running worker agent.

Use this tool to provide additional instructions, context, or course corrections to an active worker. The worker must be in a running state to receive messages.

When to use:
- A worker needs additional context based on interim results
- You want to redirect a worker's efforts based on new information
- You need to provide follow-up instructions after reviewing partial output
- You want to continue an existing worker instead of spawning a duplicate agent for the same thread of work

Requirements:
- The target worker must exist and be in a running state
- The message should be self-contained and actionable
- Prefer this over spawning a new agent when the existing worker already has the most relevant context
- Only available when coordinator mode is active`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Worker ID to send the message to (e.g., "w-abc123")',
        },
        message: {
          type: 'string',
          description: 'Follow-up instructions for the worker',
        },
      },
      required: ['to', 'message'],
    };
  }

  getActivityDescription(input) {
    return `向工作代理发送消息：${input.to}`;
  }

  getToolUseSummary(input) {
    return `发送消息到 ${input.to}：${(input.message || '').slice(0, 40)}`;
  }

  async execute(params, _context) {
    // s15: route to an in-process teammate when `to` names one. Teammates take
    // precedence because they are the multi-turn collaboration target; fall back
    // to coordinator process workers otherwise.
    try {
      const teammateBus = require('../teammateBus');
      if (teammateBus.getTeammate(params.to)) {
        const ok = teammateBus.sendToTeammate(params.to, params.message);
        if (!ok) {
          return { success: false, error: `Teammate ${params.to} cannot receive messages` };
        }
        return { success: true, message: `已向队友 ${params.to} 投递消息` };
      }
    } catch { /* teammate bus unavailable — fall through to coordinator workers */ }

    try {
      const { sendMessage, getWorkerStatus } = require('../../coordinator/workerAgent');

      const result = sendMessage(params.to, params.message);
      if (!result.delivered) {
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
    } catch (err) {
      return { success: false, error: `SendMessage failed: ${err.message}` };
    }
  }
}

module.exports = new SendMessageTool();
module.exports.SendMessageTool = SendMessageTool;
