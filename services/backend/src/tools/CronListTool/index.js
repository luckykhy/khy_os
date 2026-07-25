/**
 * CronListTool — list all scheduled cron jobs.
 * Aligned with Claude Code's CronList tool.
 */
const { BaseTool } = require('../_baseTool');

class CronListTool extends BaseTool {
  static toolName = 'CronList';
  static category = 'system';
  static risk = 'safe';
  static aliases = ['cron_list', 'list_cron'];
  static searchHint = 'list cron jobs schedule view';

  isReadOnly() { return true; }
  isConcurrencySafe() { return true; }

  prompt() {
    return `List all cron jobs scheduled via CronCreate/ScheduleCron, both durable (.khy/scheduled_tasks.json) and session-only.`;
  }

  get inputSchema() {
    return { type: 'object', properties: {} };
  }

  async execute() {
    const cronScheduler = require('../../jobs/cronScheduler');
    try {
      // Reflect on-disk durable jobs even when the scheduler was never started
      // in this context. A missing scheduled_tasks.json is the normal first-run
      // state (no durable jobs yet) and yields an empty list — never an error.
      if (typeof cronScheduler.ensureDurableLoaded === 'function') {
        cronScheduler.ensureDurableLoaded();
      }
      const jobs = cronScheduler.listJobs();
      // `success: true` is REQUIRED: the tool-result formatter treats a falsy
      // `success` as an error and would surface an empty error as "Unknown error"
      // — even for a perfectly valid empty list.
      return { success: true, jobs, count: jobs.length };
    } catch (err) {
      // Guarantee a non-empty, actionable message (include the durable file path
      // for diagnosis) so the loop never collapses this to "Unknown error".
      const file = cronScheduler.DURABLE_FILE || '~/.khy/scheduled_tasks.json';
      return {
        success: false,
        error: (err && err.message)
          ? err.message
          : `CronList 读取定时任务失败（durable 文件: ${file}）`,
      };
    }
  }
}

module.exports = CronListTool;
