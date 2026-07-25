const { BaseTool } = require('../_baseTool');
const teammateBus = require('../teammateBus');

class TeamDeleteTool extends BaseTool {
  static toolName = 'TeamDelete';
  static category = 'coordinator';
  static risk = 'medium';
  static aliases = ['team_delete', 'delete_teammate'];
  static searchHint = 'team delete remove teammate';
  static shouldDefer = true;

  isConcurrencySafe() { return false; }

  prompt() {
    return `Delete a teammate created by TeamCreate.

By default this performs a GRACEFUL shutdown handshake (s16): the lead sends a
shutdown_request and the teammate is removed only after it confirms with a
shutdown_response, so it can finish writing files instead of being killed
mid-operation. A teammate that has already finished is removed immediately.

Set force: true to remove the teammate at once without waiting for confirmation
(use only when the teammate is stuck or unresponsive).`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        teammate_id: { type: 'string', description: 'ID of the teammate to delete' },
        force: {
          type: 'boolean',
          description: 'Skip the graceful handshake and remove immediately (default: false).',
        },
      },
      required: ['teammate_id'],
    };
  }

  async execute(params) {
    const { teammate_id: teammateId, force } = params;

    if (!teammateBus.getTeammate(teammateId)) {
      return { success: false, error: `Teammate ${teammateId} not found` };
    }

    if (force) {
      teammateBus.deleteTeammate(teammateId);
      return { success: true, deleted: teammateId, mode: 'force' };
    }

    const res = teammateBus.requestShutdown(teammateId);
    if (res && res.error) {
      return { success: false, error: res.error };
    }
    if (res.status === 'approved') {
      // Teammate was already finished — shut down immediately, no handshake.
      return { success: true, deleted: teammateId, mode: 'graceful', requestId: res.requestId };
    }
    return {
      success: true,
      stopping: teammateId,
      requestId: res.requestId,
      mode: 'graceful',
      message: '已发起优雅关闭握手；队友确认 shutdown_response 后移除。',
    };
  }
}

module.exports = TeamDeleteTool;
