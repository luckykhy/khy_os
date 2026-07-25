/**
 * ScheduleCronTool — create cron jobs, aligned with Claude Code's ScheduleCron/CronCreate tool.
 *
 * Schedules prompts to run at future times, either recurring (cron schedule)
 * or one-shot. Delegates registration, matching, and firing to the canonical
 * scheduler in jobs/cronScheduler so that ScheduleCron, CronList, and CronDelete
 * all operate on ONE shared job store (previously this tool kept its own
 * disconnected in-memory store, so created jobs were invisible to list/delete).
 */
const { BaseTool } = require('../_baseTool');
const cronScheduler = require('../../jobs/cronScheduler');

class ScheduleCronTool extends BaseTool {
  static toolName = 'ScheduleCron';
  static category = 'system';
  static risk = 'medium';
  static aliases = ['cron_create', 'schedule', 'schedule_cron'];
  static searchHint = 'schedule cron job recurring timer reminder';
  static shouldDefer = true;

  // Cron trio symmetry / Claude Code alignment. CronList and CronDelete carry no
  // shouldDefer flag, so they are always eager (present in the initial tool prompt),
  // but ScheduleCron (the *create* half — by far the most common cron op) was the
  // only one deferred, forcing a SearchExtraTools round-trip just to schedule a job.
  // Claude Code exposes CronCreate/CronList/CronDelete at one tier; mirror that by
  // marking create alwaysLoad so the whole trio sits eager together. Gated
  // KHY_CRON_TRIO_EAGER (default on; 0/false/off/no/disable/disabled → byte-identical
  // old behavior where create stays deferred). shouldDefer stays true so the tool is
  // still deferred whenever this gate — or the global KHY_DEFER_TOOLS — is off.
  static get alwaysLoad() {
    const v = process.env.KHY_CRON_TRIO_EAGER;
    if (v === undefined) return true;
    return !['0', 'false', 'off', 'no', 'disable', 'disabled']
      .includes(String(v).trim().toLowerCase());
  }

  isReadOnly() { return false; }
  isConcurrencySafe() { return true; }

  prompt() {
    return `Schedule a prompt to be enqueued at a future time. Use for both recurring schedules and one-shot reminders.

Uses standard 5-field cron in the user's local timezone: minute hour day-of-month month day-of-week. "0 9 * * *" means 9am local — no timezone conversion needed.

## One-shot tasks (recurring: false)

For "remind me at X" or "at <time>, do Y" requests — fire once then auto-delete.
Pin minute/hour/day-of-month/month to specific values:
  "remind me at 2:30pm today to check the deploy" -> cron: "30 14 <today_dom> <today_month> *", recurring: false
  "tomorrow morning, run the smoke test" -> cron: "57 8 <tomorrow_dom> <tomorrow_month> *", recurring: false

## Recurring jobs (recurring: true, the default)

For "every N minutes" / "every hour" / "weekdays at 9am" requests:
  "every 5 minutes, check the health endpoint" -> cron: "*/5 * * * *"
  "weekdays at 9am, summarize PRs" -> cron: "0 9 * * 1-5"
  "every hour, check for new issues" -> cron: "0 * * * *"

## Durable vs session-only

By default a job lives only in this session — nothing is written to disk, and the
job is gone when the process exits. Pass durable: true to persist it to
.khy/scheduled_tasks.json so it survives restarts.

## Tips

- For one-shot tasks, compute the correct day-of-month and month for the target date
- Use descriptive prompt text so the job is self-documenting
- Keep the prompt text concise — it will be executed as-is when the cron fires
- Recurring jobs auto-expire after 7 days; there is a hard cap of 50 scheduled jobs`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        cron: {
          type: 'string',
          description: 'Standard 5-field cron expression (minute hour dom month dow). E.g., "0 9 * * 1-5" for weekdays at 9am.',
        },
        prompt: {
          type: 'string',
          description: 'The prompt text to execute when the cron fires',
        },
        recurring: {
          type: 'boolean',
          description: 'Whether this job recurs (default: true). Set false for one-shot tasks.',
        },
        durable: {
          type: 'boolean',
          description: 'Persist the job to disk so it survives restarts (default: false = session-only).',
        },
        description: {
          type: 'string',
          description: 'Human-readable description of what this job does',
        },
      },
      required: ['cron', 'prompt'],
    };
  }

  getActivityDescription(input) {
    return `创建定时任务：${(input.description || input.prompt || '').slice(0, 40)}`;
  }

  async execute(params, _context) {
    const { cron, prompt, recurring = true, durable = false, description } = params;

    // Delegate to the canonical scheduler — it validates the cron expression,
    // enforces MAX_JOBS, registers the job in the shared store, and self-starts
    // the tick loop so the job actually fires.
    const result = cronScheduler.createJob({ cron, prompt, recurring, durable });

    if (result && result.error) {
      return { success: false, error: result.error };
    }

    const job = result;
    return {
      success: true,
      job: {
        id: job.id,
        cron: job.cron,
        prompt: job.prompt,
        recurring: job.recurring,
        durable: job.durable,
        createdAt: job.createdAt,
        expiresAt: job.expiresAt,
        description: description || prompt.slice(0, 80),
      },
      message: `已创建定时任务：${job.id}，${recurring ? '循环执行' : '单次执行'}`
        + `（${cron}）${durable ? '，已持久化' : '，仅本会话'}`,
    };
  }
}

module.exports = new ScheduleCronTool();
module.exports.ScheduleCronTool = ScheduleCronTool;
