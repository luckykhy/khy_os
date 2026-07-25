/**
 * CronDeleteTool — cancel a scheduled cron job.
 * Aligned with Claude Code's CronDelete tool.
 */
const { BaseTool } = require('../_baseTool');

class CronDeleteTool extends BaseTool {
  static toolName = 'CronDelete';
  static category = 'system';
  static risk = 'low';
  static aliases = ['cron_delete', 'delete_cron'];
  static searchHint = 'cancel cron job schedule remove';

  isReadOnly() { return false; }
  isConcurrencySafe() { return false; }

  prompt() {
    return `Cancel a cron job previously scheduled with ScheduleCron/CronCreate.
Removes it from .khy/scheduled_tasks.json (durable jobs) or the in-memory session store (session-only jobs).`;
  }

  get inputSchema() {
    return {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Job ID returned by CronCreate/ScheduleCron.' },
      },
    };
  }

  async execute(params) {
    try {
      const cronScheduler = require('../../jobs/cronScheduler');
      const deleted = cronScheduler.deleteJob(params.id);
      if (deleted) {
        return { success: true, message: `Job ${params.id} cancelled.` };
      }
      return { error: `Job "${params.id}" not found.` };
    } catch (err) {
      return { error: err.message };
    }
  }
}

module.exports = CronDeleteTool;
